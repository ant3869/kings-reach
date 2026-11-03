# scripts/agent-create.ps1 - Windows equivalent of scripts/agent-create.sh.
# Creates a specialist agent via the compiled CLI.
# Usage: powershell -File scripts\agent-create.ps1 -Id comms -Name Comms -Description "..." [-TelegramToken ...] [-Model ...]
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Description,
  [string]$TelegramToken = "",
  [string]$Model = "claude-sonnet-4-6"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$args = @("$Root\dist\agent-create-cli.js", "create", $Id, $Name, $Description)
if ($TelegramToken -ne "") { $args += $TelegramToken } elseif ($Model -ne "claude-sonnet-4-6") { $args += "" }
if ($Model -ne "claude-sonnet-4-6" -or ($TelegramToken -ne "" -and $Model -ne "")) { $args += $Model }

node @args
