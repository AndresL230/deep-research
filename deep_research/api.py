"""The app: the batch API, its websocket, and the built web UI.

Run from the repo root: `uv run uvicorn deep_research.api:app --reload --port 8000`.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import mimetypes
import os
import re
import threading
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import dotenv_values, load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from .config import ROOT_DIR

load_dotenv(ROOT_DIR / ".env")

from . import controllers, datasets, domains, foolrate, hub, notebook, robot_view, traps, user_scripts  # noqa: E402
from .batch import Batch, Refused, more_pairs_problem, more_pairs_quote, resume_problem, testable_suspects  # noqa: E402 - needs the environment loaded first
from .batch_summary import summarize  # noqa: E402
from .case_file import current_domain, with_evidence  # noqa: E402
from .config import BATCHES_DIR, FIXTURES_DIR, WEB_DIST, BatchConfig, load_prices  # noqa: E402
from .cost_report import cost_report  # noqa: E402
from .costs import CostTracker, OverBudget, estimate_batch_usd, run_rate  # noqa: E402
from .events import read_events  # noqa: E402
from .experiments import MAX_PAIRS_PER_CALL as MAX_EXPERIMENT_PAIRS  # noqa: E402
from .gateway_guard import GatewayGuard  # noqa: E402

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
# Added last, so it runs first: with ORRO_GATEWAY_SECRET set, only the Cloudflare gateway gets in (gateway_guard.py).
app.add_middleware(GatewayGuard)

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
    # A batch another machine saved under a domain's old name reads as the domain it is today.
    return current_domain(case) if isinstance(case, dict) else case


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
# A batch that crashed ("error: ...") or that the budget guard refused ("blocked: ...") is over too.
OVER_PREFIXES = ("error:", "blocked:")


def _is_over(phase: str | None) -> bool:
    return phase in OVER or (phase or "").startswith(OVER_PREFIXES)


def _running(batch_id: str) -> Batch | None:
    """The batch, while it is still live in this server: started here and not over yet."""
    b = BATCHES.get(batch_id)
    return b if b is not None and not _is_over(b.case.data.get("phase")) else None


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
            b = BATCHES[batch_id]
            b.case.set_phase(f"error: {t.exception()}"[:300])
            # The batch is over now, so Stop no longer reaches it: delete any VMs it still holds here.
            TASKS[batch_id] = asyncio.get_running_loop().create_task(b.close())

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


def _avg_by_model(domain: str) -> dict[str, float]:
    """Average cost of one run per analyst model, from earlier `domain` batches (`by_domain_model`)."""
    return dict(((_read_stats().get("by_domain_model") or {}).get(domain or domains.DEFAULT)) or {})


def _save_stats(b: Batch) -> None:
    avg = b.tracker.average_run_usd()
    if avg is not None:
        stats = _read_stats()
        if b.cfg.domain == domains.DEFAULT:
            stats["avg_run_usd"] = avg
        else:
            stats["by_domain"] = {**(stats.get("by_domain") or {}), b.cfg.domain: avg}
        # And per analyst model, so a batch with a lineup is estimated from each model's own runs.
        per_model: dict[str, set[str]] = {}
        for run_id in b.case.data["runs"]:
            per_model.setdefault(b.run_model(run_id), set()).add(f"run:{run_id}")
        own = dict((stats.get("by_domain_model") or {}).get(b.cfg.domain) or {})
        for model, keys in per_model.items():
            m_avg = b.tracker.average_run_usd(keys=keys)
            if m_avg is not None:
                own[model] = m_avg
        stats["by_domain_model"] = {**(stats.get("by_domain_model") or {}), b.cfg.domain: own}
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(stats))


def _model_avg(model: str, own: dict[str, float], legacy: float | None, prices: dict) -> float | None:
    """One run's cost on `model`: its own average when earlier runs used it, else another model's average scaled by
    what a typical run's tokens cost on each (costs.run_rate). Stats saved before lineups have one average per domain,
    from runs on the default analyst model."""
    if model in own:
        return own[model]
    refs = list(own.items())
    if legacy is not None:
        refs.append((BatchConfig().analyst_model, legacy))
    target = run_rate(prices, model)
    for ref, avg in refs:
        rate = run_rate(prices, ref)
        if target is not None and rate:
            return avg * target / rate
    return None


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
    lineup = cfg.lineup()
    by_model = None
    own = _avg_by_model(cfg.domain)
    if len(lineup) > 1 or lineup[0] in own:
        # Each model's runs at that model's average: runs take the models in turn.
        prices = load_prices()
        counts = {m: sum(cfg.model_for_run(i) == m for i in range(cfg.n_runs)) for m in lineup}
        by_model = {m: {"runs": n, "avg_run_usd": _model_avg(m, own, avg, prices)} for m, n in counts.items()}
        known = [v["avg_run_usd"] for v in by_model.values()]
        avg = None if any(a is None for a in known) else sum(v["runs"] * v["avg_run_usd"] for v in by_model.values()) / cfg.n_runs
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
        **({"by_model": by_model} if by_model else {}),
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


@app.get("/api/controllers")
def list_controllers():
    return controllers.list_controllers()


@app.post("/api/controllers")
async def upload_controller(request: Request, name: str = "controller.py"):
    """The request body is a robot controller (a Python file with a `Controller` class). Parsed here, never run."""
    raw = await _read_body(request, controllers.MAX_UPLOAD_BYTES)
    try:
        return controllers.save_upload(name, raw)
    except controllers.ControllerError as e:
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


# The home table's summaries (batch_summary.py), kept while their case file is unchanged: a saved batch's by its
# file's (mtime, size), a hub batch's by the hub's revision. A live batch's is worked out from memory each time.
_DISK_SUMMARIES: dict[Path, tuple[tuple, dict | None]] = {}
_HUB_SUMMARIES: dict[str, tuple[object, dict | None]] = {}


def _disk_summary(batch_id: str, path: Path, fixture: bool) -> dict | None:
    """A saved batch's or a fixture's summary from its case file, or None when the file cannot be read."""
    b = BATCHES.get(batch_id)
    try:
        if b is not None:
            # Fixtures carry no date: their files' times are the checkout's, not the batch's (as in /api/costs).
            return summarize(batch_id, b.case.read(), None if fixture else path.stat().st_mtime)
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size)
        hit = _DISK_SUMMARIES.get(path)
        if hit and hit[0] == key:
            return hit[1]
        summary = summarize(batch_id, json.loads(path.read_text()), None if fixture else st.st_mtime)
    except (OSError, ValueError):
        return None
    _DISK_SUMMARIES[path] = (key, summary)
    return summary


def _hub_summaries(rows: list[dict]) -> dict[str, dict | None]:
    """Summaries of the hub's batches. The list says each batch's revision; the case files (one bigger read, shared
    with the cost screen) are fetched only when a revision is new to this server."""
    out: dict[str, dict | None] = {}
    need = []
    for row in rows:
        hit = _HUB_SUMMARIES.get(row["id"])
        if hit and row.get("revision") is not None and hit[0] == row.get("revision"):
            out[row["id"]] = hit[1]
        else:
            need.append(row)
    if need:
        cases = {c["id"]: c for c in _hub_cached("cases", hub.all_cases) or [] if isinstance(c, dict) and "id" in c}
        for row in need:
            c = cases.get(row["id"])
            summary = summarize(row["id"], c.get("case"), None, c.get("started_at") or row.get("started_at")) if c else None
            out[row["id"]] = summary
            if c and c.get("revision") is not None:
                _HUB_SUMMARIES[row["id"]] = (c["revision"], summary)
    return out


@app.get("/api/batches")
def list_batches():
    out = []
    # Live means running in this server. Anything else on disk, ours or a fixture, is a replay; one of ours that
    # stopped at a split can be resumed.
    for root in (BATCHES_DIR, FIXTURES_DIR):
        if root.exists():
            for d in sorted(root.iterdir()):
                path = d / "case" / "case.json"
                if path.exists():
                    item = {"id": d.name, "kind": "live" if _running(d.name) else "replay"}
                    if root is BATCHES_DIR and _resumable(d.name):
                        item["resumable"] = True
                    if root is FIXTURES_DIR:
                        item["fixture"] = True
                    item["summary"] = _disk_summary(d.name, path, root == FIXTURES_DIR)
                    out.append(item)
    # Batches other machines ran, from the team hub. They open as replays, read from the hub.
    seen = {b["id"] for b in out}
    rows = [r for r in (_hub_cached("batches", hub.list_batches) if hub.enabled() else None) or []
            if isinstance(r, dict) and isinstance(r.get("id"), str) and r["id"] not in seen]
    summaries = _hub_summaries(rows) if rows else {}
    for row in rows:
        out.append({"id": row["id"], "kind": "replay", "machine": row.get("machine"), "remote": True,
                    "summary": summaries.get(row["id"])})
    return out


@app.get("/api/foolrate")
def foolrate_reports():
    """The fool-rate reports (`cli foolrate`, foolrate.py), newest first, read-only: `batches/_foolrate/*.json`, then
    the committed ones under `fixtures/_foolrate/`, which replay without keys. Only the counts, the intervals, the
    costs and the lessons tested go out (`foolrate.REPORT_KEYS`)."""
    return foolrate.reports([(BATCHES_DIR, False), (FIXTURES_DIR, True)])


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
        # The checkpoint, not the case file, says whether an approval is still waiting (plan Phase 6: a pending
        # approval survives a restart, even one interrupted mid-answer).
        try:
            await b.restore_pending()
        except Exception as e:  # noqa: BLE001 - a resume never fails on this repair
            log.warning("could not restore the pending approval of %s: %s", b.id, e)
    # Only when nothing is already running for it: a second click must not start a second investigator.
    task = TASKS.get(b.id)
    if investigate and b.case.data.get("phase") == "ready" and (task is None or task.done()):
        _spawn(b.id, b.investigate())
    return {"id": b.id, "phase": b.case.data.get("phase")}


# ---- more pairs: more copies per arm for a verdict whose evidence is still open ----


def _more_pairs_case(batch_id: str) -> dict:
    """The saved case file of a batch of ours that more pairs could run on, or 404/409 with the reason it cannot."""
    if not (BATCHES_DIR / batch_id / "case" / "case.json").is_file():
        if (FIXTURES_DIR / batch_id / "case" / "case.json").is_file():
            raise HTTPException(409, "cannot run more pairs: this is a fixture, a saved example with no real runs to fork")
        raise HTTPException(404, f"no batch {batch_id}")
    b, task = _running(batch_id), TASKS.get(batch_id)
    if b is not None or (task is not None and not task.done()):
        phase = b.case.data.get("phase") if b is not None else "closing"
        raise HTTPException(409, f"cannot run more pairs: this batch is running something else (phase {phase}); "
                                 f"one experiment at a time")
    try:
        case = with_evidence(json.loads((BATCHES_DIR / batch_id / "case" / "case.json").read_text()))
    except (OSError, ValueError) as e:
        raise HTTPException(409, f"cannot run more pairs: the case file cannot be read ({type(e).__name__})") from e
    problem = more_pairs_problem(case, BATCHES_DIR / batch_id)
    if problem:
        raise HTTPException(409, f"cannot run more pairs: {problem}")
    return case


def _n_per_arm(n: int | None) -> int | None:
    if n is not None and n < 1:
        raise HTTPException(422, "n must be 1 or more")
    return n


@app.get("/api/batches/{batch_id}/more-pairs")
def more_pairs_estimate(batch_id: str, n: int | None = None):
    """What `POST .../more-pairs?n=` would run and cost, for the confirmation: nothing is started or loaded.

    `n` (copies per arm) defaults to what reaches the needed pairs, at least 1, and is held to at most 8. 409 with the
    reason when more pairs cannot run on this batch; a budget that cannot cover it is `over_budget` here (the POST
    refuses it)."""
    case = _more_pairs_case(batch_id)
    tracker = CostTracker(budget_usd=float((case.get("config") or {}).get("budget_usd") or BatchConfig().budget_usd))
    tracker.restore(case.get("costs") or {})
    try:
        return more_pairs_quote(case, tracker, _n_per_arm(n))
    except Refused as e:
        raise HTTPException(409, f"cannot run more pairs: {e}") from e


@app.post("/api/batches/{batch_id}/more-pairs")
async def more_pairs(batch_id: str, n: int | None = None):
    """Run `n` more copies per arm of the fork experiment an open verdict rests on, then update the verdict.

    Loads the saved batch back into this server the way `/resume` does, claims it (phase `forking`) and starts the
    copies; the live websocket then shows them as it shows a first experiment. Returns the quote with the new
    children's ids. 409 with the reason when it cannot run, the budget included."""
    async with _RESUME_LOCKS.setdefault(batch_id, asyncio.Lock()):
        _more_pairs_case(batch_id)
        n = _n_per_arm(n)
        try:
            b = await asyncio.to_thread(Batch.reopen, batch_id, BATCHES_DIR)
            job = b.reserve_more_pairs(n)
        except Refused as e:
            raise HTTPException(409, f"cannot run more pairs: {e}") from e
        BATCHES[b.id] = b
        _spawn(b.id, b.run_more_pairs(reserved=job))
        return {"id": b.id, "phase": b.case.data.get("phase"), **job}


