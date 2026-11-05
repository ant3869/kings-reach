# King's Reach

Personal AI assistant hub with a five-role war room. A heavy task flows
debate → verdict (agreed plan) → build, with a build button executing the
agreed plan. Also: Telegram and WhatsApp bots, voice, memory, scheduler,
and a dashboard. Version 2.14.2. Working title — formerly claudeclaw.

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
cancelled), an estimated progress bar, what each agent is doing right now, and spoken plus captioned commentary. Try it
for free with `/warroom?demo=build`, `build-fail`, `stall` or `summit`. See [`docs/LIVE.md`](docs/LIVE.md).

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
`npm run verify`, `npm test`. History: [`CHANGELOG.md`](CHANGELOG.md).

The war-room council is Python (see `warroom/`). Install its dependencies
with `pip install -r warroom/requirements.txt`, then run it as
`python warroom/server.py` (WebSocket transport, `ws://127.0.0.1:7860`
by default; port via `WARROOM_PORT`). The Node core can autostart the war
room — see `WARROOM_AUTOSTART` in `.env`.

## Configure

Copy `.env.example` to `.env` and fill in your own values. Never commit
`.env`. The war room and the Node core read the same `.env` file.

## License

MIT — see `LICENSE`.
