$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$configPath = Join-Path $repoRoot "caretv.config.json"

if (Test-Path $configPath) {
  $env:CARETV_CONFIG_FILE = $configPath
} elseif (-not $env:CARETV_SERVER_URL) {
  $env:CARETV_SERVER_URL = "http://w11.lan:4010"
}

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm dev:appliance
  exit $LASTEXITCODE
}

if (Get-Command corepack -ErrorAction SilentlyContinue) {
  corepack pnpm dev:appliance
  exit $LASTEXITCODE
}

Write-Error "Neither pnpm nor corepack was found. Install Node.js LTS with Corepack enabled."
