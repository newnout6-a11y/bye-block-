# Full test cycle for the sing-box TUN config.
# Runs WITHOUT UAC (relies on the Scheduled Task installed by install.ps1).
#
# Flow:
#   1. Stop any old sing-box
#   2. Copy diag/tunnel-config.json -> runtime (substituting the log path)
#   3. Trigger scheduled task (starts sing-box with admin privileges, silently)
#   4. Wait for tun0 interface to appear
#   5. Run an egress probe (curl https://api.ipify.org)
#   6. Stop sing-box
#   7. Print log summary (first 40 lines + key events)
#
# Usage:
#   .\diag\run-test.ps1                 # 6-second probe
#   .\diag\run-test.ps1 -DurationSec 10 # longer run
#   .\diag\run-test.ps1 -NoProbe        # skip HTTP probe (lighter log)
#   .\diag\run-test.ps1 -KeepRunning    # don't auto-stop at end

param(
  [int]$DurationSec = 6,
  [switch]$NoProbe,
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$taskName    = 'VPN-Diag-SingBox'
$runtimeDir  = Join-Path $env:APPDATA 'vpn-tunnel-enforcer\diag-runtime'
$configSrc   = Join-Path (Split-Path -Parent $PSCommandPath) 'tunnel-config.json'
$configDst   = Join-Path $runtimeDir 'sing-box.json'
$logPath     = Join-Path $runtimeDir 'sing-box.log'
$prevLogPath = Join-Path $runtimeDir 'sing-box.prev.log'
$probeOut    = Join-Path $runtimeDir 'probe.json'

function Info($msg)  { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Good($msg)  { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Bad($msg)   { Write-Host "[x] $msg" -ForegroundColor Red }

# ---------- 0. Sanity checks ----------
$taskExists = (schtasks.exe /query /tn $taskName 2>$null) -and ($LASTEXITCODE -eq 0)
if (-not $taskExists) {
  Bad "Scheduled Task '$taskName' not found. Run .\diag\install.ps1 first (as Administrator)."
  exit 1
}

# Abort if another VPN/TUN is already active — do not break a working tunnel.
# Heuristics:
#   (a) any interface whose name contains tun/wintun/wireguard/happ/singbox (case-insensitive)
#       AND is NOT our own diag TUN (172.19.0.x);
#   (b) port 10808 not listening (Happ not in Proxy mode).
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and $_.InterfaceDescription -match '(?i)wintun|tun|wireguard|openvpn|tap-windows|happ|singbox|hiddify'
}
$foreignTun = $false
foreach ($a in $adapters) {
  $ips = Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
  foreach ($ip in $ips) {
    if ($ip.IPAddress -and $ip.IPAddress -notlike '172.19.0.*') {
      Bad "Detected active foreign TUN adapter: $($a.Name) ($($ip.IPAddress))"
      Bad "Refusing to start — this would conflict with your existing VPN (e.g. Happ TUN mode)."
      Bad "Stop that VPN first, OR switch Happ to Proxy mode and retry."
      $foreignTun = $true
    }
  }
}
if ($foreignTun) { exit 2 }

$probe10808 = Test-NetConnection -ComputerName 127.0.0.1 -Port 10808 -WarningAction SilentlyContinue -InformationLevel Quiet
if (-not $probe10808) {
  Bad "127.0.0.1:10808 is not listening — Happ is not in Proxy mode (or not running)."
  Bad "Switch Happ to Proxy mode and retry."
  exit 3
}

# ---------- 1. Stop any old instance ----------
Info "Stopping any running sing-box..."
& schtasks.exe /end /tn $taskName 2>$null | Out-Null
Start-Sleep -Milliseconds 400
# If schtasks /end didn't kill it, use the elevated kill-switch task.
if (Get-Process sing-box -ErrorAction SilentlyContinue) {
  & schtasks.exe /run /tn 'VPN-Diag-SingBox-Kill' 2>$null | Out-Null
  Start-Sleep -Milliseconds 800
}
if (Get-Process sing-box -ErrorAction SilentlyContinue) {
  Bad "Could not stop existing sing-box. Run Task Manager -> sing-box.exe -> End task."
  exit 4
}

# ---------- 2. Deploy config ----------
Info "Deploying config..."
$raw = Get-Content $configSrc -Raw
$logForJson = $logPath -replace '\\','/'
$raw = $raw -replace '__LOG_PATH__', $logForJson
Set-Content -Path $configDst -Value $raw -Encoding UTF8

# Rotate log so we see only this run.
if (Test-Path $logPath) {
  Move-Item $logPath $prevLogPath -Force -ErrorAction SilentlyContinue
}

# ---------- 3. Trigger task ----------
Info "Starting sing-box via Scheduled Task..."
& schtasks.exe /run /tn $taskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  Bad "Failed to trigger '$taskName' (exit $LASTEXITCODE)"
  exit 1
}

# ---------- 4. Wait for startup ----------
$started = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 300
  if (Get-Process sing-box -ErrorAction SilentlyContinue) {
    $started = $true
    break
  }
}
if (-not $started) {
  Bad "sing-box didn't start in 6 seconds."
  if (Test-Path $logPath) { Get-Content $logPath -Tail 30 }
  exit 1
}
Good "sing-box started."

