$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$env:CARETV_SERVER_URL = if ($env:CARETV_SERVER_URL) { $env:CARETV_SERVER_URL } else { "http://w11.lan:4010" }

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm dev:appliance
  exit $LASTEXITCODE
}

if (Get-Command corepack -ErrorAction SilentlyContinue) {
  corepack pnpm dev:appliance
  exit $LASTEXITCODE
}

Write-Error "Neither pnpm nor corepack was found. Install Node.js LTS with Corepack enabled."