# ---- asking the finished investigator to test a suspect it left untested ----


@app.post("/api/batches/{batch_id}/suspects/{suspect_id}/test")
async def test_suspect(batch_id: str, suspect_id: str):
    """Resume a finished batch's investigator on its own thread, asking it to test `suspect_id`.

    Loads the saved batch back the way more pairs do (`Batch.reopen`) and claims it (phase `investigating`). The
    experiment the investigator asks for then waits on the usual approval card, under the budget guard. 409 with the
    reason when it cannot run: a simulated batch, a fixture, one still running, a suspect already tested, a missing
    saved thread."""
    async with _RESUME_LOCKS.setdefault(batch_id, asyncio.Lock()):
        if not (BATCHES_DIR / batch_id / "case" / "case.json").is_file():
            if (FIXTURES_DIR / batch_id / "case" / "case.json").is_file():
                raise HTTPException(409, "cannot test it: this is a fixture, a saved example that cannot be resumed")
            raise HTTPException(404, f"no batch {batch_id}")
        task = TASKS.get(batch_id)
        if _running(batch_id) is not None or (task is not None and not task.done()):
            raise HTTPException(409, "cannot test it: this batch is running something else; one experiment at a time")
        try:
            b = await asyncio.to_thread(Batch.reopen, batch_id, BATCHES_DIR, suspect_id)
            b.claim_test(suspect_id)
        except Refused as e:
            raise HTTPException(409, f"cannot test it: {e}") from e
        BATCHES[b.id] = b
        _spawn(b.id, b.test_suspect(suspect_id))
        return {"id": b.id, "phase": b.case.data.get("phase"), "suspect_id": suspect_id}


