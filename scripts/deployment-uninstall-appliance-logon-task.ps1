param(
  [string]$TaskName = "CareTV Appliance"
)

$ErrorActionPreference = "Stop"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Uninstalled scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' is not installed."
}
