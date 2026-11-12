# Start King's Reach if it is not already running, then open the dashboard. This is what the desktop shortcut runs.
#
# A running core is left alone, with one exception: if it is OLDER than the code on disk (you updated, it never restarted) and
# nothing is running, it is restarted gracefully so the update goes live. If work is running it is never touched.
#   -Restart  restart even when the versions match (still refused while work is running)     npm run restart
#   -NoOpen   do not open the browser (for tests)
param([switch]$Restart, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-EnvNumber($name, $default) {
    if (-not (Test-Path .env)) { return $default }
    $line = Select-String -Path .env -Pattern "^\s*$name\s*=\s*(\d+)" | Select-Object -First 1
    if ($line) { return [int]$line.Matches[0].Groups[1].Value } else { return $default }
}
$port = Get-EnvNumber 'DASHBOARD_PORT' 3141
$warPort = Get-EnvNumber 'WARROOM_PORT' 7860
$url = "http://127.0.0.1:$port/"

function Get-Health {
    try { return Invoke-RestMethod -Uri "${url}api/health" -TimeoutSec 2 } catch { return $null }
}

function Show-Problem($text) {
    Write-Warning $text
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($text, "King's Reach", 'OK', 'Warning')
}

# How many council / build / reply tasks are running right now, in the core or in the War Room (0 when it is not running).
function Get-BusyCount {
    $busy = 0
    try { $busy += @((Invoke-RestMethod -Uri "${url}api/runs" -TimeoutSec 3).runs).Count } catch { }
    try { $busy += [int](Invoke-RestMethod -Uri "http://127.0.0.1:$warPort/busy" -TimeoutSec 2).busy } catch { }
    return $busy
}

function Stop-Core {
    Invoke-RestMethod -Method Post -Uri "${url}api/admin/shutdown" -TimeoutSec 5 | Out-Null
    for ($i = 0; $i -lt 30 -and (Get-Health); $i++) { Start-Sleep -Seconds 1 }
    return -not (Get-Health)
}

function Start-Core {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Show-Problem 'Node.js was not found. Install it from nodejs.org, then try again.'; exit 1 }
    if ($script:rebuild -or -not (Test-Path (Join-Path $root 'dist\index.js'))) {
        & npm run build | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $root 'dist\index.js'))) { Show-Problem "The build failed. Open a terminal in $root and run: npm run build"; exit 1 }
    }
    New-Item -ItemType Directory -Force (Join-Path $root 'store\logs') | Out-Null
    Start-Process -FilePath node -ArgumentList 'dist/index.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root 'store\logs\core.log') -RedirectStandardError (Join-Path $root 'store\logs\core.err.log')
    for ($i = 0; $i -lt 60 -and -not (Get-Health); $i++) { Start-Sleep -Seconds 1 }
    if (-not (Get-Health)) { Show-Problem "King's Reach did not start within a minute. See store\logs\core.err.log"; exit 1 }
}

$script:rebuild = $false
$health = Get-Health
if ($health) {
    $onDisk = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $stale = $health.version -and $health.version -ne $onDisk
    if ($Restart -or $stale) {
        $busy = Get-BusyCount
        if ($busy -gt 0) {
            Write-Output "Not restarting: $busy task(s) are running. Finish or cancel them first."
        } else {
            if ($stale) { Write-Output "Running version $($health.version) is older than the code on disk ($onDisk): restarting." }
            if (-not (Stop-Core)) { Show-Problem 'The running King''s Reach did not stop. Close it from the dashboard or Task Manager, then try again.'; exit 1 }
            $script:rebuild = $true   # the build on disk may be older than the source
            $health = $null
        }
    }
}
if (-not $health) { Start-Core }
if (-not $NoOpen) { Start-Process $url }
