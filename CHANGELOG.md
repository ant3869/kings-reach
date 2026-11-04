# Changelog

## 2.14.1 - Polish and loose ends for 2.14.0 (War Room client v24, server v13, protocol council-v4)

- **Build panel resolves every phase.** The server now sends `build_progress` for preflight done and execute done/failed;
  before, a finished build still showed preflight "Waiting" and execute "active". The gate chip is marked failed when the
  checks fail (it used to stay success-coloured because a failed check is returned, not raised), and the preflight chip is
  no longer wiped when execute begins.
- **Warnings stay visible.** The activity feed evicts routine lines first, is no longer height-clipped, and a failed
  run's badge states the actual cause. The old wall-clock `thinking: X 4s` line is removed (the panel owns timing).
- **Stalled/quiet seats keep a lasting outline** (dashed amber / solid red), since the pose art reverts after seconds.
- **Measured mind-changes are visible.** The summit scoreboard shows `N measured (M claimed)`, per-agent confidence
  shifts with reasons, `held up (no tools)` and `claimed a change` flags, and which seats answered without tools. The
  Plan Library list shows the measured count for new runs and nothing for old ones (their number was a self-report).
- **Protocol bumped to `council-v4`** (activity + meter messages); a stale page now gets the hard-refresh notice.
- **Demo meter moves on every turn** like the real one, and the demo summit includes the measured-minds scoreboard.
- **Docs:** new `docs/LIVE.md` (event flow, thresholds, what each element means); README section; the handoff prompt is
  rewritten for the current state; the `C:` rule is corrected to "nothing storage-heavy on C:".
- **`verify.mjs` no longer hardcodes the protocol string** (it failed the moment v4 shipped); it imports the constant.
- **Tests:** `npm test` 72 (includes the python suites), python alone 58 (+8 summit wiring, +8 build wiring, shared
  `tests/fakes.py`), ui-check 55, verify 59. New guards fail if the browser/server silence thresholds or protocol drift. The summit tests were mutation-checked (disabling the tool-less cap makes them fail).
- Added `scripts/demo-shots.mjs` (real-Chrome screenshots of the replays to `store/logs/live-*.png`).

## 2.14.0 - Live visibility, salvage, measured minds

The 2.13.1 post-mortem left three design issues and the owner could not tell whether a build was working, stalled
or dead. This release fixes both.

**You can now see what is happening (War Room client v22, server v12)**
- **Live status panel** under the stage chips: one badge (`WORKING`, `QUIET`, `STALLED`, `RUNNING`, `DONE`, `FAILED`,
  `CANCELLED`; each has a glyph and a word, never colour alone), an estimated progress bar (`~37% (estimate)`, never
  100% until the run really finished), a per-agent row (current action, `turn 7/24`, files read / edited, seconds since
  last news), the last spoken line as a caption, and a short activity feed.
- **Real events, not timers.** `src/activity.ts` turns Claude tool calls and Codex `exec --json` events into short,
  secret-redacted sentences ("Editing src/agent.ts"; file *contents* never leave the process). The bridge streams them
  (`activity: true`) and `warroom/live.py` forwards them. Silence is shown honestly: 45 s `QUIET`, 90 s `STALLED`.
- **Cards react to what happened:** `defeated` on a failed answer, `confused` on a stall or a route failure, per-seat
  text badges next to the existing building/researching art.
- **Spoken commentary** from the same events: stage changes, first edit per file, route fallbacks, stalls, a periodic
  "N files read, M changed". Room-wide throttle (22 s, 6 s for urgent news), skipped when more than one clip is already
  queued, always captioned even when speech is off. Templated, so it is free and cannot invent progress.
- **Build reports are cross-checked** against the edits actually observed (soft warning: shell edits and
  non-streaming routes legitimately differ).
- **Demo / replay, zero cost:** `/warroom?demo=build|build-fail|stall|summit[&speed=20]` plays synthetic events through
  the real handlers on a virtual clock (browser speech stands in for Kokoro). `scripts/ui-check.mjs` drives it in real
  Chrome. Nothing is sent to the server.

**The three design issues**
- **Failed-provider work is no longer discarded.** (1) A Claude seat that hits its turn cap is resumed in the same
  session for up to 4 turns and told to answer from what it gathered; the attempt is marked `salvaged`. (2) If a route
  still fails, a bounded, redacted, clearly-UNVERIFIED work log (files looked at, its own notes) is prepended to the
  next route's prompt.
- **A tool-less route can no longer talk a verified position down.** Replies now carry `hasTools`. A tool-less debate
  answer may lower confidence by at most 0.10; tool-less takes are labelled in the log and flagged `NO TOOLS: unverified`
  to Main, and recorded as `takes_without_tools`.
- **`changed_minds` is measured.** From the before/after structured answers: confidence moved >= 0.15, or the
  recommendation was rewritten (< 45% wording kept). The agent's own `changed_mind` is kept as
  `changed_minds_claimed`, with `claimed_without_change` / `changed_without_claim` and per-agent `mind_changes`.

