# scripts/agent-service.ps1 - Windows equivalent of scripts/agent-service.sh + install-launchd.sh.
# Registers King's Reach as a Task Scheduler job (logon trigger) instead of a launchd plist.
#
#   Install:   powershell -File scripts\agent-service.ps1 -Install
#   Uninstall: powershell -File scripts\agent-service.ps1 -Uninstall
#   Status:    powershell -File scripts\agent-service.ps1 -Status
#
# Task Scheduler notes:
#   - Task name: KingsReach, trigger: ONLOGON for the current user.
#   - Action: node.exe "<root>\dist\index.js" with Start in <root> so store/ paths resolve.
#   - schtasks has no "run on boot without login" for user tasks; for a headless box,
#     use -User SYSTEM via an elevated shell or switch the task to "At startup" manually.
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$TaskName = "KingsReach"
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Action = "`"$Node`" `"$Root\dist\index.js`""

function Show-Status {
  schtasks /query /tn $TaskName /fo LIST 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "Task '$TaskName' is not registered." }
}

if ($Status) { Show-Status; exit 0 }

if ($Uninstall) {
  schtasks /delete /tn $TaskName /f
  Write-Host "Task '$TaskName' removed."
  exit 0
}

# Default / explicit install.
schtasks /create /tn $TaskName /tr $Action /sc onlogon /rl limited /f | Out-Null
Write-Host "Task '$TaskName' registered (logon trigger). Starting now..."
schtasks /run /tn $TaskName | Out-Null
Show-Status
