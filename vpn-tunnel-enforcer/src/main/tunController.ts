import { exec as execCb } from 'child_process'
import { writeFile, mkdir, copyFile, access, rename, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { promisify } from 'util'
import { createConnection } from 'net'
import { networkInterfaces } from 'os'
import { app } from 'electron'
import sudo from 'sudo-prompt'
import { execElevated, isProcessElevated } from './admin'
import { logEvent } from './appLogger'
import { rollbackTunNetworkBaselineIfApplied } from './systemNetwork'

const exec = promisify(execCb)

export interface TunStatus {
  running: boolean
  proxyAddr: string | null
  proxyType: 'socks5' | 'http' | null
  pid: number | null
  warning?: string | null
  proxyReachable?: boolean
}

interface StartOptions {
  proxyAddr: string
  proxyType?: 'socks5' | 'http'
}

let currentStatus: TunStatus = { running: false, proxyAddr: null, proxyType: null, pid: null, warning: null, proxyReachable: true }
let statusCallbacks: ((status: string) => void)[] = []
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let watchdogFailures = 0

const RUNTIME_EXE_NAME = 'vpnte-sing-box.exe'
const PROXY_CORE_PROCESS_NAMES = [
  'Happ.exe',
  'happd.exe',
  'xray.exe',
  'v2ray.exe',
  'sing-box.exe',
  'singbox.exe',
  'mihomo.exe',
  'clash.exe',
  'clash-meta.exe',
  'clash-verge.exe',
  'hiddify.exe',
  'Hiddify.exe',
  'nekoray.exe',
  'nekobox.exe',
  'shadowsocks.exe',
  'ss-local.exe',
  'trojan.exe',
  'outline.exe',
  'Outline.exe',
  'wireguard.exe',
  'openvpn.exe'
]

export function getTunRuntimeDir(): string {
  return join(app.getPath('userData'), 'tun-runtime')
}

function getBundledResource(name: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, name)
  }
  return join(app.getAppPath(), 'resources', name)
}

export function parseProxyAddress(proxyAddr: string): { host: string; port: number } {
  const trimmed = proxyAddr.trim()
  const ipv6Match = trimmed.match(/^\[([^\]]+)]:(\d+)$/)
  if (ipv6Match) {
    const port = parseInt(ipv6Match[2], 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Некорректный порт прокси: ${ipv6Match[2]}`)
    }
    return { host: ipv6Match[1], port }
  }

  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Адрес прокси должен быть в формате host:port')
  }

  const host = trimmed.slice(0, separator).trim()
  const port = parseInt(trimmed.slice(separator + 1), 10)
  if (!host) throw new Error('Не указан host прокси')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Некорректный порт прокси: ${trimmed.slice(separator + 1)}`)
  }
  return { host, port }
}

function normalizeProcessName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  return trimmed.toLowerCase().endsWith('.exe') ? trimmed : `${trimmed}.exe`
}

