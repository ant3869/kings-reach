# Changelog

## 2.19.0 - Attach files, screenshots and documents to a message (dashboard and War Room)

**Why:** you could only send words. Telegram could already take a photo or a document, but the dashboard console and the War Room could not, so showing an agent a screenshot, a log or a PDF meant pasting a path by hand.

**Added**
- **A paperclip button, drag-and-drop and paste on both pages.** Choose files, drop them on the chat, or paste a screenshot straight into the message box. Each file uploads as soon as it is chosen and shows as a chip (name, size, a thumbnail for images, a remove button), so Send is instant. Up to 5 files of up to 20 MB per message. A file with no words still sends ("Please look at the attached file."). Sending is held back, with a plain reason, while a file is still uploading or has failed; removing a chip deletes the file from the server, even if it was still uploading.
- **Agents open the files themselves.** The message carries only upload ids; the server finds the files and appends a short "[Attached files]" block with each file's path to what the agent reads (the same approach Telegram uses, so Claude's file tools open images and PDFs). Proven with real agents: Main described an uploaded screenshot correctly, and Ops read a codeword out of an uploaded text file over the War Room socket.
- **Works for a single agent, a routed `@agent:` message, and a council.** The War Room transcript shows which files went with a message; the memory search and the saved history see only what you typed.

**Safety and cost**
- A client can only name a file this system saved: an upload id (`<time>-<6 hex>_<clean name>`), validated on both servers. Paths, `..`, drive letters and other people's ids are refused (tested), so the chat cannot be used to point an agent at the `.env` or a system file. File names are cleaned and cannot leave `workspace/uploads`.
- **The file list does not make the question look harder.** The difficulty scorer ignores the path block, so the same question picks the same model with or without files (checked in a live run: tier low, difficulty 0.14, a Sonnet route, no Opus). It also never runs a question with an attachment tool-less ("light"), or the agent could not open its file.
- Uploads are swept after 24 hours, hourly while the core runs (before, only when Telegram started, and Telegram is not always running). The upload route sits behind the same host / same-origin / token guard as every other write.

**Internals:** `src/attachments.ts` (store, resolve, remove), `src/attach-format.ts` (the block, pure), `warroom/attachments.py` (the same rules for the War Room; wording pinned by a test on each side), `public/kr-attach.js` (one client module for both pages), `src/attach-css.ts`. New routes `POST /api/upload` and `DELETE /api/upload/:id`; `/api/chat` accepts `attachments`. Wire protocol `council-v7` (text and summit messages carry `attachments`: a stale page now gets the hard-refresh notice instead of silently dropping files), War Room server v20, War Room client v38, dashboard client v9.

**Not included:** voice and the Build button carry no attachments; a council stage that happens to run on a route without file tools cannot open a file (the question still tells it where the file is); files are not previewed in the transcript beyond their names.

**Needs a restart** of the core and the War Room.

**Tests:** 234 Node (8 new), 113 Python (9 new), 146 browser checks (21 new: attach, drop, paste, thumbnail, remove, oversize, six files, failed-file send block, dashboard send). Five rules were broken on purpose to confirm a test catches each: accepting any id on either server, path text inflating difficulty, running an attachment tool-less, paths polluting the memory search. The browser run also caught a real bug (a chip removed mid-upload left its file behind), now fixed.

## 2.18.1 - A build that is not approved can be continued, and the screen says what happened

**Why:** a Build whose reviewer was not satisfied ended in a red **FAILED** badge and a one-line message. It did not say whether the files were still changed (they were), that the checks had passed, or what to do next; the only way forward was to press Build again, which ran the whole plan from the start on top of files it had already edited.

