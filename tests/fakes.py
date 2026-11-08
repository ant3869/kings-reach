"""Shared test doubles for the war room's `room` interface (the UI sink Council talks to)."""


class Room:
    """Records everything the council would have shown or said."""

    def __init__(self):
        self.sent, self.stages, self.spoken, self.said = [], [], [], []

    async def send(self, obj):
        self.sent.append(obj)

    async def stage(self, name, state, detail=""):
        self.stages.append((name, state))

    async def status(self, text):
        self.said.append(("war-room", text))

    async def say(self, agent, text, spoken=None, kind="reply"):
        self.said.append((agent, text))

    async def thinking(self, agent, on):
        pass

    async def narrate(self, agent, text):
        self.spoken.append(text)

    def progress(self, phase):
        return [m["state"] for m in self.sent if m.get("type") == "build_progress" and m.get("phase") == phase]

    def final(self):
        return [m for m in self.sent if m.get("type") == "meter" and m.get("final")]

    def cards(self):
        return [m for m in self.sent if m.get("type") == "build_result"]

    def metrics(self):
        return [m for m in self.sent if m.get("type") == "metrics"]
