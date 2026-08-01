$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$configPath = Join-Path $repoRoot "caretv.config.json"

if (Test-Path $configPath) {
  $env:CARETV_CONFIG_FILE = $configPath
  Remove-Item Env:CARETV_SERVER_URL -ErrorAction SilentlyContinue
} elseif (-not $env:CARETV_SERVER_URL) {
  $env:CARETV_SERVER_URL = "http://w11.lan:4010"
}

if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
  pnpm.cmd dev:appliance
  return
}

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm dev:appliance
  return
}

if (Get-Command corepack.cmd -ErrorAction SilentlyContinue) {
  corepack.cmd pnpm dev:appliance
  return
}

if (Get-Command corepack -ErrorAction SilentlyContinue) {
  corepack pnpm dev:appliance
  return
}

Write-Error "Neither pnpm nor corepack was found. Install Node.js LTS with Corepack enabled."
