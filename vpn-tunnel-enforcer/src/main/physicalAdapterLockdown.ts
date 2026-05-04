/**
 * Hard lockdown of the physical adapter while TUN is up.
 *
 * The motivating bug: even with `auto_route: true` + `strict_route: true` +
 * the firewall kill-switch, real users are seeing leaks where the browser
 * shows the original Beeline IP and DNS resolves through the ISP. Possible
 * causes we observed in the wild:
 *
 *   1. Browser-side DNS-over-HTTPS that bypasses NRPT + uses the system
 *      default route (which still has a small fallback scope to the physical
 *      adapter when the OS is "uncertain" about the TUN's reachability).
 *   2. IPv6 traffic getting routed through the physical adapter because the
 *      OS picked the lower-metric IPv6 default route from the physical NIC
 *      over our TUN's split-default IPv6 routes.
 *   3. The Windows DHCP-pushed DNS servers staying configured on the
 *      physical adapter and being queried for `getaddrinfo()` calls that
 *      happened to bind to that interface.
 *
 * This module's nuke-from-orbit response: on TUN start, disable IPv6 on every
 * physical adapter and force their IPv4 DNS to point to the TUN's resolver.
 * On TUN stop / rollback, restore exactly what was there before.
 *
 * Wintun adapters are excluded by name and InterfaceType. Tailscale and other
 * "RemoteAccess" adapters are also excluded — we only touch real Wi-Fi /
 * Ethernet.
 *
 * Persistence: the rollback manifest lives in `userData/latest-physical-adapter-lockdown.json`.
 * If the app crashes / is killed while lockdown is active, the next startup
 * (in `index.ts`) reads the manifest and rolls back, just like baseline +
 * kill-switch.
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { execElevated } from './admin'
import { logEvent } from './appLogger'

const MANIFEST_BASENAME = 'latest-physical-adapter-lockdown.json'

interface AdapterSnapshot {
  // Stable adapter identifier on Windows.
  ifIndex: number
  alias: string
  // What we found before we touched it. We restore exactly these.
  ipv6Enabled: boolean
  ipv4DnsServers: string[]
  // What we set it to (or null if we left it alone for that field).
  forcedDnsTo: string[] | null
  forcedIpv6Off: boolean
}

interface LockdownManifest {
  appliedAt: number
  tunDnsIpv4: string
  adapters: AdapterSnapshot[]
}

function manifestPath(): string {
  return join(app.getPath('userData'), MANIFEST_BASENAME)
}

async function readManifest(): Promise<LockdownManifest | null> {
  try {
    if (!existsSync(manifestPath())) return null
    const raw = await readFile(manifestPath(), 'utf-8')
    return JSON.parse(raw) as LockdownManifest
  } catch {
    return null
  }
}

async function writeManifest(m: LockdownManifest): Promise<void> {
  await writeFile(manifestPath(), JSON.stringify(m, null, 2), 'utf-8')
}

async function deleteManifest(): Promise<void> {
  try {
    if (existsSync(manifestPath())) await unlink(manifestPath())
  } catch (err) {
    logEvent('warn', 'phys-lockdown', 'manifest delete failed', err)
  }
}

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

async function runPS(script: string, timeoutMs = 30000): Promise<string> {
  const encoded = Buffer.from(script, 'utf-16le').toString('base64')
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  const { stdout } = await execElevated(cmd, { timeout: timeoutMs })
  return stdout.toString()
}

/**
 * Snapshot every "real" physical adapter (Ethernet / Wi-Fi) that is currently
 * up. We INTENTIONALLY exclude:
 *   - Wintun (our TUN — VPNTE-TUN)
 *   - Tailscale (also Wintun-based)
 *   - WireGuard / OpenVPN tap drivers
 *   - Loopback
 *   - Hyper-V virtual switches (vEthernet)
 *
 * The shape we get back from PowerShell:
 *   [{ifIndex, alias, ipv6Enabled, ipv4DnsServers}]
 *
 * Note: PS arrays of single objects deserialize as the object itself, so we
 * normalize that on the JS side.
 */
