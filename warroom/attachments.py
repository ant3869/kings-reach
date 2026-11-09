"""Files the user attached to a War Room message: find them again by id and tell the agent where they are.

The page uploads to the dashboard (POST /api/upload, src/attachments.ts), which stores the file in workspace/uploads and
returns an opaque id. The page sends only the ids here, so a client can never point an agent at an arbitrary path.
The id pattern and the block wording MIRROR src/attachments.ts and src/attach-format.ts; tests on both sides pin them.
"""

import re
from pathlib import Path

try:
    from .config import UPLOADS_DIR
except ImportError:  # run as a script
    from config import UPLOADS_DIR

MAX_FILES = 5
UPLOAD_ID = re.compile(r"^\d{10,}-[0-9a-f]{6}_[A-Za-z0-9._-]{1,100}$")
OPEN = ("[Attached files: the user attached these. Open each with your file tools (images and PDFs too) "
        "before you answer.]")
CLOSE = "[end of attached files]"


def display_name(upload_id: str) -> str:
    return upload_id.split("_", 1)[1]


def resolve(ids, directory: Path = UPLOADS_DIR):
    """(files, problem): files is [(name, path)]; problem is a sentence for the user, or '' when all is well."""
    if ids is None:
        return [], ""
    if not isinstance(ids, list):
        return [], "attachments must be a list of upload ids"
    if len(ids) > MAX_FILES:
        return [], f"at most {MAX_FILES} files per message"
    files = []
    for upload_id in ids:
        if not isinstance(upload_id, str) or not UPLOAD_ID.match(upload_id):
            return [], "that attachment id is not valid"
        path = directory / upload_id
        if not path.is_file():
            return [], f"{display_name(upload_id)} is no longer available (uploads are kept for 24 hours): attach it again"
        files.append((display_name(upload_id), str(path)))
    return files, ""


def block(files) -> str:
    """The text appended to a message. Empty when nothing is attached."""
    if not files:
        return ""
    return "\n".join(["", "", OPEN, *(f"- {name}: {path}" for name, path in files), CLOSE])
