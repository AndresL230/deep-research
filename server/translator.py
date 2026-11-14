"""Translate a deep agent's stream into the web client's Ask events.

Pure: no network, no I/O. The runner feeds it what
`agent.astream(..., stream_mode=["messages", "tools"])` yields, and it returns
`(event_name, data)` pairs shaped per docs/api-contract.md.

- `messages` payloads are `(message, metadata)`; AI message chunks become `text` deltas
  and their `usage_metadata` is summed for `done.tokens`.
- `tools` payloads are LangGraph's tool lifecycle dicts
  (`tool-started` / `tool-finished` / `tool-error`, keyed by `tool_call_id`);
  they become `activity` run/done steps.
"""

from __future__ import annotations

import json
import posixpath
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

Event = tuple[str, dict[str, Any]]

ICONS: dict[str, str] = {
    "execute": "ci",
    "read_file": "read",
    "ls": "read",
    "write_file": "docs",
    "edit_file": "docs",
    "grep": "search",
    "glob": "search",
    "write_todos": "sprint",
}

_TODO_MARK = {"completed": "[x]", "in_progress": "[~]", "pending": "[ ]"}
_EXIT_RE = re.compile(r"\[Command (?:succeeded|failed) with exit code (-?\d+)\]")
_LABEL_MAX = 80


def sse(name: str, data: dict[str, Any]) -> str:
    """Format one Server-Sent Event."""
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def error_event(code: str, message: str) -> Event:
    return ("error", {"code": code, "message": message})


def icon_for(tool: str) -> str:
    return ICONS.get(tool, "read")


def _clip(text: str, limit: int = _LABEL_MAX) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _base(path: Any) -> str:
    path = str(path or "").rstrip("/")
    return posixpath.basename(path) or path or "/"


def _script_name(command: str) -> str | None:
    """`python analyze.py --x` / `cd d && python3 /a/b.py` → `analyze.py` / `b.py`."""
    m = re.search(r"\bpython3?(?:\.\d+)?\s+(?:-u\s+)?(\S+\.py)\b", command)
    return posixpath.basename(m.group(1)) if m else None


def tool_label(tool: str, args: dict[str, Any] | None, *, todo_count: int = 0) -> str:
    """A short human line describing a tool call."""
    args = args or {}
    if tool == "execute":
        command = str(args.get("command", "")).strip()
        script = _script_name(command)
        if script:
            return f"Running {script}"
        if re.match(r"^(?:python3?\s+-m\s+)?pip3?\s+install\b", command):
            pkgs = [p for p in command.split()[2:] if not p.startswith("-") and p != "install"]
            return _clip("Installing " + " ".join(pkgs)) if pkgs else "Installing packages"
        first = command.splitlines()[0] if command else ""
        return _clip(f"Running {first}") if first else "Running a command"
    if tool == "read_file":
        return f"Reading {_base(args.get('file_path'))}"
    if tool == "write_file":
        return f"Writing {_base(args.get('file_path'))}"
    if tool == "edit_file":
        return f"Editing {_base(args.get('file_path'))}"
    if tool == "ls":
        return _clip(f"Listing {args.get('path') or '/'}")
    if tool == "grep":
        return _clip(f"Searching for “{args.get('pattern', '')}”")
    if tool == "glob":
        return _clip(f"Finding {args.get('pattern', '')}")
    if tool == "write_todos":
        return "Planning" if todo_count == 0 else "Updating the plan"
    if tool == "task":
        desc = str(args.get("description", "")).strip()
        return _clip(f"Delegating: {desc}") if desc else "Delegating a task"
    return tool.replace("_", " ").capitalize() or "Working"


def output_text(output: Any) -> tuple[str, bool]:
    """Extract (text, is_error) from a tool's raw output (ToolMessage, Command, str, dict)."""
    msg: Any = output
    update = getattr(output, "update", None)  # langgraph Command
    if isinstance(update, dict):
        msgs = update.get("messages") or []
        msg = msgs[-1] if msgs else ""
    elif isinstance(output, dict) and output.get("type") == "constructor":
        msg = output.get("kwargs") or {}
    if isinstance(msg, dict):
        content, status = msg.get("content", ""), msg.get("status")
    elif hasattr(msg, "content"):
        content, status = msg.content, getattr(msg, "status", None)
    else:
        content, status = msg, None
    if isinstance(content, list):
        content = "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content if content is not None else ""), status == "error"


def _count_lines(text: str) -> int:
    return len([ln for ln in text.splitlines() if ln.strip()])


def _plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def result_line(tool: str, args: dict[str, Any] | None, text: str, is_error: bool) -> str:
    """A short summary of a finished tool call."""
    args = args or {}
    if tool == "execute":
        m = _EXIT_RE.search(text)
        if m:
            code = int(m.group(1))
            body = _EXIT_RE.sub("", text)
            n = _count_lines(body)
            tail = f" · {_plural(n, 'line')} of output" if n else ""
            return f"exit {code}{tail}"
        if "timed out" in text.lower():
            return "timed out"
    if is_error or text.startswith("Error"):
        first = text.strip().splitlines()[0] if text.strip() else "error"
        return _clip(first.removeprefix("Error: "), 100)
    if tool == "write_file":
        return f"wrote {_plural(len(str(args.get('content', '')).splitlines()), 'line')}"
    if tool == "edit_file":
        m = re.search(r"replaced (\d+) instance", text)
        return f"replaced {m.group(1)}" if m else "edited"
    if tool == "read_file":
        return f"read {_plural(_count_lines(text), 'line')}"
    if tool == "ls":
        return _plural(_count_lines(text), "entry", "entries")
    if tool == "grep":
        return _plural(_count_lines(text), "match", "matches")
    if tool == "glob":
        return _plural(_count_lines(text), "file")
    return ""


