import { app, BrowserWindow, ipcMain, Tray, shell, type IpcMainInvokeEvent } from 'electron'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { happDetector } from './happDetector'
import { tunController } from './tunController'
import { ipMonitor } from './ipMonitor'
import { autoconfig } from './autoconfig'
import { createTray, updateTrayIcon } from './tray'
import { settingsStore } from './settings'
import { runLeakCheck } from './leakDiagnostics'
import { runStoreRepair, type StoreRepairAction } from './storeRepair'
import { runStoreDiagnostics } from './storeDiagnostics'
import { applyLocationPrivacy, getLocationPrivacyStatus, rollbackLocationPrivacy } from './locationPrivacy'
import {
  applyTunNetworkBaseline,
  isBaselineApplied,
  rollbackTunNetworkBaseline,
  rollbackTunNetworkBaselineIfApplied
} from './systemNetwork'
import {
  disableKillSwitchIfActive,
  isKillSwitchActive,
  recoverStaleKillSwitch
} from './firewallKillSwitch'
import {
  isPhysicalAdapterLockdownApplied,
  rollbackPhysicalAdapterLockdownIfApplied
} from './physicalAdapterLockdown'
import { relaunchElevatedIfNeeded } from './admin'
import { clearAppLog, getFullLogs, logEvent, openLogFolder, type AppLogLevel } from './appLogger'
import { runSystemDiagnostics } from './systemDiagnostics'
import { getRoutingPlan } from './connectionPlanner'
import { runAutoPilot } from './autoPilot'
import { notify } from './notifications'
import { exportDiagnosticsZip } from './diagnosticsExport'
import { captureSnapshot, getSnapshotsDir, startPeriodicSnapshots, stopPeriodicSnapshots } from './systemSnapshot'
import { runLeakSelfTest, startPeriodicLeakTest, stopPeriodicLeakTest, setLeakDetectedCallback } from './leakSelfTest'

const exec = promisify(execCb)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let shutdownInProgress = false

// Global guards against uncaught exceptions / rejections in the main process.
// Without these, a stray ECONNRESET on a stale TCP socket (axios connection
// dropped mid-stream, telemetry probe killed by the firewall, etc.) shows the
// big white "A JavaScript error occurred in the main process" modal and
// effectively wedges the app — even though the error is recoverable. Here we
// just log it and keep going. We deliberately do NOT swallow the error
// silently: it goes through `logEvent` so it shows up in app log + diagnostics
// ZIP, and it's surfaced to the renderer so the user can see "что-то пошло не
// так" without losing the whole app.
function installCrashGuards(): void {
  // Common, mostly-recoverable network-layer errors that shouldn't crash the
  // app even once. ECONNRESET happens when the peer (proxy/AV/firewall) tears
  // down a half-open TCP socket. EPIPE is similar for write side. ENOTFOUND /
  // EAI_AGAIN come from DNS while TUN is restarting.
  const benignNetCodes = new Set(['ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED'])

  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    const isBenignNet = err && err.code !== undefined && benignNetCodes.has(err.code)
    logEvent(isBenignNet ? 'warn' : 'error', 'app', 'uncaughtException — keeping app alive', {
      code: err?.code,
      message: err?.message,
      stack: err?.stack
    })
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-error', {
          code: err?.code ?? 'UNKNOWN',
          message: err?.message ?? String(err)
        })
      } catch {
        // If even the IPC send throws, swallow it — there's nothing meaningful to do.
      }
    }
  })

  process.on('unhandledRejection', (reason: any) => {
    const code = reason?.code
    const isBenignNet = typeof code === 'string' && benignNetCodes.has(code)
    logEvent(isBenignNet ? 'warn' : 'error', 'app', 'unhandledRejection — keeping app alive', {
      code,
      message: reason?.message ?? String(reason),
      stack: reason?.stack
    })
  })
}
installCrashGuards()

