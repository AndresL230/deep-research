"""HTTP layer: endpoints from docs/api-contract.md. Run: `uv run uvicorn server.app:app --port 8000`."""

from __future__ import annotations

import logging
import mimetypes
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from server import config, usage
from server.conversations import (
    ConversationManager,
    Services,
    safe_upload_name,
    valid_conversation_id,
    valid_file_name,
)
from server.translator import Event, error_event, sse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("server")

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
# Agent-written files (SVG especially) must not run script when opened directly.
FILE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
}


def default_services() -> Services:
    from server.agent import build_agent
    from server.sandbox import create_daytona_session

    return Services(sandbox_factory=create_daytona_session, agent_factory=build_agent)


def _inside(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
    except ValueError:
        return False
    return True


async def _read_upload(file: UploadFile) -> bytes | None:
    """Read the upload, or return None if it exceeds the size limit."""
    if file.size is not None and file.size > config.MAX_UPLOAD_BYTES:
        return None
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > config.MAX_UPLOAD_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def create_app(services: Services | None = None) -> FastAPI:
    manager = ConversationManager(services or default_services())

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        log.info("shutting down: deleting %d sandbox(es)", len(manager.conversations))
        await manager.close_all()

    app = FastAPI(title="Data analysis deep agent", lifespan=lifespan)
    app.state.manager = manager

    def stream(events: AsyncIterator[Event]) -> StreamingResponse:
        async def body() -> AsyncIterator[str]:
            async for name, data in events:
                yield sse(name, data)

        return StreamingResponse(body(), media_type="text/event-stream", headers=SSE_HEADERS)

    async def one(event: Event) -> AsyncIterator[Event]:
        yield event

    @app.post("/api/ask")
    async def ask(
        conversation: str = Form(...),
        message: str = Form(...),
        file: UploadFile | None = File(None),
    ) -> StreamingResponse:
        if not valid_conversation_id(conversation):
            return stream(one(error_event("failed", "Invalid conversation id.")))
        missing = manager.missing_keys()
        if missing:
            # Checked before anything else touches Daytona.
            return stream(manager.run_turn(conversation, message))
        upload: tuple[str, bytes] | None = None
        if file is not None and file.filename:
            data = await _read_upload(file)
            if data is None:
                limit = config.MAX_UPLOAD_BYTES // (1024 * 1024)
                return stream(one(error_event("too_large", f"The file is larger than {limit} MB.")))
            upload = (safe_upload_name(file.filename), data)
        return stream(manager.run_turn(conversation, message, upload))

    @app.delete("/api/conversations/{conversation}", status_code=204)
    async def delete_conversation(conversation: str) -> Response:
        if valid_conversation_id(conversation):
            await manager.delete(conversation)
        return Response(status_code=204)

    @app.get("/api/files/{conversation}/{name}")
    async def get_file(conversation: str, name: str) -> Response:
        runs = manager.services.runs_dir
        if not (valid_conversation_id(conversation) and valid_file_name(name)):
            return JSONResponse({"error": "not found"}, status_code=404)
        conv_dir = runs / conversation
        path = conv_dir / name
        if not _inside(conv_dir, path) or not path.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, headers=FILE_HEADERS)

    @app.get("/api/sample")
    async def sample() -> Response:
        return FileResponse(config.SAMPLE_CSV, media_type="text/csv", filename="sales.csv")

    @app.get("/api/usage")
    async def usage_summary() -> dict[str, object]:
        return usage.summary(manager.services.runs_dir / "usage.jsonl")

    @app.get("/api/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "keys": manager.services.key_status()}

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def api_not_found(rest: str) -> Response:
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.get("/{path:path}")
    async def spa(path: str) -> Response:
        dist = config.WEB_DIST
        index = dist / "index.html"
        if path:
            candidate = dist / path
            if _inside(dist, candidate) and candidate.is_file():
                return FileResponse(candidate)
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return Response(
            "The web UI is not built yet: run `cd web && npm run build` (or use the Vite dev server).",
            status_code=404,
            media_type="text/plain",
        )

    return app


app = create_app()
