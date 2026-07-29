$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "deployment-clean-stale-runtime.ps1")
& (Join-Path $PSScriptRoot "deployment-start-full-local-stack.ps1")