function getIconPath() {
  if (process.env.ELECTRON_RENDERER_URL) {
    return join(__dirname, '../../resources/icon.ico')
  }
  return join(process.resourcesPath, 'icon.ico')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1e1e2e'
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.on('close', (e) => {
    if (isQuitting || !settingsStore.get().minimizeToTray) return
    e.preventDefault()
    mainWindow!.hide()
  })

  const loadRenderer = () => {
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow!.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => {
        setTimeout(loadRenderer, 1000)
      })
    } else {
      mainWindow!.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }
  loadRenderer()
}

function compactForLog(value: unknown): string {
  try {
    const raw = JSON.stringify(value)
    if (!raw) return ''
    return raw.length > 2000 ? `${raw.slice(0, 2000)}...<truncated>` : raw
  } catch {
    return String(value)
  }
}

function handleLogged<T>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T
) {
  ipcMain.handle(channel, async (event, ...args) => {
    const started = Date.now()
    logEvent('debug', 'ipc', `${channel} started`, { args: compactForLog(args) })
    try {
      const result = await listener(event, ...args)
      logEvent('debug', 'ipc', `${channel} finished`, {
        ms: Date.now() - started,
        result: compactForLog(result)
      })
      return result
    } catch (err) {
      logEvent('error', 'ipc', `${channel} failed`, err)
      throw err
    }
  })
}

// Crash recovery: if a previous session applied the network baseline but never rolled it
// back (process killed, BSOD, force-quit), the user's HKCU\Internet Settings + env proxy
// vars stay wiped forever. On startup, if no sing-box is left running, restore them.
async function recoverStaleBaseline(): Promise<void> {
  if (process.platform !== 'win32') return
  if (!(await isBaselineApplied())) return
  try {
    const { stdout } = await exec('tasklist /FI "IMAGENAME eq vpnte-sing-box.exe" /FO CSV /NH', {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8'
    })
    if (String(stdout).toLowerCase().includes('vpnte-sing-box.exe')) {
      logEvent('info', 'app', 'baseline marker found and sing-box is still running — keeping baseline')
      return
    }
  } catch {
    // fall through to rollback
  }
  logEvent('warn', 'app', 'stale baseline detected on startup (sing-box not running) — rolling back')
  await rollbackTunNetworkBaselineIfApplied('crash recovery on startup').catch(err =>
    logEvent('warn', 'app', 'crash-recovery rollback failed', err)
  )
}

