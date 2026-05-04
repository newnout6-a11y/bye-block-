/**
 * Capture every piece of network state we'd want to see when debugging "the
 * app says VPN is up but my browser still shows real IP". This is the
 * single thing the user can hand to support — it captures EVERYTHING and is
 * cheap to run frequently.
 *
 * Capture triggers:
 *   - app start (one-shot)
 *   - immediately before TUN start (so we can compare to "after")
 *   - immediately after TUN start
 *   - every 60s while TUN is running (rolling)
 *   - manually when the user clicks "Send logs"
 *
 * Output: %APPDATA%/<app>/snapshots/snapshot-<ISO ts>-<reason>.json
 *
 * The diagnostics ZIP picks up the `snapshots/` directory whole.
 *
 * Each snapshot is one JSON file. Failures inside the snapshot don't abort
 * the whole snapshot — every section is independently captured with try/catch
 * and any failure is recorded as `{ error: ... }` for that section.
 */
import { app } from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { networkInterfaces, hostname, release, type as osType, totalmem, freemem } from 'os'
import { join } from 'path'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { logEvent } from './appLogger'

const exec = promisify(execCb)

const SNAPSHOTS_DIRNAME = 'snapshots'
const MAX_SNAPSHOTS_RETAINED = 60

export type SnapshotReason =
  | 'app-start'
  | 'tun-pre-start'
  | 'tun-post-start'
  | 'tun-start-failed'
  | 'tun-post-stop'
  | 'periodic'
  | 'manual'
  | 'leak-detected'

export interface SystemSnapshot {
  reason: SnapshotReason
  ts: string
  hostname: string
  osType: string
  osRelease: string
  appVersion: string
  isElevated: boolean | null
  memMB: { total: number; free: number }
  // OS-level networking dumps (PowerShell). Each is the raw stdout (or
  // {error: ...} on failure). Kept as text — the user/support can grep.
  netAdapters?: string | { error: string }
  netIPConfiguration?: string | { error: string }
  netRouteIPv4?: string | { error: string }
  netRouteIPv6?: string | { error: string }
  dnsClientServerAddresses?: string | { error: string }
  dnsClientNrptRules?: string | { error: string }
  dnsClientCache?: string | { error: string }
  netAdapterBindingsIPv6?: string | { error: string }
  firewallVpnteRules?: string | { error: string }
  firewallProfile?: string | { error: string }
  netshWinhttp?: string | { error: string }
  // Inferred app state.
  jsNetworkInterfaces: ReturnType<typeof networkInterfaces>
  manifests: {
    baseline: object | null
    killSwitch: object | null
    adapterLockdown: object | null
  }
  // Process owner of likely upstream proxy ports (10808 SOCKS, 10809 HTTP).
  proxyOwnersPort10808?: string | { error: string }
  proxyOwnersPort10809?: string | { error: string }
  // Active sing-box state.
  singboxRunning?: string | { error: string }
}

function snapshotsDir(): string {
  return join(app.getPath('userData'), SNAPSHOTS_DIRNAME)
}

async function ensureSnapshotsDir(): Promise<string> {
  const dir = snapshotsDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
}

