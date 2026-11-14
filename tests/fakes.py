"""Fakes for the HTTP tests: no network, no keys."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from deepagents.backends.protocol import ExecuteResponse
from deepagents.backends.sandbox import BaseSandbox
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from server import config
from server.sandbox import RemoteFile

PNG = b"\x89PNG\r\n\x1a\nfake"


class FakeBackend(BaseSandbox):
    """Pretends to run commands; `python plot.py` writes a chart into outputs."""

    def __init__(self, session: FakeSession) -> None:
        self.session = session
        self.commands: list[str] = []

    @property
    def id(self) -> str:
        return self.session.id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        self.commands.append(command)
        if "plot.py" in command:
            self.session.files[f"{config.OUTPUTS_DIR}/revenue_by_region.png"] = PNG
        return ExecuteResponse(output="North 120\nSouth 80", exit_code=0, truncated=False)

    def upload_files(self, files):  # pragma: no cover - not used by these tests
        return []

    def download_files(self, paths):  # pragma: no cover
        return []


class FakeSession:
    created = 0
    deleted: list[str] = []

    def __init__(self) -> None:
        FakeSession.created += 1
        self.id = f"sb-{FakeSession.created}"
        self.files: dict[str, bytes] = {}
        self._backend = FakeBackend(self)
        self.ensure_running_calls = 0

    @property
    def backend(self) -> FakeBackend:
        return self._backend

    def ensure_running(self) -> None:
        self.ensure_running_calls += 1

    def upload(self, path: str, data: bytes) -> None:
        self.files[path] = data

    def list_files(self, path: str) -> list[RemoteFile]:
        prefix = path.rstrip("/") + "/"
        return [
            RemoteFile(p[len(prefix):], len(d), "t0")
            for p, d in self.files.items()
            if p.startswith(prefix) and "/" not in p[len(prefix):]
        ]

    def download(self, path: str) -> bytes:
        return self.files[path]

    def delete(self) -> None:
        FakeSession.deleted.append(self.id)


class ScriptedAgent:
    """Stands in for the compiled deep agent: replays (mode, payload) items."""

    def __init__(self, backend: FakeBackend, script: list[Any]) -> None:
        self.backend = backend
        self.script = script
        self.calls: list[tuple[Any, Any, Any]] = []

    async def astream(self, input: Any, config: Any = None, *, stream_mode: Any = None):
        self.calls.append((input, config, stream_mode))
        for item in self.script:
            if callable(item):
                item(self.backend)
                continue
            yield item


class FakeChatModel(BaseChatModel):
    """Replays AIMessages; streams text word by word, then tool-call chunks."""

    script: list[AIMessage]
    index: int = 0

    @property
    def _llm_type(self) -> str:
        return "fake"

    def bind_tools(self, tools: Any, **kwargs: Any) -> FakeChatModel:
        return self

    def _next(self) -> AIMessage:
        message = self.script[self.index]
        self.index += 1
        return message

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._next())])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        message = self._next()
        words = str(message.content).split(" ") if message.content else []
        for i, word in enumerate(words):
            text = word if i == len(words) - 1 else word + " "
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=[{"type": "text", "text": text, "index": 0}], id=message.id)
            )
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                id=message.id,
                tool_call_chunks=[
                    {"name": tc["name"], "args": json.dumps(tc["args"]), "id": tc["id"], "index": i}
                    for i, tc in enumerate(message.tool_calls)
                ],
                usage_metadata={
                    "input_tokens": 100,
                    "output_tokens": 10,
                    "total_tokens": 110,
                    "input_token_details": {"cache_read": 40},
                },
            )
        )


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in body.strip().split("\n\n"):
        if not block.strip():
            continue
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def keys(anthropic: bool = True, daytona: bool = True) -> Callable[[], dict[str, bool]]:
    return lambda: {"anthropic": anthropic, "daytona": daytona}
