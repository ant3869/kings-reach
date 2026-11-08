# Changelog

## 2.16.0 - Adaptive per-provider model ladders, agent harness providers, polish pass

**Added**
- **Difficulty tiers (off by default, Settings -> Difficulty tiers).** Each provider has its own ordered model ladder: pick the weakest (Low) and strongest (High) model and everything ranked between them is allowed (untick any). A step gets a continuous difficulty level from 0 to 1 and lands on the matching rung, so an in-between task gets an in-between model; two adjacent models make it effectively binary. A role never leaves its own provider: a role on OpenAI only uses OpenAI's range and only Claude roles can reach Opus. The role's own model stays behind the pick as the fallback. Difficulty comes from an explicit request, then the pipeline stage (`plan`/`verdict` hardest, `investigate`/`debate`/`execute`/`review` middle, `recall`/`record`/`preflight`/`gate` easiest), then a deterministic wording heuristic (the memory block the chat surfaces prepend is ignored).
- `src/model-rank.ts` orders models weakest to strongest from their names (generation first, then size: `sonnet-4-6 < opus-4-6 < sonnet-5 < opus-5-5`). Image, speech and embedding models are never ranked. Served to Settings as `ranked` on `GET /api/providers`.
- **Quick-answer wiring:** with tiers on, an easy step that does not mention repos, files, GitHub or URLs runs `light` (no MCP servers), which is most of the first-response latency. Never when the caller needs tools or set `light` itself. Logged as `difficulty tier chosen` and `mcp servers for run`.
- **Harness providers** `openclaw`, `hermes` and `codepuppy` as full-trust, tool-capable routes with health checks and model dropdowns. OpenClaw runs through `openclaw.cmd` (bare `openclaw` resolves to an unrelated executable on Windows); Code Puppy's echoed prompt is stripped from its answer; model ids reaching `cmd.exe` are restricted to safe characters.
- Council stages (`plan`, `investigate`, `debate`, `verdict`, `execute`, `review`) are forwarded to the core so the tier is known, not guessed.
- Claude sign-in prompt: logged-out Claude calls are skipped without SDK work or spend, the dashboard offers `claude auth login`, and Telegram/dashboard errors say how to sign in.
- `npm run test:py` runs the War Room's Python tests with the interpreter from `WARROOM_PYTHON`; `scripts/env.mjs` is the one shared `.env` reader for `verify` and `test:py`.
- 7 new real-browser checks for the tier editor (88 total) and 12 new unit tests (198 total).

**Fixed**
- Memory decay uses its own `decayed_at` timestamp (pure `decayStep()`); embeddings decode aligned `Float32Array`s and reject dimension mismatches.
- Settings could not un-tier a provider once one end of its range was cleared.
- Saving routes tolerates `null`/`undefined` targets instead of throwing.

**Removed (dead code, verified unreferenced by TypeScript, Python, scripts and tests)**
- Modules `hooks`, `message-classifier`, `rate-tracker`, `obsidian`, `state` and the unused functions `getDefaultAgent`, `setAgentOverrides`, `getAgentOverrides`, `effectiveTimeoutMs`, `clearSession`, `searchMemoriesFts`, `logAuditEvent`, `evaluateMemoryRelevance`, `shouldNudgeMemory`, `queueDepth`, `isProcessing`, `skillDescription`, `voiceCapabilities`.
- **Settings that never did anything**, removed from `config.ts` and `.env.example`: `PIN_HASH`, `PIN_SALT`, `IDLE_LOCK_MINUTES`, `KILL_PHRASE`, `DAILY_TOKEN_LIMIT`, `DAILY_COST_LIMIT`, `HOURLY_TOKEN_LIMIT`, `MEMORY_NUDGE_INTERVAL_*`, `STREAM_STRATEGY`, `TYPING_REFRESH_MS`, `STT_PROVIDER`, `OBSIDIAN_VAULT_PATH`, `WHATSAPP_SESSION_PATH`, the per-agent `*_TELEGRAM_TOKEN` constants and unused ElevenLabs/Pika/Recall/Slack keys. **The PIN lock, idle lock, kill phrase and spend limits were never enforced**; see HANDOFF for the decision this leaves you.

## 2.15.6 - Per-agent MCP allowlists (agent.yaml `mcp_allowlist`) and a quick-answer `light` run

