# Start King's Reach if it is not already running, then open the dashboard. This is what the desktop shortcut runs.
# It never restarts a running core: if the dashboard already answers, it only opens the browser. -NoOpen skips the browser (for tests).
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = 3141
if (Test-Path .env) {
    $line = Select-String -Path .env -Pattern '^\s*DASHBOARD_PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}
$url = "http://127.0.0.1:$port/"

function Test-Dashboard {
    try { return (Invoke-WebRequest -Uri "${url}api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Show-Problem($text) {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($text, "King's Reach", 'OK', 'Warning')
}

if (-not (Test-Dashboard)) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Show-Problem 'Node.js was not found. Install it from nodejs.org, then try again.'; exit 1 }
    if (-not (Test-Path (Join-Path $root 'dist\index.js'))) {
        & npm run build | Out-Null
        if (-not (Test-Path (Join-Path $root 'dist\index.js'))) { Show-Problem "The build failed. Open a terminal in $root and run: npm run build"; exit 1 }
    }
    New-Item -ItemType Directory -Force (Join-Path $root 'store\logs') | Out-Null
    Start-Process -FilePath node -ArgumentList 'dist/index.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root 'store\logs\core.log') -RedirectStandardError (Join-Path $root 'store\logs\core.err.log')
    for ($i = 0; $i -lt 60 -and -not (Test-Dashboard); $i++) { Start-Sleep -Seconds 1 }
    if (-not (Test-Dashboard)) { Show-Problem "King's Reach did not start within a minute. See store\logs\core.err.log"; exit 1 }
}
if (-not $NoOpen) { Start-Process $url }