async function snapshotPhysicalAdapters(): Promise<AdapterSnapshot[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
$adapters = Get-NetAdapter |
  Where-Object {
    $_.Status -eq 'Up' -and
    $_.HardwareInterface -eq $true -and
    $_.InterfaceDescription -notmatch 'Wintun|TAP-Windows|Tailscale|WireGuard|Hyper-V|Loopback|vEthernet'
  }
foreach ($a in $adapters) {
  $bind6 = Get-NetAdapterBinding -InterfaceAlias $a.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
  $dns4 = (Get-DnsClientServerAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
  if ($null -eq $dns4) { $dns4 = @() }
  $rows += [pscustomobject]@{
    ifIndex      = [int]$a.ifIndex
    alias        = [string]$a.Name
    ipv6Enabled  = [bool]($bind6 -and $bind6.Enabled)
    ipv4Dns      = @($dns4)
  }
}
$rows | ConvertTo-Json -Compress -Depth 4
`
  const stdout = await runPS(script, 20000)
  const text = stdout.trim()
  if (!text || text === 'null') return []
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    logEvent('warn', 'phys-lockdown', 'snapshot parse failed', { err: (err as Error).message, raw: text.slice(0, 200) })
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map((row: any) => ({
    ifIndex: Number(row.ifIndex),
    alias: String(row.alias),
    ipv6Enabled: Boolean(row.ipv6Enabled),
    ipv4DnsServers: Array.isArray(row.ipv4Dns) ? row.ipv4Dns.map((x: any) => String(x)) : [],
    forcedDnsTo: null,
    forcedIpv6Off: false
  }))
}

/**
 * Apply the lockdown: disable IPv6 on each physical adapter and force its
 * IPv4 DNS to the TUN's resolver. Each step is logged separately so a partial
 * failure is recoverable.
 */
export async function applyPhysicalAdapterLockdown(tunDnsIpv4: string): Promise<{ applied: boolean; adapters: number; warnings: string[] }> {
  if (process.platform !== 'win32') {
    return { applied: false, adapters: 0, warnings: ['platform is not Windows'] }
  }
  const existing = await readManifest()
  if (existing) {
    logEvent('info', 'phys-lockdown', 'lockdown already applied — skipping (idempotent)', {
      adapters: existing.adapters.length
    })
    return { applied: true, adapters: existing.adapters.length, warnings: [] }
  }

  const adapters = await snapshotPhysicalAdapters()
  if (adapters.length === 0) {
    logEvent('warn', 'phys-lockdown', 'no physical adapters to lock down — nothing to do')
    return { applied: false, adapters: 0, warnings: ['no physical adapters found'] }
  }

  const warnings: string[] = []
  for (const a of adapters) {
    try {
      const script = `
$ErrorActionPreference = 'Stop'
try { Disable-NetAdapterBinding -InterfaceAlias ${psSingleQuote(a.alias)} -ComponentID ms_tcpip6 -ErrorAction Stop; Write-Host 'ipv6:off' } catch { Write-Host "ipv6:err: $_" }
try { Set-DnsClientServerAddress -InterfaceAlias ${psSingleQuote(a.alias)} -ServerAddresses ${psSingleQuote(tunDnsIpv4)} -ErrorAction Stop; Write-Host 'dns:set' } catch { Write-Host "dns:err: $_" }
try { Clear-DnsClientCache -ErrorAction Stop; Write-Host 'cache:clear' } catch {}
`
      const out = await runPS(script, 15000)
      const ipv6Off = /ipv6:off/.test(out)
      const dnsSet = /dns:set/.test(out)
      a.forcedIpv6Off = ipv6Off
      a.forcedDnsTo = dnsSet ? [tunDnsIpv4] : null
      if (!ipv6Off || !dnsSet) {
        warnings.push(`${a.alias}: ${out.trim().split('\n').filter((l) => /err/.test(l)).join('; ') || 'partial'}`)
      }
      logEvent('info', 'phys-lockdown', `locked down ${a.alias}`, { ipv6Off, dnsSet })
    } catch (err: any) {
      warnings.push(`${a.alias}: ${err?.message ?? String(err)}`)
      logEvent('warn', 'phys-lockdown', `lockdown failed for ${a.alias}`, err)
    }
  }

  const manifest: LockdownManifest = {
    appliedAt: Date.now(),
    tunDnsIpv4,
    adapters
  }
  await writeManifest(manifest)
  return { applied: true, adapters: adapters.length, warnings }
}

/**
 * Roll back exactly what we changed. We re-enable IPv6 only if we forced it
 * off (so we don't accidentally turn ON IPv6 on an adapter that the user had
 * deliberately disabled). DNS is restored to the exact list we snapshotted —
 * empty list means "back to DHCP", which is what `Set-DnsClientServerAddress
 * -ResetServerAddresses` does.
 */
export async function rollbackPhysicalAdapterLockdownIfApplied(reason: string): Promise<{ rolledBack: boolean }> {
  if (process.platform !== 'win32') return { rolledBack: false }
  const m = await readManifest()
  if (!m) return { rolledBack: false }

  for (const a of m.adapters) {
    try {
      const dnsRestoreLine = a.ipv4DnsServers.length === 0
        ? `try { Set-DnsClientServerAddress -InterfaceAlias ${psSingleQuote(a.alias)} -ResetServerAddresses -ErrorAction Stop; Write-Host 'dns:reset' } catch { Write-Host "dns:err: $_" }`
        : `try { Set-DnsClientServerAddress -InterfaceAlias ${psSingleQuote(a.alias)} -ServerAddresses ${a.ipv4DnsServers.map(psSingleQuote).join(',')} -ErrorAction Stop; Write-Host 'dns:restore' } catch { Write-Host "dns:err: $_" }`
      const ipv6RestoreLine = a.forcedIpv6Off && a.ipv6Enabled
        ? `try { Enable-NetAdapterBinding -InterfaceAlias ${psSingleQuote(a.alias)} -ComponentID ms_tcpip6 -ErrorAction Stop; Write-Host 'ipv6:on' } catch { Write-Host "ipv6:err: $_" }`
        : `Write-Host 'ipv6:noop'`
      const script = `
$ErrorActionPreference = 'Continue'
${ipv6RestoreLine}
${dnsRestoreLine}
try { Clear-DnsClientCache -ErrorAction Stop } catch {}
`
      const out = await runPS(script, 15000)
      logEvent('info', 'phys-lockdown', `rolled back ${a.alias}`, { reason, out: out.trim() })
    } catch (err) {
      logEvent('warn', 'phys-lockdown', `rollback failed for ${a.alias}`, err)
    }
  }

  await deleteManifest()
  return { rolledBack: true }
}

export async function isPhysicalAdapterLockdownApplied(): Promise<boolean> {
  return (await readManifest()) !== null
}
