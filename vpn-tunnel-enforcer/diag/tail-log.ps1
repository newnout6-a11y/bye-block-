# Show tail of the current diag sing-box log.
# Usage: .\diag\tail-log.ps1 [-Lines 50] [-Follow]

param(
  [int]$Lines = 50,
  [switch]$Follow
)

$logPath = Join-Path $env:APPDATA 'vpn-tunnel-enforcer\diag-runtime\sing-box.log'
if (-not (Test-Path $logPath)) {
  Write-Host "No log yet at $logPath. Run .\diag\run-test.ps1 first." -ForegroundColor Yellow
  exit 1
}

if ($Follow) {
  Get-Content $logPath -Tail $Lines -Wait
} else {
  Get-Content $logPath -Tail $Lines
}