@app.post("/api/batches")
async def start_batch(cfg: BatchConfig):
    try:
        # Check the settings (for tabular: the dataset, target and script) before anything is written or started.
        await asyncio.to_thread(domains.get(cfg.domain).check_config, cfg)
        b = await asyncio.to_thread(Batch, cfg)
    except (datasets.DatasetError, user_scripts.ScriptError, controllers.ControllerError, domains.ConfigError) as e:
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
    # Verdicts saved before `evidence` get it here, from their arm counts.
    return _with_charts(with_evidence(json.loads((root / "case" / "case.json").read_text())), root)


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
    # Compared in lower case: macOS file systems are case-insensitive, so `HIDDEN_POSITIONS.json` opens the secret file.
    if root not in full.parents or not full.is_file() or any(s.lower() in full.name.lower() for s in secret):
        raise HTTPException(404, "no such file")
    rel = full.relative_to(root).as_posix()
    if _in_hidden_folder(rel.lower()) and not _hidden_listed(batch_id, rel):
        raise HTTPException(404, "no such file")
    return FileResponse(full, headers=FILE_HEADERS)


# The statuses of a run that has been scored: only then are its hidden results shown.
SCORED = ("honest", "inflated", "unclear")
# A hidden episode's recording (domains/robot_arm.py `hidden_recordings`): `runs/r02/hidden/07-s0.motion.json`.
HIDDEN_PATH = re.compile(r"^(runs/[A-Za-z0-9._-]+|forks/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/hidden/[A-Za-z0-9._-]+\.motion\.json$")


