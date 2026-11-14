"""Per-conversation state (sandbox + agent + thread id) and the turn runner."""

from __future__ import annotations

import asyncio
import itertools
import logging
import re
import shutil
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

from server import config, usage
from server.sandbox import SandboxGone, SandboxSession
from server.translator import Event, TurnTranslator, error_event

log = logging.getLogger(__name__)

CONVERSATION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ()+-]{0,127}$")
TURN_TIMEOUT_SECONDS = 30 * 60


def valid_conversation_id(value: str) -> bool:
    return bool(CONVERSATION_RE.match(value))


def valid_file_name(value: str) -> bool:
    return bool(FILE_NAME_RE.match(value)) and ".." not in value


def safe_upload_name(filename: str | None) -> str:
    """Reduce a client-supplied file name to a safe basename."""
    base = PurePosixPath((filename or "").replace("\\", "/")).name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "data.csv"
    return base[:100]


@dataclass
class Services:
    """Swappable dependencies (tests inject fakes)."""

    sandbox_factory: Callable[[], SandboxSession]
    agent_factory: Callable[[Any], Any]
    key_status: Callable[[], dict[str, bool]] = config.key_status
    runs_dir: Path = config.RUNS_DIR


@dataclass
class Conversation:
    id: str
    thread_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    session: SandboxSession | None = None
    agent: Any = None
    seen_outputs: dict[str, tuple[str, int]] = field(default_factory=dict)  # name -> (signature, version)
    todo_updates: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task[Any] | None = None
    closed: bool = False


