param(
  [switch]$ResetServerState,
  [string]$TaskName = "CareTV Appliance",
  [int[]]$Ports = @(4010, 4020, 9223)
)

$ErrorActionPreference = "Stop"

function Stop-ProcessByIdIfRunning {
  param([int]$ProcessId)

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force
    Write-Host "Stopped PID $ProcessId ($($process.ProcessName))."
  }
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "Stopped scheduled task '$TaskName'."
}

foreach ($port in $Ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    Stop-ProcessByIdIfRunning -ProcessId $connection.OwningProcess
  }
}

Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Stopped Chrome processes. Chrome profile data was not deleted."

foreach ($name in @("node", "pnpm", "tsx")) {
  Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force
}
Write-Host "Stopped stale Node/pnpm/tsx processes."

if ($ResetServerState) {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4010/api/v1/lab/reset" -Body "{}" -ContentType "application/json" | Out-Null
    Write-Host "Reset server playback state."
  } catch {
    Write-Host "Server reset skipped because the API was not reachable."
  }
}

Write-Host "Cleanup complete."
