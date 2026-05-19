"""FastAPI project entrypoint for the Python media service.

The current production-compatible media runtime lives in
`image_generate_service.py` while the service is being migrated. The file is
kept as the FastAPI boundary for the next refactor phase so the Python project
already has the intended app package shape.
"""

from fastapi import FastAPI
from .core.config import MEDIA_SERVICE_REVISION, PY_SERVICE_PORT

app = FastAPI(title="Demiurge Python Media API")


@app.get("/api/media/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "python-media-api",
        "runtime": "fastapi-shell",
        "port": PY_SERVICE_PORT,
        "revision": MEDIA_SERVICE_REVISION,
        "note": "Use python app/image_generate_service.py for the full media runtime during phase 1.",
    }
