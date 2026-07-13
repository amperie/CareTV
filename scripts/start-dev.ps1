$ErrorActionPreference = "Stop"

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm dev
  exit $LASTEXITCODE
}

if (Get-Command corepack -ErrorAction SilentlyContinue) {
  corepack pnpm dev
  exit $LASTEXITCODE
}

Write-Error "Neither pnpm nor corepack was found. Install Node.js LTS with Corepack enabled."