function uniqueProcessNames(names: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = normalizeProcessName(raw)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

export function generateSingboxConfig(
  proxyAddr: string,
  proxyType: 'socks5' | 'http',
  directProcessNames: string[] = []
): object {
  const { host, port } = parseProxyAddress(proxyAddr)
  const proxyCoreProcesses = uniqueProcessNames([...PROXY_CORE_PROCESS_NAMES, ...directProcessNames])

  // domain_strategy: 'prefer_ipv4' on the outbound is belt-and-suspenders.
  // Our DNS already resolves with prefer_ipv4 (see dns.strategy below), but
  // when sing-box has to re-resolve a sniffed SNI domain it falls back to
  // default_domain_resolver — telling the outbound to also prefer IPv4 keeps
  // a SOCKS5/HTTP proxy that has no IPv6 upstream from blackholing AAAA-only
  // destinations.
  const proxyOutbound =
    proxyType === 'http'
      ? { type: 'http', tag: 'proxy-out', server: host, server_port: port, domain_strategy: 'prefer_ipv4' }
      : { type: 'socks', tag: 'proxy-out', version: '5', server: host, server_port: port, domain_strategy: 'prefer_ipv4' }

  const logPath = join(getTunRuntimeDir(), 'sing-box.log').replace(/\\/g, '/')
  const privateRanges = [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '224.0.0.0/4',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8'
  ]

  return {
    log: { level: 'debug', timestamp: true, output: logPath },
    dns: {
      // TCP/TLS DNS is deliberately detoured through proxy-out so DNS cannot fall back
      // to the physical adapter while the full-tunnel route is active.
      // No local resolver is registered — if proxy-out is unreachable, DNS must fail
      // closed instead of silently falling back to the ISP resolver via the physical NIC.
      servers: [
        { type: 'tls', tag: 'dns-remote', server: '1.1.1.1', detour: 'proxy-out' },
        { type: 'tls', tag: 'dns-backup', server: '8.8.8.8', detour: 'proxy-out' }
      ],
      strategy: 'prefer_ipv4'
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'VPNTE-TUN',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 1500,
        auto_route: true,
        strict_route: true,
        route_address: ['0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1'],
        stack: 'system'
      }
    ],
    outbounds: [
      proxyOutbound,
      { type: 'direct', tag: 'direct-out' },
      { type: 'block', tag: 'block-out' }
    ],
    route: {
      rules: [
        {
          process_name: proxyCoreProcesses,
          outbound: 'direct-out'
        },
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_cidr: privateRanges, outbound: 'direct-out' },
        // HTTP proxy outbound has no UDP transport at all, so every UDP packet
        // (QUIC/HTTP3, gaming, raw DNS that escaped hijack) would silently time
        // out. Explicitly block UDP/443 so browsers fail fast on QUIC and fall
        // back to TCP TLS instead of waiting for QUIC to time out on each load.
        ...(proxyType === 'http'
          ? [{ network: 'udp', port: 443, outbound: 'block-out' }]
          : [])
      ],
      final: 'proxy-out',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-remote'
    }
  }
}

function notifyStatus(status: string) {
  statusCallbacks.forEach(cb => cb(status))
}

