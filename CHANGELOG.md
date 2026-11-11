# Changelog

## 2.24.2 - Copying `.env.example` no longer breaks start-up; CI; a roadmap and a how-it-works page

Found by a second audit and a feature-scouting pass (the new `feature-scout` skill). Nothing here changes what the War Room or the dashboard show.

**Fixed**
- **The README's first step crashed the War Room.** `.env.example` ships all 42 settings as `YOUR_VALUE_HERE` and nothing treated that as "unset". Copying the
  file as documented made `warroom.config` die on start (`int('YOUR_VALUE_HERE')`, for `WARROOM_PORT`, `DASHBOARD_PORT` and the debate and turn counts), made
  `OPENROUTER_BASE_URL`, `OLLAMA_BASE_URL` and `KOKORO_URL` replace their defaults with that text, and made `npm run test:py` try to launch `YOUR_VALUE_HERE` as Python.
  The exact placeholder now reads as unset in every place that reads `.env` (`src/env.ts`, `warroom/config.py`, `scripts/env.mjs`). `scripts/status.ts` had its own,
  weaker third parser; it now uses the shared reader.
  Reproduced first (the config crash is the new end-to-end test), then fixed; each new test fails when its fix is removed.
- **Two PNGs removed in 2.24.1 were not dead.** `public/card-states/warroom-cards-idle.png` and `-clean.png` are the inputs of `scripts/clean-card-strips.ps1` and
  `scripts/split-card-states.ps1`, which build the idle card art. Those scripts name them with PowerShell `$state` templates, which the audit's search had not
  understood, so the 2.24.1 entry below is wrong to say they were "named nowhere". Restored byte for byte. The audit scanner now understands `$var`, `$(...)` and `%s`
  templates (36 of 36 planted cases), and the audit skill now says a "a template may build this name" note is a stop sign, not a to-do.
- `npm run status` no longer prints a raw `ERROR: The system cannot find the file` when the startup task is not registered.

**Added**
- **CI** (`.github/workflows/ci.yml`) on every push to `main`, every `v*` tag and every pull request, on a Windows runner: `npm ci`, typecheck and build, every Node test,
  then the Python tests. Proven both ways before it was added: green on the released v2.24.1 (1 min 28 s), and red at `npm test` (`error TS1110`) when a syntax error
  like the one behind the broken v2.20.0 was pushed. The browser checks and anything needing a model, a login or a key stay local.
- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md): what each stage of a summit and a build does, what it costs, and where results land, with numbers measured from
  31 real runs. [`docs/ROADMAP.md`](docs/ROADMAP.md): ideas ranked with evidence, what was rejected and why, and what could not be verified. Both, and the
  previously unlinked Windows notes, are listed in a new "Docs" section of the README.

**Changed (same behavior)**
- Deleting a scheduled task is one function, `deleteScheduledTask()` in `src/db.ts`, instead of the same SQL in three files.

**Tests:** `tests/env-placeholder.test.mjs` (4) and `tests/test_env_placeholder.py` (5): every setting in the real `.env.example` reads as unset, a real value is never
mistaken for the placeholder, a `.env` copied from the example loads empty, and a fresh interpreter imports the War Room config from one. `tests/task-cli.test.mjs` (+1):
delete through both CLIs. Browser checks were not rerun: no page changed.

## 2.24.1 - An audit: one real bug fixed, and dead weight removed

Found by a full-repo audit (a new scanner plus a read of what it flagged). Nothing here changes the War Room or the dashboard.

**Fixed**
- **`mission-cli` ran the schedule CLI as well.** It imported `printTaskTable` from `schedule-cli.ts`, and that file calls `main()` as soon as it is
  imported, so every `mission-cli` command also ran `schedule-cli` on the same arguments. `create` stored **two** tasks (a `msn_` and a `tsch_` one)
  and printed two replies, so a mission would have fired twice. The shared parts now live in `src/task-cli-shared.ts`, which has no side effects.
  Checked against a throwaway database: the old code fails the new test, the new code passes. The real database holds no scheduled tasks, so
  no duplicates were left behind.

**Removed**
- **`@google/genai`**: never imported anywhere (Gemini is called over plain `fetch`). 35 packages leave `node_modules`, 17 leave the lockfile.
- Two old composite images, `public/card-states/warroom-cards-idle.png` and `-clean.png` (1.3 MB): named nowhere in the repo.
- `modelRange()` and `embeddingToHex()`: no production code called them, only their own tests (those tests went with them; the hex-string reading
  that older rows need is still tested).

