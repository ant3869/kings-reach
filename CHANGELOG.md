# Changelog

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
