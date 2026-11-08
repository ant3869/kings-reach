"""Live visibility for council and build runs.

The Node bridge streams what each agent is ACTUALLY doing (tool calls, turns, route changes). This module turns that
stream into three things: UI updates, a short spoken running commentary, and an honest progress estimate.

Commentary is templated from real events, so it costs nothing and cannot invent progress. Turn counts and file
counts are measured; the percentage is an estimate (a stage can finish early) and is labelled that way in the UI.
"""

import asyncio
import contextlib
import re
import time
from collections import Counter

QUIET_S, STALL_S = 45, 90   # the page uses the same numbers for its amber / red "gone quiet" warnings
NARRATE_GAP_S = 22          # routine spoken updates: at most one per this many seconds, room-wide
URGENT_GAP_S = 6            # fallbacks and stalls may interrupt that, but still not machine-gun
SUMMARY_EVERY_S = 50
TICK_S = 5

COUNCIL_PHASES = (("recall", 3), ("plan", 10), ("investigate", 45), ("debate", 20), ("verdict", 17), ("record", 5))
BUILD_PHASES = (("preflight", 4), ("execute", 72), ("gate", 8), ("review", 12), ("reboot", 4))
# Follow-ups continue a finished build, so they only have the later phases (their own progress bars, never a fake preflight).
FOLLOWUP_PHASES = {"fix": (("execute", 70), ("gate", 10), ("review", 15), ("reboot", 5)),
                   "review": (("gate", 15), ("review", 80), ("reboot", 5)),
                   "accept": (("reboot", 100),)}
PROVIDER_NAMES = {"claude": "Claude", "codex": "Codex", "chatgpt": "ChatGPT", "gemini": "Gemini", "meta": "Meta"}


def count(n, noun):
    """'1 file' / '2 files': spoken and shown text must not say '1 actions'."""
    return f"{n} {noun}{'' if n == 1 else 's'}"


def spoken_name(path):
    """'src/agent-voice-bridge.ts' -> 'agent voice bridge': something a voice can say."""
    base = re.split(r"[\\/]", path or "")[-1]
    stem = base.rsplit(".", 1)[0] if "." in base[1:] else base
    return re.sub(r"[-_.]+", " ", stem).strip() or "a file"


def _norm(path):
    return (path or "").replace("\\", "/").lstrip("./").lstrip("…").lower()


def same_file(a, b):
    """Paths from different sources: repo-relative, backslashed, or shortened with a leading ellipsis."""
    a, b = _norm(a), _norm(b)
    return bool(a and b and (a == b or a.endswith(b) or b.endswith(a)))


class Meter:
    """Weighted progress across named phases. Never reaches 100 until finish(): estimates must not lie about done."""

    def __init__(self, phases):
        self.phases = tuple(phases)
        self.done, self.frac = set(), {}

    def set(self, phase, frac):
        self.frac[phase] = max(0.0, min(0.95, float(frac)))

    def complete(self, phase):
        self.done.add(phase)

    def pct(self):
        total = sum(w for _, w in self.phases) or 1
        got = sum(w * (1.0 if p in self.done else self.frac.get(p, 0.0)) for p, w in self.phases)
        return min(99, int(round(100 * got / total)))


class Tracker:
    """Everything one agent call has visibly done so far."""

    def __init__(self, agent, now=time.monotonic):
        self.agent, self._now = agent, now
        self.reset()

    def reset(self):
        self.t0 = self.last = self._now()
        self.turn = self.max_turns = self.events = self.routes = 0
        self.tools, self.reads, self.edited = Counter(), set(), []
        self.doing, self._new_edit = "", None
        self._stalled_said, self._summary_t, self._summary_events = False, self.t0, 0

    def idle_s(self):
        return self._now() - self.last

    def turn_frac(self):
        return (self.turn / self.max_turns) if self.max_turns else 0.0

    def feed(self, ev):
        """Absorb one bridge event; returns the message the page should get."""
        kind = ev.get("kind")
        self.last, self.events, self._stalled_said = self._now(), self.events + 1, False
        target = ev.get("target") or ""
        if kind == "turn":
            self.turn = int(ev.get("turn") or self.turn)
            self.max_turns = int(ev.get("maxTurns") or self.max_turns)
        elif kind == "tool":
            self.tools[ev.get("tool") or "tool"] += 1
            if ev.get("edit"):
                if target and not any(same_file(target, e) for e in self.edited):
                    self.edited.append(target)
                    self._new_edit = target
            elif ev.get("tool") == "Read" and target:
                self.reads.add(target)
            self.doing = ev.get("text") or self.doing
        elif kind == "route":
            self.doing = ev.get("text") or self.doing
            if ev.get("state") == "try":
                self.routes, self.turn, self.max_turns = self.routes + 1, 0, 0  # a new route counts its own turns
        return {"type": "activity", "agent_id": self.agent, "kind": kind, "text": ev.get("text", ""),
                "state": ev.get("state"), "target": target or None, "edit": bool(ev.get("edit")),
                "provider": ev.get("provider"), "turn": self.turn, "max_turns": self.max_turns,
                "reads": len(self.reads), "edits": len(self.edited), "tools": sum(self.tools.values())}

    def propose(self, ev=None):
        """(text, urgent) worth saying aloud now, or None. Pure: the caller decides whether the room may talk."""
        if ev is not None:
            state = ev.get("state")
            if state == "salvage":
                return "I ran out of turns. Wrapping up from what I already gathered.", True
            if state == "failed":
                who = PROVIDER_NAMES.get(ev.get("provider"), ev.get("provider") or "That route")
                return f"{who} could not finish. Trying the next route.", True
            if ev.get("kind") == "tool" and ev.get("edit") and self._new_edit:
                name, self._new_edit = spoken_name(self._new_edit), None
                return (f"First change, in {name}." if len(self.edited) == 1 else f"Now changing {name}."), False
            return None
        now = self._now()
        if self.idle_s() >= STALL_S and not self._stalled_said:
            self._stalled_said = True
            return f"Nothing new from me for {int(self.idle_s())} seconds. Either a long step, or I am stuck.", True
        # A summary says "still on it", so it is only true if something happened recently; silence gets the warning above.
        if (now - self._summary_t >= SUMMARY_EVERY_S and self.events > self._summary_events
                and self.idle_s() < QUIET_S):
            self._summary_t, self._summary_events = now, self.events
            if self.edited:
                return f"Still on it. {count(len(self.reads), 'file')} read, {len(self.edited)} changed.", False
            if self.reads:
                return f"Still on it. {count(len(self.reads), 'file')} read so far.", False
            return f"Still working. {count(sum(self.tools.values()), 'action')} so far.", False
        return None

    def compare(self, claimed):
        """(claimed but never seen, seen but never claimed): did the report match what we watched happen?"""
        unseen = [c for c in claimed if not any(same_file(c, e) for e in self.edited)]
        unreported = [e for e in self.edited if not any(same_file(e, c) for c in claimed)]
        return unseen, unreported


