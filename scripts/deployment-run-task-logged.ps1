param(
  [string]$TaskName = "CareTV Appliance",
  [Parameter(Mandatory = $true)]
  [string]$StartScript
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $repoRoot ".caretv\task-logs"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "$($TaskName -replace '[^a-zA-Z0-9._-]', '_')-$timestamp.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path $logPath -Force | Out-Null

try {
  Write-Host "Task: $TaskName"
  Write-Host "User: $env:USERDOMAIN\$env:USERNAME"
  Write-Host "Repo: $repoRoot"
  Write-Host "Start script: $StartScript"
  Write-Host "PATH: $env:PATH"
  Set-Location $repoRoot
  & (Resolve-Path $StartScript)
  exit $LASTEXITCODE
} catch {
  Write-Error $_
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