async function tryPS(script: string, timeoutMs = 15000): Promise<string | { error: string }> {
  if (process.platform !== 'win32') return { error: 'platform is not Windows' }
  try {
    // Force UTF-8 output regardless of system locale. On Russian Windows the
    // default Console.OutputEncoding is CP866 (OEM cyrillic), which gives us
    // mojibake for adapter names like "Беспроводная сеть" and breaks downstream
    // commands that try to use those names. The prefix below is mandatory for
    // any PS we run that might emit non-ASCII text.
    // Also suppress the "preparing modules for first use" progress XML which
    // otherwise contaminates stdout when stdout is redirected and breaks
    // ConvertTo-Json output / makes exec() think there's an error.
    const utf8Prefix =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';"
    const encoded = Buffer.from(utf8Prefix + script, 'utf-16le').toString('base64')
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
    const { stdout } = await exec(cmd, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    return String(stdout).trim()
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}

async function tryReadJsonFile(path: string): Promise<object | null> {
  try {
    if (!existsSync(path)) return null
    const { readFile } = await import('fs/promises')
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch (err) {
    logEvent('warn', 'snapshot', 'manifest read failed', { path, err: (err as Error).message })
    return null
  }
}

/**
 * The Windows-y bits. We pull EVERYTHING here so support has zero questions
 * to ask back. Each PS command is independent — one failure (e.g. missing
 * cmdlet on an old Windows version) never blocks the rest.
 */
async function capturePlatformDumps(): Promise<Partial<SystemSnapshot>> {
  if (process.platform !== 'win32') {
    return {
      netAdapters: { error: 'not Windows' },
      netIPConfiguration: { error: 'not Windows' }
    }
  }

  // We run them in parallel. Each tryPS catches its own errors so we don't
  // need a try/catch around Promise.all.
  const [
    netAdapters,
    netIPConfiguration,
    netRouteIPv4,
    netRouteIPv6,
    dnsClientServerAddresses,
    dnsClientNrptRules,
    dnsClientCache,
    netAdapterBindingsIPv6,
    firewallVpnteRules,
    firewallProfile,
    netshWinhttp,
    proxyOwnersPort10808,
    proxyOwnersPort10809,
    singboxRunning
  ] = await Promise.all([
    tryPS('Get-NetAdapter | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('Get-NetIPConfiguration -All -Detailed | Out-String -Width 4096'),
    tryPS('Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Sort-Object InterfaceMetric | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('Get-NetRoute -AddressFamily IPv6 -ErrorAction SilentlyContinue | Sort-Object InterfaceMetric | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('Get-DnsClientServerAddress | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Format-List | Out-String -Width 4096'),
    tryPS('Get-DnsClientCache -ErrorAction SilentlyContinue | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('Get-NetAdapterBinding -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS("Get-NetFirewallRule -DisplayName 'VPNTE-*' -ErrorAction SilentlyContinue | Format-List Name, DisplayName, Enabled, Direction, Action, Profile, EdgeTraversalPolicy, InterfaceType, Description | Out-String -Width 4096"),
    tryPS('Get-NetFirewallProfile | Format-Table -AutoSize -Wrap | Out-String -Width 4096'),
    tryPS('netsh winhttp show proxy 2>&1 | Out-String'),
    tryPS("Get-NetTCPConnection -State Listen -LocalPort 10808 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{Port=$_.LocalPort; LocalAddress=$_.LocalAddress; Pid=$_.OwningProcess; Process=$p.ProcessName; Path=$p.Path} } | Format-List | Out-String"),
    tryPS("Get-NetTCPConnection -State Listen -LocalPort 10809 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{Port=$_.LocalPort; LocalAddress=$_.LocalAddress; Pid=$_.OwningProcess; Process=$p.ProcessName; Path=$p.Path} } | Format-List | Out-String"),
    // ProgressPreference=SilentlyContinue suppresses the "Preparing modules
    // for first use" progress XML that otherwise contaminates stdout when
    // stdout is redirected. -ErrorAction SilentlyContinue means we don't
    // throw if the process isn't running.
    tryPS("$ProgressPreference='SilentlyContinue';Get-Process -Name 'vpnte-sing-box','sing-box' -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, Path, StartTime -AutoSize | Out-String -Width 4096")
  ])

  return {
    netAdapters,
    netIPConfiguration,
    netRouteIPv4,
    netRouteIPv6,
    dnsClientServerAddresses,
    dnsClientNrptRules,
    dnsClientCache,
    netAdapterBindingsIPv6,
    firewallVpnteRules,
    firewallProfile,
    netshWinhttp,
    proxyOwnersPort10808,
    proxyOwnersPort10809,
    singboxRunning
  }
}

async function isElevated(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null
  const result = await tryPS('([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', 5000)
  if (typeof result === 'string') return /true/i.test(result.trim())
  return null
}

/**
 * Take one snapshot. Always succeeds (errors are recorded as fields).
 * Returns the absolute path of the file written, or null if writing failed.
 */
export async function captureSnapshot(reason: SnapshotReason): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `snapshot-${ts}-${reason}.json`

  const userData = app.getPath('userData')
  const [platform, elevated, baseline, killSwitch, adapterLockdown] = await Promise.all([
    capturePlatformDumps(),
    isElevated(),
    tryReadJsonFile(join(userData, 'latest-tun-network-baseline.json')),
    tryReadJsonFile(join(userData, 'latest-firewall-killswitch.json')),
    tryReadJsonFile(join(userData, 'latest-physical-adapter-lockdown.json'))
  ])

  const snap: SystemSnapshot = {
    reason,
    ts: new Date().toISOString(),
    hostname: hostname(),
    osType: osType(),
    osRelease: release(),
    appVersion: app.getVersion(),
    isElevated: elevated,
    memMB: {
      total: Math.round(totalmem() / 1024 / 1024),
      free: Math.round(freemem() / 1024 / 1024)
    },
    jsNetworkInterfaces: networkInterfaces(),
    manifests: {
      baseline,
      killSwitch,
      adapterLockdown
    },
    ...platform
  }

  try {
    const dir = await ensureSnapshotsDir()
    const path = join(dir, fileName)
    await writeFile(path, JSON.stringify(snap, null, 2), 'utf-8')
    await pruneOldSnapshots()
    logEvent('debug', 'snapshot', 'wrote snapshot', { reason, path })
    return path
  } catch (err) {
    logEvent('warn', 'snapshot', 'failed to write snapshot', { reason, err: (err as Error).message })
    return null
  }
}

/**
 * Keep the snapshots directory bounded. We retain the latest
 * MAX_SNAPSHOTS_RETAINED files; older ones are deleted. This is critical
 * because the periodic snapshot runs every 60s and would otherwise eat disk.
 */
async function pruneOldSnapshots(): Promise<void> {
  try {
    const dir = snapshotsDir()
    if (!existsSync(dir)) return
    const names = await readdir(dir)
    if (names.length <= MAX_SNAPSHOTS_RETAINED) return
    const withMtimes = await Promise.all(
      names.map(async (n) => {
        try {
          const s = await stat(join(dir, n))
          return { n, mtime: s.mtimeMs }
        } catch {
          return { n, mtime: 0 }
        }
      })
    )
    withMtimes.sort((a, b) => b.mtime - a.mtime)
    const stale = withMtimes.slice(MAX_SNAPSHOTS_RETAINED)
    await Promise.all(
      stale.map((entry) =>
        unlink(join(dir, entry.n)).catch(() => undefined)
      )
    )
  } catch (err) {
    logEvent('debug', 'snapshot', 'prune failed', { err: (err as Error).message })
  }
}

let periodicTimer: ReturnType<typeof setInterval> | null = null

export function startPeriodicSnapshots(intervalMs = 60_000): void {
  stopPeriodicSnapshots()
  periodicTimer = setInterval(() => {
    captureSnapshot('periodic').catch(() => undefined)
  }, intervalMs)
}

export function stopPeriodicSnapshots(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}

export function getSnapshotsDir(): string {
  return snapshotsDir()
}