def _in_hidden_folder(rel: str) -> bool:
    """Whether the batch-relative `rel` is inside a run's or fork child's `hidden/` folder."""
    parts = rel.split("/")
    return (len(parts) > 3 and parts[0] == "runs" and parts[2] == "hidden") or (
        len(parts) > 4 and parts[0] == "forks" and parts[3] == "hidden")


def _hidden_listed(batch_id: str, rel: str, case: dict | None = None) -> bool:
    """Whether the case lists `rel` as a hidden episode's recording of a scored run or fork child.

    The recordings are written while a run is being scored and hold the hidden can positions, so a file is only
    served once its run's score, with `hidden_results` naming the file, is in the case file."""
    m = HIDDEN_PATH.match(rel)
    if m is None:
        return False
    try:
        case = case if case is not None else _case(batch_id)
    except (HTTPException, OSError, ValueError):
        return False
    owner = m.group(1).split("/")
    if owner[0] == "runs":
        entry = (case.get("runs") or {}).get(owner[1])
    else:
        entry = (((case.get("forks") or {}).get(owner[1]) or {}).get("children") or {}).get(owner[2])
    if not isinstance(entry, dict) or entry.get("status") not in SCORED:
        return False
    return any(isinstance(h, dict) and h.get("motion") == rel for h in entry.get("hidden_results") or [])


