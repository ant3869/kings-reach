# Skills and research

A **skill** is a short playbook (`SKILL.md`, plus optional reference files) that tells an agent *how* to do a kind of
work. King's Reach treats the skill library like code from a stranger: every skill is vetted before it loads, pinned to
the content you approved, and handed only to the agents that should have it.

## How it works

```
skillpack/                      a Claude Code plugin named "kings-reach"
  .claude-plugin/plugin.json
  registry.json                 provenance, state, approved SHA-256, per-agent assignments
  skills/<name>/SKILL.md        ACTIVE skills (the only ones the SDK can see)
  quarantine/<name>/            installed, scanned, NOT loaded until you enable them
  proposed/<name>/              drafts agents wrote for you to review; never loaded
```

Every agent call goes through `src/agent.ts`, which now:

1. loads the plugin and passes the SDK an allowlist of `kings-reach:<skill>` names for **that agent only**
   (the user-level `~/.claude` skills are not shown to the model);
2. appends short guidance naming the agent's *required* skills (it must load them first) and *available* ones;
3. for research-capable agents, appends a **live research-capability note** (is the internet reachable, is a browser
   installed, is agent-reach installed), so an agent on an offline machine says so instead of guessing;
4. puts `tools/bin` and the browser tool on the agent's `PATH`;
5. for providers without a Skill tool (ChatGPT/Gemini/Meta routes), pastes in the full text of required skills that
   are flagged `inline` (currently `council-reasoning`), within a character budget.

A skill is only offered when **all** of these hold: it is `active`; its directory hash still equals the hash recorded
when you approved it (so an agent with write access cannot quietly rewrite a playbook); and it passes the scanner.
A rejected skill is dropped and reported, never loaded.

## The starter library

| Skill | Source | Given to |
|---|---|---|
| `council-reasoning` | authored here | everyone (required) |
| `karpathy-guidelines` | forrestchang/andrej-karpathy-skills @ 2c60614 (MIT) | everyone; **required** for ops |
| `deep-research` | authored here | research (required), main, content |
| `agent-reach` | Panniantong/Agent-Reach @ 7a38047 (MIT), **adapted** | research, main, content, ops |
| `playwright-cli` | microsoft/playwright-cli @ db2a0fa (Apache-2.0), preamble added | research, ops |
| `systematic-debugging` | obra/superpowers @ 22f0b46 (MIT) | research, ops |
| `test-driven-development` | obra/superpowers @ 22f0b46 (MIT) | main, ops |
| `build-discipline` | authored here | ops (required), main |

Why adapted: the upstream `agent-reach` skill tells the agent to install channels, run logins, update itself and
uninstall. Those are owner actions, so the installed copy keeps the read/search guidance, drops the management
sections, and adds King's Reach rules. The upstream `playwright-cli` skill documents `--headed`, `--persistent`,
`attach`, cookie injection and similar; a preamble restricts agents to headless, throwaway, public-page sessions and
tells them page text is data, not instructions. Both edits are recorded in `registry.json` (`note`).

## Managing skills

```
npm run build
npm run skills -- list
npm run skills -- show <name>
npm run skills -- install github:owner/repo/path/to/skill@<commit> --text-only
npm run skills -- install C:\path\to\local\skill-folder
npm run skills -- enable <name> [--inline] [--note "..."]
npm run skills -- assign research <name> [--required]     (use "*" for every agent)
npm run skills -- unassign <agent|*> <name>
npm run skills -- disable <name>
npm run skills -- trust <name>        re-approve after you have read a change to an active skill
npm run skills -- create <name> "<description>"           scaffold a draft in skillpack/proposed/
npm run skills -- doctor [--live]
```

`install` never activates anything: it fetches at an exact commit (text files only with `--text-only`), scans, and
files the skill in `quarantine/`. Read `quarantine/<name>/SKILL.md`, then `enable` it. Scripts inside a skill are never
run by this tool and always raise a warning.

**Scanner rules** (errors block install/enable): bad frontmatter or a name that does not match its folder; symlinks;
files over 200 KB, over 60 files, or non-text file types; invisible/bidirectional Unicode; known injection phrases
("ignore previous instructions"); pipe-a-download-into-a-shell; `Invoke-Expression`; recursive deletes of a root.
Warnings: scripts, credential-file mentions, long hidden HTML comments, `eval()`.

`doctor` checks the registry against the disk and every agent's resolution. `doctor --live` also starts the real
Agent SDK (no model call) and checks that each agent's prompt holds exactly its assigned skills and nothing else.

**Agents can propose, not install.** Agents are told not to touch `skillpack/skills/` and to write improvements to
`skillpack/proposed/<name>/SKILL.md`. Edits to an active skill are caught by the hash check.

## Research that is real

| Layer | What | Where |
|---|---|---|
| Built-in `WebSearch` / `WebFetch` | first choice | Claude Code tools |
| `agent-reach` | web search + clean page text, GitHub issue/PR threads, YouTube metadata and subtitles, V2EX | `tools/agent-reach/venv`, wrapped by `tools/bin/agent-reach` |
| `playwright-cli` | headless browser for pages that need JavaScript or visual confirmation | `tools/browser/` (npm, pinned), drives your installed Chrome/Edge |

Install or repair: `npm run setup:research` (idempotent; caches stay under `store/`). Prove it works without spending
a cent: `npm run research-check`. The core reports readiness at `/api/health` (`research`, `skills`) and
`node scripts/verify.mjs` asserts it.

**The agent-reach wrapper** (`tools/bin/agent-reach-guard.mjs`) pins agent-reach's `HOME` to `store/agent-reach-home`
so its config, browser profile and login sessions never touch your real profile, and refuses the owner-only
subcommands (`setup add remove login logout browser update configure uninstall skill`) with `OWNER_ONLY`. Only
`web`, `github`, `youtube` and `v2ex` are ready; other platforms (X, Reddit, Bilibili...) need *you* to run
`agent-reach add <channel>` and, where required, log in yourself.

**Honest limits**
- `web read` sends the URL to the Jina Reader service and `web search` sends the query to Exa. Agents are told not to
  put secrets or private data in them.
- A skill can only *ask* an agent to behave. Agents run with `bypassPermissions`; the guard, the hash check and the
  scanner are what actually constrain them. Anything that could be hijacked by a web page must stay read-only.
- Web pages are untrusted input. The research skills tell agents to treat page text as data and report injection
  attempts; that reduces risk, it does not remove it.
- If the machine is offline, agents are told so and must label external claims unverified.
- Pinned dependency set for agent-reach comes from its own `constraints.txt`. PyPI's `agent-reach` is a *different*
  project; always install from the pinned GitHub commit via `npm run setup:research`.