- `agent.yaml` now accepts `mcp_allowlist` per agent (inline `[a, b]` or block list). Omitted keeps the old behaviour (every server from Claude settings), `[]` means no MCP servers, a list means exactly those names. An unreadable value fails closed (no servers) and is logged. Server definitions and credentials stay in Claude settings; project still wins over user.
- `loadMcpServers`: an empty allowlist used to mean "all servers"; it now means none. Names with no configured server are dropped and logged.
- Shipped `agent.yaml`: `main`, `ops`, `research` get `[github]` (the only verified server), `comms` and `content` get `[]`.
- New `light` run option: a quick-answer run gets no MCP servers whatever the role allowlist says. Every Claude run logs `mcp servers for run` with the agent, the light flag and the server names. Nothing sets `light` yet; callers opt in.
- A restricted run now also passes `strictMcpConfig`, otherwise the CLI keeps loading servers from the settings sources and the allowlist is cosmetic. Agents without an allowlist are unchanged.
- Tests: `tests/mcp-allowlist-parse.test.mjs`, `tests/mcp-allowlist-run.test.mjs`.

## 2.15.5 - Card text centred; audit fixes (client v35, server v17)

- Card plate: title, role, route and voice are centred on the card and the role/route/voice lines sit at the same height on every card (the voice `<select>` left-aligned its text inside a box sized to the widest voice name; the title line height varied with its shrunk font). Two new UI checks measure both.
- Fixed: a tab that had just closed made the voice-change broadcast raise, which aborted the handler and was then misread as the *current* tab disconnecting. One shared `broadcast()` now skips dead tabs (also used by the voice warm-up). Regression test added, proven red on the old code.
- Removed an unused variable (`src/memory.ts`); `tsc --noUnusedLocals --noUnusedParameters` is clean.
- `warroom/voices.json` now carries the voices you picked in the dropdown.

## 2.15.4 - A single agent that is working no longer looks stalled (server v16)

- Asking one agent (typed or by voice) never streamed its activity, unlike council runs, so a healthy tool run showed QUIET then STALLED after ~100 s while the agent was actually working (its tool processes were running). `Session.answer` now follows the agent through `Live`: the status panel shows its turns and tools, the card route line fills in `provider / model`, and the meter closes complete/failed.
- New `tests/test_answer.py` (stubbed agents, no spend).
- Observed, not changed: the first action of a direct voice question can take ~2 minutes because the agent starts your global Claude MCP servers and runs with full tool access (`bypassPermissions`, 12 turns).

## 2.15.3 - Cleaner card plate; one Welcome per page

- The "route:" and "voice:" prefixes are gone from the card plate: it shows just `provider / model` and the voice name (the dropdown caret now lives inside the select and appears on hover/focus). Client v34.
- The Welcome message shows once per page load; a reconnect no longer stacks another one in the log.

## 2.15.2 - Speech-to-text works: microphone audio was being sent as JSON

- `send()` JSON-encoded the mic's ArrayBuffer (`{}`), so the server answered "unknown message type: None" and Whisper never got the audio; the Voice panel sat on "transcribing...". Binary audio now goes out as a binary frame. Client v33.
- New UI check: a mic utterance leaves the page as one binary frame.

## 2.15.1 - Stale card art no longer shows under the live nameplate

- Card images are cached for 24 h under fixed names, so browsers kept showing the old art (painted text under the new live text) after 2.15.0. Image URLs now carry the client version (`?v=32`), so every client bump fetches fresh art. Client v32.

## 2.15.0 - Live card nameplates and a voice dropdown under every card

- The painted-in name/title on all 230 card images is gone (`scripts/card_plate.py`, also run by `build_card_art.py`).
  The page draws the title large and the role small, live from `voices.json`; long titles shrink to fit.
- Pin moved below the card; route and voice now sit on the card plate.
- Voice label becomes a dropdown on hover/focus (always a real `<select>`: works by keyboard and touch). Choices come
  only from the installed Kokoro voice file (28 English voices, grouped). Changing one is validated server-side, saved
  atomically to `voices.json`, applied to the next sentence without a restart, and mirrored to all open tabs.