app.whenReady().then(async () => {
  logEvent('info', 'app', 'application ready', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath('userData')
  })

  if (app.isPackaged && await relaunchElevatedIfNeeded()) {
    logEvent('info', 'app', 'relaunching elevated')
    app.quit()
    return
  }

  await recoverStaleBaseline()
  await recoverStaleKillSwitch(async () => {
    try {
      const { stdout } = await exec('tasklist /FI "IMAGENAME eq vpnte-sing-box.exe" /FO CSV /NH', {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      })
      return String(stdout).toLowerCase().includes('vpnte-sing-box.exe')
    } catch {
      return false
    }
  })

  // Same crash-recovery story for the physical-adapter lockdown: if a previous
  // run left IPv6 disabled / DNS overridden on real adapters, the user is now
  // looking at a half-broken network and there's no sing-box to enforce
  // anything. Roll back to whatever we snapshotted.
  if (await isPhysicalAdapterLockdownApplied()) {
    let singboxRunning = false
    try {
      const { stdout } = await exec('tasklist /FI "IMAGENAME eq vpnte-sing-box.exe" /FO CSV /NH', {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      })
      singboxRunning = String(stdout).toLowerCase().includes('vpnte-sing-box.exe')
    } catch {
      // If tasklist fails we assume sing-box is not running and roll back.
    }
    if (!singboxRunning) {
      logEvent('warn', 'phys-lockdown', 'recovering stale adapter lockdown — sing-box not running')
      try {
        await rollbackPhysicalAdapterLockdownIfApplied('startup recovery — sing-box not running')
      } catch (err) {
        logEvent('warn', 'phys-lockdown', 'startup rollback failed', err)
      }
    }
  }

  const initialSettings = settingsStore.get()
  settingsStore.syncLoginItem()
  ipMonitor.setCheckInterval(initialSettings.checkInterval)

  createWindow()
  tray = createTray(mainWindow!)

  // Capture a snapshot of the system state on every app launch — gives us a
  // "what does the network look like before the user clicks anything" record
  // for free, in case they later report "doesn't work" without ever clicking.
  captureSnapshot('app-start').catch(() => undefined)

  // When the periodic leak self-test (started at TUN start) detects a leak,
  // bubble that to the renderer so the UI can show a giant red banner, AND
  // fire a Windows toast.
  setLeakDetectedCallback((r) => {
    try {
      mainWindow?.webContents.send('leak-detected', r)
    } catch {}
    try {
      notify('warn', 'УТЕЧКА обнаружена', r.summary)
    } catch {}
  })

  // IPC handlers
  handleLogged('detect-happ', async () => {
    return happDetector.detect()
  })

  handleLogged('get-public-ip', async () => {
    return ipMonitor.getCurrentIp()
  })

  handleLogged('start-tun', async (_e, proxyAddr: string, proxyType?: 'socks5' | 'http') => {
    // Snapshot BEFORE we change anything. This is the baseline state that
    // support/diagnostics will compare against.
    captureSnapshot('tun-pre-start').catch(() => undefined)

    const plan = await getRoutingPlan()
    if (!plan.canStartHard) {
      return {
        success: false,
        error: `${plan.title}. ${plan.explanation} ${plan.after}`
      }
    }

    let baselineWarning: string | null = null
    if (settingsStore.get().autoNetworkBaseline) {
      const baseline = await applyTunNetworkBaseline()
      if (!baseline.success) {
        baselineWarning = `Не удалось применить сетевой baseline: ${baseline.message}`
      }
    }

    const result = await tunController.start({
      proxyAddr,
      proxyType: proxyType ?? 'socks5',
      enableFirewallKillSwitch: settingsStore.get().firewallKillSwitch,
      enableAdapterLockdown: settingsStore.get().strictAdapterLockdown
    })
    if (!result.success) {
      // TUN failed to start. If we wiped the user's proxy settings to prepare for it,
      // restore them now so we don't leave the system worse than we found it. The
      // kill-switch is dropped by tunController itself in this path — see start().
      await rollbackTunNetworkBaselineIfApplied('start-tun failed').catch(err =>
        logEvent('warn', 'app', 'rollback after start-tun failure failed', err)
      )
      captureSnapshot('tun-start-failed').catch(() => undefined)
      return result
    }

    const ipInfo = await ipMonitor.getCurrentIp()
    if (ipInfo.ip) ipMonitor.setVpnIp(ipInfo.ip)
    if (tray) updateTrayIcon(tray, 'protected')

    // Snapshot AFTER everything is applied (TUN up, kill-switch up,
    // adapter lockdown up). Then start the periodic snapshot timer +
    // periodic leak self-test so we keep collecting data for support.
    captureSnapshot('tun-post-start').catch(() => undefined)
    startPeriodicSnapshots(60_000)
    startPeriodicLeakTest(120_000)

    return {
      ...result,
      warning: [baselineWarning, result.warning].filter(Boolean).join(' | ') || null,
      vpnIp: ipInfo.ip ?? null
    }
  })

  handleLogged('stop-tun', async () => {
    stopPeriodicSnapshots()
    stopPeriodicLeakTest()
    const result = await tunController.stop()
    ipMonitor.clearVpnIp()
    if (tray) updateTrayIcon(tray, 'off')
    captureSnapshot('tun-post-stop').catch(() => undefined)
    return result
  })

  handleLogged('get-tun-status', async () => {
    return tunController.getStatus()
  })

  handleLogged('apply-autoconfig', async (_e, targets: string[], proxyAddr: string, proxyType?: 'socks5' | 'http') => {
    return autoconfig.apply(targets, proxyAddr, proxyType ?? settingsStore.get().proxyType)
  })

  handleLogged('rollback-autoconfig', async (_e, targets: string[]) => {
    return autoconfig.rollback(targets)
  })

  handleLogged('get-autoconfig-status', async () => {
    return autoconfig.getStatus()
  })

  handleLogged('get-settings', async () => {
    return settingsStore.get()
  })

  handleLogged('save-settings', async (_e, settings) => {
    const saved = settingsStore.save(settings)
    ipMonitor.setCheckInterval(saved.checkInterval)
    return saved
  })

  handleLogged('set-login-item', async (_e, openAtLogin: boolean) => {
    return settingsStore.setLoginItem(openAtLogin)
  })

  handleLogged('run-leak-check', async (_e, options?: { proxyAddr?: string; proxyType?: 'socks5' | 'http' }) => {
    const tunStatus = tunController.getStatus()
    return runLeakCheck({
      proxyAddr: options?.proxyAddr ?? tunStatus.proxyAddr ?? undefined,
      proxyType: options?.proxyType ?? tunStatus.proxyType ?? settingsStore.get().proxyType,
      tunRunning: tunStatus.running
    })
  })

  handleLogged('run-store-repair', async (_e, action: StoreRepairAction) => {
    return runStoreRepair(action)
  })

  handleLogged('run-store-diagnostics', async () => {
    return runStoreDiagnostics()
  })

  handleLogged('run-system-diagnostics', async () => {
    return runSystemDiagnostics()
  })

  handleLogged('get-routing-plan', async () => {
    return getRoutingPlan()
  })

  handleLogged('run-auto-pilot', async () => {
    return runAutoPilot()
  })

  handleLogged('renderer-log', async (_e, level: AppLogLevel, message: string) => {
    const safeLevel: AppLogLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info'
    logEvent(safeLevel, 'renderer', message)
    return { success: true }
  })

  handleLogged('get-full-logs', async () => {
    return getFullLogs()
  })

  handleLogged('clear-app-log', async () => {
    await clearAppLog()
    logEvent('info', 'app', 'app log cleared')
    return { success: true }
  })

  handleLogged('apply-tun-network-baseline', async () => {
    return applyTunNetworkBaseline()
  })

  handleLogged('rollback-tun-network-baseline', async () => {
    return rollbackTunNetworkBaseline()
  })

  // Manual override: snip the firewall kill-switch even if sing-box hasn't been
  // restarted. Used by the Dashboard banner that appears when sing-box died and
  // left the rules in place — the user can either restart TUN or, as a last
  // resort, drop the kill-switch and accept the leak window themselves.
  handleLogged('disable-firewall-kill-switch', async () => {
    return tunController.disableFirewallKillSwitch('manual override from UI')
  })

  handleLogged('get-firewall-kill-switch-status', async () => {
    return { active: await isKillSwitchActive() }
  })

  handleLogged('get-location-privacy', async () => {
    return getLocationPrivacyStatus()
  })

  handleLogged('apply-location-privacy', async () => {
    const status = await applyLocationPrivacy()
    settingsStore.save({ locationPrivacyEnabled: status.applied })
    return status
  })

  handleLogged('rollback-location-privacy', async () => {
    const status = await rollbackLocationPrivacy()
    settingsStore.save({ locationPrivacyEnabled: status.applied })
    return status
  })

  handleLogged('open-tun-log-folder', async () => {
    const folder = join(app.getPath('userData'), 'tun-runtime')
    await shell.openPath(folder)
    return folder
  })

  handleLogged('open-log-folder', async () => {
    return openLogFolder()
  })

  handleLogged('export-diagnostics', async () => {
    // User-driven export. Take a fresh snapshot first so it's the most
    // recent thing in the ZIP — then call the existing exporter.
    await captureSnapshot('manual').catch(() => undefined)
    return exportDiagnosticsZip()
  })

  handleLogged('run-leak-self-test', async () => {
    const result = await runLeakSelfTest()
    if (result.physicalAdapterReached || result.publicIpMismatch) {
      // Always snapshot when we see a leak — that's exactly the moment we
      // want frozen for support.
      captureSnapshot('leak-detected').catch(() => undefined)
    }
    return result
  })

  handleLogged('open-snapshots-folder', async () => {
    const dir = getSnapshotsDir()
    try {
      // Ensure the directory exists before opening — on first launch the user
      // might click this before any snapshot has been written.
      const { mkdir } = await import('fs/promises')
      await mkdir(dir, { recursive: true })
      const { shell } = await import('electron')
      const result = await shell.openPath(dir)
      // openPath returns '' on success, error message on failure.
      if (result) return { success: false, error: result, path: dir }
      return { success: true, path: dir }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Push events from main → renderer
  ipMonitor.onIpChange((ip: string, isLeak: boolean) => {
    mainWindow?.webContents.send('ip-changed', { ip, isLeak })
    if (tray) updateTrayIcon(tray, isLeak ? 'leak' : tunController.getStatus().running ? 'protected' : 'off')
    if (isLeak) {
      notify('error', 'Виден ваш реальный IP', `Текущий публичный IP: ${ip}. Включите защиту или проверьте VPN-клиент.`)
    }
  })

  tunController.onStatusChange((status: string) => {
    mainWindow?.webContents.send('tun-status-changed', status)
    if (tray) updateTrayIcon(tray, status === 'running' ? 'protected' : 'off')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

// Coordinated shutdown: stop TUN, roll back any global system-proxy edits we made, and
// roll back the soft-mode env-proxy autoconfig. Without this, closing the app could
// leave the user with no VPN AND no original proxy settings — the "breaks global
// settings" failure mode this PR addresses.
async function performShutdownCleanup(reason: string): Promise<void> {
  if (shutdownInProgress) return
  shutdownInProgress = true
  logEvent('info', 'app', `shutdown cleanup started: ${reason}`)

  try {
    if (tunController.getStatus().running) {
      await tunController.stop()
    }
  } catch (err) {
    logEvent('warn', 'app', 'tunController.stop during shutdown failed', err)
  }

  try {
    await rollbackTunNetworkBaselineIfApplied(`shutdown: ${reason}`)
  } catch (err) {
    logEvent('warn', 'app', 'baseline rollback during shutdown failed', err)
  }

  try {
    // Always disengage the firewall kill-switch on app exit. Leaving it in
    // place would lock the user out of the internet between sessions.
    await disableKillSwitchIfActive(`shutdown: ${reason}`)
  } catch (err) {
    logEvent('warn', 'app', 'kill-switch disable during shutdown failed', err)
  }

  try {
    // Same for the adapter lockdown: never leave IPv6 disabled / DNS overridden
    // across sessions. tunController.stop() already does this, but a forced
    // shutdown path (no Stop button click) needs it as a backstop.
    await rollbackPhysicalAdapterLockdownIfApplied(`shutdown: ${reason}`)
  } catch (err) {
    logEvent('warn', 'app', 'adapter lockdown rollback during shutdown failed', err)
  }

  try {
    const status = await autoconfig.getStatus()
    const envApplied = status.find(t => t.id === 'env')?.applied
    if (envApplied) {
      logEvent('info', 'app', 'rolling back env autoconfig (setx HTTP_PROXY) on shutdown')
      await autoconfig.rollback(['env'])
    }
  } catch (err) {
    logEvent('warn', 'app', 'env autoconfig rollback during shutdown failed', err)
  }
}

app.on('before-quit', async (event) => {
  if (shutdownInProgress) return
  isQuitting = true
  logEvent('info', 'app', 'before quit')
  event.preventDefault()
  await performShutdownCleanup('before-quit')
  app.exit(0)
})

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    logEvent('info', 'app', 'all windows closed')
    await performShutdownCleanup('window-all-closed')
    app.quit()
  }
})
