# Roadmap ideas

Researched 2026-11-10 against v2.24.1, with the `feature-scout` method: read the project's own words, measured its own run history,
read similar projects and what their users complain about, then ranked. Every claim carries a label:
**VERIFIED** (seen in a file, a command's output or a fetched page), **REPORTED** (someone else said it; link given),
**INFERRED** (reasoned from the above; say so). Nothing here is built yet unless it says **done**.

## The premise, in three sentences

King's Reach is a personal AI hub whose centre is a five-role council (Main, Research, Comms, Content, Ops) that investigates a task,
debates it, agrees a verdict (a plan), and then a Build step carries the plan out by editing files: by default **King's Reach's own repository**, since no agent config sets another folder (`src/agent.ts:192`, `warroom/schemas.py:55`). Around that sit
a dashboard, Telegram and WhatsApp bots, voice, memory and a scheduler. A win is a plan you trust, built into your files, for a few dollars
and about ten minutes, that you can watch while it happens and stop when you want (README; `docs/LIVE.md`; `docs/RUN-LIFECYCLE.md`).

## The pipeline, and what it measured on this machine

`recall > plan > investigate > debate > verdict > record` (read-only; `warroom/council.py:1-6`), then optionally
`preflight > execute > gate > review > reboot` (execute is the only stage that writes; `warroom/live.py:23`). More in [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md). Numbers are from `store/council-runs.jsonl`,
VERIFIED, **31 real runs** (the 15 `cancelled` rows are one test fixture, "should we ship?", each stopped within 1.3 s at no cost, so they are excluded):

| | |
|---|---|
| Spent | **$51.49** in total; mean **$1.66** a run; a summit that reaches a verdict **$1.66**, a Build **$2.00** |
| Time | mean 9.3 min; `investigate` is the longest council stage (247 s), `execute` the longest overall (432 s) |
| Outcomes | **77%** reach a usable result (verdict or built); 3 `needs_work`, 4 other partial endings |
| Debate | at least one councillor measurably changed their mind in **14 of 17** summits (the project's own rule, `warroom/mindchange.py`) |
| Progress bar | council weights are close to measured (investigate 45% vs 48.5%); **Build is not**: review is 24% of the time but weighted 12%, gate 0.4% but weighted 8% |

## What the project already admits it lacks

- No way to undo a Build safely: "Deliberately not added: a 'discard changes' button" because it could destroy your own uncommitted work (CHANGELOG 2.18.1).
- Preflight and gate "have no heartbeat", so a slow check cannot be told from a hung one (`docs/LIVE.md:40`).
- Two published releases were broken: v2.20.0 "does not compile on a clean checkout", v2.21.0 "contained three hunks of an unfinished Build" (CHANGELOG 2.22.0).
- No spend limit anywhere (VERIFIED: a search of `src/` and `warroom/` for budget/cap/limit settings finds none), and no CI (no `.github/`).
- Found while writing this: the README's own first step, "copy `.env.example` to `.env`", crashed the War Room on start. **Done** in this release, with tests.

## Top five, ranked

Scores are 0-3 for Fit / Value / Evidence / Risk (3 = safe) / Leverage; effort S about a day, M about a week, L more.
Rank = total over effort (S=1, M=2, L=4); ties go to stronger evidence. That puts the cheap items first. **If you can only do two, my pick is
#4 and #5 together**: they are the ones that protect your money and your files, and the roadmap's biggest worry is that Builds touch real files.

### 1. Rate the result, then learn from it   [Pipeline, S then M]   F3 V3 E2 R3 L3 = 14
- **Problem**: the project measures cost, time and whether minds changed, but never whether the result was **good**.
- **Evidence**: VERIFIED no rating field in the run record. REPORTED, and mixed: debate often does not beat cheaper baselines ([Smit et al., 2023-11-29, rev. 2024-07-18](https://arxiv.org/abs/2311.17371); [2025-02-12](https://arxiv.org/abs/2502.08788)); more rounds hurt and voting beat consensus on reasoning ([2025-02-26](https://arxiv.org/abs/2502.19130)); different models per agent was the one consistent fix; diversity and base-model strength matter most ([2025-11-11](https://arxiv.org/abs/2511.07784)). King's Reach already follows that advice (one debate round by default, a different provider per role), so the design is on solid ground, but nothing shows it **earns** its two minutes (115 s on average) on your work.
- **Smallest slice**: thumbs up/down and an optional reason on the verdict and result cards, stored in the run record, and `/history` showing rating next to cost, specialists convened and mind-changes.
- **Full vision**: a blind "council vs a single agent" test on ten real questions; feed ratings into the difficulty ladder.
- **Kill signal**: a single agent matches the council on 7 of 10; then make the council opt-in for light questions.

### 2. CI on every push and tag   [Quick win, S]   F2 V3 E3 R3 L2 = 13
- **Problem**: two broken releases shipped in four days of 17 releases.
- **Evidence**: VERIFIED no CI config exists; VERIFIED the two incidents above; REPORTED: similar projects show CI badges and test workflows (hex/claude-council, LoopTroop).
- **Smallest slice**: one workflow on `windows-latest` running `tsc`, `npm run build`, `npm test`, `npm run test:py`. Browser checks stay local.
- **Kill signal**: slower than 10 minutes or flaky; then run only typecheck and build.

### 3. A first-run checklist and an honest "Run it"   [Quick win, S]   F3 V2 E3 R3 L2 = 13
- **Problem**: 42 settings, and the README's "Run it" (`README.md:85`) never mentions `npm run setup`, which exists to ask for only what you enable.
- **Evidence**: VERIFIED both. The crash above shows the first-run path had never been walked as a stranger.
- **Smallest slice**: README leads with `npm run setup`; a dashboard card reads `/api/health` and lists what is configured, what is missing, and the one step to fix each.
- **Kill signal**: none; this is documentation plus a read-only card.

### 4. An opt-in spend limit and a visible running cost   [Trust, S-M]   F3 V3 E3 R3 L1 = 13
- **Problem**: nothing stops or warns about spend. A single run cost up to $3.58 here and the total is $51.49 over a few days, with no alarm at any point.
- **Evidence**: VERIFIED no cap exists; cost per agent is already recorded after every call (`warroom/council.py:91`). VERIFIED the mockup you supplied on 2026-11-09 ("reach the level of something like this") lists "Cost & Usage" among its memory entries; the app has no cost view beyond each run's own record. REPORTED: people improvise budgets with proxies and say to avoid agents that ignore usage limits ([HN, 2025-07-31](https://news.ycombinator.com/item?id=44742710)); parallelism "inflates token costs" ([HN, 2025-05-28](https://news.ycombinator.com/item?id=44116872)).
- **Smallest slice**: `COUNCIL_MAX_COST_USD` (default unset = today's behaviour). Check between stages, never inside a call; when over, stop like Cancel and say why. Show a running total on the status panel.
- **It must not**: kill a call mid-write, change anything when unset, or count a cancelled stage as free.
- **Test**: a fake bridge that reports cost; the run ends at the stage boundary, the record says `over_budget`, files are untouched.
- **Kill signal**: caps trigger so often that people raise them to "off".

### 5. A safe undo for Builds   [Trust, M]   F3 V3 E3 R2 L2 = 13
- **Problem**: a Build edits files in the same working tree you are editing, and the only way back is `git checkout`, which also throws away your own work.
- **Evidence**: VERIFIED the Build runs in the live repository (`src/agent.ts:192`; `warroom/build.py` checks `PROJECT_ROOT`) and the project chose not to add undo for that reason (CHANGELOG 2.18.1). VERIFIED it has already bitten the project itself (CHANGELOG 2.22.0). REPORTED: people lose uncommitted work to agents ([HN, 2026-02-26](https://news.ycombinator.com/item?id=47172238)); parallel-agent users fall back on git worktrees ([Khami, 2025-05-26](https://www.skeptrune.com/posts/git-worktrees-agents-and-tmux/)) but a worktree "is not an isolation boundary" ([Chaplinsky, 2026-07-30](https://fletch.sh/blog/git-worktrees-vs-clones-for-ai-agents/)).
- **What similar projects teach**: LoopTroop (closest relative: council planning, then build) isolates builds in worktrees and gates delivery on a human-approved PR (its own README, so marketing, not proof).
- **Smallest slice**: before `execute`, record a hash of every tracked file and capture the working tree with `git stash create` (it stores nothing and changes nothing; untracked files are not covered, which the card must say). After the Build, save the exact patch it made as `store/builds/<run>.patch` and show it on the result card. INFERRED: confirm `git stash create` on a scratch repo first.
- **Full vision**: a button that reverts **only files whose current hash still equals the one the Build left**. That answers the objection in the changelog: anything you touched since is skipped and listed, never overwritten.
- **It must not**: change or stash your tree, run when git is absent (say so instead), or touch a file you edited after the Build.
- **Test**: a scratch repo with a user edit, a Build edit and a later user edit; undo restores only the middle file.
- **Kill signal**: patches that cannot be applied cleanly more than one time in ten.

## The rest

| idea | bucket | effort | why, and the catch |
|---|---|---|---|
| Re-weight the Build progress bar from history | Quick win | S | Build weights are off (table above); 11 Builds is a small sample, so fit from the user's own runs and fall back to defaults |
| Heartbeat for preflight and gate | Pipeline | S | admitted in `docs/LIVE.md:40`; a worker thread that reports "still running" |
| Skip `investigate` when memory already answers | Pipeline | M | INFERRED saving of ~4 min on easy questions; risks a confident wrong answer, so only with a visible "answered from memory" note |
| Threat model for untrusted content | Trust | S (doc), L (guard) | the dashboard is loopback-only with host and origin checks (`src/http-guard.ts`, `warroom/config.py`: VERIFIED strong). The open question is a web page or message reaching an agent that can write; REPORTED: prompt injection led to `curl \| python` in an OpenClaw install ([2026-03-27, Part 4 read only](https://itmeetsot.eu/posts/2026-03-27-openclaw_webfetch/)); the "lethal trifecta" framing ([Willison, 2025-08-09](https://simonwillison.net/2025/Aug/9/bay-area-ai/)). INFERRED that King's Reach is exposed; write the table of which role holds which tool first |
| Point a Build at another folder | Pipeline | M | VERIFIED no setting does; the gate (`warroom/build.py`) is hard-wired to this repo's `tsc` and `py_compile`, so another project would need configurable checks first. INFERRED demand: ask whether you want to build things other than King's Reach itself |
| Pipeline overview doc | Quick win | S | **done**: [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) |

## Moonshots (bets, each with a kill signal)

- **Replay a past council with a different provider mix** and compare with what happened (the run record and the 14 archived verdicts are the data). Kill: replays too noisy to compare.
- **Overnight missions with an approval inbox on Telegram** (the scheduler and mission CLI exist). REPORTED tension: per-action approval is safe but tiring ([HN, 2026-01-30](https://news.ycombinator.com/item?id=46820783)). Kill: more than a few approvals a day.
- **Routing learned from ratings**: after idea 4, let rated outcomes tune which model a step gets. Kill: ratings too sparse.

## Rejected, with reasons

- **A swarm of parallel agents** (Paseo, swarmterm style): REPORTED review time becomes the bottleneck ([HN, 2025-12-23](https://news.ycombinator.com/item?id=46368739)); against a premise of deliberation, not volume.
- **An automatic "discard changes" button**: unsafe as stated; replaced by idea 1, which only reverts what you have not touched.
- **More debate rounds**: REPORTED to hurt ([2025-02-26](https://arxiv.org/abs/2502.19130)).
- **Remote access or a hosted version**: REPORTED mass exposure of self-hosted assistants ([Infosecurity, 2026-02-09](https://www.infosecurity-magazine.com/news/researchers-40000-exposed-openclaw/), vendor-sourced figures); loopback-only is a strength to keep.

## Similar projects looked at

| project | what it is (own README) | what its users report |
|---|---|---|
| [karpathy/llm-council](https://github.com/karpathy/llm-council) 26k stars | models answer, rank each other, a chairman writes the answer | VERIFIED three open issues for one failure, "Unable to generate final synthesis" ([#64](https://github.com/karpathy/llm-council/issues/64), [#83](https://github.com/karpathy/llm-council/issues/83), [#113](https://github.com/karpathy/llm-council/issues/113)): when the last step fails the whole run is lost. King's Reach records partial endings (`no_verdict`) |
| [LoopTroop](https://github.com/looptroop-ai/LoopTroop) | council planning, worktree builds, human-gated PRs | the only open issue returned is a dependency-bot dashboard; nothing learned from its users |
| [hermes-war-room](https://github.com/Naroh091/hermes-war-room) | a visual War Room over an existing agent system | one open issue, a display bug |
| [hex/claude-council](https://github.com/hex/claude-council) | asks several agents one question, shows answers side by side | no open issues returned |
| [secure-openclaw](https://github.com/composio-community/secure-openclaw) | personal assistant on messaging apps | [#3](https://github.com/composio-community/secure-openclaw/issues/3): an unauthenticated QR endpoint and unrestricted DMs |

Seen only as a one-line description (or a README opening that did not load usefully), so no verdict on them: Paseo, claude-code-router, swarmterm, FastGPT, crewAI.

## What I could not reach or verify

- Several Hacker News sources were read as comment threads only, by a sub-agent; the dates are the ones it reported. I confirmed that all nine non-HN links load and carry the expected titles, not that every claim in them is accurate.
- The NVD page (CVE-2026-33579) is script-rendered; I could not independently read its content. The Infosecurity figures come from a security vendor.
- The BrokenClaw series: only the opening of Part 4 was read. The MAST paper's submission date was not captured.
- The GitHub phrase search `multi-agent debate` returned nothing; no Reddit; no interviews or usage data beyond this one machine's 46 rows.
- `git stash create` behaviour on this project's repo is untested (idea 1); the visual rework in `store/build-state.json` is unfinished and not assessed.