- New: `warroom/casting.py`, `public/warroom-casting.js`, WebSocket `casting` / `set_voice` (server v15, client v31).
- Tests: casting (Python), card plate + shipped-art scan (Python), dropdown UI (node), nameplate/pin/dropdown layout (UI check).
- The old "state cards share the idle nameplate layout" test is retired: it measured text that no longer exists.

## 2.14.10 - Renamed ClaudeClaw to King's Reach everywhere; README banner

- Display/brand text, agent prompts, scripts, the auth header (`x-kings-reach-token`), env vars (`KINGS_REACH_CONFIG`,
  `KINGS_REACH_DB`), the pid file (`store/kings-reach.pid`), the Task Scheduler task name (`KingsReach`), temp file and
  OpenRouter labels. `docs/banner.png` now tops the README.
- Deliberately NOT renamed (would orphan real data or paths): the database file `store/claudeclaw.db`, the voice-model
  folder `D:\models\claudeclaw`, and the `H:\projects\claudeclaw` folder paths. Rename those by hand when convenient.
- Owner note: if your own `.env` still has `CLAUDECLAW_CONFIG`/`CLAUDECLAW_DB`, rename the key.

## 2.14.9 - A route that crashes after spending money still has that money counted

Council verdict a6bba3c9. The route loop in `runAgent` only counted the cost of a failed route when the route RETURNED a
failure. Two throw paths dropped cost the provider had already reported (new tests execute the real loop with a faked SDK):

- `runClaudeAgent` rethrew a non-turn-cap SDK error without its local `costUsd`. It now tags the error
  (`attachReportedCost`, finite non-negative costs only) and `runAgent` records it in `attempts` once.
- `salvage` swallowed a throwing wrap-up call and lost that call's cost. It now adds it to the capped attempt before returning null.
- Token ledger: an external fallback logged `result.costUsd`, which already includes the failed routes' cost, while the failed
  Claude route had logged its own row, so summing `token_usage` double-counted. The fallback now logs its own route cost only.
- `runAgentWithRetry` is unchanged and has no callers. Contract (pinned by a test): each `runAgent` call owns its ledger.
- Known gap, not fixed: a route that throws mid-stream (not at the turn cap) still loses its handoff notes.
- `npm test` now passes `--experimental-test-module-mocks` (needed by `tests/agent-cost-routes.test.mjs`).

## 2.14.8 - A build that changed nothing is no longer "reviewed and approved" (build `e80fb359`)

Build `e80fb359` (plan a6bba3c9, all five steps owned by Main) changed no file, and Research still spent 4m29s and $0.67
reviewing it and "approved" with 10/10 criteria. Cause chain, verified by a live probe:

- Main's routes (edited in Settings) had no Claude route, so the Build skipped the tool-less ChatGPT route and ran on **Codex**.
- **Codex's Windows sandbox is broken on this machine** (`helper_unknown_error: setup refresh had errors`, `[windows] sandbox =
  "elevated"` in the owner's `~/.codex/config.toml`): it cannot start a process or write a file, yet replies "done". Probe:
  `codex exec --sandbox workspace-write` asked to create one file; no file, exit 0. That is why Main "could not provide reliable
  current source" and edited nothing.
- Our bug: with zero changed files the gate trivially passed (nothing to compile) and the review ran anyway.

Fixed here:
- Review is skipped when no file changed (`review skipped: no file changed`), saving the cost and the false approval.
- `build_outcome`: green checks + no changed files is `no_changes` regardless of review; the failure text now says the owner could
  not edit and to check its route (Claude, or a working Codex sandbox).
- History: label "Nothing was built" (was "Approved, nothing changed"); the notice shows the recorded reason. History client v4.
- Tests: +2 python (67): an empty build skips the reviewer and is `no_changes`; outcome table.
- NOT changed (owner's machine/data): Codex's sandbox setup and the Main route list. Builds assigned to Main need a Claude route.

## 2.14.7 - Provider settings: dropdowns of valid choices, refused on save

The Settings > Providers page used free-text model boxes, so a mismatched pair saved fine and then failed on every call (Main's
Claude route held `cx/gpt-5.6-Sol`, its ChatGPT route held `claude-sonnet-5-5`, and Research's ChatGPT route held a Meta model),
which sent Main to Codex on every run.

- New `src/provider-models.ts`: builds the valid models per provider from what is actually verified (live 9Router catalog, provider
  health, installed Ollama models, known-good built-ins; Claude also gets the 9Router `cc/` lane with the prefix stripped).
- The page now shows a provider dropdown (not-set-up providers greyed out) and a model dropdown with capability notes. Changing
  the provider resets the model to a valid one; a saved route that is not valid is flagged red with a warning.
- `PUT /api/providers/config` now refuses any route whose provider is not available or whose model is not in that provider's list,
  with a readable reason. `ProviderHealth.configured` (credentials/service present) is separate from `available` (last call worked),
  so one bad model cannot lock a provider out of the picker.
- The owner's saved routing was repaired through that endpoint (swap back, Research's Meta route moved to the `meta` provider,
  identical trailing duplicate dropped). Backup: `store/provider-routing.backup-before-dropdowns.json`.
- Tests: `tests/provider-models.test.mjs` (+6, npm 110) and three live provider-page checks in `ui-check` (68), which also
  captures `store/logs/live-providers.png` before it mutates the page.

## 2.14.6 - Fix #1: memory keyword recall broke on punctuation (reported by @mattabate)

- `buildMemoryContext` built its FTS5 MATCH string by stripping only `" * : ( )`, so ordinary questions (`what's the status?`,
  `check my e-mail`) were syntax errors and the words NOT / AND / NEAR were read as operators. The catch block only logged,
  so keyword recall silently returned nothing for most questions. New `ftsMatchQuery()` keeps only letter/digit/underscore runs
  (unicode aware) and double-quotes each word, which FTS5 always treats as a literal. Same limits as before (words over 2
  characters, at most 8, OR-ed).
