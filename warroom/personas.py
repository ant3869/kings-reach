"""Council personas. Casting (name, title, voice, personality) lives in voices.json."""

try:
    from .config import load_voices
except ImportError:  # run as a script: python warroom/server.py
    from config import load_voices

AGENT_IDS = ("main", "research", "comms", "content", "ops")
SPECIALISTS = AGENT_IDS[1:]
DEFAULT = {"name": "Main", "title": "Hand of the King", "kokoro_voice": "bm_george", "speed": 1.0, "personality": ""}
_CAST = load_voices()


def get_persona(agent_id):
    """Persona dict for an agent; unknown ids get Main's casting."""
    return {**DEFAULT, **_CAST.get("main", {}), **_CAST.get(agent_id, {})}


def persona_prompt(agent_id):
    """Appended to Claude Code's system prompt for every war room call."""
    p = get_persona(agent_id)
    return (
        f"You are {p['name']}, the {p['title']} of the War Room council. {p['personality']}\n"
        "Anything in a field named `spoken` is read aloud by text-to-speech: plain sentences, "
        "no markdown, no lists, no URLs, no code, at most 45 words. Put detail in the other fields. "
        "No em dashes, no AI cliches, no sycophancy. Disagree when you have reason to."
    )
