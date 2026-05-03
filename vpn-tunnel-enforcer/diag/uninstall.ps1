# Remove the VPN-Diag-SingBox Scheduled Task.
# Usage: PowerShell (Admin) -> .\diag\uninstall.ps1

$ErrorActionPreference = 'Stop'

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }
  $proc = Start-Process $pwshExe `
    -Verb RunAs `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") `
    -Wait -PassThru
  exit $proc.ExitCode
}

$taskName = 'VPN-Diag-SingBox'

# Best-effort stop.
& schtasks.exe /end /tn $taskName 2>$null | Out-Null
Get-Process sing-box -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Task '$taskName' removed." -ForegroundColor Green
