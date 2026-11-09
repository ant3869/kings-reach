# Attachments: sending files, screenshots and documents to an agent

Added in v2.19.0. Works in the dashboard console and the War Room (a single agent, an `@agent:` message, or a council).
Telegram has its own media handling (`src/media.ts`) and shares the same upload folder and cleanup.

## Using it

- Click the paperclip, drop files on the chat, or paste a screenshot into the message box. Pasted *text* is untouched.
- Each file uploads the moment it is chosen and appears as a chip (name, size, thumbnail for images, remove button).
- A message may be files only; it is sent as "Please look at the attached file(s)."
- Send is held, with the reason on screen, while a file is uploading or has failed. Removing a chip deletes the file from
  the server, even if it was still uploading.
- Limits: 5 files per message, 20 MB each, no empty files (`MAX_FILES`, `MAX_FILE_BYTES` in `src/attachments.ts`).

## What the agent receives

The page sends **upload ids, never paths**. The server looks each id up and appends this to what the agent reads:

```
[Attached files: the user attached these. Open each with your file tools (images and PDFs too) before you answer.]
- shot.png: H:\...\workspace\uploads\1731000000000-a1b2c3_shot.png
[end of attached files]
```

The agent opens the files with its own tools, so only a route that has tools can read them (Claude, Codex and the full-trust
harnesses; not the plain chat APIs). A message with an attachment is therefore **never** run tool-less, whatever its difficulty.

What does *not* see the block: the difficulty score (same question, same model, with or without files), the memory search,
the saved conversation history, the council ledger / history title, and the memory written after a run. Council agents all
see it in their shared context (`attached` argument of `Council.deliberate`).

## Safety

- An id must match `<13+ digits>-<6 hex>_<cleaned name>` and name a regular file inside `workspace/uploads`; anything else
  (`../../.env`, `C:\Windows\win.ini`, `/etc/passwd`, another folder's file) is refused before a run starts, on **both**
  servers. The pattern lives in `src/attachments.ts` and `warroom/attachments.py`: keep them identical (a test on each side
  pins the wording and the pattern).
- File names are cleaned (`sanitizeFilename`) and can never leave the uploads folder; the page draws names as text, not HTML.
- Upload routes sit behind the same host / same-origin / token guard as every other write.

## Where things are

| Piece | File |
|---|---|
| Store, resolve, remove, hourly sweep | `src/attachments.ts` |
| The prompt block (pure) | `src/attach-format.ts`, `warroom/attachments.py` |
| Routes | `POST /api/upload` (raw body, `x-filename` header), `DELETE /api/upload/:id`; `/api/chat` and the War Room `text` / `summit` messages take `attachments: [ids]` |
| Page code (both pages) | `public/kr-attach.js`, `src/attach-css.ts` |
| Cleanup | uploads older than 24 hours are deleted hourly while the core runs |

## Troubleshooting

- *"x is no longer available (uploads are kept for 24 hours): attach it again"*: the file was swept; attach it again.
- *The agent says it cannot see the file*: look in `store/logs/bridge.log` (War Room) or `core.log` (dashboard) for the route
  that answered. A tool-less route cannot open files; the run should have used one, so report it.
- Verified end to end on real runs: an uploaded screenshot was described correctly, and a council reading two attached
  screenshots quoted details from both (run `efadb592`).
