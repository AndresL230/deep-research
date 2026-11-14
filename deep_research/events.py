"""Turn LangGraph stream updates into flat events the UI and the analysis can use."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage

MAX_TEXT = 4000


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def events_from_update(update: dict) -> list[dict]:
    """`update` is one chunk from `astream(..., stream_mode="updates")`: {node: state_delta}."""
    out: list[dict] = []
    for node, delta in (update or {}).items():
        if not isinstance(delta, dict):
            continue
        msgs = delta.get("messages")
        if isinstance(msgs, list):
            for m in msgs:
                if isinstance(m, AIMessage):
                    text = _text(m.content).strip()
                    if text:
                        out.append({"type": "thought", "text": text[:MAX_TEXT]})
                    for tc in m.tool_calls:
                        out.append({"type": "tool_call", "id": tc.get("id"), "name": tc["name"], "args": tc.get("args", {})})
                elif isinstance(m, ToolMessage):
                    out.append(
                        {
                            "type": "tool_result",
                            "id": m.tool_call_id,
                            "name": m.name,
                            "content": _text(m.content)[:MAX_TEXT],
                        }
                    )
        todos = delta.get("todos")
        if isinstance(todos, list):
            out.append({"type": "todos", "todos": todos})
    return out


def current_step(todos: list[dict]) -> str | None:
    for t in todos:
        if t.get("status") == "in_progress":
            return t.get("content")
    return None


class EventLog:
    """Append-only JSONL log for one run."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._f = path.open("a")
        self.started = time.time()

    def write(self, ev: dict) -> dict:
        ev = {"t": round(time.time() - self.started, 2), **ev}
        self._f.write(json.dumps(ev, default=str) + "\n")
        self._f.flush()
        return ev

    def close(self) -> None:
        self._f.close()


def read_events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
