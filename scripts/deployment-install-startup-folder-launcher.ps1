param(
  [string]$Name = "CareTV Appliance",
  [string]$StartScript = (Join-Path $PSScriptRoot "deployment-start-appliance.ps1")
)

$ErrorActionPreference = "Stop"

$scriptPath = Resolve-Path $StartScript
$wrapperPath = Resolve-Path (Join-Path $PSScriptRoot "deployment-run-task-logged.ps1")
$startupDir = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupDir "$Name.cmd"

$content = @"
@echo off
start "$Name" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "$wrapperPath" -TaskName "$Name" -StartScript "$scriptPath" -KeepOpen
"@

Set-Content -Path $launcherPath -Value $content -Encoding ASCII

Write-Host "Installed startup launcher: $launcherPath"
Write-Host "Startup script: $scriptPath"
Write-Host "Task logs: $(Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".caretv\task-logs")"