async function isSingboxRunning(): Promise<boolean> {
  try {
    const { stdout } = await exec(`tasklist /FI "IMAGENAME eq ${RUNTIME_EXE_NAME}" /FO CSV /NH`)
    return stdout.toLowerCase().includes(RUNTIME_EXE_NAME)
  } catch {
    return false
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function killRuntimeProcess(imageName: string, executablePath: string): Promise<void> {
  const command =
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
    `"Get-CimInstance Win32_Process -Filter \\\"Name='${imageName}'\\\" | ` +
    `Where-Object { $_.ExecutablePath -eq ${psQuote(executablePath)} } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`

  return execElevated(command, { timeout: 15000 }).then(() => undefined).catch(() => undefined)
}

async function killOwnedRuntimeProcesses(): Promise<void> {
  const runtimeDir = getTunRuntimeDir()
  await killRuntimeProcess(RUNTIME_EXE_NAME, join(runtimeDir, RUNTIME_EXE_NAME))
  await killRuntimeProcess('sing-box.exe', join(runtimeDir, 'sing-box.exe'))
  await killRuntimeProcess('sing-box.exe', getBundledResource('sing-box.exe'))
}

// Kill-switch behavior: when the upstream proxy is unreachable, we INTENTIONALLY do NOT
// tear down sing-box. The TUN keeps strict_route + final=proxy-out, so traffic just
// times out at the dead proxy instead of leaking out the physical adapter. The watchdog
// only annotates the status so the UI can warn the user that traffic is currently
// blocked; it never kills the runtime on its own.
function markProxyUnreachable(reason: string): void {
  if (!currentStatus.running) return
  if (currentStatus.proxyReachable === false) return
  logEvent('warn', 'tun-watchdog', reason)
  currentStatus = { ...currentStatus, proxyReachable: false, warning: reason }
  notifyStatus('proxy-down')
}

function markProxyRecovered(): void {
  if (!currentStatus.running) return
  if (currentStatus.proxyReachable !== false) return
  logEvent('info', 'tun-watchdog', 'upstream proxy recovered, traffic flowing again')
  currentStatus = { ...currentStatus, proxyReachable: true, warning: null }
  notifyStatus('running')
}

function stopProxyWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  watchdogFailures = 0
}

function startProxyWatchdog(proxyAddr: string) {
  stopProxyWatchdog()

  let parsed: { host: string; port: number }
  try {
    parsed = parseProxyAddress(proxyAddr)
  } catch (err: any) {
    logEvent('warn', 'tun-watchdog', 'watchdog disabled because proxy address is invalid', err)
    return
  }

  watchdogTimer = setInterval(async () => {
    if (!currentStatus.running) {
      stopProxyWatchdog()
      return
    }

    const alive = await probeTcp(parsed.host, parsed.port, 1500)
    if (alive) {
      watchdogFailures = 0
      markProxyRecovered()
      return
    }

    watchdogFailures += 1
    if (watchdogFailures >= 3) {
      // Kill-switch: do NOT stop sing-box. The TUN keeps blocking traffic until proxy returns.
      markProxyUnreachable(
        `Прокси ${proxyAddr} не отвечает. Трафик блокируется в TUN, чтобы не утекать мимо VPN.`
      )
    } else {
      logEvent('warn', 'tun-watchdog', `upstream proxy probe failed (${watchdogFailures}/3)`, { proxyAddr })
    }
  }, 5000)
}

// Quick TCP reachability probe (2s timeout). Used to verify the upstream proxy
// (e.g. Happ on 127.0.0.1:10808) is actually accepting connections BEFORE we
// rewrite system routing — otherwise the TUN would blackhole all traffic.
export function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function getProxyOwnerProcessNames(host: string, port: number): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const safeHost = host.replace(/'/g, "''")
  const script = [
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();',
    `$hostName='${safeHost}';`,
    `$port=${port};`,
    "$addresses=@($hostName,'127.0.0.1','::1','0.0.0.0','::');",
    'Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |',
    'Where-Object { $addresses -contains $_.LocalAddress } |',
    'ForEach-Object {',
    '  $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;',
    '  if ($p) { [pscustomobject]@{ ProcessName=$p.ProcessName; Id=$p.Id } }',
    '} | ConvertTo-Json -Compress'
  ].join(' ')
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`

  try {
    const { stdout } = await exec(command, { windowsHide: true, timeout: 8000, encoding: 'utf8' })
    const raw = stdout.trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return uniqueProcessNames(rows.map((row: any) => String(row.ProcessName || '')))
  } catch (err: any) {
    logEvent('warn', 'tun', 'failed to detect proxy owner process', { host, port, error: err.message || String(err) })
    return []
  }
}

// Detect another active VPN/TUN adapter (Happ TUN, WireGuard, OpenVPN, …).
// Returns the interface name if found. We refuse to start in that case so we
// don't rip apart the user's working tunnel with our own auto_route.
// Our own adapter uses 172.19.0.x — anything else matching VPN patterns is foreign.
//
// Uses os.networkInterfaces() which returns raw adapter names as Windows knows them
// (e.g. 'happ-tun', 'wg0', 'WireGuard Tunnel'). Locale-independent, no external process.
export function detectForeignTun(): string | null {
  const vpnNameRx = /wintun|\btun\b|wireguard|\bwg\d*\b|openvpn|tap-windows|happ|hiddify|singbox|v2ray|xray/i
  const nics = networkInterfaces()
  for (const [name, addrs] of Object.entries(nics)) {
    if (!addrs) continue
    if (!vpnNameRx.test(name)) continue
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('172.19.0.')) continue // our own TUN
      return `${name} (${a.address})`
    }
  }
  return null
}

async function prepareRuntime(
  proxyAddr: string,
  proxyType: 'socks5' | 'http',
  directProcessNames: string[]
): Promise<{ singbox: string; config: string }> {
  const runtimeDir = getTunRuntimeDir()
  await mkdir(runtimeDir, { recursive: true })

  const singboxSrc = getBundledResource('sing-box.exe')
  const wintunSrc = getBundledResource('wintun.dll')
  const singboxDst = join(runtimeDir, RUNTIME_EXE_NAME)
  const wintunDst = join(runtimeDir, 'wintun.dll')
  const configPath = join(runtimeDir, 'sing-box.json')
  const logPath = join(runtimeDir, 'sing-box.log')
  const logPrevPath = join(runtimeDir, 'sing-box.prev.log')

  // Rotate previous log so each run has a clean slate; previous one kept as .prev.log.
  try {
    await stat(logPath)
    await rename(logPath, logPrevPath).catch(() => undefined)
  } catch {
    // no existing log — nothing to rotate
  }

  // Copy binaries to a writable runtime dir (Program Files is read-only for normal users;
  // also ensures sing-box.exe and wintun.dll are in the same directory).
  await access(singboxSrc)
  await access(wintunSrc)
  await copyFile(singboxSrc, singboxDst)
  await copyFile(wintunSrc, wintunDst)

  const config = generateSingboxConfig(proxyAddr, proxyType, directProcessNames)
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')

  return { singbox: singboxDst, config: configPath }
}

export const tunController = {
  async start(proxyAddrOrOpts: string | StartOptions): Promise<{ success: boolean; error?: string; warning?: string | null }> {
    if (currentStatus.running) {
      return { success: false, error: 'TUN уже запущен' }
    }

    const proxyAddr = typeof proxyAddrOrOpts === 'string' ? proxyAddrOrOpts : proxyAddrOrOpts.proxyAddr
    const proxyType: 'socks5' | 'http' =
      typeof proxyAddrOrOpts === 'string' ? 'socks5' : proxyAddrOrOpts.proxyType ?? 'socks5'

    // ---------- Pre-flight 1: detect another VPN/TUN ----------
    // We no longer abort here: Happ often exposes both a local proxy and its own TUN.
    // Instead we exclude known Happ core processes from this TUN to avoid proxy loops.
    const foreign = detectForeignTun()
    if (foreign) {
      const message =
        `Уже активен другой системный туннель: ${foreign}. Второй TUN поверх него не запускается, ` +
        'потому что так чаще всего ломаются DNS и интернет. Оставьте текущий VPN/TUN включенным или выключите TUN в VPN-клиенте и оставьте только локальный proxy.'
      logEvent('warn', 'tun', 'start refused because another TUN/VPN is already active', { foreign, proxyAddr, proxyType })
      return { success: false, error: message }
    }
    const warning = null

    // ---------- Pre-flight 2: proxy must actually be listening ----------
    // If Happ is closed or in TUN mode, port 10808 isn't listening — without this check
    // sing-box would start TUN, hijack all routes, and then 100% of traffic would blackhole.
    let parsedProxy: { host: string; port: number }
    try {
      parsedProxy = parseProxyAddress(proxyAddr)
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
    }

    const { host, port } = parsedProxy
    const proxyAlive = await probeTcp(host, port, 2000)
    if (!proxyAlive) {
      logEvent('error', 'tun', 'start refused because upstream proxy is not reachable', { proxyAddr, proxyType })
      return {
        success: false,
        error:
          `Прокси ${proxyAddr} недоступен. Убедитесь, что Happ запущен в режиме Proxy ` +
          `и слушает порт ${port}.`
      }
    }
    logEvent('info', 'tun', 'upstream proxy is reachable', { proxyAddr, proxyType })

    const proxyOwnerProcesses = await getProxyOwnerProcessNames(host, port)
    if (proxyOwnerProcesses.length > 0) {
      logEvent('info', 'tun', 'detected local proxy owner process for direct-out exclusion', {
        proxyAddr,
        processNames: proxyOwnerProcesses
      })
    }

    // Kill only VPNTE-owned runtime binaries. Never kill generic sing-box.exe elsewhere:
    // Happ may use its own sing-box/xray core.
    if (await isSingboxRunning()) {
      await killOwnedRuntimeProcesses()
      // Give the OS a moment to release handles.
      await new Promise((r) => setTimeout(r, 500))
    } else {
      await killRuntimeProcess('sing-box.exe', join(getTunRuntimeDir(), 'sing-box.exe'))
    }

    let runtime: { singbox: string; config: string }
    try {
      runtime = await prepareRuntime(proxyAddr, proxyType, proxyOwnerProcesses)
      await exec(`"${runtime.singbox}" check -c "${runtime.config}"`)
    } catch (err: any) {
      logEvent('error', 'tun', 'failed to prepare TUN runtime', err)
      return { success: false, error: `Не удалось подготовить TUN-окружение: ${err.stderr || err.message || err}` }
    }

    const runtimeDir = dirname(runtime.singbox)

    // sudo-prompt's callback fires on child exit. For a long-running daemon we:
    // 1. Fire-and-forget the sudo.exec call, using its callback to mark "stopped" on exit.
    // 2. Poll tasklist for sing-box.exe to determine if it actually started.
    return new Promise((resolve) => {
      let resolved = false
      const finish = (result: { success: boolean; error?: string; warning?: string | null }) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      // Wrap command so it runs in the runtime dir (so wintun.dll resolves correctly).
      const cmd = `cmd /c cd /d "${runtimeDir}" && "${runtime.singbox}" run -c "${runtime.config}"`

      const onExit = (error?: Error | null, stderr?: string) => {
        // This fires only when sing-box exits (or UAC is denied).
        const wasRunning = currentStatus.running
        stopProxyWatchdog()
        currentStatus = { running: false, proxyAddr: null, proxyType: null, pid: null, warning: null, proxyReachable: true }
        notifyStatus('stopped')
        if (!resolved) {
          const msg = error?.message || (stderr ? String(stderr) : 'sing-box не запустился')
          logEvent('error', 'tun', 'sing-box exited before startup completed', { message: msg, stderr })
          finish({ success: false, error: msg })
        } else if (error || stderr) {
          logEvent(error ? 'error' : 'warn', 'tun', 'sing-box process exited', { error: error?.message, stderr })
        } else {
          logEvent('info', 'tun', 'sing-box process exited')
        }
        // sing-box died unexpectedly while we believed TUN was up. Restore proxy settings
        // so we don't leave the user with both no-VPN and no-original-proxy-config.
        if (wasRunning) {
          rollbackTunNetworkBaselineIfApplied('sing-box exited').catch(err =>
            logEvent('warn', 'tun', 'baseline auto-rollback after sing-box exit failed', err)
          )
        }
      }

      isProcessElevated().then((elevated) => {
        if (elevated) {
          execCb(cmd, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => onExit(error, stderr))
        } else {
          sudo.exec(cmd, { name: 'VPN Tunnel Enforcer' }, (error, _stdout, stderr) => onExit(error, String(stderr || '')))
        }
      }).catch((error) => onExit(error))

      // Poll for sing-box.exe presence.
      let attempts = 0
      const maxAttempts = 15 // 15 * 500ms = 7.5s
      const poller = setInterval(async () => {
        attempts++
        const running = await isSingboxRunning()
        if (running) {
          clearInterval(poller)
          currentStatus = { running: true, proxyAddr, proxyType, pid: null, warning, proxyReachable: true }
          startProxyWatchdog(proxyAddr)
          logEvent('info', 'tun', 'TUN started', { proxyAddr, proxyType, warning })
          notifyStatus('running')
          finish({ success: true, warning })
        } else if (attempts >= maxAttempts) {
          clearInterval(poller)
          if (!resolved) {
            logEvent('error', 'tun', 'sing-box did not start within timeout', { proxyAddr, proxyType })
            finish({
              success: false,
              error: 'sing-box не стартовал за 7 секунд. Проверьте UAC-подтверждение и журнал.'
            })
          }
        }
      }, 500)
    })
  },

  async stop(): Promise<{ success: boolean; error?: string }> {
    try {
      stopProxyWatchdog()
      await killOwnedRuntimeProcesses()

      currentStatus = { running: false, proxyAddr: null, proxyType: null, pid: null, warning: null, proxyReachable: true }
      logEvent('info', 'tun', 'TUN stopped')
      notifyStatus('stopped')

      // If we modified HKCU/HKLM proxy settings before starting the TUN, restore them now.
      // Without this, stopping the TUN leaves the user without VPN AND without the proxy
      // settings they had before — the exact "breaks global settings" failure mode.
      await rollbackTunNetworkBaselineIfApplied('TUN stopped').catch(err =>
        logEvent('warn', 'tun', 'baseline auto-rollback after stop failed', err)
      )

      return { success: true }
    } catch (err: any) {
      logEvent('error', 'tun', 'failed to stop TUN', err)
      return { success: false, error: err.message || String(err) }
    }
  },

  getStatus(): TunStatus {
    return { ...currentStatus }
  },

  onStatusChange(callback: (status: string) => void) {
    statusCallbacks.push(callback)
  }
}
