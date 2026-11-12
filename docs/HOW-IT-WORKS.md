# How a run works

One question goes in; a plan comes out (a **summit**); if you press Build, the plan is carried out (a **build**). Everything below
is read from the code (`warroom/council.py`, `warroom/buildflow.py`, `warroom/build.py`, `warroom/live.py`), and the numbers are measured
from one machine's run history, so yours will differ. You can watch any of it, free, with `/warroom?demo=summit` or `?demo=build`.

## The summit: deliberation only

Nobody can write or edit a file during a summit: the stages are read-only (`warroom/council.py:5`). Each stage returns a structured
answer that is checked against a schema, so a half-finished reply cannot slip through.

| stage | what happens | typical time |
|---|---|---|
| **recall** | looks up memory relevant to the question (the record keeps how many memory lines were used) | 1 s |
| **plan** | **Main** turns the question into an objective, success criteria and assignments (which specialist does what, and whether they need tools) | 44 s |
| **investigate** | each assigned specialist works its part with its tools (up to 24 tool-use turns each) and returns a recommendation, findings, evidence, risks and a confidence | 247 s |
| **debate** | the specialists cross-examine each other (one round by default, `COUNCIL_DEBATE_ROUNDS`; 0 skips it). Whether anyone **really** changed their mind is measured from their confidence and wording, not from what they say about themselves (`warroom/mindchange.py`) | 115 s |
| **verdict** | Main writes the agreed plan: steps with an owner, and the success criteria | 95 s |
| **record** | the verdict is saved and a line of metrics (time, cost, who changed their mind) is added to the run history | 8 s |

A summit that reaches a verdict has cost about **$1.66** here. Cancelling is final: it never retries (see the README).

## The build: where files change

Pressing **Build** runs the latest verdict. By default the build works in **King's Reach's own repository**: no agent sets a different
folder (`src/agent.ts:192`), and the agents are told "Repo root" is this project (`warroom/schemas.py:55`).

| stage | what happens | typical time |
|---|---|---|
| **preflight** | a cheap check **before any tokens are spent**: the TypeScript compiles, key browser and Python files parse | 3 s |
| **execute** | the owners carry out their steps of the plan (up to 40 turns) | 432 s |
| **gate** | checks only what changed: `tsc` for TypeScript, `node --check` for JavaScript, `py_compile` for Python | 2 s |
| **review** | a reviewer judges the result against the plan's success criteria, one by one | 138 s |
| **reboot** | the Node core is restarted, gracefully first, so the new code is the code that runs | |

A build ends as **built**, **needs_work** (the reviewer was not satisfied: you can re-check, fix only what was flagged, or keep the
files as they are, without redoing the plan) or **no_changes**. A build costs about **$2.00** here.

## Where everything lands

| file | holds |
|---|---|
| `store/summit-verdict.md` and `.json` | the latest agreed plan (the build reads the `.json`) |
| `store/verdicts/<run>.md` and `.json` | every verdict ever locked: the plan library |
| `store/build-state.json` | where the latest build stopped, so a follow-up can continue it |
| `store/council-runs.jsonl` | one line per run: stages, seconds, cost per agent, outcome, mind-changes. This is the history page's data |
| `workspace/council/<run>/` | deliverables that are not code (a document, a table) |
| `workspace/uploads/` | files you attached to a message |

Everything under `store/` and `workspace/` is yours and local; it is ignored by Git.

## Spend limit (`COUNCIL_MAX_COST_USD`)

- **Off by default.** Set it to dollars (`2`, `$2.50`) in `.env` and restart the War Room. Blank or `0` = off. A value that is not a positive number is **reported when the run starts** and means no limit, never a silent off.
- **Per run:** one council, or one Build, may spend up to the limit. The status line at the start says which limit applies.
- **Checked between stages:** a council before the specialists investigate and before the debate; a Build before each owner starts (never in the middle of someone's edits). The verdict is never skipped: it is the product and the cheapest paid stage. The review is not skipped either.
- **So it can overshoot:** a stage already running finishes, and several specialists run at once. Treat the limit as "stop starting new paid work", not a hard ceiling.
- **Only reported costs count.** Claude reports every call; Codex, Gemini, ChatGPT and Meta only sometimes. The stop message says so. (In this project's history Claude reported a cost on 78 of 78 agent-runs, the others on only 13 of 45.)
- **When it stops:** outcome `over_budget` in the ledger and the Plan Library, everything said so far stays in the log, and a Build that already changed files keeps them and offers **Fix**, exactly like a cancelled one. It stays out of the build success rate; its spend still counts.

## Getting started card and provider re-check (dashboard)

- Every line is a real check, not a guess: `.env` exists, Claude signed in, a fallback model ready, War Room running, a first council run, and (optional) Telegram. Each undone line says what to do. Source: `GET /api/setup`.
- **Set up but not answering** (separate list): a provider you configured whose last call failed, with the reason in plain words. Out of credit points at that provider's billing page.
- **Re-check** (OpenAI, OpenRouter, Gemini): one tiny call, under a cent, to the model you already route to, and only when you press it. It records the result, so Settings stops showing an old failure. `POST /api/providers/:id/check`.
- A failed provider heals itself too: the router tries every route in order and ignores that flag, so the first success clears it. Providers late in a ladder (OpenAI is last for Comms and Content) may not be reached for a while, which is what Re-check is for.
- Hidden when nothing needs attention.

## The crest, the launcher icon and the royal look

- **Crest:** `public/brand/kr-crest-source.png` is the one source image. `python scripts/make-brand.py` rebuilds every size from it (square, never stretched; the tiny sizes use the shield alone): the nav seal, the War Room title, the tab icon (`favicon.ico`), the iOS icon and `kings-reach.ico` for the shortcut.
- **Launcher:** `npm run shortcut` (Windows) makes a **King's Reach** icon on the Desktop and in the Start menu. It runs `scripts/launch.ps1`: if the dashboard already answers, it only opens the browser; if not, it starts the core hidden (logs in `store/logs/core.log`), waits up to a minute, then opens it. Re-run it if you move the project folder.
- **Royal look is on by default** in the War Room. `/warroom?royal=0` turns it off (remembered per browser address); `?royal=1` brings it back. A browser you have not used before, or a different address (`localhost` vs `127.0.0.1`), starts from the default.
- **Silent runs:** if "Agents speak aloud" is unticked the page says so when you send. If the browser is still holding sound back, it says so once, keeps the clips, and plays them all after your next click or key press.

## Rate and share a run (Plan Library, `/history`)

- **Was this useful?** Useful / Not useful on any run; click again to clear. Saved to `store/ratings.jsonl` (append-only, last answer wins; the run ledger is never edited). The page shows "Rated useful: n of m".
- **Download Markdown / Copy Markdown** gives one file with everything about the run: facts, question, the plan with the council's takes, the builds that executed it, changed files, check output, timings, cost per agent, deliverables (each cut at 20,000 characters, with the path to the full file) and any other recorded fields.
- Meant for handing to another agent. API keys and anything shaped like one are redacted first, and the file says so. Your own project paths and file names stay in.
- API: `GET /api/history/:id/export.md`, `POST /api/history/:id/rating` with `{"value": 1 | -1 | 0}`.

## Reading the numbers

Over 31 real runs here: mean 9.3 minutes, 77% reached a usable result (a verdict or a built change), total spend $51.49. In 14 of 17
summits at least one specialist measurably changed their mind during the debate. See [`ROADMAP.md`](ROADMAP.md) for what these numbers suggest.
