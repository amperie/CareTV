$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "deployment-clean-stale-runtime.ps1") -Ports @(9223)
& (Join-Path $PSScriptRoot "deployment-start-appliance.ps1")
