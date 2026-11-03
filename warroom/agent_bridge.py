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


def _safe_env():
    return {k: v for k, v in os.environ.items() if not any(h in k.upper() for h in SENSITIVE_HINTS)}


def _last_json_line(stdout):
    for line in reversed((stdout or "").splitlines()):
        if line.strip().startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


async def bridge(payload, timeout_s=DEFAULT_TIMEOUT_S):
    """Run one bridge op. Always returns a dict with `ok`; failures carry a readable `text`."""
    try:
        proc = await asyncio.create_subprocess_exec(
            shutil.which("node") or "node", AGENT_BRIDGE_PATH, "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT), env=_safe_env(),
        )
    except OSError as exc:
        return {"ok": False, "text": f"could not start the agent bridge: {exc}"}
    try:
        out, err = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode("utf-8")), timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        proc.kill()
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        return {"ok": False, "text": f"{payload.get('agent', payload.get('op'))} timed out after {timeout_s}s"}
    reply = _last_json_line(out.decode("utf-8", "replace"))
    if isinstance(reply, dict):
        return reply
    tail = err.decode("utf-8", "replace").strip()[-300:]
    return {"ok": False, "text": f"agent bridge failed (exit {proc.returncode}): {tail or 'no output'}"}


async def ask(agent, prompt, *, system="", schema=None, read_only=False, tools="preferred", max_turns=None,
              memory_query=None, resume=False, chat_id="warroom"):
    payload = {"op": "ask", "agent": agent, "prompt": prompt, "system": system, "chatId": chat_id,
               "readOnly": read_only, "tools": tools, "resume": resume}
    if schema:
        payload["schema"] = schema
    if max_turns:
        payload["maxTurns"] = max_turns
    if memory_query:
        payload["memoryQuery"] = memory_query
    return await bridge(payload)


async def recall(query, chat_id="warroom"):
    reply = await bridge({"op": "recall", "query": query, "chatId": chat_id}, timeout_s=120)
    return reply.get("context", "") if reply.get("ok") else ""


async def record(*, question=None, answer=None, agent="main", hive=(), chat_id="warroom"):
    return await bridge({"op": "record", "question": question, "answer": answer, "agent": agent,
                         "hive": list(hive), "chatId": chat_id}, timeout_s=300)
