param(
  [string]$TaskName = "CareTV Appliance",
  [string]$StartScript = (Join-Path $PSScriptRoot "deployment-start-appliance.ps1")
)

$ErrorActionPreference = "Stop"

$scriptPath = Resolve-Path $StartScript
$wrapperPath = Resolve-Path (Join-Path $PSScriptRoot "deployment-run-task-logged.ps1")
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$userId = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapperPath`" -TaskName `"$TaskName`" -StartScript `"$scriptPath`"" `
  -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Starts the CareTV appliance agent when the Windows user logs on." `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' for $userId."
Write-Host "Startup script: $scriptPath"
Write-Host "Task logs: $(Join-Path $repoRoot ".caretv\task-logs")"
