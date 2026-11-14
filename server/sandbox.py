"""Daytona sandbox lifecycle. Every method here is blocking: call it via `asyncio.to_thread`."""

from __future__ import annotations

import logging
import os
import shlex
from dataclasses import dataclass
from typing import Any, Protocol

from deepagents.backends.protocol import SandboxBackendProtocol

from server import config

log = logging.getLogger(__name__)


class SandboxGone(RuntimeError):
    """The conversation's sandbox no longer exists (expired or deleted)."""


@dataclass(frozen=True)
class RemoteFile:
    name: str
    size: int
    modified: str


class SandboxSession(Protocol):
    """What the server needs from a conversation's sandbox."""

    @property
    def id(self) -> str: ...

    @property
    def backend(self) -> SandboxBackendProtocol: ...

    def ensure_running(self) -> None: ...

    def upload(self, path: str, data: bytes) -> None: ...

    def list_files(self, path: str) -> list[RemoteFile]: ...

    def download(self, path: str) -> bytes: ...

    def delete(self) -> None: ...


class DaytonaSession:
    """One Daytona sandbox, wrapped for the deep agent (`backend`) and for the server."""

    def __init__(self, sandbox: Any) -> None:
        from langchain_daytona import DaytonaSandbox

        self._sandbox = sandbox
        self._backend = DaytonaSandbox(sandbox=sandbox, timeout=15 * 60)

    @property
    def id(self) -> str:
        return self._sandbox.id

    @property
    def backend(self) -> SandboxBackendProtocol:
        return self._backend

    def prepare(self) -> None:
        dirs = " ".join(shlex.quote(d) for d in (config.DATA_DIR, config.OUTPUTS_DIR))
        result = self._backend.execute(f"mkdir -p {dirs}", timeout=60)
        if result.exit_code not in (0, None):
            raise RuntimeError(f"could not create sandbox dirs: {result.output[:200]}")

    def ensure_running(self) -> None:
        """Restart the sandbox if Daytona auto-stopped it between turns."""
        try:
            self._sandbox.refresh_data()
        except Exception as exc:  # noqa: BLE001 - the SDK raises several error types
            raise SandboxGone(str(exc)) from exc
        state = str(getattr(self._sandbox.state, "value", self._sandbox.state))
        if state in ("destroyed", "destroying", "error", "build_failed"):
            raise SandboxGone(f"sandbox is {state}")
        if state != "started":
            log.info("starting sandbox %s (was %s)", self.id, state)
            self._sandbox.start(timeout=120)

    def upload(self, path: str, data: bytes) -> None:
        self._sandbox.fs.upload_file(data, path)

    def list_files(self, path: str) -> list[RemoteFile]:
        try:
            entries = self._sandbox.fs.list_files(path)
        except Exception:  # noqa: BLE001 - a missing dir is not an error for us
            log.debug("list_files(%s) failed", path, exc_info=True)
            return []
        return [
            RemoteFile(e.name, int(e.size), str(e.modified_at or e.mod_time))
            for e in entries
            if not e.is_dir
        ]

    def download(self, path: str) -> bytes:
        return self._sandbox.fs.download_file(path)

    def delete(self) -> None:
        self._sandbox.delete()


_client: Any = None


def _daytona_client() -> Any:
    global _client
    if _client is None:
        from daytona import Daytona, DaytonaConfig

        _client = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"]))
    return _client


def create_daytona_session() -> DaytonaSession:
    """Create and prepare a fresh sandbox (blocking, ~seconds)."""
    from daytona import CreateSandboxFromSnapshotParams

    params = CreateSandboxFromSnapshotParams(
        language="python",
        auto_stop_interval=config.AUTO_STOP_MINUTES,
        auto_delete_interval=config.AUTO_DELETE_MINUTES,
        labels={"app": "deep-research-analyst"},
    )
    sandbox = _daytona_client().create(params, timeout=180)
    session = DaytonaSession(sandbox)
    try:
        session.prepare()
    except Exception:
        session.delete()
        raise
    log.info("created sandbox %s", session.id)
    return session
