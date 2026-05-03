# Fast diagnostic summary of the last sing-box run.
# Usage: .\diag\summary.ps1

$logPath = Join-Path $env:APPDATA 'vpn-tunnel-enforcer\diag-runtime\sing-box.log'
if (-not (Test-Path $logPath)) {
  Write-Host "No log at $logPath" -ForegroundColor Yellow
  exit 1
}

$log   = Get-Content $logPath
$count = $log.Count

Write-Host ""
Write-Host "File    : $logPath"
Write-Host "Lines   : $count"
Write-Host ""

# Startup line
$start = $log | Select-String 'sing-box started' | Select-Object -First 1
if ($start) { Write-Host "[OK] $start" -ForegroundColor Green } else { Write-Host "[!!] sing-box start marker missing" -ForegroundColor Red }

# Errors
$errs = $log | Select-String -Pattern '(FATAL|ERROR|panic|failed|refused|timeout)'
Write-Host ""
Write-Host "Errors/warnings: $($errs.Count)"
if ($errs) { $errs | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red } }

# DNS behaviour
Write-Host ""
Write-Host "DNS events:"
$log | Select-String -Pattern 'hijack|:53|dns' -CaseSensitive:$false |
  Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }

# Outbound share
$proxied = ($log | Select-String 'outbound/(socks|http)\[proxy-out\]').Count
$direct  = ($log | Select-String 'outbound/direct\[direct-out\]').Count
Write-Host ""
Write-Host "Outbound totals:"
Write-Host "  proxy-out : $proxied"
Write-Host "  direct-out: $direct"

# Rule hits
$ruleHits = @{}
$log | Select-String -Pattern 'match\[(\d+)\]' | ForEach-Object {
  $idx = $_.Matches[0].Groups[1].Value
  if (-not $ruleHits.ContainsKey($idx)) { $ruleHits[$idx] = 0 }
  $ruleHits[$idx]++
}
if ($ruleHits.Count -gt 0) {
  Write-Host ""
  Write-Host "Route rule hits:"
  $ruleHits.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  rule[{0}] : {1}" -f $_.Key, $_.Value)
  }
}