**Honest limits**
- The salvage / handoff / activity-stream path through the real Claude SDK is covered by unit tests of its parts and the
  protocol parser, but its first end-to-end exercise is the next paid run. Watch the first summit's feed.
- Progress % is an estimate (phase weights are guesses); turn counts and file counts are measured.
- `to_thread` phases (preflight, gate) have no heartbeat: the page shows the phase clock but cannot flag them stalled.
- Tests: node 64 (+16), python 42 (+22 in `tests/test_live.py`), ui-check +16.

## 2.13.1 - Summit post-mortem fixes

Found by auditing the first live summit (run `cfac8fa0`) against the Claude Code transcripts.

- **Honest cost.** A route that failed after spending money (a Claude seat that hit its turn cap) is no longer
  dropped: its cost is recorded on the attempt (`attempts[].costUsd`), added to the answer that finally succeeded,
  and reported when every route fails. That summit logged $0.95; reconstructing from transcripts it was ~$2.20.
- **Memory recall in sandboxed agents.** `agent-voice-bridge --recall` now falls back to a read-only database
  handle when it cannot write (codex agents hit `attempt to write a readonly database`). Writes are still refused.
- **Turn budget.** `COUNCIL_INVESTIGATE_TURNS` default 16 -> 24. In that summit two Claude seats used all 16 and
  were discarded, then redone by another provider. 24 is a judgement call, not a measurement; override in `.env`.
- **council-reasoning skill:** `[verified]` now requires evidence that could have shown the claim false. Package
  metadata proves *installed*, not *where from*; and never cite a guard/flag/file you did not open. (Ops had labelled
  "agent-reach came from PyPI" as verified from a `METADATA` file, and cited a "loopback guard" that does not exist.)
  Re-approved with `skill trust` after the edit, which also exercised the tamper check.
- Tests: +2 (`tests/cost-recall.test.mjs`).

## 2.13.0 - Skills and real research

**Skill system** (see `docs/SKILLS.md`)
- New `skillpack/` plugin ("kings-reach"): a vetted, integrity-checked library of `SKILL.md` playbooks with a registry
  recording source, pinned commit, license, approved SHA-256 and per-agent assignments.
- Every agent call (Telegram, dashboard, orchestrator, War Room council and build) now loads only that agent's skills,
  names its required skills in the system prompt, and gets a live research-capability note. Tool-less providers get
  flagged required skills pasted inline.
- Safety: install lands in quarantine; a scanner rejects bad frontmatter, symlinks, binaries, oversized skills, hidden
  Unicode, injection phrases and pipe-to-shell; an active skill whose content changed after approval is refused.
- `npm run skills -- <list|show|install|enable|disable|trust|assign|unassign|create|doctor>`; `doctor --live` asks the
  real Agent SDK which skills each agent's prompt actually contains.
- Starter library: karpathy-guidelines, systematic-debugging, test-driven-development, playwright-cli, agent-reach
  (adapted: management/login sections removed), plus authored council-reasoning, deep-research, build-discipline.

**Research**
- `tools/browser`: pinned `@playwright/cli` driving the installed Chrome/Edge, headless.
- `tools/agent-reach`: Agent-Reach 1.6.1 built from a pinned GitHub commit with its own `constraints.txt` (the PyPI
  package of that name is a different project). Wrapped by `tools/bin/agent-reach`, which pins its HOME inside
  `store/` and refuses owner-only subcommands.
- `npm run setup:research` (idempotent, caches kept under `store/`) and `npm run research-check` (free end-to-end proof).
- `/api/health` now reports `skills` and `research` (internet / browser / agent-reach); `scripts/verify.mjs` asserts them.
- Offline machines are detected: agents are told so and must label external claims unverified.

**Tests:** +17 (`tests/skills.test.mjs`): scanner, hashing, resolution, tamper detection, SDK options, spec parsing
(including a path-traversal case it caught), research probe, guard refusals, and a guard that `tools/browser` keeps a
single pinned dependency (an early `npm install --prefix` had saved the repo into it as a self-linking loop).

## 2.12.0 - Dynamic card variants (War Room client v21)
- Each councillor independently draws from weighted art pools (`set_2` preferred, `set_1` secondary, occasional
  close-ups); variants rotate without immediate repeats; reduced-motion disables rotation.
- New inferred poses: researching, offense, defense, confused, defeated. Falls back to the original four-state art if
  the manifest cannot load. Active speaker is lifted and scaled.

## 2.11.0 - Regenerated card states
- All 15 non-idle card states regenerated as individual framed cards with border-connected flood fill.

## 2.10.0 - Plan Library (`/history`)
- Browse and filter past councils and builds with metrics and archived plans; reconvene a summit; start a build from an
  archived unbuilt plan behind a single-use two-minute token and a confirmation.
