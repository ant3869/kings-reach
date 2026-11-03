# King's Reach

Personal AI assistant hub with a five-role war room. A heavy task flows
debate → verdict (agreed plan) → build, with a build button executing the
agreed plan. Also: Telegram and WhatsApp bots, voice, memory, scheduler,
and a dashboard. Version 2.5.2. Working title — formerly claudeclaw.

## The five roles

- **Main — Hand of the King.** Coordinates the realm, decomposes problems,
  assigns the right specialist, and owns the final call.
- **Research — Grand Maester.** Finds facts, reads the code and the
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

Role cards live in `public/card-states/` (idle, thinking, speaking,
building strips).

## Run it

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm start
```

Other useful commands: `npm run dev`, `npm run setup`, `npm run status`,
`npm run verify`, `npm test`.

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