**Changed**
- **A new "needs your decision" state, separate from FAILED.** Green checks with an unconvinced reviewer is now an amber **NEEDS REVIEW** badge (progress bar, build panel and cards stay calm: the cards are no longer drawn defeated). FAILED is kept for things that really broke: the checks failed, an owner never reported back, nothing changed, or the baseline was already broken. The ledger still records `needs_work`.
- **A Build result card says what happened.** Title, one paragraph that answers "are my files still changed?" (kept exactly as written, nothing restarted), what is still wrong in the reviewer's own words (its issues plus every success criterion it could not confirm), the list of kept files, and the check output when the checks failed. Every build ends with one: built, needs your decision, failed, nothing built, or stopped before anything was edited.
- **Three ways forward that never redo the build.** On a build that passed its checks: **Re-check only** (Research looks again, nothing edited, the cheapest), **Fix what was flagged** (the Hand of the King gets only the open issues and the files already changed, told not to redo anything, then the checks and review run again) and **Keep as is** (free; restarts the core if the changes need it, and the ledger says it was your decision). A build whose checks failed only offers Fix (re-checking or keeping failing code makes no sense). An owner that never reported back is named, and the fix takes over its unfinished steps. Each follow-up has its own progress bar, its own scoreboard line, and can be cancelled like any run.
- **The card survives a refresh.** What the latest build left behind is saved to `store/build-state.json`; a page that connects gets the card and its buttons back. It is only offered while the verdict it was built from is still the current one (a newer council overwrites it, and the server says so rather than building the wrong thing). Files a fix changed are remembered immediately, even if it is cancelled before it finishes.
- **Free preview:** `/warroom?demo=build-review` shows the new card (and `build-fail` / `build` now end with theirs).
- **Internals:** the check-and-review half of a build moved out of `_execute` into `warroom/buildflow.py` and is shared by the first build and every follow-up; the council's schemas and prompt notes moved to `warroom/schemas.py` (re-exported from `council.py`). `council.py` went from 561 to about 470 lines. Wire protocol `council-v6` (new `build_result` and `build_followup` messages, `note` on the final meter), War Room server v19, client v37.

**Deliberately not added:** a "discard changes" button. A build edits files that may already hold your own uncommitted work, so reverting them automatically could destroy it. The card lists the kept files; `git diff` / `git checkout -- <file>` is the safe way to undo.

**Needs a restart** of the core and the War Room (new messages, new page).

**Tests:** 226 Node, 104 Python (17 new: the three states, the card for every outcome, each follow-up, an unfinished owner, a failed fix, cancel mid-fix, the saved state), 125 browser checks (18 new). Each new rule was broken on purpose to confirm a test catches it. Checked live over a real WebSocket: card replayed on connect, an unavailable option refused without starting a run.

## 2.18.0 - Cancel is honest, and the dashboard shows what is running

**Changed**
- **War Room: Cancel run and Hush voices are now two buttons.** *Cancel run* sits in the live status header while a run is active. It shows *Cancelling...* until the server answers (new `cancel_ack` message: the wire protocol is now `council-v5`, War Room server v18), the CANCELLED badge arrives when the run really ends, and if neither arrives within 8 s it says so and offers *Retry cancel*. *Hush voices* (the old *Cancel / hush*) now only mutes speech and says the run keeps going.
- **Dashboard: new "Running now" panel.** It reads `GET /api/runs`, shows each run's agent, origin (dashboard chat, council step, or a chat id for Telegram and scheduled runs) and a ticking elapsed time. *Stop this run* is offered only for dashboard-owned runs, with *Stopping...*, a receipt, and *Retry stop* on failure. An empty list and a failing endpoint each have their own message.

**Needs a restart:** the server keeps the page HTML in memory, so the new buttons and panel appear after the dashboard and War Room are restarted. Until then the old page keeps working with the new script (its single button still cancels).

**Tests:** 225 Node, Python unchanged, 107 browser checks (14 new: cancel pending, ack, stuck retry, hush split, runs panel).

## 2.17.4 - Council steps are now logged

**Fixed**
- **The War Room's agent calls were invisible in the logs.** Every council step runs in a short-lived Node bridge whose stdout is the JSON channel back to Python, and Python deliberately drops every line that is not a reply, so each log line the bridge wrote (which model a step picked and why, which route failed and why, MCP servers loaded) was thrown away. The bridge now writes to `store/logs/bridge.log` (one JSON line per event, tagged `"proc":"bridge"`; at 5 MB it rotates to `bridge.log.1`). See the model each step chose with `findstr "tier chosen" store\logs\bridge.log`. As a side effect the bridge's stdout is now the reply and nothing else, so a log line that happened to contain an `ok` key can no longer be mistaken for the answer.
- **The difficulty-tier log line overwrote its own severity.** It carried a `level` field (the difficulty) beside pino's `level` (severity 30), so any JSON reader saw the difficulty where the severity belonged. The field is now `difficulty`. A test scans every logger call in `src` for keys pino owns (`level`, `time`, `msg`, `pid`, `hostname`); it fails if the old key comes back.

