"""Turn LangGraph stream updates into flat events the UI and the analysis can use."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

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
    """Append-only JSONL log for one run.

    Each event has a position (`seq`): its line number in the file, counting lines already there when a log is
    reopened (the investigator appends to one file per resume). `on_write(seq, event)` is called after each write,
    which is how events reach the hub; a failing callback never loses the event on disk.
    """

    def __init__(self, path: Path, on_write: Callable[[int, dict], None] | None = None):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.seq = sum(1 for line in path.open() if line.strip()) if path.exists() else 0
        self._f = path.open("a")
        self.started = time.time()
        self._on_write = on_write

    def write(self, ev: dict) -> dict:
        ev = {"t": round(time.time() - self.started, 2), **ev}
        self._f.write(json.dumps(ev, default=str) + "\n")
        self._f.flush()
        seq, self.seq = self.seq, self.seq + 1
        if self._on_write is not None:
            try:
                self._on_write(seq, json.loads(json.dumps(ev, default=str)))
            except Exception:  # noqa: BLE001 - the log on disk is what matters
                pass
        return ev

    def close(self) -> None:
        self._f.close()


# Next to a fork child's events.jsonl: the source run's events up to the fork point (`prefix_events`). The child's
# own log starts after them, but the episodes they ran are the child's too.
PREFIX_EVENTS = "prefix_events.jsonl"


def prefix_events(events: list[dict], n_actions: int) -> list[dict]:
    """`events` up to the tool call of action `n_actions` (counting from 0), so with the results of the first
    `n_actions` tool calls: what a run had done when a fork cut it there."""
    out: list[dict] = []
    seen = 0
    for e in events:
        if e.get("type") == "tool_call":
            if seen >= n_actions:
                break
            seen += 1
        out.append(e)
    return out


def read_events(path: Path) -> list[dict]:
    """The events of a log, oldest first. A line that is not whole JSON is skipped, not fatal: a process killed
    mid-write (a server restart, a machine out of memory) leaves its last line half written, and the rest of the log
    still says what the agent did."""
    if not path.exists():
        return []
    out, bad = [], 0
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            ev = None
        if isinstance(ev, dict):
            out.append(ev)
        else:
            bad += 1
    if bad:
        logging.getLogger(__name__).warning("%s: skipped %d line(s) that were not whole JSON", path, bad)
    return out