**Changed (same behavior, less code)**
- `schedule-cli` and `mission-cli` share one `create` path (`createTaskFromArgs`) instead of two copies of the same 20 lines.
- `memory-ingest.ts` builds its 10-field memory record once (`save()`), not twice.
- `provider-config.ts` copies its defaults with `structuredClone` instead of a JSON round trip.

**Tests:** `tests/task-cli.test.mjs` (5) runs both built CLIs against a throwaway database and pins ids, replies, the 1-5 priority clamp, bad-cron
and missing-argument errors, and "one command stores one task".

**Looked at and left alone, on purpose:** the sequential `await`s in loops (the scheduler runs due tasks one at a time deliberately; the rest are
poll and retry loops); the 10 empty `catch` / `except OSError: pass` blocks (each narrow and commented: a process that is already gone, an optional file);
the exports that only tests use but the file itself calls (test seams); the legacy `individual/*.png` card art (6.9 MB, the fallback when the
manifest is missing: it overlaps the unfinished visual Build); `chars/` and `frames/` (intermediates of the card-art scripts).

## 2.24.0 - The action buttons are icons with tooltips

**Changed**
- **Attach, Send, Convene, Build, Hush and the five Pin buttons now show only an icon.** Paperclip, paper plane, a group of people,
  a hammer, a muted speaker, and a pushpin. Each keeps its name for screen readers (`aria-label`, so they still hear "Send" and "Build the
  verdict") and shows a tooltip when you point at it **or tab to it**, drawn by CSS from `data-tip`. A `title` attribute was not used: it
  is slow and never appears on keyboard focus. The tooltips say what the button really does, e.g. Hush: "stop the spoken replies (a running
  task keeps going)", Pin: "plain messages go to them instead of Main". Targets are 48px wide (the Pin buttons 44).
- **Cancel run keeps its words.** Its text becomes "Cancelling..." and "Retry cancel" as the cancel progresses, and it ends a real run;
  an icon cannot say that.
- **Build and Hush moved up into the message-box row.** Narrow buttons no longer need a row of their own, so the dock is one row shorter
  and the transcript gets the height back. Send, Convene, Build and Hush wrap together on narrow windows.
- **Pin buttons report their state.** `aria-pressed` follows the pinned agent and the tooltip switches to "Unpin ...". Client 43.

**Fixed**
- A browser check ("building shows every card in its building art") failed once after a core restart because it read the card images the
  instant the page opened, before a cold cache had delivered them. It now waits up to 5 seconds for them (and still fails if they never load).

**Removed:** the quill and three-crowns icons (replaced by the plane and the people), so the sprite has no unused symbols.

**Tests:** `tests/warroom-iconbuttons.test.mjs` (8) and 7 browser checks that use a real mouse and the real Tab key: nothing shows until you
point or tab, every tooltip shows, and the pin state and wording round-trip. All eight rules (name removed, tooltip not starting with the name,
a duplicate `title`, Hush claiming to stop a run, no keyboard-focus tooltip, no pressed state, a 36px target, words creeping back onto a button)
were broken on purpose and caught. 274 Node and 139 Python on a clean export of what is staged; 186 browser checks on the working folder.
The first versions of two icons did not read at full size and were replaced after cropping a screenshot at native resolution: a ring of five
dots for Convene looked like a molecule, and a hammer next to a small box for Build looked like an edit-note icon. Tooltips on a touch screen
appear on tap-focus; that was not tried on a real phone.

## 2.23.0 - New hold-to-talk button, and the message box stays on screen

**Added**
- **The hold-to-talk button is now the gold-ringed microphone art you supplied.** The original was 87px, which goes soft at button
  size, so one larger version was generated from it (same double gold ring, same lit capsule), its gold toned down about 15% to match
  the page, and saved as `public/warroom-mic.webp` (320px, 28KB, transparent corners). "Hold to talk / or hold Space" stays as real text
  under it, so the button still has its name. Holding it rings the picture in red and pulses; it stops pulsing for people who ask for less
  motion; when the mic is unavailable it dims and loses its colour. Hover glows. The old horn icon is removed from the sprite.
- **The message box can no longer fall off the bottom of the screen.** The attach, message, Send, Convene, Build and Hush rows now sit in
  one dock that sticks to the bottom of the window while the page is taller than it (it was below the fold at 1080p once the cards grew).
- **The transcript is shorter while idle on wide screens** (36% of the window height from 1500x760, was 45%), and gets its 45% back as soon
  as a run starts and the cards shrink. Client 42.