- `tests/fts-query.test.mjs` runs real in-memory FTS5: it first proves the old query shape throws on those inputs, then that the
  new one finds the right memory, never parses operator words, cannot be escaped with a quote, and keeps unicode.
- Not changed: `searchMemoriesFts()` in `db.ts` still takes a raw query, but nothing calls it.
- Known, not fixed: OR-ing every word means common words ("the") match many rows; ranking would help.

## 2.14.5 - Second successful Build: salvage hardening and provenance (summit `0bb2cb86`, build `d1fc1b47`; client v30)

The summit ran while Claude's usage quota was exhausted, so every seat fell back to Codex (a clean fallback demo; salvage itself was
not exercised). The council still found real holes in the 2.14.4 salvage fix; Build `d1fc1b47` (6 files, gate pass, review approved,
criteria 5/5, about 19 min, recorded $3.47) implemented the plan, re-verified independently (diff read, npm 99, python 65).

- `salvage()` now returns null when the wrap-up call itself fails, so the original capped result keeps its cost and handoff for the
  next route instead of the whole attempt being lost.
- `ProviderRoutesError` carries the final handoff; the bridge's failed reply includes it.
- War Room labels a salvaged reply "recovered after turn cap"; the Plan Library marks the agent as salvaged. Both read the existing
  `attempts[].salvaged` flag.
- Tests: +13 node (99 total). Still unproven on a real run: salvage actually rescuing a capped seat.
- Note: the summit's recorded cost ($0.16) excludes Codex usage; Codex cost is not priced.

## 2.14.4 - First successful Build + the real salvage bug (summit `edcd1990`, build `8fa32ddd`)

- **First real Build succeeded**: preflight clean, 1/1 owners, 2 files, gate (py_compile) pass, Research approved, criteria 6/6,
  $1.03, 5m16s. Plan came from the summit (provider diversity should count only tool-verified providers). The Build's own
  change is `warroom/council.py` `Run.charge()` (`hasTools` gate on the provider list) + a regression test in
  `tests/test_summit.py`; independently re-verified (python 65 tests, diff read). Plan flaws it tolerated: used `pytest`
  (not installed) and a wrong line number.
- **Salvage never ran on a real turn cap.** The SDK *throws* "Claude Code returned an error result: Reached maximum number of
  turns (N)" instead of only yielding an error result; `runClaudeAgent` let it escape, so `runAgent` fell through to the next
  route and discarded the paid-for research (Ops and Research both did this at `COUNCIL_INVESTIGATE_TURNS=6`). The unit tests
  used the yielded shape, so they passed. Now the cap exception is caught (`turnCapMessage`), the session id and cost are kept,
  and salvage resumes the session. Other exceptions still propagate. Not yet seen working on a real run.
