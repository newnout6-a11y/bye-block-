import { app } from 'electron'
import { mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { execElevated } from './admin'
import { logEvent } from './appLogger'

const exec = promisify(execCb)

// Rule-name prefix for every firewall rule we add. We rely on this prefix to
// find and remove our rules during rollback, even if our manifest is missing
// (e.g. user wiped %APPDATA% manually after a crash).
const RULE_PREFIX = 'VPNTE-killswitch'

// Outbound traffic that must keep flowing while the kill-switch is engaged so
// the box stays usable but can never reach the public internet by accident.
// Localhost — sing-box ↔ Happ proxy on 127.0.0.1 lives here.
// RFC1918 + link-local + multicast + IPv6 ULA — printers, NAS, mDNS, router admin UI.
const LAN_BYPASS_CIDRS = [
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

export interface FirewallKillSwitchResult {
  success: boolean
  message: string
  details?: string
}

interface FirewallManifest {
  createdAt: number
  ruleNames: string[]
  singboxExePath: string | null
}

function backupDir() {
  return join(app.getPath('userData'), 'firewall-killswitch')
}

function manifestPath() {
  return join(backupDir(), 'manifest.json')
}

async function readManifest(): Promise<FirewallManifest | null> {
  try {
    const raw = await readFile(manifestPath(), 'utf-8')
    return JSON.parse(raw) as FirewallManifest
  } catch {
    return null
  }
}

async function writeManifest(m: FirewallManifest): Promise<void> {
  await mkdir(backupDir(), { recursive: true })
  await writeFile(manifestPath(), JSON.stringify(m, null, 2), 'utf-8')
}

async function clearManifest(): Promise<void> {
  try {
    await unlink(manifestPath())
  } catch {
    // already gone
  }
}

function encodedPowerShell(script: string) {
  const prelude =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();' +
    '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new();' +
    '$ErrorActionPreference="Stop";'
  return Buffer.from(prelude + script, 'utf16le').toString('base64')
}

async function ps(script: string, elevated = false, timeout = 30000) {
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPowerShell(script)}`
  if (elevated) {
    return execElevated(command, { timeout, maxBuffer: 1024 * 1024 * 4 })
  }
  return exec(command, {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
    encoding: 'utf8'
  })
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function isKillSwitchActive(): Promise<boolean> {
  return (await readManifest()) !== null
}

/**
 * Install Windows Firewall rules so that, when sing-box dies or fails to start,
 * outbound traffic on every physical adapter is blocked. sing-box itself and
 * private-LAN ranges are explicitly allowed so the user can still reach printers,
 * NAS, and the local proxy.
 *
 * Order of installation (each rule is independent — Windows Firewall uses a
 * "block wins unless a more specific allow exists" model and we rely on the
 * Program-based allow being more specific than the Interface-based block):
 *  1. Allow program=sing-box.exe outbound (so sing-box can talk to a remote proxy
 *     across the internet — for local 127.0.0.1 proxies this is a no-op since
 *     loopback isn't bound to a physical adapter).
 *  2. Allow LAN CIDRs outbound (so the firewall doesn't break the user's network).
 *  3. Block outbound on every physical adapter (every adapter that isn't Wintun /
 *     loopback / VM / virtual / Bluetooth).
 *
 * Returns success even if some rules failed — we record what we managed to
 * install in the manifest so the rollback path knows what to remove. Returns
 * { success: false } only if we couldn't install ANY rule (so the caller knows
 * the kill-switch is NOT engaged).
 */
export async function enableKillSwitch(opts: {
  singboxExePath: string
}): Promise<FirewallKillSwitchResult> {
  if (process.platform !== 'win32') {
    return { success: true, message: 'Firewall kill-switch недоступен (не Windows)' }
  }

  const ruleNames: string[] = []
  const singboxAllow = `${RULE_PREFIX}-allow-singbox`
  const lanAllow = `${RULE_PREFIX}-allow-lan`
  const physicalBlock = `${RULE_PREFIX}-block-physical`

  // Build one giant PowerShell script so installation is atomic from the user's
  // POV (one UAC prompt, not three). Also clears any stale rules from a
  // previous run before installing fresh ones.
  const lanRemoteAddresses = LAN_BYPASS_CIDRS.map((c) => `'${c}'`).join(',')
  const script = `
# Clean up stale rules from a previous run (idempotent).
Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

$rules = @()

# 1. Allow sing-box.exe outbound on any profile/interface.
try {
  New-NetFirewallRule \`
    -DisplayName ${psSingleQuote(singboxAllow)} \`
    -Description 'VPN Tunnel Enforcer kill-switch: allow sing-box.exe outbound (must be more specific than the block rule below).' \`
    -Direction Outbound -Action Allow \`
    -Program ${psSingleQuote(opts.singboxExePath)} \`
    -Profile Any -Enabled True | Out-Null
  $rules += ${psSingleQuote(singboxAllow)}
} catch { Write-Host "WARN allow-singbox: $_" }

# 2. Allow LAN ranges outbound (printers, NAS, router, mDNS, IPv6 ULA).
try {
  New-NetFirewallRule \`
    -DisplayName ${psSingleQuote(lanAllow)} \`
    -Description 'VPN Tunnel Enforcer kill-switch: allow private-LAN destinations so the firewall does not break the home network.' \`
    -Direction Outbound -Action Allow \`
    -RemoteAddress ${lanRemoteAddresses} \`
    -Profile Any -Enabled True | Out-Null
  $rules += ${psSingleQuote(lanAllow)}
} catch { Write-Host "WARN allow-lan: $_" }

# 3. Block outbound on every physical adapter that isn't our Wintun TUN.
#    InterfaceType Wired/Wireless covers Ethernet + Wi-Fi.
#    The TUN adapter itself reports as 'RemoteAccess' or has a Wintun interface
#    description, so it is not in the Wired/Wireless set and stays unblocked.
try {
  New-NetFirewallRule \`
    -DisplayName ${psSingleQuote(physicalBlock)} \`
    -Description 'VPN Tunnel Enforcer kill-switch: block all outbound on physical adapters. Removed when TUN stops gracefully.' \`
    -Direction Outbound -Action Block \`
    -InterfaceType Wired,Wireless \`
    -Profile Any -Enabled True | Out-Null
  $rules += ${psSingleQuote(physicalBlock)}
} catch { Write-Host "WARN block-physical: $_" }

$rules -join ','
`

  let installedRules: string[] = []
  try {
    const { stdout } = await ps(script, true, 60000)
    installedRules = String(stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('WARN'))
      .flatMap((line) => line.split(','))
      .map((name) => name.trim())
      .filter((name) => name.startsWith(RULE_PREFIX))
  } catch (err: any) {
    logEvent('error', 'firewall-killswitch', 'failed to install firewall rules', err)
    return {
      success: false,
      message: 'Не удалось установить правила Windows Firewall',
      details: err?.stderr || err?.message || String(err)
    }
  }

  ruleNames.push(...installedRules)
  if (ruleNames.length === 0) {
    return {
      success: false,
      message: 'Windows Firewall не принял ни одного правила kill-switch'
    }
  }

  await writeManifest({
    createdAt: Date.now(),
    ruleNames,
    singboxExePath: opts.singboxExePath
  })

  logEvent('info', 'firewall-killswitch', 'kill-switch engaged', { ruleNames })
  return {
    success: true,
    message: `Firewall kill-switch активирован (правил: ${ruleNames.length})`
  }
}

async function removeAllOurRules(): Promise<void> {
  // Wildcard-match by display name, so we still clean up if the manifest is
  // gone or out-of-sync.
  await ps(
    `Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue | ` +
      `Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    true,
    30000
  )
}

export async function disableKillSwitch(reason: string): Promise<FirewallKillSwitchResult> {
  if (process.platform !== 'win32') {
    return { success: true, message: 'Firewall kill-switch недоступен (не Windows)' }
  }

  try {
    await removeAllOurRules()
  } catch (err: any) {
    logEvent('warn', 'firewall-killswitch', 'failed to remove firewall rules', err)
    // Still clear manifest so the app doesn't get stuck thinking kill-switch is
    // active. The rules will still be removed by the next successful disable
    // (Get-NetFirewallRule is idempotent).
    await clearManifest()
    return {
      success: false,
      message: 'Часть правил kill-switch не снялась — проверьте Windows Firewall вручную',
      details: err?.stderr || err?.message || String(err)
    }
  }

  await clearManifest()
  logEvent('info', 'firewall-killswitch', `kill-switch disengaged: ${reason}`)
  return { success: true, message: 'Firewall kill-switch снят' }
}

/**
 * Idempotent disable. Safe to call multiple times. No-op if kill-switch is not
 * currently active.
 */
export async function disableKillSwitchIfActive(
  reason: string
): Promise<FirewallKillSwitchResult & { skipped?: boolean }> {
  if (process.platform !== 'win32') {
    return { success: true, skipped: true, message: 'Firewall kill-switch недоступен (не Windows)' }
  }
  if (!(await isKillSwitchActive())) {
    return { success: true, skipped: true, message: 'Kill-switch уже снят' }
  }
  logEvent('info', 'firewall-killswitch', `auto-disable kill-switch: ${reason}`)
  return disableKillSwitch(reason)
}

async function probeFirewallForOurRules(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    const { stdout } = await ps(
      `(Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue | Measure-Object).Count`,
      false,
      15000
    )
    const count = parseInt(String(stdout || '0').trim(), 10)
    return Number.isFinite(count) && count > 0
  } catch {
    return false
  }
}

/**
 * Crash recovery: if a previous session left kill-switch rules behind but
 * sing-box is no longer running, the user is locked out of the internet for
 * no good reason. Snip the rules on next startup.
 *
 * We check BOTH our manifest AND a direct probe of Windows Firewall, because
 * the app could have crashed between rule installation and manifest write,
 * leaving rules in place with no manifest to recover from.
 */
export async function recoverStaleKillSwitch(isSingboxRunning: () => Promise<boolean>): Promise<void> {
  if (process.platform !== 'win32') return
  const manifestSaysActive = await isKillSwitchActive()
  const firewallSaysActive = manifestSaysActive ? true : await probeFirewallForOurRules()
  if (!manifestSaysActive && !firewallSaysActive) return
  if (await isSingboxRunning()) {
    logEvent(
      'info',
      'firewall-killswitch',
      'kill-switch rules found and sing-box is still running — keeping kill-switch',
      { manifestSaysActive, firewallSaysActive }
    )
    return
  }
  logEvent(
    'warn',
    'firewall-killswitch',
    'stale kill-switch detected on startup (sing-box not running) — clearing',
    { manifestSaysActive, firewallSaysActive }
  )
  await disableKillSwitch('crash recovery on startup').catch((err) =>
    logEvent('warn', 'firewall-killswitch', 'crash-recovery disable failed', err)
  )
}