**Tests:** 225 Node (new: which process gets a log file, the size cap, bridge stdout is the reply alone, the reserved-key guard), 87 Python, 93 browser checks. Checked live with one cheap recall-stage bridge call: the decision line landed in `bridge.log` and stdout was a single reply line.

## 2.17.3 - The council chair no longer always gets the top model

**Fixed**
- **Plan and verdict always ran on the strongest model.** Both stages were fixed at difficulty 1, so with tiers on, Main (the chair) landed on the top rung of its ladder (Claude Opus 5.5) for every council, however plain the question. In a real run on "which file handles cancelling a run" the Opus chair cost $1.02 of a $2.03 council, while Ops on Sonnet 5.5 had reached the same answer for $0.61; verdict confidence (0.85) was inside the usual 0.78-0.93 range. The chair's jobs are synthesis (the plan is told to skim a file or two; the verdict to decide from what the specialists found), so both now start at mid, like the investigation they depend on.
- The council question can still raise the chair: its own text is scored with the same fitted model as free-form prompts, and the chair takes the higher of that and its stage level. A hard question (large, points at code) still gets the strongest model; the reason is logged as `hard question: level N`. No other stage is affected, and no stage goes below its own level.

**Tests:** 221 Node (new: chair levels, question extraction, the ladder rung an ordinary and a hard question land on; the integration test for tiers now pins Sonnet for an ordinary verdict and Opus for a hard plan). Python unchanged (87).

**Note:** council steps run in the War Room's Node bridge, whose log lines do not reach `core.log`; the model each step used is in the live status panel ("Main - Asking claude (...)") and in `store/council-runs.jsonl` under each agent's `models`.

## 2.17.2 - Council quorum and the Claude CLI version

