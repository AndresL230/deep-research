"""The app: the batch API, its websocket, and the built web UI.

Run from the repo root: `uv run uvicorn deep_research.api:app --reload --port 8000`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import dotenv_values, load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from .config import ROOT_DIR

load_dotenv(ROOT_DIR / ".env")

from . import datasets, domains, hub, traps, user_scripts  # noqa: E402
from .batch import Batch, resume_problem  # noqa: E402 - needs the environment loaded first
from .config import BATCHES_DIR, FIXTURES_DIR, WEB_DIST, BatchConfig, load_prices  # noqa: E402
from .cost_report import cost_report  # noqa: E402
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


# The lab pages run inside the VMs behind Daytona's signed preview URLs. Opened directly in a browser (an iframe
# included) Daytona first shows a "preview URL" warning page that needs a click, once per VM. Fetching them through
# this server lets us send the header that skips it, and keeps every tile on our own origin.
LAB_SKIP_WARNING = {"X-Daytona-Skip-Preview-Warning": "true"}
# Only what lab_page/server.py serves: the page, its state, and the charts in the live folder.
LAB_PATH = re.compile(r"^(|index\.html|state\.json|live/[A-Za-z0-9._ -]{1,200})$")
# The page is agent-adjacent content on our origin: the CSP sandbox gives it an opaque origin even when it is opened
# outside the iframe, so it can never reach this app's cookies, storage or API as us.
LAB_HTML_HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
}
LAB_FILE_HEADERS = {**FILE_HEADERS, "Cache-Control": "no-store"}
_lab_client: httpx.AsyncClient | None = None


def lab_client() -> httpx.AsyncClient:
    global _lab_client
    if _lab_client is None:
        _lab_client = httpx.AsyncClient(timeout=httpx.Timeout(10.0), headers=LAB_SKIP_WARNING, follow_redirects=False)
    return _lab_client


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Keys this machine does not have come from the team hub, when one is set up (hub.py).
    await asyncio.to_thread(hub.load_runner_env)
    yield
    await close_all()
    pusher = hub.pusher()
    if pusher is not None:
        await asyncio.to_thread(pusher.close)  # send what is still queued
    if _lab_client is not None:
        await _lab_client.aclose()


app = FastAPI(title="Orro", lifespan=lifespan)
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


# ---- the team hub: batches other machines ran ----

HUB_CACHE_SECONDS = 10.0
_hub_cache: dict[str, tuple[float, object]] = {}


def _hub_cached(name: str, fetch) -> object:
    """A hub read shared for a few seconds, so the home screen and the cost screen do not wait on it each time."""
    hit = _hub_cache.get(name)
    if hit and time.monotonic() - hit[0] < HUB_CACHE_SECONDS:
        return hit[1]
    value = fetch()
    if value is not None:
        _hub_cache[name] = (time.monotonic(), value)
    return value


def _is_local(batch_id: str) -> bool:
    return any((root / batch_id / "case" / "case.json").exists() for root in (BATCHES_DIR, FIXTURES_DIR))


def _remote_case(batch_id: str) -> dict:
    case = hub.get_case(batch_id) if hub.enabled() else None
    if case is None:
        raise HTTPException(404, f"no batch {batch_id}")
    return case


def _remote_events(batch_id: str, key: str) -> list[dict]:
    if not hub.enabled():
        raise HTTPException(404, f"no batch {batch_id}")
    return hub.get_events(batch_id, key) or []


def _batch_dir(batch_id: str) -> Path:
    for root in (BATCHES_DIR, FIXTURES_DIR):
        d = root / batch_id
        if (d / "case" / "case.json").exists():
            return d
    raise HTTPException(404, f"no batch {batch_id}")


# Phases after which nothing more happens: the batch is a saved replay from then on, even in the server that ran it.
OVER = {"done", "no_split", "stopped"}


def _running(batch_id: str) -> Batch | None:
    """The batch, while it is still live in this server: started here and not over yet."""
    b = BATCHES.get(batch_id)
    return b if b is not None and b.case.data.get("phase") not in OVER else None


def _live(batch_id: str) -> Batch:
    b = _running(batch_id)
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


def _read_stats() -> dict:
    try:
        stats = json.loads(STATS_FILE.read_text())
        return stats if isinstance(stats, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _avg_run_usd(domain: str | None = None) -> float | None:
    """Average cost of one run of a `domain` batch from earlier batches, saved when a batch finishes.

    `avg_run_usd` is the default domain's, as stats saved before domains have it; the others are under `by_domain`.
    """
    stats = _read_stats()
    domain = domain or domains.DEFAULT
    if domain == domains.DEFAULT:
        return stats.get("avg_run_usd")
    return (stats.get("by_domain") or {}).get(domain)


def _save_stats(b: Batch) -> None:
    avg = b.tracker.average_run_usd()
    if avg is not None:
        stats = _read_stats()
        if b.cfg.domain == domains.DEFAULT:
            stats["avg_run_usd"] = avg
        else:
            stats["by_domain"] = {**(stats.get("by_domain") or {}), b.cfg.domain: avg}
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(stats))


@app.get("/api/health")
def health():
    # The hub check is a network call: shared for a few seconds, like the other hub reads.
    hub_status = _hub_cached_status()
    return {"ok": True, "keys": key_status(), "hub": hub_status}


HUB_STATUS_SECONDS = 15.0
_hub_status: tuple[float, dict] | None = None


def _hub_cached_status() -> dict:
    global _hub_status
    if not hub.enabled():
        return {"state": "off"}
    if _hub_status and time.monotonic() - _hub_status[0] < HUB_STATUS_SECONDS:
        cached = dict(_hub_status[1])
    else:
        cached = hub.status()
        _hub_status = (time.monotonic(), cached)
    # What is queued changes every second: always fresh.
    p = hub.pusher()
    if p is not None:
        cached.update(queued=p.queued(), last_push_at=p.last_ok_at, push_error=p.last_error)
    return cached


@app.get("/api/defaults")
def defaults():
    prices = load_prices()
    missing = any(v.get("input_per_mtok") is None for v in prices.get("models", {}).values())
    return {
        "config": BatchConfig().model_dump(),
        "prices_missing": missing or prices.get("daytona_vm_per_hour") is None,
        # Every trap a batch can plant, for the picker (`BatchConfig.trap` is one of their names).
        "traps": [t.public() for t in traps.registered()],
        # Every domain a batch can run, each with its own defaults (`BatchConfig.domain` is one of their names).
        # `config` above is the default domain's.
        "domains": [{**d.public(), "config": BatchConfig(domain=d.name).model_dump()} for d in domains.registered()],
    }


@app.post("/api/estimate")
def estimate(cfg: BatchConfig):
    # Runs of different domains cost differently (a robot run simulates episodes), so each has its own average.
    avg = _avg_run_usd(cfg.domain)
    runs = estimate_batch_usd(cfg.n_runs, avg)
    # No split yet, so this counts every arm the config allows. The `show` arm only exists for a step that
    # has a weaker version defined, so this is an upper bound (forks.arm_plan).
    n_arms = 2 + cfg.placebo_arm + cfg.show_arm
    forks = None if avg is None else avg * n_arms * cfg.forks_per_choice
    return {
        "avg_run_usd": avg,
        "runs_usd": runs,
        "forks_usd": forks,
        "total_usd": None if runs is None else runs + forks,
        "over_budget": runs is not None and runs + forks > cfg.budget_usd,
        "basis": "average of earlier runs" if avg is not None else "no earlier runs yet",
        "domain": cfg.domain,
    }


@app.get("/api/datasets")
def list_datasets():
    return datasets.list_datasets()


async def _read_body(request: Request, limit: int) -> bytes:
    """The request body, refused once it passes `limit` bytes."""
    too_big = HTTPException(413, f"the file is larger than {_size(limit)}")
    if int(request.headers.get("content-length") or 0) > limit:
        raise too_big
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            raise too_big
    if not raw:
        raise HTTPException(422, "the file is empty")
    return bytes(raw)


def _size(n: int) -> str:
    return f"{n // (1024 * 1024)} MB" if n >= 1024 * 1024 else f"{n // 1024} KB"


@app.post("/api/datasets")
async def upload_dataset(request: Request, name: str = "dataset.csv"):
    """The request body is the CSV file itself. Returns its columns and a suggested target."""
    raw = await _read_body(request, datasets.MAX_UPLOAD_BYTES)
    try:
        return await asyncio.to_thread(datasets.save_upload, name, raw)
    except datasets.DatasetError as e:
        raise HTTPException(422, str(e)) from e


@app.post("/api/scripts")
async def upload_script(request: Request, name: str = "train.py"):
    """The request body is the Python training script. It is parsed, never run, on this server."""
    raw = await _read_body(request, user_scripts.MAX_UPLOAD_BYTES)
    try:
        return user_scripts.save_upload(name, raw)
    except user_scripts.ScriptError as e:
        raise HTTPException(422, str(e)) from e


def _resumable(batch_id: str) -> bool:
    """A saved batch of ours (not a fixture, not live) that `Batch.resume` would accept."""
    if _running(batch_id):
        return False
    d = BATCHES_DIR / batch_id
    try:
        case = json.loads((d / "case" / "case.json").read_text())
    except Exception:  # noqa: BLE001 - a half-written case file is not resumable
        return False
    return resume_problem(case, d) is None


@app.get("/api/batches")
def list_batches():
    out = []
    # Live means running in this server. Anything else on disk, ours or a fixture, is a replay; one of ours that
    # stopped at a split can be resumed.
    for root in (BATCHES_DIR, FIXTURES_DIR):
        if root.exists():
            for d in sorted(root.iterdir()):
                if (d / "case" / "case.json").exists():
                    item = {"id": d.name, "kind": "live" if _running(d.name) else "replay"}
                    if root is BATCHES_DIR and _resumable(d.name):
                        item["resumable"] = True
                    out.append(item)
    # Batches other machines ran, from the team hub. They open as replays, read from the hub.
    seen = {b["id"] for b in out}
    for row in (_hub_cached("batches", hub.list_batches) if hub.enabled() else None) or []:
        if isinstance(row, dict) and row.get("id") not in seen:
            out.append({"id": row["id"], "kind": "replay", "machine": row.get("machine"), "remote": True})
    return out


@app.get("/api/costs")
def costs():
    """Spend across every batch (cost_report.py): live ones from memory, saved ones and fixtures from disk."""
    entries, seen = [], set()
    for root in (BATCHES_DIR, FIXTURES_DIR):
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            path = d / "case" / "case.json"
            if d.name in seen or not path.exists():
                continue
            seen.add(d.name)
            b = BATCHES.get(d.name)
            try:
                case = b.case.read() if b is not None else json.loads(path.read_text())
                # Fixtures carry no date: their files' times are the checkout's, not the batch's.
                mtime = None if root == FIXTURES_DIR else path.stat().st_mtime
            except (OSError, ValueError):
                continue  # a case file that cannot be read is left out, not a failed report
            entries.append({"id": d.name, "kind": "live" if _running(d.name) else "replay", "case": case, "mtime": mtime})
    # The rest of the team's spend, from the hub.
    for row in (_hub_cached("cases", hub.all_cases) if hub.enabled() else None) or []:
        if isinstance(row, dict) and row.get("id") not in seen and isinstance(row.get("case"), dict):
            seen.add(row["id"])
            entries.append({"id": row["id"], "kind": "replay", "case": row["case"], "mtime": None, "machine": row.get("machine")})
    return cost_report(entries)


# One resume at a time per batch: two clicks (two tabs) must not build two batches and start two investigators.
_RESUME_LOCKS: dict[str, asyncio.Lock] = {}


@app.post("/api/batches/{batch_id}/resume")
async def resume_batch(batch_id: str, investigate: bool = False):
    """Load a saved batch back into this server so the investigator and the fork experiment can run on it.

    Only a batch whose runs are scored, with a split and no verdict yet. It comes back in phase `ready`; with
    `?investigate=true` the investigator starts right away.
    """
    return await _resume_locked(batch_id, investigate)


async def _resume_locked(batch_id: str, investigate: bool) -> dict:
    async with _RESUME_LOCKS.setdefault(batch_id, asyncio.Lock()):
        return await _resume(batch_id, investigate)


async def _resume(batch_id: str, investigate: bool) -> dict:
    b = _running(batch_id)
    if b is None:
        _batch_dir(batch_id)  # 404 for an unknown id
        # A batch that is over in this server (stopped, say) is a replay; resuming it starts from its files on disk.
        BATCHES.pop(batch_id, None)
        try:
            b = await asyncio.to_thread(Batch.resume, batch_id, BATCHES_DIR)
        except ValueError as e:
            raise HTTPException(409, f"this batch cannot be resumed: {e}") from e
        BATCHES[b.id] = b
    # Only when nothing is already running for it: a second click must not start a second investigator.
    task = TASKS.get(b.id)
    if investigate and b.case.data.get("phase") == "ready" and (task is None or task.done()):
        _spawn(b.id, b.investigate())
    return {"id": b.id, "phase": b.case.data.get("phase")}


@app.post("/api/batches")
async def start_batch(cfg: BatchConfig):
    try:
        # Check the settings (for tabular: the dataset, target and script) before anything is written or started.
        await asyncio.to_thread(domains.get(cfg.domain).check_config, cfg)
        b = await asyncio.to_thread(Batch, cfg)
    except (datasets.DatasetError, user_scripts.ScriptError, domains.ConfigError) as e:
        raise HTTPException(422, str(e)) from e
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


CHART_SUFFIXES = (".png", ".jpg", ".jpeg", ".svg")


def _saved_charts(root: Path, rel: str) -> list[str]:
    """Charts on disk under `<rel>/live`, oldest first, as paths for the files endpoint."""
    live = root / rel / "live"
    if not live.is_dir():
        return []
    files = [f for f in live.iterdir() if f.is_file() and f.suffix.lower() in CHART_SUFFIXES]
    files.sort(key=lambda f: (f.stat().st_mtime, f.name))
    return [f"{rel}/live/{f.name}" for f in files]


def _with_charts(case: dict, root: Path) -> dict:
    """Fill in `charts` for runs and fork children that have chart files on disk but no list in the case file."""
    for run_id, run in (case.get("runs") or {}).items():
        if isinstance(run, dict) and not run.get("charts"):
            found = _saved_charts(root, f"runs/{run_id}")
            if found:
                run["charts"] = found
    for fork_id, fork in (case.get("forks") or {}).items():
        for cid, child in ((fork or {}).get("children") or {}).items():
            if isinstance(child, dict) and not child.get("charts"):
                found = _saved_charts(root, f"forks/{fork_id}/{cid}")
                if found:
                    child["charts"] = found
    return case


@app.get("/api/batches/{batch_id}/case")
def get_case(batch_id: str):
    if not _is_local(batch_id):
        return _remote_case(batch_id)
    root = _batch_dir(batch_id)
    return _with_charts(json.loads((root / "case" / "case.json").read_text()), root)


def _events(batch_id: str, rel: str, key: str) -> list[dict]:
    if not _is_local(batch_id):
        return _remote_events(batch_id, key)
    return read_events(_batch_dir(batch_id) / rel / "events.jsonl")


@app.get("/api/batches/{batch_id}/runs/{run_id}/events")
def run_events(batch_id: str, run_id: str):
    return _events(batch_id, f"runs/{run_id}", run_id)


@app.get("/api/batches/{batch_id}/forks/{fork_id}/{child}/events")
def fork_events(batch_id: str, fork_id: str, child: str):
    return _events(batch_id, f"forks/{fork_id}/{child}", f"{fork_id}/{child}")


@app.get("/api/batches/{batch_id}/investigator/events")
def investigator_events(batch_id: str):
    return _events(batch_id, "investigator", "investigator")


@app.get("/api/batches/{batch_id}/files/{path:path}")
def batch_file(batch_id: str, path: str):
    """Charts and outputs saved with a batch, such as `runs/r01/live/02_confusion.png` in replays, or a robot run's
    motion files (`runs/r01/outputs/live/practice.motion.json`). Never a domain's hidden truth (`Domain.secret_files`):
    the holdout labels, the hidden can positions."""
    root = _batch_dir(batch_id).resolve()
    full = (root / path).resolve()
    secret = ("holdout_labels", *domains.secret_files())
    if root not in full.parents or not full.is_file() or any(s in full.name for s in secret):
        raise HTTPException(404, "no such file")
    return FileResponse(full, headers=FILE_HEADERS)


def _case(batch_id: str) -> dict:
    b = BATCHES.get(batch_id)
    return b.case.read() if b is not None else get_case(batch_id)


async def _proxy_lab(lab_url: str | None, path: str) -> Response:
    if not lab_url:
        raise HTTPException(404, "this run has no lab page")
    if not LAB_PATH.match(path):
        raise HTTPException(404, "no such file")
    base, _, query = lab_url.partition("?")
    target = f"{base.rstrip('/')}/{path}" + (f"?{query}" if query else "")
    try:
        res = await lab_client().get(target)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"the lab page did not answer ({type(e).__name__})") from e
    if res.status_code != 200:
        raise HTTPException(502 if res.status_code >= 300 else res.status_code, f"the lab page answered HTTP {res.status_code}")
    ctype = res.headers.get("content-type", "application/octet-stream")
    if path in ("", "index.html"):
        return Response(res.content, media_type="text/html; charset=utf-8", headers=LAB_HTML_HEADERS)
    if path == "state.json":
        return Response(res.content, media_type="application/json", headers=LAB_FILE_HEADERS)
    if not ctype.startswith("image/"):
        raise HTTPException(404, "no such file")
    return Response(res.content, media_type=ctype.split(";")[0], headers=LAB_FILE_HEADERS)


@app.get("/api/batches/{batch_id}/runs/{run_id}/lab/{path:path}")
async def run_lab(batch_id: str, run_id: str, path: str):
    """A run's lab page through this server, without Daytona's preview warning. Use the trailing slash."""
    run = _case(batch_id).get("runs", {}).get(run_id) or {}
    return await _proxy_lab(run.get("lab_url"), path)


@app.get("/api/batches/{batch_id}/forks/{fork_id}/{child}/lab/{path:path}")
async def fork_lab(batch_id: str, fork_id: str, child: str, path: str):
    fork = _case(batch_id).get("forks", {}).get(fork_id) or {}
    return await _proxy_lab((fork.get("children") or {}).get(child, {}).get("lab_url"), path)


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
    b = _running(batch_id)
    if b is None:
        try:
            case = get_case(batch_id)
        except HTTPException as e:
            await websocket.send_json({"kind": "error", "message": e.detail})
            await websocket.close(code=4404)
            return
        await websocket.send_json({"kind": "snapshot", "case": case, "live": False, "resumable": _resumable(batch_id)})
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