class Live:
    """Binds trackers + meter to a room. Room contract: send(dict), narrate(agent_id, text)."""

    def __init__(self, room, phases=COUNCIL_PHASES, now=time.monotonic):
        self.room, self._now = room, now
        self.meter, self.trackers = Meter(phases), {}
        self.phase, self.expected, self.finished, self.running = "", 0, 0, set()
        self.caption, self._last_spoken = "", -1e9

    def tracker(self, agent):
        return self.trackers.setdefault(agent, Tracker(agent, self._now))

    # --- progress ---------------------------------------------------------------------------
    async def enter(self, phase, expected=1, caption=""):
        self.phase, self.expected, self.finished, self.caption = phase, max(1, expected), 0, caption
        await self._push()

    async def leave(self, phase, ok=True):
        if ok:
            self.meter.complete(phase)
        await self._push(failed=not ok)

    async def _push(self, failed=False):
        if self.phase in dict(self.meter.phases) and self.phase not in self.meter.done:
            live = sum(self.tracker(a).turn_frac() for a in self.running)
            self.meter.set(self.phase, (self.finished + live) / self.expected)
        busy = [self.tracker(a) for a in sorted(self.running)]
        detail = " · ".join(f"{t.agent} turn {t.turn}/{t.max_turns}" for t in busy if t.max_turns)
        label = " · ".join(x for x in (self.phase, self.caption, detail) if x)
        await self.room.send({"type": "meter", "pct": self.meter.pct(), "phase": self.phase, "label": label,
                              "failed": failed})

    async def finish(self, state="complete", note=""):
        """Final meter message. state: complete | attention | failed | cancelled (cancelled is not a failure of the work;
        attention is finished work that needs a human decision). `note` is the one-line reason the page shows."""
        ok = state == "complete"
        await self.room.send({"type": "meter", "pct": 100 if ok else self.meter.pct(), "phase": state, "label": state,
                              "failed": state == "failed", "state": state, "final": True, "note": note})

    # --- narration --------------------------------------------------------------------------
    async def announce(self, agent, text):
        """A stage-level line (always reaches the feed; spoken when voice is on). Resets the chatter clock."""
        self._last_spoken = self._now()
        await self.room.narrate(agent, text)

    async def _maybe_speak(self, tracker, proposal):
        if not proposal:
            return
        text, urgent = proposal
        if self._now() - self._last_spoken < (URGENT_GAP_S if urgent else NARRATE_GAP_S):
            return
        await self.announce(tracker.agent, text)

    def listener(self, agent):
        tracker = self.tracker(agent)

        async def on_event(ev):
            await self.room.send(tracker.feed(ev))
            await self._maybe_speak(tracker, tracker.propose(ev))
            if ev.get("kind") == "turn":
                await self._push()
        return on_event

    async def _watch(self, agent):
        tracker = self.tracker(agent)
        while True:
            await asyncio.sleep(TICK_S)
            await self._maybe_speak(tracker, tracker.propose())

    @contextlib.asynccontextmanager
    async def following(self, agent):
        """Wrap one agent call: yields the event listener, runs the quiet-watchdog, and always cleans up."""
        self.tracker(agent).reset()
        self.running.add(agent)
        watcher = asyncio.ensure_future(self._watch(agent))
        try:
            yield self.listener(agent)
        finally:
            watcher.cancel()
            self.running.discard(agent)
            self.finished += 1
            await self.room.send({"type": "activity", "agent_id": agent, "kind": "done",
                                  "turn": self.tracker(agent).turn, "max_turns": self.tracker(agent).max_turns})
            await self._push()