**Fixed**
- **A council that assigned a single specialist could never finish.** The chair may pick "1 to 4" specialists, but quorum was `max(2, ceil(2n/3))`, so one specialist answering perfectly still ended as `no_quorum` ("1/1 answered; 2 required") and the whole run was thrown away. Quorum is now never more than the number assigned (`quorum_for`): 1 of 1, 2 of 2, 2 of 3, 3 of 4. A lone specialist that fails is still a `no_quorum`. Seen live; five new tests, and three of them fail if the old rule is put back.
- **Opus steps silently fell back to Sonnet.** The Claude Agent SDK bundled Claude Code 2.1.141, which the API rejects for `claude-opus-5-5` ("version 2.1.280 or newer is required"), so every Opus attempt failed and the route moved on. Upgraded `@anthropic-ai/claude-agent-sdk` 0.2.141 to 0.3.319 (bundled CLI 2.1.319). Checked live: Opus and Sonnet both answer on the bundled CLI, strict TypeScript is clean, and the cancel hook still ends the whole process tree on the new SDK (the agent's `ping` was dead by the time the cancel request returned).

**Note:** a War Room server keeps the Python it started with, so restart it after updating (the core only starts one when none is running).

## 2.17.1 - Audit and polish pass

**Fixed**
- **Shutdown no longer orphans running agents.** Stopping or restarting the core while a run was in flight closed the database and exited, leaving the Claude CLI and any command it had started running with no parent. Shutdown now cancels in-flight runs first (verified live: the agent and its `ping` were both gone, nothing left behind).
- **The core no longer dies silently on a stray rejection.** There were no `unhandledRejection` / `uncaughtException` handlers, so one rejected promise from any library could kill the whole daemon on modern Node. A rejection is now logged and the core carries on; a true uncaught exception is logged and the core shuts down cleanly (runs cancelled, database closed).
- **Settings no longer stalls for up to 10 s.** The provider health check (OpenClaw starts slowly) blocked every Settings visit that came more than a minute after the last one. It is now stale-while-revalidate: the last answer is served at once and refreshed behind it, concurrent callers share one probe, and the core warms it at boot. First load measured 10.5 s before, 0.8 s after.
- Runtime failures in voice (speech-to-text and text-to-speech fallbacks) and the scheduler wrote to the console instead of the structured log, so they never reached `core.log`. They use the logger now.

**Removed (dead code and unused dependencies)**
- **WhatsApp.** `src/whatsapp.ts` was never started (`initWhatsApp` had no caller), yet `WHATSAPP_ENABLED` defaulted to `true`, the setup wizard asked "Enable WhatsApp bridge?" and `package.json` advertised it. Gone: the file, the setting, the wizard prompt, `whatsapp-web.js` and `qrcode-terminal`. A real WhatsApp channel would be a feature to build; the old stub is in git at `v2.17.0`. Your own `.env` is untouched and any leftover `WHATSAPP_*` lines in it are harmless.
- `vitest` (never referenced; the tests run on `node:test`), the unread `AGENT_TIMEOUT_MS` setting (the runtime never read it; **Stop** is how to end a run), the unused TypeScript copy of `AGENT_BRIDGE_PATH` (the War Room reads it from `.env` itself), and an unused `VoiceCapabilities` type.
- Effect: 213 fewer packages, `node_modules` 416 MB to 331 MB, and `npm audit` from 17 findings (11 high, 2 critical in dev tooling) to 1 moderate. The one left is `@hono/node-server`'s `serveStatic`, which this project does not use; the MCP SDK carries its own copy of that line, so it cannot be cleared from here.

**Tests:** 220 Node (new: Telegram `/stop` driven through the real bot with a fake Telegram API, including a refused stranger and the queue clearing; stale-while-revalidate and shared probes), 82 Python, 93 browser checks. The `/stop` test was mutation-checked: putting the old blocking handler back makes it fail.

## 2.17.0 - Cancel any run, and a difficulty model fitted to real usage

**Added**
- **Cancel a run.** Dashboard: a Stop button beside Send while a chat is working. Telegram: `/stop` (also clears messages queued behind the running one). API: `GET /api/runs` and `POST /api/runs/cancel` by `id`, `chatId` or `all` (no criteria cancels nothing). Every `runAgent` call registers in `src/run-control.ts` and gets an abort signal, which reaches the Claude SDK (`abortController`), provider CLIs, agent harnesses and HTTP providers.
- A cancel is final and distinct (`RunCancelled`): it is never retried (also not during a retry backoff, which now wakes at once), never falls through to the next provider, is not recorded as a provider failure, and a cancelled scheduled task goes back to `active` for its next run instead of `failed`.
- **The whole process tree is ended**, not just the top process. Verified live: the Claude SDK kills only its own CLI on abort, which left a command the agent had started (a long `ping`) running with nobody listening; the same was true of Codex/harness runs (`cmd.exe` wrapper) and of the War Room's Cancel and timeout. New `killTree` (synchronous `taskkill /T`, because the SDK's own `kill()` can reach the parent first and orphan the children) and `spawnClaudeCli` for the SDK; `kill_tree` for the War Room bridge.
- `npm run difficulty:calibrate` (`--write` saves, `--show` lists the worst misses, `--dir` reads another projects folder).

**Changed**
- **Free-form difficulty is now fitted to evidence, not guessed.** `scripts/difficulty-calibrate.mjs` pairs 167 real prompts from your Claude transcripts with the work they caused (model turns + tool calls), fits a small ridge regression on `ln(1 + effort)`, validates it with repeated five-fold cross-validation and writes `src/difficulty-model.ts`. Held-out rank correlation is 0.46 over all prompts and 0.62 on the free-form ones it serves. Word lists ("refactor", "architecture") and step counts were tested and removed: they added no held-out accuracy. What survived: prompt length, and whether the request names code or files. Weights cannot be negative, and the 0-1 level comes from percentile anchors, so the ladder is used by observed effort rather than arbitrary score cutoffs. Stage and explicit difficulty still win over it.
- Honest finding: of your free-form prompts, 65% are quick (median 1 turn, 0 tools), 29% are real work (median 11 turns, 15 tool calls) and 6% are heavy; none of the 40 that would run `light` used an MCP tool. (An earlier report said most prompts were high; that was the council prompts, which never use this model.)
- Telegram runs now carry their chat id, so their token usage is recorded (it never was) and `/stop` can find them. Telegram handlers no longer block the update loop for the length of a run, which is what lets `/stop` arrive at all (messages in one chat still run in order).
- `scripts/ui-check.mjs`: the tiers check no longer assumes tiers are off, since that is the owner's saved choice.

**Tests:** 215 Node, 82 Python, 93 browser checks. New: registry/cancel semantics, no-fallback and no-retry on cancel, queue clearing, and real process-tree kills (grandchild must die) for `killTree`, `spawnClaudeCli`, a plain `kill()`, and the War Room bridge.

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