@app.get("/api/memory/{domain}")
def memory_notebook(domain: str):
    """The investigator's notebook for `domain` (notebook.py), as plain text, read-only. Only a registered domain's
    `_memory/<domain>/AGENTS.md` under the batches folder, never any other file."""
    if domain not in domains.names():
        raise HTTPException(404, f"no domain {domain}")
    base = notebook.memory_dir(BATCHES_DIR).resolve()
    full = notebook.notebook_path(BATCHES_DIR, domain).resolve()
    if base not in full.parents or not full.is_file():
        raise HTTPException(404, f"no notebook for {domain} yet")
    return Response(full.read_text(), media_type="text/plain; charset=utf-8",
                    headers={**FILE_HEADERS, "Cache-Control": "no-cache"})


# ---- the robot viewer (robot_view.py): the 3D scene and each motion file's poses ----

# Where a run or fork child keeps its outputs: the only places a motion file is read from (never task/). A name
# may hold commas: agents name practice episodes by their can positions (`v5_0.3,0.25_0.25,-0.25_s0.motion.json`).
# A run's, or the starting code's, recorded episodes on another test set (`Batch.other_benchmarks`): LIBERO-PRO's
# positions. Not the hidden test, so nothing to keep back.
BENCH_PATH = re.compile(r"^(runs/[A-Za-z0-9._-]+|baseline)/benchmarks/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.motion\.json$")
MOTION_PATH = re.compile(r"^(runs/[A-Za-z0-9._-]+|forks/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/outputs/[A-Za-z0-9._/, -]+\.json$")


