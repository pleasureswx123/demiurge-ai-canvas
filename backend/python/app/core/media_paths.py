from __future__ import annotations

import contextvars
import re
from pathlib import Path
from typing import Any

from .config import OUTPUTS_DIR, PROJECTS_ROOT

OUTPUTS_CTX: contextvars.ContextVar[Path] = contextvars.ContextVar(
    "OUTPUTS_CTX",
    default=OUTPUTS_DIR,
)


def active_outputs_dir() -> Path:
    return OUTPUTS_CTX.get()


def bind_outputs_from_request(handler: Any) -> contextvars.Token[Path]:
    slug = (handler.headers.get("X-Project-Slug") or "").strip()
    if slug and re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", slug):
        target = (PROJECTS_ROOT / slug / "assets").resolve()
        try:
            target.relative_to(PROJECTS_ROOT.resolve())
        except ValueError:
            return OUTPUTS_CTX.set(OUTPUTS_DIR)
        target.mkdir(parents=True, exist_ok=True)
        return OUTPUTS_CTX.set(target)
    return OUTPUTS_CTX.set(OUTPUTS_DIR)


def reset_outputs_context(token: contextvars.Token[Path]) -> None:
    OUTPUTS_CTX.reset(token)


def video_preview_url(filename: str) -> str:
    outputs_dir = active_outputs_dir()
    try:
        rel = outputs_dir.resolve().relative_to(PROJECTS_ROOT.resolve())
        parts = rel.parts
        if len(parts) >= 2 and parts[1] == "assets":
            return f"/api/media/video-file/{parts[0]}/{filename}"
    except ValueError:
        pass
    return f"/api/media/video-file/{filename}"
