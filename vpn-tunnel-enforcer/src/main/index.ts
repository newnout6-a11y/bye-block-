import { app, BrowserWindow, ipcMain, Tray, shell, type IpcMainInvokeEvent } from 'electron'
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
import { applyTunNetworkBaseline, rollbackTunNetworkBaseline } from './systemNetwork'
import { relaunchElevatedIfNeeded } from './admin'
import { clearAppLog, getFullLogs, logEvent, openLogFolder, type AppLogLevel } from './appLogger'
import { runSystemDiagnostics } from './systemDiagnostics'
import { getRoutingPlan } from './connectionPlanner'
import { runAutoPilot } from './autoPilot'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

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

  const initialSettings = settingsStore.get()
  settingsStore.syncLoginItem()
  ipMonitor.setCheckInterval(initialSettings.checkInterval)

  createWindow()
  tray = createTray(mainWindow!)

  // IPC handlers
  handleLogged('detect-happ', async () => {
    return happDetector.detect()
  })

  handleLogged('get-public-ip', async () => {
    return ipMonitor.getCurrentIp()
  })

  handleLogged('start-tun', async (_e, proxyAddr: string, proxyType?: 'socks5' | 'http') => {
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

    const result = await tunController.start({ proxyAddr, proxyType: proxyType ?? 'socks5' })
    if (!result.success) return result

    const ipInfo = await ipMonitor.getCurrentIp()
    if (ipInfo.ip) ipMonitor.setVpnIp(ipInfo.ip)
    if (tray) updateTrayIcon(tray, 'protected')
    return {
      ...result,
      warning: [baselineWarning, result.warning].filter(Boolean).join(' | ') || null,
      vpnIp: ipInfo.ip ?? null
    }
  })

  handleLogged('stop-tun', async () => {
    const result = await tunController.stop()
    ipMonitor.clearVpnIp()
    if (tray) updateTrayIcon(tray, 'off')
    return result
  })

  handleLogged('get-tun-status', async () => {
    return tunController.getStatus()
  })

  handleLogged('apply-autoconfig', async (_e, targets: string[], proxyAddr: string) => {
    return autoconfig.apply(targets, proxyAddr)
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

  // Push events from main → renderer
  ipMonitor.onIpChange((ip: string, isLeak: boolean) => {
    mainWindow?.webContents.send('ip-changed', { ip, isLeak })
    if (tray) updateTrayIcon(tray, isLeak ? 'leak' : tunController.getStatus().running ? 'protected' : 'off')
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

app.on('before-quit', () => {
  isQuitting = true
  logEvent('info', 'app', 'before quit')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    tunController.stop()
    logEvent('info', 'app', 'all windows closed')
    app.quit()
  }
})
