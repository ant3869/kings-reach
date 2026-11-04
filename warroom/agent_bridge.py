"""Async door into the Node side: agents, memory recall, hive mind (dist/agent-voice-bridge.js).

One JSON request on stdin, one JSON line back. Async subprocess, so a cancelled council
kills its agents instead of leaking them. Secrets are stripped from the child's environment
(the Node side reads .env itself).
"""

import asyncio
import json
import os
import shutil

try:
    from .config import AGENT_BRIDGE_PATH, PROJECT_ROOT
except ImportError:  # run as a script: python warroom/server.py
    from config import AGENT_BRIDGE_PATH, PROJECT_ROOT

SENSITIVE_HINTS = ("API_KEY", "TOKEN", "SECRET", "PASSWORD")
DEFAULT_TIMEOUT_S = 900
STREAM_LIMIT = 64 * 1024 * 1024  # one reply line can be a whole verdict; the 64 KiB default would raise mid-read


def _safe_env():
    return {k: v for k, v in os.environ.items() if not any(h in k.upper() for h in SENSITIVE_HINTS)}


def parse_line(line):
    """One stdout line -> (kind, dict). kind is 'activity' (live progress), 'reply' (the answer) or None (noise).

    The Node side also logs JSON lines (pino); only a dict with `ok` is an answer, only `event: activity` is progress.
    """
    line = (line or "").strip()
    if not line.startswith("{"):
        return None, None
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(data, dict):
        return None, None
    if data.get("event") == "activity":
        return "activity", data
    return ("reply", data) if "ok" in data else (None, None)


async def _read_stdout(stream, on_event, found):
    async for raw in stream:
        kind, data = parse_line(raw.decode("utf-8", "replace"))
        if kind == "reply":
            found["reply"] = data  # the last answer wins
        elif kind == "activity" and on_event:
            try:
                await on_event(data)
            except Exception:  # noqa: BLE001 - a broken observer must never fail the agent it is watching
                pass


async def bridge(payload, timeout_s=DEFAULT_TIMEOUT_S, on_event=None):
    """Run one bridge op. Always returns a dict with `ok`; failures carry a readable `text`.

    With `on_event`, the Node side streams live progress lines while the agent works (`await on_event(dict)`).
    """
    if on_event:
        payload = {**payload, "activity": True}
    try:
        proc = await asyncio.create_subprocess_exec(
            shutil.which("node") or "node", AGENT_BRIDGE_PATH, "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT), env=_safe_env(), limit=STREAM_LIMIT,
        )
    except OSError as exc:
        return {"ok": False, "text": f"could not start the agent bridge: {exc}"}
    found, errors = {}, []

    async def feed_and_wait():
        proc.stdin.write(json.dumps(payload).encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        await asyncio.gather(_read_stdout(proc.stdout, on_event, found),
                             _collect(proc.stderr, errors), proc.wait())

    try:
        await asyncio.wait_for(feed_and_wait(), timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        proc.kill()
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        return {"ok": False, "text": f"{payload.get('agent', payload.get('op'))} timed out after {timeout_s}s"}
    if found.get("reply"):
        return found["reply"]
    tail = b"".join(errors).decode("utf-8", "replace").strip()[-300:]
    return {"ok": False, "text": f"agent bridge failed (exit {proc.returncode}): {tail or 'no output'}"}


async def _collect(stream, chunks):
    chunks.append(await stream.read())


async def ask(agent, prompt, *, system="", schema=None, read_only=False, tools="preferred", max_turns=None,
              memory_query=None, resume=False, chat_id="warroom", on_event=None):
    payload = {"op": "ask", "agent": agent, "prompt": prompt, "system": system, "chatId": chat_id,
               "readOnly": read_only, "tools": tools, "resume": resume}
    if schema:
        payload["schema"] = schema
    if max_turns:
        payload["maxTurns"] = max_turns
    if memory_query:
        payload["memoryQuery"] = memory_query
    return await bridge(payload, on_event=on_event)


async def recall(query, chat_id="warroom"):
    reply = await bridge({"op": "recall", "query": query, "chatId": chat_id}, timeout_s=120)
    return reply.get("context", "") if reply.get("ok") else ""


async def record(*, question=None, answer=None, agent="main", hive=(), chat_id="warroom"):
    return await bridge({"op": "record", "question": question, "answer": answer, "agent": agent,
                         "hive": list(hive), "chatId": chat_id}, timeout_s=300)
