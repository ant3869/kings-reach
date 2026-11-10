# What happens to a run when the page goes away

A council or a Build can take ten minutes and spend real money. Before 2.20.0 it lived and died with the browser tab that
started it: a reload, a closed tab or a laptop that slept cancelled it. A Build that had already edited files left no
ledger row and no saved state, so nothing said what had changed on disk.

## The rule now

**Work belongs to the War Room server, not to the page.** Only these end a run:

| What you did | What happens |
|---|---|
| Reload or close the tab | The run **keeps going**. Everything it says and does is remembered. |
| Open the War Room again | The new page is told to clear itself, then replayed what it missed, then gets live updates. |
| Press **Cancel run** | The run stops. It is recorded as `cancelled`. (Hush voices never stops a run.) |
| An error escapes the run | It is recorded as `crashed` and reported. |
| Restart the War Room server | Running work **is** stopped (it lives in that process). Check first, see below. |

There is deliberately **no "leave this page?" warning**: leaving is safe, so a warning would be false.

## How the replay works

`warroom/server.py` keeps a bounded journal (`JOURNAL_LIMIT`, 2000 messages) per session of what a page needs to redraw
itself: chat lines, your own messages, stages, thinking, activity, meter, provider, metrics, build progress and the Build
result card. It does **not** keep audio, pongs, acknowledgements, the casting list or greetings.

- When the tab leaves with work still running, the session is **detached** (`DETACHED`) instead of closed. Messages keep
  being journaled; nothing is written to the dead socket.
- The next tab to connect **takes over** the detached session: it receives `{"type": "resume"}`, then the journal in
  order, then live messages. Journaling and writing share one lock, so a message is never delivered twice or out of order
  while it catches up.
- If the work finishes with nobody watching, the result waits `RETIRE_AFTER_S` (10 minutes) for a page to collect it, then
  is dropped.
- Voice is switched off on a detached session (nobody is there to hear it), so no speech is synthesized for an empty room.
- Your own lines come back as `{"type": "you", "kind", "text", "files"}` carrying file **names**, never paths.

One detail worth knowing: a page that merely blipped (network) and reconnected is handled the same way, which is why the
page clears its transcript on `resume` instead of appending a second copy.

## A stopped run is written down

`warroom/interrupted.py` (pure functions) and `BuildFlow.record_interruption` run after the final meter has been sent:

- **Every** cancelled or crashed council or Build gets a ledger row in `store/council-runs.jsonl` with `outcome`
  (`cancelled` / `crashed`), `interrupted_at` (the stage that was running), `failure_summary`.
- A **Build** also records `changed_files`: what its owners reported *plus* any edit the live feed saw, so a file Ops edited
  but never got to report is not lost.
- A Build that had already edited files saves `store/build-state.json` and shows an *attention* card with **Fix** (finish
  what is left, then run the checks and the review). A page that reconnects gets that card back. A Build stopped before any
  edit saves nothing, and an earlier build's state is not overwritten: just build again.
- The History page labels the new outcomes, and a cancelled Build is counted separately and kept **out of the build
  success rate** (it is neither a success nor a failure). Its spend still counts.
- Writing the note can never replace the cancel: if it fails, the page still learns the run ended and a status line says
  why the note could not be written.

## Before you restart the War Room

`ping` now answers `busy`: the number of tasks running across all tabs, including ones whose tab has left.

```
{"ok": true, "pong": "council-v8", "server": 22, "busy": 0, ...}
```

A restart script should wait for `busy` to be `0`, or tell you what it is about to stop.

## Tests

`tests/test_detach.py` (reload keeps the work, takeover and catch-up, no double delivery during the replay, Cancel from the
new tab, bounded journal, retirement, `busy`), `tests/test_execute.py` and `tests/test_summit.py` (what is recorded for a
cancelled or crashed run, Fix after a cancel), `tests/history.test.mjs` (stats), and the `resume:` checks in
`scripts/ui-check.mjs` (real Chrome: a replay shows each line once).
