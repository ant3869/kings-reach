# Roadmap ideas

Researched 2026-11-10 against v2.24.2 (`feature-scout` method). Labels: **V**erified (seen in code/data), **R**eported (outside source, linked), **I**nferred.

## Premise
A council of five AI roles investigates, debates, agrees a plan, then a Build carries it out (by default in King's Reach's own repo).
A win: a trusted plan, built, for about $2 and 10 minutes, that you can watch and stop.

## What 31 real runs show (V)
- $51.49 total, $1.66 a run, 9.3 min
- 77% reach a usable result
- Debate changed a mind in 14 of 17 summits
- Build progress bar is off: review is 24% of the time, weighted 12%

## Top five (ranked by score over effort)

| # | Idea | Why | Smallest slice | Effort |
|---|---|---|---|---|
| 1 | **Rate the result** | Nothing records if a result was *good* (V). Debate often doesn't beat cheaper baselines ([paper](https://arxiv.org/abs/2311.17371), [paper](https://arxiv.org/abs/2502.08788)) (R) | Thumbs up/down on result cards, shown in `/history`. **Done in 2.26.0 for `/history`**; the War Room result card still needs the run id sent over the wire | S |
| 2 | **CI** | Two broken releases (V, CHANGELOG 2.22.0) | **Done in 2.24.2** | S |
| 3 | **First-run checklist** | 42 settings; README "Run it" skips `npm run setup` (V) | README leads with setup; dashboard card from `/api/health` | S |
| 4 | **Spend limit** | No cap anywhere; one run cost $3.58 (V). People improvise budgets ([HN](https://news.ycombinator.com/item?id=44742710)) (R) | `COUNCIL_MAX_COST_USD`, off by default, checked between stages | S-M |
| 5 | **Safe Build undo** | Builds edit the live repo (V). People lose uncommitted work ([HN](https://news.ycombinator.com/item?id=47172238)) (R) | Save each Build's patch; later, undo only files you haven't touched since | M |

Stop signs: #1 if a single agent matches the council 7 times in 10; #4 if people raise the cap to "off"; #5 if patches fail to apply 1 time in 10.

## Also worth doing
- Re-weight the Build progress bar from history (S)
- Heartbeat for preflight and gate, already admitted in `docs/LIVE.md` (S)
- Threat model: which role holds which tool, vs prompt injection ([Willison](https://simonwillison.net/2025/Aug/9/bay-area-ai/)) (S, doc first)
- Skip `investigate` when memory already answers (M, risky; show "answered from memory")
- Point a Build at another folder (M; the gate is hard-wired to this repo)
- ~~Export a run as Markdown for another agent~~ **Done in 2.26.0**

## Moonshots
- Replay a past council with a different provider mix
- Overnight missions with Telegram approvals (stop if approvals pile up)
- Model routing learned from ratings (needs #1)

## Rejected
- **Parallel agent swarm:** human review becomes the bottleneck ([HN](https://news.ycombinator.com/item?id=46368739)) (R)
- **Auto "discard changes":** can destroy your own edits; #5 is the safe version
- **More debate rounds:** reported to hurt ([paper](https://arxiv.org/abs/2502.19130)) (R)
- **Remote or hosted access:** mass exposure of self-hosted assistants ([report](https://www.infosecurity-magazine.com/news/researchers-40000-exposed-openclaw/), vendor figures) (R)

## Similar projects
| Project | Lesson |
|---|---|
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | Three open issues for one failure ("Unable to generate final synthesis": [#64](https://github.com/karpathy/llm-council/issues/64), [#83](https://github.com/karpathy/llm-council/issues/83), [#113](https://github.com/karpathy/llm-council/issues/113)); a failed last step loses the run. King's Reach keeps partial results |
| [LoopTroop](https://github.com/looptroop-ai/LoopTroop) | Closest cousin; builds in worktrees, human-approved PRs (own README) |
| [hermes-war-room](https://github.com/Naroh091/hermes-war-room) | Same War Room idea over another agent system |
| [secure-openclaw](https://github.com/composio-community/secure-openclaw) | [#3](https://github.com/composio-community/secure-openclaw/issues/3): unauthenticated endpoint, open DMs |

## Not verified
- HN threads were read as comments only, by a sub-agent
- Infosecurity figures are from a security vendor; the NVD page was not readable
- No Reddit, no user interviews, no usage data beyond this machine
- `git stash create` (for #5) not yet tested on this repo
