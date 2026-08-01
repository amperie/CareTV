param(
  [ValidateSet("Appliance", "FullStack")]
  [string]$Mode = "Appliance",
  [ValidateSet("StartupFolder", "ScheduledTask")]
  [string]$StartupMethod = "StartupFolder",
  [string]$ServerUrl = "http://w11.lan:4010",
  [string]$ApplianceId = "living-room-tv",
  [string]$ApplianceName = "Living Room TV",
  [string]$RuntimeDir = "C:\CareTV\runtime",
  [string]$ChromeProfileDir = "C:\CareTV\chrome-profile",
  [string]$ApplianceMediaDir = "C:\CareTV\media",
  [switch]$InstallDependencies,
  [switch]$StartNow,
  [switch]$EnablePlaybackNow,
  [string]$AutologonExe,
  [string]$AutologonUser = $env:USERNAME,
  [string]$AutologonDomain = $env:USERDOMAIN,
  [securestring]$AutologonPassword
)

$ErrorActionPreference = "Stop"

function PlainText([securestring]$Value) {
  if (-not $Value) { return $null }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

foreach ($dir in @($RuntimeDir, $ChromeProfileDir, $ApplianceMediaDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$config = [ordered]@{
  host = "0.0.0.0"
  serverPort = 4010
  webPort = 4020
  runtimeDir = $RuntimeDir
  chromeProfileDir = $ChromeProfileDir
  timezone = "America/Los_Angeles"
  serverUrl = $ServerUrl
  applianceId = $ApplianceId
  applianceName = $ApplianceName
  appliancePollMs = 1000
  applianceHeartbeatMs = 5000
  appliancePlaybackObserveMs = 1000
  applianceRequestTimeoutMs = 10000
  applianceMediaDir = $ApplianceMediaDir
  applianceMediaScanMs = 30000
}

$configPath = Join-Path $repoRoot "caretv.config.json"
$configJson = $config | ConvertTo-Json
[System.IO.File]::WriteAllText(
  $configPath,
  $configJson,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Wrote $configPath"

if ($InstallDependencies) {
  if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    throw "Corepack was not found. Install Node.js LTS first."
  }

  corepack enable
  corepack prepare pnpm@9.15.4 --activate
  corepack pnpm install
}

$taskName = if ($Mode -eq "FullStack") { "CareTV Full Stack" } else { "CareTV Appliance" }
$startScript = if ($Mode -eq "FullStack") {
  Join-Path $PSScriptRoot "deployment-start-full-local-stack.ps1"
} else {
  Join-Path $PSScriptRoot "deployment-start-appliance.ps1"
}

if ($StartupMethod -eq "ScheduledTask") {
  & (Join-Path $PSScriptRoot "deployment-install-appliance-logon-task.ps1") `
    -TaskName $taskName `
    -StartScript $startScript
} else {
  & (Join-Path $PSScriptRoot "deployment-install-startup-folder-launcher.ps1") `
    -Name $taskName `
    -StartScript $startScript
}

if ($AutologonExe -or $AutologonPassword) {
  if (-not $AutologonExe) {
    throw "Pass -AutologonExe with the path to Sysinternals Autologon.exe or Autologon64.exe."
  }

  $autologonPath = Resolve-Path $AutologonExe
  $password = PlainText $AutologonPassword
  if (-not $password) {
    throw "Pass -AutologonPassword. Example: -AutologonPassword (Read-Host -AsSecureString)"
  }

  & $autologonPath $AutologonUser $AutologonDomain $password /accepteula
  Write-Host "Configured Windows autologon for $AutologonDomain\$AutologonUser."
}

if ($EnablePlaybackNow) {
  try {
    Invoke-RestMethod -Method Post -Uri "$ServerUrl/api/v1/playback/start" | Out-Null
    Write-Host "Playback enabled on $ServerUrl."
  } catch {
    Write-Warning "Could not enable playback on $ServerUrl. The server may not be running yet."
  }
}

if ($StartNow) {
  if ($StartupMethod -eq "ScheduledTask") {
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
    Get-ScheduledTaskInfo -TaskName $taskName
  } else {
    & (Join-Path ([Environment]::GetFolderPath("Startup")) "$taskName.cmd")
  }
}

Write-Host ""
Write-Host "Autostart setup complete."
Write-Host "Mode: $Mode"
Write-Host "Startup method: $StartupMethod"
Write-Host "Name: $taskName"
Write-Host "Startup script: $startScript"
Write-Host "Dashboard: http://127.0.0.1:4020"
