"""The app: the batch API, its websocket, and the built web UI.

Run from the repo root: `uv run uvicorn deep_research.api:app --reload --port 8000`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import dotenv_values, load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from .config import ROOT_DIR

load_dotenv(ROOT_DIR / ".env")

from .batch import Batch  # noqa: E402 - needs the environment loaded first
from .config import BATCHES_DIR, FIXTURES_DIR, WEB_DIST, BatchConfig, load_prices  # noqa: E402
from .costs import OverBudget, estimate_batch_usd  # noqa: E402
from .events import read_events  # noqa: E402

log = logging.getLogger("deep_research.api")

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")

STATS_FILE = BATCHES_DIR / "_stats.json"
KEYS = {"anthropic": "ANTHROPIC_API_KEY", "daytona": "DAYTONA_API_KEY"}
# Agent-written files (SVG especially) must not run script when opened directly.
FILE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await close_all()


app = FastAPI(title="deep-research", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BATCHES: dict[str, Batch] = {}
TASKS: dict[str, asyncio.Task] = {}


async def close_all() -> None:
    """Cancel running batch work and stop every VM. Runs on server shutdown."""
    for t in TASKS.values():
        if not t.done():
            t.cancel()
    if BATCHES:
        log.info("shutting down: stopping the VMs of %d batch(es)", len(BATCHES))
    results = await asyncio.gather(*(b.close() for b in BATCHES.values()), return_exceptions=True)
    for r in results:
        if isinstance(r, BaseException):
            log.warning("could not close a batch: %r", r)


def key_status() -> dict[str, bool]:
    """Whether each required key is set. Never the values."""
    # Pick up keys added to .env after the server started (fills only unset vars).
    env_file = ROOT_DIR / ".env"
    if env_file.is_file():
        for name, value in dotenv_values(env_file).items():
            if name in KEYS.values() and value and not os.environ.get(name):
                os.environ[name] = value
    return {k: bool(os.environ.get(v, "").strip()) for k, v in KEYS.items()}


def _inside(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
    except ValueError:
        return False
    return True


def _batch_dir(batch_id: str) -> Path:
    for root in (BATCHES_DIR, FIXTURES_DIR):
        d = root / batch_id
        if (d / "case" / "case.json").exists():
            return d
    raise HTTPException(404, f"no batch {batch_id}")


def _live(batch_id: str) -> Batch:
    b = BATCHES.get(batch_id)
    if b is None:
        raise HTTPException(409, "this batch is not live (replays are read-only)")
    return b


def _spawn(batch_id: str, coro) -> None:
    task = asyncio.create_task(coro)
    TASKS[batch_id] = task

    def done(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception() is not None:
            BATCHES[batch_id].case.set_phase(f"error: {t.exception()}"[:300])

    task.add_done_callback(done)


def _avg_run_usd() -> float | None:
    """Average cost of one run from earlier batches, saved when a batch finishes."""
    try:
        return json.loads(STATS_FILE.read_text()).get("avg_run_usd")
    except Exception:  # noqa: BLE001
        return None


def _save_stats(b: Batch) -> None:
    avg = b.tracker.average_run_usd()
    if avg is not None:
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps({"avg_run_usd": avg}))


@app.get("/api/health")
def health():
    return {"ok": True, "keys": key_status()}


@app.get("/api/defaults")
def defaults():
    prices = load_prices()
    missing = any(v.get("input_per_mtok") is None for v in prices.get("models", {}).values())
    return {"config": BatchConfig().model_dump(), "prices_missing": missing or prices.get("daytona_vm_per_hour") is None}


@app.post("/api/estimate")
def estimate(cfg: BatchConfig):
    avg = _avg_run_usd()
    runs = estimate_batch_usd(cfg.n_runs, avg)
    forks = None if avg is None else avg * 2 * cfg.forks_per_choice
    return {
        "avg_run_usd": avg,
        "runs_usd": runs,
        "forks_usd": forks,
        "total_usd": None if runs is None else runs + forks,
        "over_budget": runs is not None and runs + forks > cfg.budget_usd,
        "basis": "average of earlier runs" if avg is not None else "no earlier runs yet",
    }


@app.get("/api/batches")
def list_batches():
    out = []
    for root, kind in ((BATCHES_DIR, "live"), (FIXTURES_DIR, "replay")):
        if root.exists():
            for d in sorted(root.iterdir()):
                if (d / "case" / "case.json").exists():
                    out.append({"id": d.name, "kind": "live" if d.name in BATCHES else kind})
    return out


@app.post("/api/batches")
async def start_batch(cfg: BatchConfig):
    b = Batch(cfg)
    BATCHES[b.id] = b

    async def go():
        try:
            await b.run_all()
        except OverBudget as e:
            b.case.set_phase(f"blocked: {e}")
        finally:
            _save_stats(b)

    _spawn(b.id, go())
    return {"id": b.id}


@app.get("/api/batches/{batch_id}/case")
def get_case(batch_id: str):
    return json.loads((_batch_dir(batch_id) / "case" / "case.json").read_text())


@app.get("/api/batches/{batch_id}/runs/{run_id}/events")
def run_events(batch_id: str, run_id: str):
    return read_events(_batch_dir(batch_id) / "runs" / run_id / "events.jsonl")


@app.get("/api/batches/{batch_id}/forks/{fork_id}/{child}/events")
def fork_events(batch_id: str, fork_id: str, child: str):
    return read_events(_batch_dir(batch_id) / "forks" / fork_id / child / "events.jsonl")


@app.get("/api/batches/{batch_id}/investigator/events")
def investigator_events(batch_id: str):
    return read_events(_batch_dir(batch_id) / "investigator" / "events.jsonl")


@app.get("/api/batches/{batch_id}/files/{path:path}")
def batch_file(batch_id: str, path: str):
    """Charts and outputs saved with a batch, such as `runs/r01/live/02_confusion.png` in replays."""
    root = _batch_dir(batch_id).resolve()
    full = (root / path).resolve()
    if root not in full.parents or not full.is_file() or "holdout_labels" in full.name:
        raise HTTPException(404, "no such file")
    return FileResponse(full, headers=FILE_HEADERS)


@app.post("/api/batches/{batch_id}/investigate")
async def investigate(batch_id: str):
    b = _live(batch_id)
    _spawn(batch_id, b.investigate())
    return {"ok": True}


class Decision(BaseModel):
    approve: bool


@app.post("/api/batches/{batch_id}/decision")
async def decision(batch_id: str, d: Decision):
    b = _live(batch_id)
    if b.case.data.get("phase") != "awaiting_approval":
        raise HTTPException(409, "nothing is waiting for approval")
    _spawn(batch_id, b.decide(d.approve))
    return {"ok": True}


@app.post("/api/batches/{batch_id}/stop")
async def stop(batch_id: str):
    b = _live(batch_id)
    t = TASKS.get(batch_id)
    if t and not t.done():
        t.cancel()
    await b.close()
    b.case.set_phase("stopped")
    return {"ok": True}


@app.websocket("/api/batches/{batch_id}/ws")
async def ws(websocket: WebSocket, batch_id: str):
    await websocket.accept()
    b = BATCHES.get(batch_id)
    if b is None:
        try:
            case = get_case(batch_id)
        except HTTPException as e:
            await websocket.send_json({"kind": "error", "message": e.detail})
            await websocket.close(code=4404)
            return
        await websocket.send_json({"kind": "snapshot", "case": case, "live": False})
        await websocket.close()
        return
    q = b.subscribe()
    try:
        await websocket.send_json({"kind": "snapshot", "case": b.case.read(), "live": True})
        while True:
            await websocket.send_json(await q.get())
    except WebSocketDisconnect:
        pass
    finally:
        b.unsubscribe(q)


# Registered last, so they never shadow the batch routes or the websocket.
@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def api_not_found(rest: str) -> Response:
    return JSONResponse({"error": "not found"}, status_code=404)


@app.get("/{path:path}")
async def spa(path: str) -> Response:
    """The built web UI, with a fallback to index.html for client-side routes."""
    index = WEB_DIST / "index.html"
    if path:
        candidate = WEB_DIST / path
        if _inside(WEB_DIST, candidate) and candidate.is_file():
            return FileResponse(candidate)
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return Response(
        "The web UI is not built yet: run `cd web && npm run build` (or use the Vite dev server).",
        status_code=404,
        media_type="text/plain",
    )
