<p align="center">
  <img src="docs/banner.png" alt="King's Reach: the AI council for command, build, and execution" width="100%">
</p>

# King's Reach

Personal AI assistant hub with a five-role war room. A heavy task flows
debate → verdict (agreed plan) → build, with a build button executing the
agreed plan. Also: Telegram and WhatsApp bots, voice, memory, scheduler,
and a dashboard. Version 2.24.2.

## The five roles

- **Main — Hand of the King.** Coordinates the realm, decomposes problems,
  assigns the right specialist, and owns the final call.
- **Research — Grand Master.** Finds facts, reads the code and the
  sources, cites evidence, distrusts claims without proof. Deep dives,
  competitive analysis, market research.
- **Comms — Master of Whisperers.** Thinks about the people involved:
  users, stakeholders, how it will be received and explained. Email,
  Slack, LinkedIn, all communications.
- **Content — Royal Bard.** Owns clarity, naming, copy, UX wording, and
  the creative angle nobody else considered. Writing, editing,
  publishing, brand voice.
- **Ops — Master of War.** Owns feasibility, implementation,
  infrastructure, cost and risk. System admin, deployments,
  infrastructure, backups.

Role cards live in `public/card-states/`; each seat picks its own art
variant per state from weighted pools (`manifest.json`). Past councils and
builds are browsable at `/history`.

## Seeing what the agents are doing

The War Room shows a live status panel for every council and build: a badge (working, quiet, stalled, done, failed,
cancelled, or needs review), an estimated progress bar, what each agent is doing right now, and spoken plus captioned commentary. Try it
for free with `/warroom?demo=build`, `build-fail`, `build-review`, `stall` or `summit`. See [`docs/LIVE.md`](docs/LIVE.md).

Attach files, screenshots or documents to any message (paperclip, drag-and-drop, or paste a screenshot) in the dashboard
console and the War Room; the agent opens them itself. Up to 5 files of 20 MB per message. Details and safety rules:
[`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md).

When a build finishes, a result card says what happened and whether your files are still changed. If the reviewer was not
satisfied you can re-check, fix only what was flagged, or keep the files as they are, without running the whole plan again.

## Providers and adaptive models

Each role routes to an ordered list of providers: Claude (Agent SDK), Codex CLI, the OpenAI and Gemini APIs, OpenRouter,
Ollama, 9Router (ChatGPT and Meta models), and three full-trust agent harnesses (**OpenClaw**, **Hermes Agent**, **Code
Puppy**) that bring their own tools. Routes are set per
role in Settings (`/providers`) from dropdowns of valid models only.

**Difficulty tiers** (switch on in Settings) pick the model by how hard the step is. Each provider has its own ladder: choose the
weakest (Low) and strongest (High) model you accept and everything ranked between them is allowed. A step is rated from
trivial to very hard (council steps by their job; free-form messages by a small model fitted to how much work your own past prompts really caused, see `npm run difficulty:calibrate`) and lands on the matching rung, so
an in-between task gets an in-between model. A role never leaves its own provider: a role on OpenAI uses OpenAI's range, and
only Claude roles can reach Opus. Quick, tool-free steps also skip loading MCP servers, so they answer faster.

## Stopping a run

Any run can be cancelled, and cancelling really stops it. **Dashboard:** a Stop button appears next to Send while the console is
working. **Telegram:** `/stop` cancels the run in progress and clears whatever is queued behind it. **API:** `GET /api/runs` lists what
is running; `POST /api/runs/cancel` with `{"id": ...}`, `{"chatId": ...}` or `{"all": true}` stops it (an empty body stops nothing).
**War Room:** its own Cancel button, which now also ends the agent's whole process tree. Reloading or closing the page does **not** cancel a run: it keeps going and the next page is caught up ([how](docs/RUN-LIFECYCLE.md)); a run you do cancel is written to the history. **Stop War Room** on the dashboard refuses while a run is going and asks before it ends one.

A stop is final: it never retries and never falls through to the next provider, a cancelled scheduled task stays scheduled instead of
being marked failed, and the Claude CLI and every command it started (a build, a long test run) are ended together rather than left
running in the background.

## Skills and research

Agents follow a vetted, integrity-checked skill library (`skillpack/`) and
can research with the built-in web tools, `agent-reach` and a headless
Playwright browser. Skills are scanned, quarantined until you enable them,
assigned per role, and refused if their content changes after approval.
See [`docs/SKILLS.md`](docs/SKILLS.md).

```sh
npm run setup:research     # install browser + agent-reach tooling (pinned)
npm run research-check     # prove it works, no model cost
npm run skills -- list     # the library and who gets what
npm run skills -- doctor --live
```

## Run it

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm start
```

Other useful commands: `npm run dev`, `npm run setup`, `npm run status`,
`npm run verify`, `npm test`, `npm run difficulty:calibrate` (refit the free-form difficulty model; add `--write` to save it), `npm run test:py` (War Room), `npm run ui-check` (real browser). History: [`CHANGELOG.md`](CHANGELOG.md).

The war-room council is Python (see `warroom/`). Install its dependencies
with `pip install -r warroom/requirements.txt`, then run it as
`python warroom/server.py` (WebSocket transport, `ws://127.0.0.1:7860`
by default; port via `WARROOM_PORT`). The Node core can autostart the war
room — see `WARROOM_AUTOSTART` in `.env`.

## Configure

Copy `.env.example` to `.env` and fill in your own values. Never commit
`.env`. The war room and the Node core read the same `.env` file.

## Docs

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md): what each stage of a summit and a build does, what it costs, and where the results land.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): researched ideas for what to build next, ranked, with the evidence behind each.
- [`docs/LIVE.md`](docs/LIVE.md): how the War Room shows what is happening, and the wire protocol versions.
- [`docs/RUN-LIFECYCLE.md`](docs/RUN-LIFECYCLE.md): what happens to a run when the page goes away, and how Stop War Room stays safe.
- [`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md): sending files, screenshots and documents to an agent.
- [`docs/SKILLS.md`](docs/SKILLS.md): skills and research.
- [`scripts/WINDOWS_NOTES.md`](scripts/WINDOWS_NOTES.md): run King's Reach as a Windows startup task.
- [`CHANGELOG.md`](CHANGELOG.md): every release.

## License

MIT — see `LICENSE`.
