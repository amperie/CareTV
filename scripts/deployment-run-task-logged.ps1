param(
  [string]$TaskName = "CareTV Appliance",
  [Parameter(Mandatory = $true)]
  [string]$StartScript,
  [switch]$KeepOpen
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $repoRoot ".caretv\task-logs"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "$($TaskName -replace '[^a-zA-Z0-9._-]', '_')-$timestamp.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path $logPath -Force | Out-Null

$exitCode = 0

try {
  Write-Host "Task: $TaskName"
  Write-Host "User: $env:USERDOMAIN\$env:USERNAME"
  Write-Host "Repo: $repoRoot"
  Write-Host "Start script: $StartScript"
  Write-Host "PATH: $env:PATH"
  Set-Location $repoRoot
  & (Resolve-Path $StartScript)
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) {
    throw "Startup script exited with code $exitCode."
  }
} catch {
  Write-Error $_
  $exitCode = if ($exitCode -ne 0) { $exitCode } else { 1 }
} finally {
  Stop-Transcript | Out-Null
}

if ($KeepOpen -and $exitCode -ne 0) {
  Write-Host ""
  Write-Host "CareTV startup failed. Log file: $logPath"
  Read-Host "Press Enter to close"
}

exit $exitCode