# Give the TUN interface a moment to come up.
Start-Sleep -Seconds 1

# ---------- 5. Egress probes (all through TUN) ----------
if (-not $NoProbe) {
  $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
  if (-not $curl) { $curl = 'C:\Windows\System32\curl.exe' }

  Info "Probing egress IP (curl api.ipify.org)..."
  try {
    $ipResp = & $curl -sS --max-time 6 'https://api.ipify.org?format=json' 2>&1
    Set-Content $probeOut $ipResp
    $ip = ($ipResp | ConvertFrom-Json -ErrorAction Stop).ip
    Good "Egress IP (via TUN): $ip"
  } catch {
    Warn "Egress probe failed: $ipResp"
  }

  Info "Probing DNS (nslookup google.com 1.1.1.1)..."
  $ns = & nslookup.exe google.com 1.1.1.1 2>&1
  $aLine = ($ns | Select-String 'Address:' | Select-Object -Skip 1 -First 3) -join '; '
  if ($aLine) { Good "DNS google.com -> $aLine" } else { Warn "DNS probe unclear:`n$ns" }

  Info "Probing proxied HTTPS (curl https://www.google.com)..."
  try {
    $hdrs = & $curl -sS -I --max-time 6 'https://www.google.com' 2>&1
    $status = ($hdrs | Select-Object -First 1)
    Good "www.google.com: $status"
  } catch {
    Warn "HTTPS probe failed: $hdrs"
  }
}

# ---------- 6. Wait + stop ----------
$remaining = $DurationSec - 1
if ($remaining -gt 0) {
  Info "Collecting logs for ${remaining}s..."
  Start-Sleep -Seconds $remaining
}

if (-not $KeepRunning) {
  Info "Stopping sing-box..."
  & schtasks.exe /end /tn $taskName 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
}

# ---------- 7. Summary ----------
if (-not (Test-Path $logPath)) {
  Bad "No log produced."
  exit 1
}

$log = Get-Content $logPath
$lineCount = $log.Count
Write-Host ""
Write-Host ("=" * 60) -ForegroundColor DarkGray
Write-Host "LOG SUMMARY ($lineCount lines)" -ForegroundColor White
Write-Host ("=" * 60) -ForegroundColor DarkGray

# First 15 lines — always shows startup path
Write-Host "`n[First 15 lines]" -ForegroundColor DarkCyan
$log | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }

# Any panics / errors
$errors = $log | Select-String -Pattern '(FATAL|ERROR|panic|failed)' -SimpleMatch:$false
if ($errors) {
  Write-Host "`n[Errors]" -ForegroundColor Red
  $errors | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
}

# DNS handling
Write-Host "`n[DNS routing]" -ForegroundColor DarkCyan
$dnsLines = $log | Select-String -Pattern 'hijack.?dns|dns.*hijack|ip_is_private.*dns|protocol=dns' -AllMatches
if ($dnsLines) {
  $dnsLines | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
} else {
  # Fallback: any line referencing :53
  $log | Select-String ':53' | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
}

# Route rule matches
Write-Host "`n[Route matches]" -ForegroundColor DarkCyan
$log | Select-String -Pattern 'match\[' | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }

# Outbound breakdown
Write-Host "`n[Outbound breakdown]" -ForegroundColor DarkCyan
$proxied = ($log | Select-String 'outbound/(socks|http)\[proxy-out\]').Count
$direct  = ($log | Select-String 'outbound/direct\[direct-out\]').Count
$blocked = ($log | Select-String 'outbound/block').Count
Write-Host "  proxy-out : $proxied"
Write-Host "  direct-out: $direct"
Write-Host "  block-out : $blocked"

Write-Host ""
Write-Host "Full log: $logPath"
if ($KeepRunning) { Warn "sing-box is still running. Stop with: schtasks /end /tn `"$taskName`"" }
