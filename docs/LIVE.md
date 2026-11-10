# Live visibility: how the War Room shows what is happening

Added in v2.14. The goal: at any moment you can tell whether a council or build is **working, quiet, stalled, finished,
failed or cancelled**, what each agent is doing, and why, without reading logs and without a paid run to see it.

## Event flow

```
Claude SDK stream / Codex `exec --json`
        |  src/activity.ts   describeTool() / codexActivity(): tool call -> short, secret-redacted sentence
        v                    (file CONTENTS never leave the process; only paths, patterns, hosts, commands)
src/agent.ts  onActivity -> src/agent-voice-bridge.ts   (request {activity: true}) streams {"event":"activity",...}
        v                                                one JSON line per event on stdout; the reply is the last line
warroom/agent_bridge.py   reads stdout line by line (parse_line), forwards activity to on_event, keeps the last answer
        v
warroom/live.py   Tracker (per agent: turns, reads, edits, silence), Meter (weighted estimate), Live (room-level)
        v   room.send({type: activity|meter})   room.narrate(agent, text)
warroom/server.py Session           activity/meter go to the browser; narration also goes to the speech queue
        v
public/warroom-live.js   pure state machine + DOM panel; public/warroom-app.js wires it into stage/thinking/poses
```

Wire protocol `council-v4` (see the table at the end of this page for every version) adds two message types: `activity` (`kind`: `turn`, `tool`, `route`, `narration`,
`done`) and `meter` (`pct`, `phase`, `label`, and on the last one `final: true` with `state`
`complete|attention|failed|cancelled`). A page on an older protocol shows the existing "hard-refresh" notice.

## What the page shows

| Element | Meaning |
|---|---|
| Badge | `WORKING` an agent produced news in the last 45 s; `QUIET` 45-90 s of silence; `STALLED` 90 s or more; `RUNNING` between agent calls (preflight, gate, reboot); `DONE`, `NEEDS REVIEW` (the work is on disk and its checks passed, but the reviewer wants changes: a decision, not a failure), `FAILED`, `CANCELLED` are final and distinct |
| Bar | An **estimate** (`~37% (estimate)`). Phase weights are guesses; it never reaches 100% until the run really ends, and a failed run freezes where it got to |
| Agent rows | Current action, `turn N/M` (model turns, as the SDK's cap counts them: one per message id, not per content block), files read / edited (measured), seconds since last news |
| Plan line | "Build will execute plan X" under the buttons; re-fetched from `/warroom/planline` when a summit locks a verdict |
| Seat badge + outline | Text badge per card; a lasting dashed (quiet) or solid (stalled) outline, because pose art reverts after a few seconds |
| Caption | The last spoken line, shown even when speech is off. Dropped on a clean finish if older than 15 s; kept on failure (it is the reason) |
| Feed | Last 8 notable events; warnings and failures are evicted last |

Thresholds live in `warroom/live.py` (`QUIET_S, STALL_S = 45, 90`) and `public/warroom-live.js`; a test fails if they differ.
Preflight and gate run in a worker thread with no heartbeat, so they show a phase clock but cannot be flagged stalled.

## Spoken commentary

Templated from real events (free, cannot invent progress): stage changes, the first edit of each file, route fallbacks,
stalls, and a periodic "N files read, M changed" (only when something recent happened). Room-wide throttle: 22 s between
routine remarks, 6 s for urgent ones (fallback, stall). `Session.narrate` skips speech when more than one clip is
already queued, so commentary never lags behind the screen. Narration always reaches the caption/feed.

## Failed attempts keep their work (`src/agent.ts`)

1. A Claude run that hits its turn cap is **resumed in the same session** for up to 4 turns and told to answer from what
   it gathered (`salvage()`); the attempt is recorded with `salvaged: true`.
2. If a route still fails, its `WorkLog` (files looked at, its own notes; bounded, redacted, labelled UNVERIFIED) is
   prepended to the next route's prompt.
3. Replies carry `hasTools`. A tool-less debate answer can lower a position's confidence by at most 0.10
   (`warroom/mindchange.py`), and tool-less takes are flagged `NO TOOLS: unverified` to Main.
4. `changed_minds` is **measured** (rule 2, `mind_rule: 2` on the ledger row): confidence moved by 0.15 or more, OR the
   agent claimed a change AND the recommendation really was rewritten (under 45% shared wording). A rewrite nobody
   claims is only **reworded** (`reworded_agents`, shown separately). Rule 1 counted any rewrite, which scored two
   councillors who kept the same design as having changed their minds (run `9a7edfa0`); rows without `mind_rule: 2`
   are not shown as measurements. Limit: a silent stance flip with a small confidence move shows only as reworded.
   The agent's own claim is kept as `changed_minds_claimed`.

## Try it without spending anything

- `/warroom?demo=build`, `build-fail`, `build-review` (checks pass, reviewer not satisfied: the amber state and the result card), `stall` (watch QUIET then STALLED then CANCELLED), `summit` (scoreboard with
  measured mind-changes). Add `&speed=20` to go faster (virtual clock), `&still=1` to freeze animations.
  Browser speech stands in for the Kokoro voice; nothing is sent to the server.
- `node scripts/demo-shots.mjs` writes `store/logs/live-*.png` from real headless Chrome.

## Tests

`tests/activity.test.mjs` (redaction, handoff), `tests/live.test.mjs` (state machine, demos, threshold + protocol sync),
`tests/test_live.py` (Tracker/Meter/Live, mind changes, bridge stream), `tests/test_execute.py` (build event order and
failure handling), `tests/test_summit.py` (summit wiring), `tests/minds.test.mjs`, and `scripts/ui-check.mjs` (real
Chrome against the replays). Proven on a real paid summit (`9a7edfa0`): the SDK event stream feeding the panel; that run
also exposed the turn-count and mind-change bugs fixed in 2.14.2. Still unproven: `salvage()` against a real turn-capped
session and the failed-route handoff (no seat hit its cap; force it with `COUNCIL_INVESTIGATE_TURNS=4`).

## Wire protocol versions

`PROTOCOL` in `warroom/server.py` and `WARROOM_PROTOCOL` in `src/warroom-html.ts` must match; a page on another version shows
the hard-refresh notice instead of silently misbehaving. A test pins the two together.

| Protocol | First server | Added |
|---|---|---|
| `council-v4` | 13 | `activity` and `meter` messages (this page) |
| `council-v5` | 18 | `cancel_ack`: the server confirms a cancel and says how many tasks it stopped |
| `council-v6` | 19 | `build_result` (the result card), `build_followup` (re-check / fix / keep) |
| `council-v7` | 20 | `text` and `summit` messages may carry `attachments` (see [`ATTACHMENTS.md`](ATTACHMENTS.md)) |
| `council-v8` | 22 | `resume` (clear, a replay follows) and `you` (a line the user typed): a page that reconnects mid-run is caught up. See [`RUN-LIFECYCLE.md`](RUN-LIFECYCLE.md) |

Server versions can also change without a protocol change. Server 23 added a plain-HTTP `GET /busy` on the same port (not a websocket
message, so it needs no protocol bump); see [`RUN-LIFECYCLE.md`](RUN-LIFECYCLE.md).
