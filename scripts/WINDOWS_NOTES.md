# Windows service notes (replaces launchd .plist workflow)

The spec's `install-launchd.sh` flow is macOS-only. On Windows 11:

## Register (logon trigger)

```powershell
powershell -File scripts\agent-service.ps1 -Install
```

This creates a Task Scheduler task named `KingsReach`:

- Trigger: ONLOGON for the current user
- Action: `node.exe "<root>\dist\index.js"`, Start in `<root>`
- Shows up under Task Scheduler Library as `KingsReach`

## Useful schtasks commands (cmd-compatible)

```cmd
schtasks /query /tn KingsReach /fo LIST
schtasks /run /tn KingsReach
schtasks /delete /tn KingsReach /f
```

## Headless / boot without login

`schtasks /sc onlogon` needs a user session. For a server-style box, either:

1. Run the install from an elevated shell and change the task to run as SYSTEM,
   or
2. Open Task Scheduler GUI, change the trigger to "At startup" with
   "Run whether user is logged on or not".

## Helpers

- `scripts\agent-create.ps1` — scaffold a specialist agent (wraps `agent-create-cli.js`)
- `scripts\notify.ps1 "message"` — toast when long tasks finish (used by agents for progress pings)
- `npm run status` — checks pid file, Task Scheduler registration, ports 3141/7860