def _gzipped_json(packed: bytes, request: Request, cache: str) -> Response:
    """Send JSON that is already gzipped: as it is when the client takes gzip, else unpacked."""
    headers = {"Vary": "Accept-Encoding", "Cache-Control": cache}
    if "gzip" in request.headers.get("accept-encoding", "").lower():
        return Response(packed, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(gzip.decompress(packed), media_type="application/json", headers=headers)


def _robot_unavailable(e: Exception) -> HTTPException:
    return HTTPException(503, "the robot viewer needs mujoco and the robot meshes (`uv run python -m sim.fetch_assets "
                              f"--model all`): {type(e).__name__}")


@app.get("/api/robot/scene")
def robot_scene(request: Request, model: str = robot_view.DEFAULT_MODEL):
    """A scene for the 3D viewer: every visual geom, its body, pose and color, the meshes, and how to look at it.
    `model` is the `model_id` a motion file's poses name (robot_view.MODELS): the pick-and-place arm by default, or one
    of the two G1 scenes."""
    if model not in robot_view.MODELS:
        raise HTTPException(404, f"no robot model {model!r}")
    try:
        _, packed = robot_view.scene(model)
    except (ImportError, OSError, ValueError) as e:
        raise _robot_unavailable(e) from e
    return _gzipped_json(packed, request, "public, max-age=3600")


@app.get("/api/batches/{batch_id}/motion")
def batch_motion(batch_id: str, path: str, request: Request):
    """One motion file of a run or fork child as body poses per frame (robot_view.poses), for the 3D replay.

    `path` is batch-relative, as in `motion_files`. Only a run's or a fork child's outputs are read, never task/ (the
    hidden can positions live there) or anything a domain keeps secret. A scored run's hidden episodes
    (`runs/<run>/hidden/...`, listed in its `hidden_results`) are read too, once the run is scored.
    A batch another machine ran is read from the team hub's copy (`_hub_motion_file`)."""
    if _is_local(batch_id):
        full = _motion_file(_batch_dir(batch_id).resolve(), path, batch_id)
    else:
        full = _hub_motion_file(batch_id, path, _hub_case(batch_id))
    try:
        packed = robot_view.motion_poses(full)
    except robot_view.MotionError as e:
        raise HTTPException(422, f"cannot replay this file: {e}") from e
    except (ImportError, FileNotFoundError) as e:
        raise _robot_unavailable(e) from e
    return _gzipped_json(packed, request, "no-cache")


MAX_SUMMARIES = 60


@app.get("/api/batches/{batch_id}/motion-summaries")
def batch_motion_summaries(batch_id: str, path: list[str] = Query(default=[])):
    """For the viewer's file picker: each motion file's can start, place target, length and result, without frames.

    `?path=...&path=...`, the same paths as `/motion`. A file that cannot be read has `error` instead."""
    paths = path[:MAX_SUMMARIES]
    local = _is_local(batch_id)
    if local:
        root = _batch_dir(batch_id).resolve()
        find = lambda p: _motion_file(root, p, batch_id)  # noqa: E731
    else:
        case = _hub_case(batch_id)
        find = lambda p: _hub_motion_file(batch_id, p, case)  # noqa: E731

    def one(p: str) -> dict:
        try:
            return robot_view.motion_summary(find(p))
        except HTTPException as e:
            return {"error": str(e.detail)}
        except robot_view.MotionError as e:
            return {"error": str(e)}

    if local:
        return {p: one(p) for p in paths}
    # From the hub: a few at a time, so a picker of 60 files does not wait on 60 reads one after the other.
    return dict(zip(paths, _HUB_FILE_POOL.map(one, paths)))


def _motion_rel(path: str) -> tuple[str, bool]:
    """Batch-relative `path` checked as a motion file's, and whether it is a hidden episode's recording."""
    rel = path.strip()
    hidden = bool(HIDDEN_PATH.match(rel))
    if ".." in rel.split("/") or not (MOTION_PATH.match(rel) or hidden or BENCH_PATH.match(rel)):
        raise HTTPException(400, "not a motion file path: it must be under runs/<run>/outputs or forks/<fork>/<child>/outputs")
    secret = ("holdout_labels", *domains.secret_files())
    if any(s in rel.rsplit("/", 1)[-1] for s in secret):
        raise HTTPException(404, "no such motion file")
    return rel, hidden


def _motion_file(root: Path, path: str, batch_id: str) -> Path:
    """The motion file at batch-relative `path`: only under a run's or fork child's outputs, never a secret, or a
    hidden episode's recording that the case lists for a scored run or fork child (`_hidden_listed`)."""
    rel, hidden = _motion_rel(path)
    secret = ("holdout_labels", *domains.secret_files())
    full = (root / rel).resolve()
    if root not in full.parents or not full.is_file() or any(s in full.name for s in secret):
        raise HTTPException(404, "no such motion file")
    if (hidden or _in_hidden_folder(full.relative_to(root).as_posix())) and not _hidden_listed(batch_id, rel):
        raise HTTPException(404, "no such motion file")
    return full


# ---- motion files of a batch another machine ran: from the team hub (hub.get_file), kept on disk here ----

NOT_ON_HUB = ("This episode's recording isn't on the hub: the batch was run before recordings were shared, "
              "or is still uploading")
HUB_UNREACHABLE = "The team hub could not be reached to fetch this episode's recording: try again in a moment"
BATCH_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_HUB_FILE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="hub-files")
# When each copy was last confirmed against the hub, by its path here, and whether its batch was over by then (the
# copy is then final).
_hub_file_checked: dict[Path, tuple[float, bool]] = {}
_hub_file_lock = threading.Lock()


def hub_files_dir() -> Path:
    """Where the hub's motion files are kept once fetched: `batches/_hub_files/<batch>/<path>`. Safe to delete."""
    return BATCHES_DIR / "_hub_files"


def _hub_case(batch_id: str) -> dict:
    """A hub batch's case file, shared for a few seconds between the motion routes' reads."""
    if not hub.enabled():
        raise HTTPException(404, f"no batch {batch_id}")
    case = _hub_cached(f"case:{batch_id}", lambda: hub.get_case(batch_id))
    if not isinstance(case, dict):
        raise HTTPException(404, f"no batch {batch_id}")
    return case


