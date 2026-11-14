"""Paths, limits, and key checks."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

RUNS_DIR = ROOT / "runs"
WEB_DIST = ROOT / "web" / "dist"
SAMPLE_CSV = ROOT / "samples" / "sales.csv"

MODEL = "anthropic:claude-sonnet-5-5"
SANDBOX_HOME = "/home/daytona"
DATA_DIR = f"{SANDBOX_HOME}/data"
OUTPUTS_DIR = f"{SANDBOX_HOME}/outputs"

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
AUTO_STOP_MINUTES = 15
# A stopped sandbox is deleted this long after it stops (safety net for leaks).
AUTO_DELETE_MINUTES = 60

IMAGE_EXTENSIONS = {".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp"}


def _refresh_keys_from_dotenv() -> None:
    """Pick up keys added to .env after the server started (only fills unset/empty vars)."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    for name, value in dotenv_values(path).items():
        if name in ("ANTHROPIC_API_KEY", "DAYTONA_API_KEY") and value and not os.environ.get(name):
            os.environ[name] = value


def key_status() -> dict[str, bool]:
    """Whether each required key is set (never the value)."""
    _refresh_keys_from_dotenv()
    return {
        "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
        "daytona": bool(os.environ.get("DAYTONA_API_KEY", "").strip()),
    }