**Tests:** `tests/warroom-mic.test.mjs` (5: the file is a real transparent 320px WebP under 60KB, it is on the server's allowlist and carries
the version query, the picture is hidden from assistive tech with the captions as the name, every state is styled, the dock holds both rows,
the log rule comes after the base rule) and 10 browser checks (the picture is served as `image/webp` and decodes at 320px, the name is intact,
the message box is on screen at 1440x900, 1600x900, 1920x1080 and 2560x1440, the log height at each). Five of the six rules were broken
on purpose and caught by the right test. The browser run also caught that the first version of the log rule never applied: it sat above the
base `#log` rule, and equal CSS specificity means the later rule wins; the unit test now checks the order. 266 Node and 139 Python on a clean
export of what is staged; 180 browser checks against the working folder.
Still true at 1080p: the page scrolls a little (the Voice panel's checkboxes are below the fold) and the idle status panel is taller than
it needs to be; both are worth shrinking next.

## 2.22.1 - The War Room cards are full size when idle, and bigger on a big screen

Reported with a screenshot: the five agent cards were small and a Build that was asked to enlarge them changed nothing.

**Fixed**
- **The cards were shrunk all the time, not only during a run.** The compact size (x0.62) was meant for "once a run has started", but
  it keyed on the stage chips (`recall`, `plan`, ...), and the page draws those the moment it loads. So the cards were permanently
  0.62 of their designed 184px, about 114px, on every screen. The page now marks a run itself (`body.ran`, set when the first stage
  arrives, also for a replay after a reload, and cleared before one), and only that shrinks the cards. Idle: full 184px.
  A finished run still leaves them compact so the log and verdict stay above the fold, as before.

**Added**
- **Cards scale up on big screens.** The row zooms x1.15 from 1500px wide, x1.3 from 1800px and x1.45 from 2200px (each also needs
  760 / 900 / 1100px of height), cards about 212 / 239 / 267px wide, text and Pin buttons with them. The in-run compact size scales the
  same way. Every step keeps the five cards on one row inside the 1400px page. Client 41.

**Also**
- `scripts/ui-check.mjs` uses the installed Google Chrome (`--headless=new`) when the Playwright headless shell is missing, which it
  was on this machine.

**Tests:** `tests/warroom-cards.test.mjs` (4: no shrink on the chips, the page marks and clears a run, every step is a valid media query,
every zoom fits the page width) and 6 browser checks (idle width at 1440 / 1600 / 1920 / 2560px, one row, the compact size at 1440 and
1920px). Each rule was broken on purpose and a test failed, including `and(` without spaces, which is a function token and made the
whole big-screen rule silently never apply (the browser check caught that during development).
Trade-off: at 1080p the message box is below the fold while idle (it already was; the log is 45% of the window).

## 2.22.0 - Stopping the War Room asks first when work is running, and the last two releases are repaired

Found while checking a real Build (`1199410e`, 12 minutes, $2.29) that was running as these changes were made. Details of what the
restart guard does and does not cover: [`docs/RUN-LIFECYCLE.md`](docs/RUN-LIFECYCLE.md).

**Added**
- **Stop War Room refuses while work is running.** A council, Build or reply now outlives its page, so "nobody is looking" no
  longer means "nothing is running", and stopping the server ends that work for good. The dashboard button (and
  `POST /api/warroom/stop`) now answers `409` with how many tasks are running; the dashboard asks *"Stop it anyway? The running
  work will be lost."* and only a yes sends `{"force": true}`. If the War Room cannot be asked (down, wedged) the stop goes ahead.
- **`GET /busy` on the War Room port** (server v23): plain HTTP, `{"busy": N, "server": 23}`, answered before any session exists.
  The older websocket `ping` also reports `busy`, but a websocket connection takes over a run that is waiting for its page, so
  the core uses it only as a fallback against a v22 server and never to poll.

**Fixed**
- **The published `v2.20.0` does not compile on a clean checkout** (`TS1005` at `src/warroom-html.ts:310`). Staging that release
  by line-number hunks left one `<script>` line in the wrong place in the committed file; the working folder was fine, so every
  test passed. `v2.21.0` already carried the corrected placement. Found by exporting exactly what is staged into an empty folder
  and building it there, which is now how a release is checked.
- **The published `v2.21.0` contained three hunks of an unfinished Build.** A Build was editing `src/warroom-html.ts` while that
  release was committed, and the whole file went in: the five agent card images were switched from `.png` to `.webp` (with lazy
  loading), the page background to `warroom-chamber-bg.webp`, and the static-asset list to both. None of those webp files is in the
  repository, so a fresh clone showed five broken portraits and no background, and one Node test failed. Those three hunks are
  taken back out; the Build's files and its edits stay in the working folder, uncommitted.

**Tests:** 257 Node on the clean export (+10: `warroom-busy.test.mjs` 7, `page-scripts.test.mjs` 3), 139 Python (+5, `test_probe.py`),
164 browser checks (+4: the stop button asks, declining sends nothing more, only yes sends `force`). `page-scripts.test.mjs` parses
every inline script of the dashboard, War Room and History pages; it was written after a `\n` inside a TypeScript template literal
broke the whole dashboard script while `tsc` and all 247 other tests stayed green. Each new rule was broken on purpose and a test
failed, including a hang that now fails fast. The first Python run also caught a deploy-breaking mistake: `websockets.serve` here is
the *legacy* API, whose `process_request` takes `(path, headers)`, not the newer `(connection, request)`.
The browser suite ran against the working folder (it needs the live core), not the clean export.

**Not deployed yet.** The running War Room is still server v22 and has work in progress, so it was not restarted. Until it is,
`/busy` returns 426 and the core asks by `ping`; the guard works either way (confirmed live: a stop request was refused with 409 and
the server kept running). Restarting the core, including a Build's own reboot step, is not guarded.

## 2.21.0 - War Room icons and a bigger hold-to-talk button, and the Python tests stop writing to your real history

**Added**
- **An original icon set for the War Room** (hand-drawn paths in one hidden sprite, drawn in the current text colour so they follow
  the royal palette): a clasp on Attach, a quill on Send, crowns on Convene council, a hammer on Build the verdict and a muted horn
  on Hush voices. They decorate the words rather than replace them, and are hidden from screen readers.
- **Hold to talk is now a 132px round gold-ringed button** with a horn, the caption *Hold to talk / or hold Space*, a pulsing red ring
  and a *Recording. Release to send* caption while held (no pulse with reduced motion). Its full name stays available to assistive
  tech, and the mic status line is now a polite live region.

**Fixed**
- **The message box placeholder was cut off** beside the wider buttons (*...or convene the council (Ctrl+En*). It is now
  *Ask an agent, or convene the council*; the Enter / Ctrl+Enter shortcuts moved into the box's accessible name and tooltip. The
  composer wraps on narrow windows, and Send and Convene wrap together instead of one stranding alone.
- **A hidden Cancel run button was drawn while idle.** The new button styles set `display`, which beats the browser's own `[hidden]`
  rule; `button.go[hidden]` now wins, and a browser check fails if anything marked hidden is ever drawn.
- **The Python tests wrote two junk rows into your real History.** Found while checking a real council's run: two cancelled
  *"should we ship?"* rows (0 s, $0) appeared in `store/council-runs.jsonl`. They came from `tests/test_detach.py` in 2.20.0: since
  2.20.0 a cancelled council writes a ledger row, and those tests never redirected it. They now use a temp folder (and a stubbed
  memory recall, which used to ask the live core), and wait for cancelled work to finish writing before the real paths come back.
  The two rows were removed by id from the ledger (backed up first; the other 44 rows are unchanged). **`npm run test:py` now
  fingerprints `store/council-runs.jsonl`, `summit-verdict.json` and `build-state.json` and fails if the suite changed any of them.**
- Client 40, so browsers drop the cached page.

**Tests:** 247 Node (+8, `tests/warroom-icons.test.mjs`: every icon points at a real symbol and none is unused or announced, every
button has a name, the placeholder fits, the mic keeps its label), 134 Python (unchanged count, now isolated and guarded), 160
browser checks (+7: icons render at 20px, the composer row stays on one line, the placeholder fits at 1100px, the mic is a 132px
round target and swaps its caption, nothing hidden is drawn). Each new rule was broken on purpose and a test failed, including the
store guard (it tripped on the first polluted run).

## 2.20.0 - A run survives its tab, and a stopped Build is written down

Reloading or closing the War Room page used to cancel whatever it was running. This was found when a real Build was cut off
by a reload at 12:37: Ops had already edited a file, and the Build left **no ledger row and no saved state**, so nothing
recorded what had changed on disk. Both halves are fixed. Full description: [`docs/RUN-LIFECYCLE.md`](docs/RUN-LIFECYCLE.md).

**Changed**
- **Work belongs to the server, not the tab.** A council, Build or reply keeps running when its page reloads or closes. The
  next page to connect is told to clear itself (`resume`), is replayed everything it missed from a bounded journal (2000
  messages), then gets live updates. Only **Cancel run**, an error, or restarting the War Room server stops a run. Finished
  work nobody collected is kept 10 minutes, then dropped. There is no "leave this page?" warning, because leaving is safe.
- **A stopped run is recorded.** Every cancelled (`cancelled`) or crashed (`crashed`) council or Build now gets a ledger row
  with the stage it was in (`interrupted_at`). A Build also records the files it had changed, including edits the live feed
  saw that the owner never got to report. If files were edited it saves its state and shows a card with **Fix** (finish the
  unfinished steps, then check and review); a page that reconnects gets the card back. A Build stopped before any edit saves
  nothing and leaves an earlier build's state alone.
- **History** labels the new outcomes. A cancelled Build is counted on its own and is **not** counted against the build success
  rate or the average cost (its spend still adds to the total).
- `ping` answers `busy`: how many tasks are running across every tab, including detached ones, so a restart can check first.
- Protocol `council-v8` (server 22, client 39): `resume`, and `you` (a line you typed, replayed with file **names**, never
  paths). The Cancel-run button logic moved into `public/warroom-cancel.js`.

**Fixed**
- The cosmetic *"Task exception was never retrieved: ConnectionClosedOK"* after a tab left (`thinking(False)` on a dead
  socket). A send to a tab that has gone is now absorbed in one place, and speech is not synthesized for nobody.
- Recording a stopped run can never replace the cancel being reported, or leave the meter looking busy, if the write fails.

**Not changed, on purpose.** Restarting the War Room server still stops running work (it lives in that process); check
`busy` first. Voice is switched off for a detached session. A reconnecting page can cancel a run it did not start (this is a
local, single-owner tool).

**Tests:** 238 Node + 1 (cancelled builds and the success rate), 134 Python (+20: 12 reload/takeover/replay/ordering/retire/busy,
7 stopped-build records and Fix, 1 cancelled council), 153 browser checks (+7: the replay starts clean, shows your question
with its file, and is idempotent). Each rule was broken on purpose and a test failed; two surviving mutations exposed missing
tests, which were added before release.

## 2.19.1 - A false "Claude is logged out" no longer sends a council to fallbacks, and attached files stay out of the history

Found by reading the logs of the first real council that used attachments (run `efadb592`, two pasted screenshots). The
screenshots reached the agents and were described correctly (the verdict quotes the voice panel's 116px button and the
rectangular `.go` buttons), so attachments work. Two problems showed up around them.

**Fixed**
- **One bad reading of the Claude login sent every agent to a fallback.** Between 12:28:41 and 12:29:06 four agents of that
  council (and an Ops message at 12:19:35) each got *"Claude is logged out"* and skipped Claude, while `claude auth status`
  run by hand said *logged in* every time (12 checks, serial and parallel, plus one under the bridge's own filtered
  environment). Claude's credentials file was rewritten at 12:29:06, the end of that window, which is consistent with a token
  refresh being read half-done, though that was not proven. The result: Main and Ops fell back to Codex, Research to Codex,
  and **Content had no usable route at all** (the plain-chat providers are skipped when tools are required), so it never
  answered and the verdict says its brand wording is unreviewed. A "logged out" reading is now checked **2 more times, 1.5 s
  apart (3 s at most)** before it is believed, and the check still fails open. A normal logged-in check still costs exactly one
  probe, concurrent agents still share one check, and every flap is logged (`claude auth: a logged-out reading did not repeat`
  with the readings) so you can see how often it happens; a login that is really gone is still reported, now 3 s later.
- **The attached-files block was glued onto the council question.** For a council the paths were appended to the question
  itself, so they became the history title (`/history` showed `...for send, convene, build, etc ....[Attached files`), the
  memory search text, the text saved to memory after the run, and the "Question" in the saved verdict. The council now takes
  the files separately: every agent's context still lists them, but the ledger, history title, memory recall and the saved
  memory see only what you typed. Direct messages already behaved this way.

**Tests:** 238 Node (4 new: one flap is not believed, a real logout is still reported after exactly the extra readings and a
short wait, an unreadable re-check fails open, five concurrent agents share one re-check), 114 Python (1 new: files reach the
verdict seat but not the ledger, recall query, recorded memory or verdict file). Each rule was broken on purpose (no re-check; re-checking a good
reading; the files back in the question) and a test failed every time.

**Needs a restart** of the core and the War Room (War Room server v21; the page and the protocol, `council-v7`, are unchanged).

**Known, not changed here:** closing or reloading the War Room tab cancels whatever the council or build is doing (by design,
`Session.close()`), and a cancelled Build is not recorded. This happened to a real Build at 12:37 (Ops had already edited a
file). Options, smallest first: warn before leaving while a run is active; let a run outlive its tab and replay its live events
to the next tab that connects (the proper fix); at least record a cancelled Build so the files it touched are listed.

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
