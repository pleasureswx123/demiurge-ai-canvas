from __future__ import annotations

import os
from pathlib import Path

PY_SERVICE_PORT = int(os.environ.get("PY_MEDIA_API_PORT", "3300"))
MEDIA_SERVICE_REVISION = "gpt-image2-env-2026-04"

SERVICE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = SERVICE_ROOT.parent.parent
ENV_PATHS = [SERVICE_ROOT / ".env", SERVICE_ROOT / ".env.local"]


def load_dotenv_file(dotenv_path: Path, override: bool = False) -> None:
    if not dotenv_path.exists():
        return
    for raw_line in dotenv_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if override or key not in os.environ:
            os.environ[key] = value


def load_env() -> None:
    for env_path in ENV_PATHS:
        load_dotenv_file(env_path, override=env_path.name == ".env.local")


def resolve_service_path(raw: str | None, fallback: Path) -> Path:
    if not raw:
        return fallback.resolve()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = SERVICE_ROOT / candidate
    return candidate.resolve()


load_env()

OUTPUTS_DIR = resolve_service_path(os.environ.get("OUTPUTS_ROOT"), REPO_ROOT / "outputs")
PROJECTS_ROOT = resolve_service_path(os.environ.get("PROJECTS_ROOT"), REPO_ROOT / "projects")
MATERIAL_LIBRARY_ROOT = resolve_service_path(
    os.environ.get("MATERIAL_LIBRARY_ROOT"),
    REPO_ROOT / "material-library",
)

OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