def _short(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    name = type(exc).__name__
    return f"{name}: {text[:200]}" if text else name


def _is_timeout(exc: BaseException) -> bool:
    return isinstance(exc, (TimeoutError, asyncio.TimeoutError)) or "Timeout" in type(exc).__name__


class ConversationManager:
    def __init__(self, services: Services) -> None:
        self.services = services
        self.conversations: dict[str, Conversation] = {}
        self._message_ids = itertools.count(1)
        self._background: set[asyncio.Future[Any]] = set()

    # -- lifecycle -------------------------------------------------------

    async def delete(self, conversation_id: str) -> None:
        conv = self.conversations.pop(conversation_id, None)
        if conv is None:
            return
        conv.closed = True
        if conv.task is not None:
            conv.task.cancel()
        await self._delete_session(conv)
        shutil.rmtree(self.services.runs_dir / conversation_id, ignore_errors=True)

    async def close_all(self) -> None:
        convs = list(self.conversations.values())
        self.conversations.clear()
        for conv in convs:
            conv.closed = True
            if conv.task is not None:
                conv.task.cancel()
        await asyncio.gather(*(self._delete_session(c) for c in convs), return_exceptions=True)
        if self._background:
            await asyncio.wait(self._background, timeout=30)

    async def _create_session(self) -> SandboxSession:
        """Create a sandbox; if the turn is cancelled meanwhile, delete it once it exists."""
        creating = asyncio.ensure_future(asyncio.to_thread(self.services.sandbox_factory))
        try:
            return await asyncio.shield(creating)
        except asyncio.CancelledError:

            def cleanup(fut: asyncio.Future[SandboxSession]) -> None:
                if not fut.cancelled() and fut.exception() is None:
                    session = fut.result()
                    log.info("deleting sandbox %s created for a cancelled turn", session.id)
                    deleting = asyncio.ensure_future(asyncio.to_thread(session.delete))
                    self._background.add(deleting)
                    deleting.add_done_callback(self._background.discard)

            creating.add_done_callback(cleanup)
            raise

    async def _delete_session(self, conv: Conversation) -> None:
        session, conv.session, conv.agent = conv.session, None, None
        if session is None:
            return
        try:
            await asyncio.wait_for(asyncio.to_thread(session.delete), timeout=30)
            log.info("deleted sandbox %s (conversation %s)", session.id, conv.id)
        except Exception:
            log.exception("failed to delete sandbox %s", getattr(session, "id", "?"))

    # -- turns -----------------------------------------------------------

    def missing_keys(self) -> list[str]:
        status = self.services.key_status()
        names = {"anthropic": "ANTHROPIC_API_KEY", "daytona": "DAYTONA_API_KEY"}
        return [names[k] for k, ok in status.items() if not ok]

    async def run_turn(
        self,
        conversation_id: str,
        message: str,
        upload: tuple[str, bytes] | None = None,
    ) -> AsyncIterator[Event]:
        """Run one turn, yielding contract events. Cancelling the consumer cancels the run."""
        missing = self.missing_keys()
        if missing:
            yield error_event(
                "no_key",
                f"Missing {' and '.join(missing)}. Add {'it' if len(missing) == 1 else 'them'} to .env.",
            )
            return

        conv = self.conversations.get(conversation_id)
        if conv is None:
            conv = self.conversations[conversation_id] = Conversation(conversation_id)

        async with conv.lock:
            translator = TurnTranslator(todo_updates=conv.todo_updates)
            for event in translator.start():
                yield event

            # The agent runs in its own task so it can be cancelled explicitly: by the client
            # going away (this generator is cancelled) or by DELETE /api/conversations/{id}.
            queue: asyncio.Queue[Event | None] = asyncio.Queue()

            started_at = datetime.now(timezone.utc)
            started_clock = time.monotonic()

            async def produce() -> None:
                status = "error"
                try:
                    async with asyncio.timeout(TURN_TIMEOUT_SECONDS):
                        async for event in self._turn(conv, translator, message, upload):
                            queue.put_nowait(event)
                    for event in translator.finish(next(self._message_ids)):
                        queue.put_nowait(event)
                    status = "done"
                except asyncio.CancelledError:
                    status = "stopped"
                    log.info("turn cancelled (conversation %s)", conversation_id)
                    raise
                except SandboxGone as exc:
                    log.warning("sandbox gone for %s: %s", conversation_id, exc)
                    conv.session, conv.agent = None, None
                    queue.put_nowait(error_event(
                        "failed", "This conversation's sandbox has expired. Start a new conversation."
                    ))
                except Exception as exc:
                    log.exception("turn failed (conversation %s)", conversation_id)
                    queue.put_nowait(error_event("timeout" if _is_timeout(exc) else "failed", _short(exc)))
                finally:
                    conv.todo_updates = translator.todo_updates
                    usage.record(
                        self.services.runs_dir / "usage.jsonl",
                        conversation=conversation_id,
                        question=message,
                        status=status,
                        started_at=started_at,
                        seconds=time.monotonic() - started_clock,
                        model=config.MODEL,
                        tokens=translator.tokens,
                    )
                    queue.put_nowait(None)

            producer = asyncio.create_task(produce(), name=f"turn-{conversation_id}")
            conv.task = producer
            try:
                while (event := await queue.get()) is not None:
                    yield event
            finally:
                # Don't await the producer here: under a cancelled scope every await re-raises.
                producer.cancel()
                if conv.task is producer:
                    conv.task = None

    async def _turn(
        self,
        conv: Conversation,
        translator: TurnTranslator,
        message: str,
        upload: tuple[str, bytes] | None,
    ) -> AsyncIterator[Event]:
        if conv.session is None:
            conv.session = await self._create_session()
            if conv.closed:  # deleted while the sandbox was being created
                await self._delete_session(conv)
                raise RuntimeError("the conversation was deleted")
            conv.agent = await asyncio.to_thread(self.services.agent_factory, conv.session.backend)
        else:
            await asyncio.to_thread(conv.session.ensure_running)
        session = conv.session

        text = message
        if upload is not None:
            name, data = upload
            path = f"{config.DATA_DIR}/{name}"
            await asyncio.to_thread(session.upload, path, data)
            text = f"{message}\n\n[Attached dataset: {path}]"

        stream = conv.agent.astream(
            {"messages": [{"role": "user", "content": text}]},
            {"configurable": {"thread_id": conv.thread_id}},
            stream_mode=["messages", "tools"],
        )
        try:
            async for mode, payload in stream:
                for event in translator.feed(mode, payload):
                    yield event
                if translator.last_finished_tool == "execute":
                    for event in await self._new_images(conv, translator):
                        yield event
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                await aclose()
        for event in await self._new_images(conv, translator):
            yield event

    async def _new_images(self, conv: Conversation, translator: TurnTranslator) -> list[Event]:
        """Download new or changed images from the sandbox's outputs dir."""
        session = conv.session
        if session is None:
            return []
        try:
            files = await asyncio.to_thread(session.list_files, config.OUTPUTS_DIR)
        except Exception:
            log.warning("listing outputs failed", exc_info=True)
            return []
        events: list[Event] = []
        local_dir = self.services.runs_dir / conv.id
        for f in sorted(files, key=lambda f: (f.modified, f.name)):
            if Path(f.name).suffix.lower() not in config.IMAGE_EXTENSIONS or not valid_file_name(f.name):
                continue
            signature = f"{f.size}:{f.modified}"
            seen = conv.seen_outputs.get(f.name)
            if seen is not None and seen[0] == signature:
                continue
            try:
                data = await asyncio.to_thread(session.download, f"{config.OUTPUTS_DIR}/{f.name}")
            except Exception:
                log.warning("downloading %s failed", f.name, exc_info=True)
                continue
            local_dir.mkdir(parents=True, exist_ok=True)
            (local_dir / f.name).write_bytes(data)
            version = 1 if seen is None else seen[1] + 1
            conv.seen_outputs[f.name] = (signature, version)
            url = f"/api/files/{quote(conv.id)}/{quote(f.name)}"
            if version > 1:
                url += f"?v={version}"  # same name re-rendered: bust the browser cache
            alt = Path(f.name).stem.replace("_", " ").replace("-", " ")
            events.extend(translator.image(url, alt))
        return events
