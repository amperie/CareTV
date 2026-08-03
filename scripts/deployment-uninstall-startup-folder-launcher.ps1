param(
  [string]$Name = "CareTV Appliance"
)

$ErrorActionPreference = "Stop"

$launcherPath = Join-Path ([Environment]::GetFolderPath("Startup")) "$Name.cmd"

if (Test-Path $launcherPath) {
  Remove-Item -LiteralPath $launcherPath -Force
  Write-Host "Uninstalled startup launcher: $launcherPath"
} else {
  Write-Host "Startup launcher is not installed: $launcherPath"
}
