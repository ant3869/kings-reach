# Put a King's Reach icon on the Desktop and in the Start menu. Clicking it runs scripts\launch.ps1.
# Run it again after moving the project folder: the shortcut stores the folder's path.   npm run shortcut
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'public\brand\kings-reach.ico'
if (-not (Test-Path $icon)) { throw "Missing $icon (run: python scripts/make-brand.py)" }

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $path = Join-Path $folder "King's Reach.lnk"
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = (Get-Command powershell.exe).Source
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $root 'scripts\launch.ps1')`""
    $link.WorkingDirectory = $root
    $link.IconLocation = "$icon,0"
    $link.Description = "Start King's Reach and open the dashboard"
    $link.Save()
    Write-Output "Created $path"
}
