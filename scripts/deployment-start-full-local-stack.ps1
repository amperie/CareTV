$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$env:CARETV_HOST = if ($env:CARETV_HOST) { $env:CARETV_HOST } else { "0.0.0.0" }
$env:CARETV_SERVER_PORT = if ($env:CARETV_SERVER_PORT) { $env:CARETV_SERVER_PORT } else { "4010" }
$env:CARETV_WEB_PORT = if ($env:CARETV_WEB_PORT) { $env:CARETV_WEB_PORT } else { "4020" }

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm dev
  exit $LASTEXITCODE
}

if (Get-Command corepack -ErrorAction SilentlyContinue) {
  corepack pnpm dev
  exit $LASTEXITCODE
}

Write-Error "Neither pnpm nor corepack was found. Install Node.js LTS with Corepack enabled."
