# One-time installer for the VPN diagnostic harness.
# Creates a Scheduled Task that runs sing-box with admin privileges
# so that subsequent start/stop can be triggered WITHOUT UAC prompts.
#
# Usage:
#   PowerShell (Admin) -> .\diag\install.ps1

$ErrorActionPreference = 'Stop'

# Require elevation. Self-relaunch elevated, waiting for it to finish so exit code propagates.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Need admin. Requesting elevation (UAC prompt)..." -ForegroundColor Yellow
  $pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }
  try {
    $proc = Start-Process $pwshExe `
      -Verb RunAs `
      -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") `
      -Wait -PassThru
    exit $proc.ExitCode
  } catch {
    Write-Host "UAC was denied or elevation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}

$taskName   = 'VPN-Diag-SingBox'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$srcSingbox = Join-Path $projectDir 'resources\sing-box.exe'
$srcWintun  = Join-Path $projectDir 'resources\wintun.dll'

$runtimeDir = Join-Path $env:APPDATA 'vpn-tunnel-enforcer\diag-runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

Write-Host "Copying binaries to: $runtimeDir" -ForegroundColor Cyan
Copy-Item -Path $srcSingbox -Destination (Join-Path $runtimeDir 'sing-box.exe') -Force
Copy-Item -Path $srcWintun  -Destination (Join-Path $runtimeDir 'wintun.dll')  -Force

$singboxPath = Join-Path $runtimeDir 'sing-box.exe'
$configPath  = Join-Path $runtimeDir 'sing-box.json'

# Unregister previous task (if any).
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Action: run sing-box with the runtime config.
$action = New-ScheduledTaskAction `
  -Execute $singboxPath `
  -Argument "run -c `"$configPath`"" `
  -WorkingDirectory $runtimeDir

# Current user, highest privileges, interactive (so wintun + TUN work).
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 24) `
  -MultipleInstances IgnoreNew `
  -Hidden

Register-ScheduledTask `
  -TaskName   $taskName `
  -Action     $action `
  -Principal  $principal `
  -Settings   $settings `
  -Description 'VPN TUN diagnostic harness (managed by Cascade)' | Out-Null

# ---------- Kill-switch task ----------
# schtasks /end sometimes fails to kill sing-box if the task engine lost the PID link.
# Having a dedicated elevated "taskkill" task lets us force-stop it without another UAC prompt.
$killTaskName = 'VPN-Diag-SingBox-Kill'
Unregister-ScheduledTask -TaskName $killTaskName -Confirm:$false -ErrorAction SilentlyContinue

$killAction = New-ScheduledTaskAction `
  -Execute 'C:\Windows\System32\taskkill.exe' `
  -Argument '/F /IM sing-box.exe'

Register-ScheduledTask `
  -TaskName   $killTaskName `
  -Action     $killAction `
  -Principal  $principal `
  -Settings   $settings `
  -Description 'Force-stops sing-box (Cascade diagnostic kill-switch)' | Out-Null

Write-Host "`nScheduled Tasks registered:" -ForegroundColor Green
Write-Host "  '$taskName'      — start sing-box"
Write-Host "  '$killTaskName' — emergency kill"
Write-Host "Start  : schtasks /run /tn `"$taskName`""
Write-Host "Stop   : schtasks /end /tn `"$taskName`""
Write-Host "Kill   : schtasks /run /tn `"$killTaskName`""
Write-Host "Runtime: $runtimeDir"
Write-Host "`nInstallation complete. You can close this window."