- Tests: npm 86, python 65.

## 2.14.3 - Fixes from the second real summit (run `241424d9`; client v29, server v14)

The council (asked about "28 connected War Room clients") found that the number was a mistake of mine: `/api/health`'s
`clients.warroom` was `WARROOM_CLIENT_VERSION`, a page version, not a connection count. No leak exists. It also found two
real client flaws. $2.73, 12m44s, all logs clean; turn counts stayed under cap (3/12, 8/12).

- `/api/health` field renamed `clients` to `clientVersions` (`verify.mjs` updated).
- Reconnect backoff reset on a bare WebSocket handshake, so a link that connects then drops retried every 2 s forever. It now
  resets on the first pong.
- `lastPong` starts at connect, so a socket that never answers still hits the 45 s self-close.
- `warroom.log` lines now carry an ISO timestamp and `open tabs now: N`.
- Not done (the verdict's step 5): a 24 h observation of the connect rate; read the new timestamps when convenient.
- Still open: `provider_diversity` counts a tool-less debate answer as a second family; salvage and failed-route handoff
  still unproven on a real run.

## 2.14.2 - Fixes from the first real summit (run `9a7edfa0`; War Room client v28, server v13)

The first paid run after 2.14 proved the live panel works against the real SDK ($1.93, 8m47s, no errors in any log) and
exposed four bugs in 2.14, found by reading the screenshot against the ledger and the Claude transcripts.

- **`turn N/M` was inflated 2-3x** (the page showed `Ops turn 18/12`). The SDK streams one `assistant` event per content
  block (thinking, text, tool_use) sharing a message id; I counted events. New `TurnCounter` counts distinct message ids,
  which is what the SDK's `maxTurns` counts. Regression test uses the real shape (18 events, 6 messages).
- **Mind-change rule 2.** Rule 1 counted any rewritten recommendation as a changed mind, so two councillors who kept the
  same design and refined a detail ("2 lines" to "4 lines"; Ops even answered `changed_mind: false`) scored `2 measured`.
  Now a mind has changed when confidence moves >= 0.15, or the agent claimed a change AND the text really was rewritten.
  A rewrite nobody claims is `reworded` (new `reworded_agents`, shown apart). Ledger rows carry `mind_rule: 2`; the Plan
  Library no longer shows older rows as measurements, and the scoreboard labels them "old rule". The existing ledger is
  untouched. Test uses the real Ops texts from that run.
- **Stale "Build will execute plan cfac8fa0".** The line was rendered once at page load. The server now serves it at
  `/warroom/planline` (one renderer) and the page re-fetches it when a summit locks a verdict. (Build itself always ran the
  right plan; only the display was wrong.)
- **Stale caption after DONE** ("Main: Still working. 1 actions so far."). A clean finish drops a caption older than 15 s; a
  failure keeps its caption (it is the reason). Plurals fixed ("1 file read", "1 action"); an existing test had asserted
  the wrong grammar.
- **Scoreboard** now labels every tool-less debate answer ("answered without tools"), not only capped ones, since Research's
  debate answer in that run came from ChatGPT without tools.
- **Found by screenshotting the fixes** (each would have been invisible to the assertions): clearing the caption left an
  empty gold bar (the box keeps its height to avoid layout jumps; its styling now hides while empty); a sparse metrics row
  printed `undefined (self-reported)`; a finished agent whose route streamed no events read `DONE ... Starting` (now
  "Answered" / "Gave no usable answer"). The demo summit now emits every stage, memory/hive fields and per-call `done`
  events like the real server, so a DONE badge over dim chips can no longer pass.
- Tests: `npm test` 82 (+9: turn counter, plan line, stale caption, history rule, demo stages, finished-agent text), python 64
  (+6: mind rule incl. the real case, plurals, ledger rule tag, reworded-not-changed), ui-check 65 (+10: footer refresh,
  reworded seat, tool-less label, every chip resolved, no `undefined`, rows kept, empty caption, no "Starting").
- `scripts/demo-shots.mjs` gained a summit scoreboard shot and expands collapsed blocks before capturing.
- Known, not fixed: `provider_diversity` in the ledger counts a tool-less debate answer's provider as a second family.
  Still unproven on a real run: turn-cap salvage and the failed-route handoff.

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