def todo_results(args: dict[str, Any] | None) -> tuple[list[str], str]:
    todos = (args or {}).get("todos") or []
    lines: list[str] = []
    done = 0
    for t in todos:
        if not isinstance(t, dict):
            continue
        status = t.get("status", "pending")
        done += status == "completed"
        lines.append(f"{_TODO_MARK.get(status, '[ ]')} {t.get('content', '')}")
    return lines, f"{done} of {len(lines)} done"


def message_text(message: Any) -> str:
    """Text deltas from an AI message chunk; tool-use / thinking blocks are skipped."""
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") in ("text", "text-delta")
        )
    return ""


def _is_ai(message: Any) -> bool:
    return getattr(message, "type", None) in ("ai", "AIMessageChunk")


@dataclass
class _Step:
    number: int
    tool: str
    args: dict[str, Any]


@dataclass
class TurnTranslator:
    """Stateful per-turn translator. One instance per `/api/ask` turn."""

    clock: Callable[[], float] = time.monotonic
    todo_updates: int = 0  # carried across turns by the caller if it wants "Updating the plan"
    _started_at: float | None = None
    _thinking_done: bool = False
    _step: int = 0
    _open: dict[str, _Step] = field(default_factory=dict)
    tokens: dict[str, int] = field(
        default_factory=lambda: {"in": 0, "out": 0, "cached": 0, "cache_write": 0, "cache_write_1h": 0}
    )
    last_finished_tool: str | None = None

    # -- lifecycle -------------------------------------------------------

    def start(self) -> list[Event]:
        self._started_at = self.clock()
        return [("thinking", {"state": "run"})]

    def _begin_output(self) -> list[Event]:
        if self._thinking_done:
            return []
        self._thinking_done = True
        started = self._started_at if self._started_at is not None else self.clock()
        seconds = max(0, round(self.clock() - started))
        return [("thinking", {"state": "done", "seconds": seconds, "summary": ""})]

    def finish(self, message_id: int) -> list[Event]:
        events = self._begin_output()
        for call_id in list(self._open):
            step = self._open.pop(call_id)
            events.append(("activity", {"step": step.number, "state": "done", "resultLine": ""}))
        events.append(
            (
                "done",
                {
                    "messageId": message_id,
                    "cites": [],
                    "tokens": {k: self.tokens[k] for k in ("in", "out", "cached")},
                },
            )
        )
        return events

    # -- stream input ----------------------------------------------------

    def feed(self, mode: str, payload: Any) -> list[Event]:
        if mode == "messages":
            message, metadata = payload
            return self.on_message(message, metadata or {})
        if mode == "tools":
            return self.on_tool(payload)
        return []

    def on_message(self, message: Any, metadata: dict[str, Any]) -> list[Event]:
        if not _is_ai(message):
            return []
        if metadata.get("lc_source") == "summarization":
            return []
        usage = getattr(message, "usage_metadata", None)
        if usage:
            self.tokens["in"] += int(usage.get("input_tokens") or 0)
            self.tokens["out"] += int(usage.get("output_tokens") or 0)
            details = usage.get("input_token_details") or {}
            self.tokens["cached"] += int(details.get("cache_read") or 0)
            # langchain-anthropic zeroes the generic `cache_creation` when it reports per-TTL keys.
            write_5m = int(details.get("ephemeral_5m_input_tokens") or 0)
            write_1h = int(details.get("ephemeral_1h_input_tokens") or 0)
            if not write_5m and not write_1h:
                write_5m = int(details.get("cache_creation") or 0)
            self.tokens["cache_write"] += write_5m
            self.tokens["cache_write_1h"] += write_1h
        text = message_text(message)
        if not text:
            return []
        return [*self._begin_output(), ("text", {"delta": text})]

    def on_tool(self, payload: dict[str, Any]) -> list[Event]:
        self.last_finished_tool = None
        kind = payload.get("event")
        call_id = str(payload.get("tool_call_id") or "")
        if kind == "tool-started":
            tool = str(payload.get("tool_name") or "tool")
            args = payload.get("input") if isinstance(payload.get("input"), dict) else {}
            self._step += 1
            step = _Step(self._step, tool, args)
            self._open[call_id] = step
            label = tool_label(tool, args, todo_count=self.todo_updates)
            if tool == "write_todos":
                self.todo_updates += 1
            return [
                *self._begin_output(),
                (
                    "activity",
                    {"step": step.number, "state": "run", "tool": tool, "icon": icon_for(tool), "label": label},
                ),
            ]
        if kind in ("tool-finished", "tool-error"):
            step = self._open.pop(call_id, None)
            if step is None:
                return []
            self.last_finished_tool = step.tool
            data: dict[str, Any] = {"step": step.number, "state": "done"}
            if kind == "tool-error":
                data["resultLine"] = _clip(str(payload.get("message") or "error"), 100)
            elif step.tool == "write_todos":
                data["results"], data["resultLine"] = todo_results(step.args)
            else:
                text, is_error = output_text(payload.get("output"))
                data["resultLine"] = result_line(step.tool, step.args, text, is_error)
            return [("activity", data)]
        return []

    def image(self, url: str, alt: str) -> list[Event]:
        return [*self._begin_output(), ("block", {"kind": "image", "url": url, "alt": alt})]
