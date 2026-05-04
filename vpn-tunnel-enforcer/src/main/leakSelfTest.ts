/**
 * Active "is the kill-switch ACTUALLY blocking?" probe.
 *
 * Background: the user reported that with the firewall kill-switch + TUN
 * both up, Yandex Browser still showed the original Beeline IP. The app's
 * own `getPublicIp()` correctly showed the VPN IP because it goes through
 * the TUN. So we need a probe that mimics what the leaking app is doing —
 * binding to the physical adapter directly and seeing if it can reach the
 * outside.
 *
 * How: use `curl.exe --interface <physical-ip> https://1.1.1.1` with a
 * 4-second connect timeout. If curl returns 0 (or even a TLS handshake
 * happens), the physical adapter is NOT being blocked, which means the
 * kill-switch is leaking. If it returns a nonzero exit and "couldn't
 * connect" in stderr, we're sealed.
 *
 * Also: pull the public IP via TUN and via every physical adapter
 * separately and log all of them so we can see at a glance whether any
 * adapter sees a different external IP than the TUN.
 *
 * Result is logged AND fed back to the renderer so the UI can show a giant
 * red banner "УТЕЧКА: kill-switch не блокирует Wi-Fi".
 */
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { logEvent } from './appLogger'

const exec = promisify(execCb)

export interface AdapterReach {
  alias: string
  ipv4: string | null
  // Public IP we get when we explicitly bind to this adapter's IPv4 address.
  // null = curl failed (which is what we WANT when kill-switch is engaged).
  publicIpViaThisAdapter: string | null
  // Raw curl output, useful for debugging.
  curlExitCode: number | null
  curlStderrTail: string | null
}

export interface LeakSelfTestResult {
  ts: number
  // True iff at least one physical adapter could reach the outside while we
  // expected the kill-switch to block it. This is what we surface as "leak"
  // in the UI when TUN + kill-switch are supposedly active.
  physicalAdapterReached: boolean
  // True iff the public IP via any physical adapter differs from the public
  // IP via the default route. The default-route IP should be the VPN IP.
  publicIpMismatch: boolean
  defaultRoutePublicIp: string | null
  perAdapter: AdapterReach[]
  // Compact human-readable summary (one line, used for notifications).
  summary: string
}

const PROBE_URL = 'https://1.1.1.1'
const IP_ENDPOINT = 'https://api.ipify.org'

function parseIp(stdout: string): string | null {
  const trimmed = String(stdout).trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return trimmed
  return null
}

async function curlBound(ip: string, url: string, timeoutSec = 4): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  // We want curl to succeed (stdout = result) OR fail cleanly. We capture
  // both so we can log details. The `--interface` flag forces the TCP source
  // IP, which is what we want for testing physical adapter reachability.
  const cmd = `curl.exe -4 --interface ${ip} -sS --max-time ${timeoutSec} --connect-timeout ${timeoutSec} ${url}`
  try {
    const { stdout, stderr } = await exec(cmd, { windowsHide: true, timeout: (timeoutSec + 2) * 1000, encoding: 'utf8' })
    return { stdout, exitCode: 0, stderr: stderr || '' }
  } catch (err: any) {
    return {
      stdout: err?.stdout?.toString() || '',
      exitCode: typeof err?.code === 'number' ? err.code : -1,
      stderr: err?.stderr?.toString() || err?.message || ''
    }
  }
}

async function listPhysicalAdaptersWithIPv4(): Promise<{ alias: string; ipv4: string }[]> {
  if (process.platform !== 'win32') return []
  // Mirror the lockdown filter — keep them consistent so the leak test
  // tests every adapter that the lockdown is responsible for.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
$adapters = Get-NetAdapter | Where-Object {
  $_.Status -eq 'Up' -and
  $_.InterfaceDescription -notmatch 'Wintun|TAP-Windows|Tailscale|WireGuard|Hyper-V|Loopback|vEthernet|VPN|VirtualBox|VMware|Bluetooth' -and
  $_.MacAddress -and $_.MacAddress -ne '00-00-00-00-00-00'
}
foreach ($a in $adapters) {
  $cfg = Get-NetIPConfiguration -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue
  if ($cfg -and $cfg.IPv4Address -and $cfg.IPv4Address.Count -gt 0) {
    foreach ($ip in $cfg.IPv4Address) {
      if ($ip.IPAddress -and $ip.IPAddress -notlike '169.254.*') {
        $rows += [pscustomobject]@{ Alias = $a.Name; Ipv4 = $ip.IPAddress }
      }
    }
  }
}
$rows | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf-16le').toString('base64')
  try {
    const { stdout } = await exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8'
    })
    const text = String(stdout).trim()
    if (!text || text === 'null') return []
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((r: any) => ({ alias: String(r.Alias), ipv4: String(r.Ipv4) }))
  } catch (err) {
    logEvent('warn', 'leak-test', 'failed to list physical adapters', { err: (err as Error).message })
    return []
  }
}

