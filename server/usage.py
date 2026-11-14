"""Per-run cost log: one JSON line per agent turn in runs/usage.jsonl.

Prices are Anthropic first-party rates per million tokens for the model in config.MODEL.
Daytona sandbox time is not included.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# USD per million tokens. Cache writes use the 5-minute TTL rate (1.25x input), which is
# what deepagents' AnthropicPromptCachingMiddleware uses by default.
PRICES: dict[str, dict[str, float]] = {
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.10, "cache_write": 2.50},
}

_lock = threading.Lock()


def model_key(model: str) -> str:
    return model.split(":", 1)[-1]


def cost_usd(model: str, tokens: dict[str, int]) -> float | None:
    """Cost of one run. `tokens["in"]` is the total input, including cached reads and writes."""
    price = PRICES.get(model_key(model))
    if price is None:
        return None
    total_in = tokens.get("in", 0)
    read = tokens.get("cached", 0)
    write = tokens.get("cache_write", 0)
    write_1h = tokens.get("cache_write_1h", 0)
    uncached = max(0, total_in - read - write - write_1h)
    dollars = (
        uncached * price["input"]
        + read * price["cache_read"]
        + write * price["cache_write"]
        + write_1h * price["input"] * 2  # 1-hour cache writes are 2x input
        + tokens.get("out", 0) * price["output"]
    ) / 1_000_000
    return round(dollars, 6)


def record(
    path: Path,
    *,
    conversation: str,
    question: str,
    status: str,
    started_at: datetime,
    seconds: float,
    model: str,
    tokens: dict[str, int],
) -> dict[str, Any] | None:
    """Append one run. Runs that used no tokens (e.g. failed before the model ran) are skipped."""
    if not tokens.get("in") and not tokens.get("out"):
        return None
    entry = {
        "at": started_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "conversation": conversation,
        "question": " ".join(question.split())[:200],
        "status": status,
        "seconds": round(seconds, 1),
        "model": model_key(model),
        "tokens": {
            "in": tokens.get("in", 0),
            "out": tokens.get("out", 0),
            "cache_read": tokens.get("cached", 0),
            "cache_write": tokens.get("cache_write", 0) + tokens.get("cache_write_1h", 0),
        },
        "cost": cost_usd(model, tokens),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock, path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        log.warning("could not write usage log %s", path, exc_info=True)
    return entry


def summary(path: Path) -> dict[str, Any]:
    """All runs, newest first, with totals."""
    runs: list[dict[str, Any]] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                runs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    runs.reverse()
    return {
        "runs": runs,
        "totalCost": round(sum(r.get("cost") or 0 for r in runs), 6),
        "totalRuns": len(runs),
        "totalTokens": {
            "in": sum(r["tokens"]["in"] for r in runs),
            "out": sum(r["tokens"]["out"] for r in runs),
        },
    }
