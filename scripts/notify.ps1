# scripts/notify.ps1 - Windows equivalent of scripts/notify.sh.
# Toast notification for long tasks. Usage: powershell -File scripts\notify.ps1 "message"
param([Parameter(Mandatory = $true)][string]$Message)

$ErrorActionPreference = "Continue"
try {
  # BurntToast if the user has it, else a WinForms balloon, else plain console.
  if (Get-Module -ListAvailable -Name BurntToast) {
    New-BurntToastNotification -Text "ClaudeClaw", $Message
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.ShowBalloonTip(5000, "ClaudeClaw", $Message, "Info")
    Start-Sleep -Seconds 6
    $icon.Dispose()
  }
} catch {
  Write-Host "ClaudeClaw: $Message"
}