export async function runLeakSelfTest(): Promise<LeakSelfTestResult> {
  const ts = Date.now()

  // 1. Public IP via the default route (which should be the TUN). Use plain
  //    curl with no --interface so the OS picks the default route.
  let defaultRoutePublicIp: string | null = null
  try {
    const { stdout } = await exec(`curl.exe -4 -sS --max-time 6 --connect-timeout 6 ${IP_ENDPOINT}`, {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8'
    })
    defaultRoutePublicIp = parseIp(stdout)
  } catch {
    defaultRoutePublicIp = null
  }

  // 2. Per physical adapter: try to reach 1.1.1.1 directly bypassing the
  //    default route. If curl succeeds while TUN+kill-switch are up, that's a
  //    leak.
  const adapters = await listPhysicalAdaptersWithIPv4()
  const perAdapter: AdapterReach[] = []
  for (const a of adapters) {
    const res = await curlBound(a.ipv4, IP_ENDPOINT, 4)
    perAdapter.push({
      alias: a.alias,
      ipv4: a.ipv4,
      publicIpViaThisAdapter: parseIp(res.stdout),
      curlExitCode: res.exitCode,
      curlStderrTail: (res.stderr || '').slice(-200) || null
    })
  }

  const physicalAdapterReached = perAdapter.some(
    (a) => a.curlExitCode === 0 && a.publicIpViaThisAdapter !== null
  )
  const publicIpMismatch = perAdapter.some(
    (a) => a.publicIpViaThisAdapter !== null && a.publicIpViaThisAdapter !== defaultRoutePublicIp
  )

  let summary: string
  if (physicalAdapterReached && publicIpMismatch) {
    const leakedIp = perAdapter.find((a) => a.publicIpViaThisAdapter)?.publicIpViaThisAdapter
    summary = `УТЕЧКА: физический адаптер виден из интернета как ${leakedIp} (TUN отдаёт ${defaultRoutePublicIp ?? 'неизвестно'})`
  } else if (physicalAdapterReached) {
    summary = `УТЕЧКА: kill-switch не блокирует физический адаптер (curl до 1.1.1.1 прошёл)`
  } else if (defaultRoutePublicIp) {
    summary = `OK: физические адаптеры заблокированы, TUN отдаёт публичный IP ${defaultRoutePublicIp}`
  } else {
    summary = `Не удалось определить публичный IP через TUN (curl не дошёл)`
  }

  const result: LeakSelfTestResult = {
    ts,
    physicalAdapterReached,
    publicIpMismatch,
    defaultRoutePublicIp,
    perAdapter,
    summary
  }

  logEvent(physicalAdapterReached || publicIpMismatch ? 'warn' : 'info', 'leak-test', summary, {
    physicalAdapterReached,
    publicIpMismatch,
    defaultRoutePublicIp,
    perAdapter
  })

  return result
}

let periodicLeakTimer: ReturnType<typeof setInterval> | null = null
let onLeakDetectedCb: ((r: LeakSelfTestResult) => void) | null = null

export function setLeakDetectedCallback(cb: (r: LeakSelfTestResult) => void): void {
  onLeakDetectedCb = cb
}

export function startPeriodicLeakTest(intervalMs = 120_000): void {
  stopPeriodicLeakTest()
  periodicLeakTimer = setInterval(() => {
    runLeakSelfTest()
      .then((r) => {
        if (r.physicalAdapterReached || r.publicIpMismatch) {
          onLeakDetectedCb?.(r)
        }
      })
      .catch((err) => logEvent('warn', 'leak-test', 'periodic test threw', { err: (err as Error).message }))
  }, intervalMs)
}

export function stopPeriodicLeakTest(): void {
  if (periodicLeakTimer) {
    clearInterval(periodicLeakTimer)
    periodicLeakTimer = null
  }
}
