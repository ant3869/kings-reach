---
name: agent-reach
description: >
  Read-only internet access through one CLI (`agent-reach`): search the web, read any page as clean text, search and
  read GitHub repos/issues/PRs, fetch YouTube metadata and subtitles, read V2EX. Use when you need external evidence and
  your built-in WebSearch/WebFetch is unavailable, fails, or returns a page shell instead of the body, or when you need
  a GitHub issue/PR thread or a video's subtitle text. Never posts, comments, logs in, or changes the machine.
metadata:
  homepage: https://github.com/Panniantong/Agent-Reach
  version: "1.6.1"
---

# Agent Reach (King's Reach edition)

One command: `agent-reach`. It prints one JSON object. It is read-only. Say "using the agent-reach skill (channel X)"
before you use it.

## King's Reach rules (these override anything below)

- The CLI is wrapped: owner-only subcommands (`setup`, `add`, `remove`, `login`, `logout`, `browser`, `update`,
  `configure`, `uninstall`, `skill`) are refused with `OWNER_ONLY`. Do not try to work around that. If a channel
  needs setup or a login, say so in your findings and continue with what you can reach.
- Never ask for, print, or handle passwords, cookies or keys. Never post, comment, like or message anything.
- Only these channels are ready: `web`, `github`, `youtube`, `v2ex`. Other platforms (Twitter/X, Reddit, Bilibili,
  Xiaohongshu, LinkedIn...) need the owner to add them: do not promise results from them.
- Privacy: `web read` sends the URL to the Jina Reader service and `web search` sends the query to Exa. Do not put
  secrets, private file contents or internal hostnames in a URL or query.

## Choosing a route

- Public content: try your own WebSearch/WebFetch first. Reach when they are unavailable, fail, or the result lacks
  the body you need (page shell, paywall stub, JS-only page, comment thread, subtitles).
- Snippets, page shells, comment counts and subtitle track lists are not body text, comments or subtitles. State
  which one you actually have, and never present a snippet as having read the page.
- `agent-reach channels` lists every channel, action and parameter. `agent-reach read <url>` picks the channel itself.

## Channels ready on this machine

| Channel | Action | What it does | Usage |
|---|---|---|---|
| `web` | `search` | Search the web (Exa semantic search) | `agent-reach web search <query> [--limit N]` |
| `web` | `read` | Read a web page as clean text | `agent-reach web read <url>` |
| `github` | `search` | Search repositories | `agent-reach github search <query> [--limit N]` |
| `github` | `read` | Repo + README, or an issue / PR with its comments | `agent-reach github read <owner/repo or link>` |
| `youtube` | `read` | Title, channel, date, description | `agent-reach youtube read <url>` |
| `youtube` | `search` | Search videos | `agent-reach youtube search <query> [--limit N]` |
| `youtube` | `subtitle` | Full subtitle text (manual or auto captions) | `agent-reach youtube subtitle <url> [--lang L]` |
| `v2ex` | `hot` / `node` / `read` / `user` | Topics, replies, profiles | `agent-reach v2ex hot [--limit N]` |

Do not use `youtube transcribe`: it spends the owner's speech-to-text quota.

## Results and errors

- `ok: true` -> content is in `items`; each has `title / url / author / published_at / text`.
- `ok: false` -> branch on `error.code` and follow `error.hint`:

| error.code | What to do |
|---|---|
| `OWNER_ONLY` | You tried a reserved command. Stop; report it, do not retry. |
| `NEED_SETUP` | A dependency or key is missing. Report it to the owner; continue with other sources. |
| `NEED_LOGIN` | Needs a login only the owner can do. Keep what you have; say login is required. |
| `UPSTREAM_BROKEN` | That platform is temporarily down. Say which and roughly why; never retry in a loop. |
| `TIMEOUT` | Retry once at most. A timeout is a network problem, not proof the platform needs a login. |
| `RATE_LIMITED` | Wait `retry_after_seconds`; do not switch backends. |
| `PLATFORM_BLOCKED` | The site wants a captcha or verification. Stop; use another source. |
| `BUSY` | Try again later; do not close or switch browsers. |
| `NOT_FOUND` | Check the link or id. |
| `BAD_INPUT` | Wrong arguments; run `agent-reach channels` for usage. |

On `PLATFORM_BLOCKED`, `RATE_LIMITED`, `NEED_LOGIN` or `BUSY`, stop this attempt. Do not retry with other accounts,
backends or browsers.

## Red lines

- Read only. Never write to any site.
- Ordinary queries never change dependencies, install anything, or update.