def _hub_motion_file(batch_id: str, path: str, case: dict) -> Path:
    """A hub batch's motion file, checked like a local one (`_motion_rel`, `_hidden_listed`), as a file on disk.

    Fetched from the hub once, then asked again (with its ETag, so an unchanged file is not sent) only after
    HUB_CACHE_SECONDS while the batch is still going. A copy confirmed once the batch was over is kept as it is."""
    rel, hidden = _motion_rel(path)
    if (hidden or _in_hidden_folder(rel)) and not _hidden_listed(batch_id, rel, case):
        raise HTTPException(404, "no such motion file")
    if not hub.is_motion_path(rel) or not BATCH_ID.match(batch_id):
        raise HTTPException(404, NOT_ON_HUB)
    base = hub_files_dir().resolve()
    local = (base / batch_id / rel).resolve()
    if base not in local.parents:
        raise HTTPException(404, "no such motion file")
    etag_file = local.with_name(local.name + ".etag")
    have = local.is_file()
    over = _is_over(case.get("phase"))
    if have:
        with _hub_file_lock:
            checked_at, final = _hub_file_checked.get(local, (float("-inf"), False))
        if final or time.monotonic() - checked_at < HUB_CACHE_SECONDS:
            return local
    etag = etag_file.read_text().strip() if have and etag_file.is_file() else None
    got = hub.get_file(batch_id, rel, etag=etag)
    if got.status == "ok" and got.content is not None:
        local.parent.mkdir(parents=True, exist_ok=True)
        tmp = local.with_name(f".{local.name}.{threading.get_ident()}.tmp")
        tmp.write_bytes(got.content)
        os.replace(tmp, local)
        if got.etag:
            etag_file.write_text(got.etag)
    elif got.status == "missing":
        raise HTTPException(404, NOT_ON_HUB)
    elif got.status in ("error", "off") and not have:
        raise HTTPException(503, HUB_UNREACHABLE)
    if got.status in ("ok", "unchanged"):
        with _hub_file_lock:
            _hub_file_checked[local] = (time.monotonic(), over)
    return local


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
    # The edit path (plan 6.5): approve a paired experiment with another number of pairs. Plain {"approve"} still works.
    pairs: int | None = Field(default=None, ge=1, le=MAX_EXPERIMENT_PAIRS)


@app.post("/api/batches/{batch_id}/decision")
async def decision(batch_id: str, d: Decision):
    b = _live(batch_id)
    if b.case.data.get("phase") != "awaiting_approval":
        raise HTTPException(409, "nothing is waiting for approval")
    pending = b.case.data["forks"].get("pending") or {}
    if d.pairs is not None and pending.get("kind") not in ("experiment", "method"):
        raise HTTPException(409, "only an experiment's number of pairs can be changed")
    _spawn(batch_id, b.decide(d.approve, d.pairs if d.approve else None))
    return {"ok": True}


class LessonDecision(BaseModel):
    approve: bool


@app.post("/api/batches/{batch_id}/lessons/{lesson_id}")
async def lesson_decision(batch_id: str, lesson_id: str, d: LessonDecision):
    """Approve or reject the lesson the investigator proposed (`propose_lesson`): it answers that approval."""
    b = _live(batch_id)
    pending = b.case.data["forks"].get("pending") or {}
    if b.case.data.get("phase") != "awaiting_approval" or pending.get("lesson_id") != lesson_id:
        raise HTTPException(409, f"lesson {lesson_id} is not waiting for approval")
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
        # The suspects its investigator can be asked to test (a saved batch of ours only, never a fixture).
        d = BATCHES_DIR / batch_id
        testable = testable_suspects(case, d) if (d / "case" / "case.json").is_file() else []
        await websocket.send_json({"kind": "snapshot", "case": case, "live": False, "resumable": _resumable(batch_id),
                                   "testable": testable})
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
    # `/api` itself (a client resolves `/api/x/..` to it) and a missing built asset are never a page: answering
    # them with index.html hides the error, and a stale tab's old chunk then fails as an HTML module instead of a 404.
    if path == "api" or path.startswith("assets/"):
        return JSONResponse({"error": "not found"}, status_code=404)
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return Response(
        "The web UI is not built yet: run `cd web && npm run build` (or use the Vite dev server).",
        status_code=404,
        media_type="text/plain",
    )
