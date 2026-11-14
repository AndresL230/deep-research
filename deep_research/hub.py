"""The client for the hub (hub/, a Cloudflare Worker with D1): the team's shared record of batches, runs and costs.

Turned on by two settings in .env: HUB_URL (the Worker's URL) and HUB_TOKEN (the team token). Without them every
function here does nothing, so the app works exactly as before on its own.

- Keys: `load_runner_env()` fills in ANTHROPIC_API_KEY, DAYTONA_API_KEY and the other runner settings from the hub
  when they are not set locally. A key set in the local .env always wins.
- Pushing: a `Pusher` sends a batch's case file and its agents' events from a background thread, so a slow or
  unreachable hub never holds up a run. It keeps only the newest case file per batch and retries what failed.
- Reading: `list_batches`, `get_case`, `all_cases` and `get_events` read the team's batches, with short timeouts;
  they return None when the hub cannot be reached.

The hub never receives holdout labels, task files or API keys: only case files and agent event logs.
"""

from __future__ import annotations

import logging
import os
import queue
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import httpx

log = logging.getLogger("deep_research.hub")

TIMEOUT = httpx.Timeout(10.0, connect=5.0)
READ_TIMEOUT = httpx.Timeout(6.0, connect=3.0)
MAX_EVENTS_PER_PUSH = 500
RUNNER_KEYS = (
    "ANTHROPIC_API_KEY", "DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET", "DAYTONA_SNAPSHOT", "LANGSMITH_API_KEY",
)


@dataclass(frozen=True)
class HubConfig:
    url: str
    token: str
    machine: str

    @property
    def headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.token}"}


def config() -> HubConfig | None:
    """The hub settings from the environment, or None when the hub is not set up."""
    url = os.environ.get("HUB_URL", "").strip().rstrip("/")
    token = os.environ.get("HUB_TOKEN", "").strip()
    if not url or not token:
        return None
    machine = os.environ.get("HUB_MACHINE", "").strip() or default_machine()
    return HubConfig(url=url, token=token, machine=machine[:64])


@lru_cache(maxsize=1)
def default_machine() -> str:
    """Who this server's batches are from when HUB_MACHINE is not set: the git user's name, else the computer's."""
    try:
        name = subprocess.run(
            ["git", "config", "user.name"], capture_output=True, text=True, timeout=3, check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        name = ""
    return name or socket.gethostname() or "unknown"


def enabled() -> bool:
    return config() is not None


def _client(cfg: HubConfig, timeout: httpx.Timeout = TIMEOUT) -> httpx.Client:
    return httpx.Client(base_url=cfg.url, headers=cfg.headers, timeout=timeout)


# ── keys ─────────────────────────────────────────────────────────────────────


def load_runner_env(client: httpx.Client | None = None) -> list[str]:
    """Set the runner keys the hub holds that are not already set here. Returns the names it set."""
    cfg = config()
    if cfg is None:
        return []
    try:
        c = client or _client(cfg, READ_TIMEOUT)
        res = c.get("/v1/runner-env")
        res.raise_for_status()
        values = res.json()
    except Exception as e:  # noqa: BLE001 - a missing hub must never stop the server from starting
        log.warning("could not load the runner keys from the hub: %s", e)
        return []
    set_now = []
    for name in RUNNER_KEYS:
        value = values.get(name) if isinstance(values, dict) else None
        if isinstance(value, str) and value and not os.environ.get(name, "").strip():
            os.environ[name] = value
            set_now.append(name)
    if set_now:
        log.info("runner settings from the hub: %s", ", ".join(set_now))
    return set_now


# ── reading ──────────────────────────────────────────────────────────────────


def _get(path: str, params: dict | None = None, client: httpx.Client | None = None) -> Any | None:
    cfg = config()
    if cfg is None:
        return None
    try:
        c = client or _client(cfg, READ_TIMEOUT)
        res = c.get(path, params=params)
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return res.json()
    except Exception as e:  # noqa: BLE001
        log.warning("hub read %s failed: %s", path, e)
        return None


def list_batches(client: httpx.Client | None = None) -> list[dict] | None:
    """Every batch on the hub, newest first, without case files. None when the hub cannot be reached."""
    return _get("/v1/batches", client=client)


def all_cases(client: httpx.Client | None = None) -> list[dict] | None:
    """Every batch on the hub with its case file."""
    return _get("/v1/cases", client=client)


def get_case(batch_id: str, client: httpx.Client | None = None) -> dict | None:
    row = _get(f"/v1/batches/{batch_id}", client=client)
    return row.get("case") if isinstance(row, dict) else None


def get_events(batch_id: str, log_key: str, client: httpx.Client | None = None) -> list[dict] | None:
    return _get(f"/v1/batches/{batch_id}/events", {"log": log_key}, client=client)


# ── pushing ──────────────────────────────────────────────────────────────────


@dataclass
class _Pending:
    cases: dict[str, tuple[int, dict, str | None]] = field(default_factory=dict)  # batch -> (revision, case, started_at)
    events: dict[tuple[str, str], dict[int, dict]] = field(default_factory=dict)  # (batch, log) -> {seq: event}


class Pusher:
    """Sends case files and events to the hub from one background thread.

    `push_case` keeps only the newest case per batch; `push_event` queues an event under its log and position.
    Anything that fails stays queued and is retried, with a growing pause, until it goes through or the process ends.
    """

    def __init__(self, cfg: HubConfig, client: httpx.Client | None = None, interval: float = 1.0):
        self.cfg = cfg
        self._client = client
        self._interval = interval
        self._pending = _Pending()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._revisions: dict[str, int] = {}
        self._thread: threading.Thread | None = None
        self.failures = 0
        # For the status badge: when a push last went through, and the last error since then.
        self.last_ok_at: float | None = None
        self.last_error: str | None = None

    def queued(self) -> int:
        """Case files and events waiting to be sent."""
        with self._lock:
            return len(self._pending.cases) + sum(len(v) for v in self._pending.events.values())

    # The revision only has to grow per batch, also across restarts of this server: milliseconds since 1970 do.
    def _revision(self, batch_id: str) -> int:
        r = max(int(time.time() * 1000), self._revisions.get(batch_id, 0) + 1)
        self._revisions[batch_id] = r
        return r

    def push_case(self, batch_id: str, case: dict, started_at: str | None = None) -> None:
        with self._lock:
            self._pending.cases[batch_id] = (self._revision(batch_id), case, started_at)
        self._start()
        self._wake.set()

    def push_event(self, batch_id: str, log_key: str, seq: int, event: dict) -> None:
        with self._lock:
            self._pending.events.setdefault((batch_id, log_key), {})[seq] = event
        self._start()

    def _start(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._loop, name="hub-pusher", daemon=True)
            self._thread.start()

    def _loop(self) -> None:
        client = self._client or _client(self.cfg)
        pause = self._interval
        while not self._stop.is_set():
            self._wake.wait(pause)
            self._wake.clear()
            ok = self.flush(client)
            pause = self._interval if ok else min(60.0, pause * 2)
        self.flush(client)

    def flush(self, client: httpx.Client | None = None) -> bool:
        """Send everything queued now. Returns False if something failed (it stays queued)."""
        client = client or self._client or _client(self.cfg)
        with self._lock:
            cases, self._pending.cases = self._pending.cases, {}
            events, self._pending.events = self._pending.events, {}
        ok = True
        for batch_id, (revision, case, started_at) in cases.items():
            body = {"machine": self.cfg.machine, "revision": revision, "case": case}
            if started_at:
                body["started_at"] = started_at
            if not self._send(client, "PUT", f"/v1/batches/{batch_id}", body):
                ok = False
                with self._lock:  # keep it unless a newer case was queued meanwhile
                    self._pending.cases.setdefault(batch_id, (revision, case, started_at))
        for (batch_id, log_key), by_seq in events.items():
            seqs = sorted(by_seq)
            for i in range(0, len(seqs), MAX_EVENTS_PER_PUSH):
                chunk = seqs[i : i + MAX_EVENTS_PER_PUSH]
                body = {"log": log_key, "events": [{"seq": s, "event": by_seq[s]} for s in chunk]}
                if not self._send(client, "POST", f"/v1/batches/{batch_id}/events", body):
                    ok = False
                    with self._lock:
                        kept = self._pending.events.setdefault((batch_id, log_key), {})
                        for s in chunk:
                            kept.setdefault(s, by_seq[s])
        return ok

    def _send(self, client: httpx.Client, method: str, path: str, body: dict) -> bool:
        try:
            res = client.request(method, path, json=body)
            if res.status_code in (400, 413):
                # The hub will never take this one: drop it rather than retry forever.
                log.warning("the hub refused %s %s: %s", method, path, res.text[:200])
                return True
            res.raise_for_status()
            self.last_ok_at, self.last_error = time.time(), None
            return True
        except Exception as e:  # noqa: BLE001
            self.failures += 1
            self.last_error = _describe(e)
            if self.failures in (1, 10) or self.failures % 100 == 0:
                log.warning("hub push %s %s failed (%d so far): %s", method, path, self.failures, e)
            return False

    def close(self, timeout: float = 5.0) -> None:
        """Send what is left and stop the thread."""
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)


def _describe(e: Exception) -> str:
    """An error in a few words, for the badge's tooltip. Never includes the token."""
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        if code == 401:
            return "the hub refused the token (HUB_TOKEN is wrong)"
        if code == 503:
            return "the hub has no team token set yet"
        return f"the hub answered HTTP {code}"
    if isinstance(e, httpx.TimeoutException):
        return "the hub did not answer in time"
    if isinstance(e, httpx.TransportError):
        return "the hub could not be reached"
    return type(e).__name__


def status(client: httpx.Client | None = None) -> dict[str, Any]:
    """Whether this server is connected to the hub, for the badge in the UI and /api/health.

    `state` is one of: off (not set up), connected, wrong_token, unreachable. Never includes the token.
    """
    cfg = config()
    if cfg is None:
        return {"state": "off"}
    out: dict[str, Any] = {"url": cfg.url, "machine": cfg.machine}
    try:
        c = client or _client(cfg, READ_TIMEOUT)
        res = c.get("/v1/ping")
        res.raise_for_status()
        body = res.json()
        out.update(state="connected", batches=body.get("batches"), machines=body.get("machines"), last_update=body.get("last_update"))
    except httpx.HTTPStatusError as e:
        out.update(state="wrong_token" if e.response.status_code == 401 else "unreachable", error=_describe(e))
    except Exception as e:  # noqa: BLE001
        out.update(state="unreachable", error=_describe(e))
    p = _pusher if _pusher is not None and _pusher.cfg == cfg else None
    if p is not None:
        out.update(queued=p.queued(), last_push_at=p.last_ok_at, push_error=p.last_error)
    return out


_pusher: Pusher | None = None
_pusher_lock = threading.Lock()


def pusher() -> Pusher | None:
    """The process-wide pusher, or None when the hub is not set up."""
    global _pusher
    cfg = config()
    if cfg is None:
        return None
    with _pusher_lock:
        if _pusher is None or _pusher.cfg != cfg:
            _pusher = Pusher(cfg)
        return _pusher


# ── uploading saved batches ──────────────────────────────────────────────────


def started_from_id(batch_id: str, year: int | None = None) -> str | None:
    """A batch id is `MMDD-HHMMSS-xxxx`, in this machine's local time: turn it into an ISO time, or None."""
    import re

    m = re.match(r"^(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-", batch_id)
    if not m:
        return None
    month, day, hh, mm, ss = (int(x) for x in m.groups())
    try:
        t = time.mktime((year or time.localtime().tm_year, month, day, hh, mm, ss, 0, 0, -1))
    except (OverflowError, ValueError):
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


def event_logs(batch_dir) -> dict[str, Any]:
    """Every event log a saved batch has, by hub key: runs ("r01"), fork children ("f1/control-1"), "investigator"."""
    from pathlib import Path

    d = Path(batch_dir)
    logs: dict[str, Path] = {}
    for p in sorted((d / "runs").glob("*/events.jsonl")):
        logs[p.parent.name] = p
    for p in sorted((d / "forks").glob("*/*/events.jsonl")):
        logs[f"{p.parent.parent.name}/{p.parent.name}"] = p
    if (d / "investigator" / "events.jsonl").is_file():
        logs["investigator"] = d / "investigator" / "events.jsonl"
    return logs


def queue_batch(p: Pusher, batch_dir) -> tuple[int, int]:
    """Queue a saved batch's case file and every event log on `p`. Returns (logs, events)."""
    import json
    from pathlib import Path

    d = Path(batch_dir)
    case = json.loads((d / "case" / "case.json").read_text())
    p.push_case(d.name, case, started_from_id(d.name))
    n_logs = n_events = 0
    for key, path in event_logs(d).items():
        n_logs += 1
        seq = 0
        for line in path.read_text().splitlines():
            if line.strip():
                p.push_event(d.name, key, seq, json.loads(line))
                seq += 1
        n_events += seq
    return n_logs, n_events


def _main(argv: list[str]) -> int:
    """`python -m deep_research.hub push-all`: upload every saved batch in batches/ (never the fixtures)."""
    import argparse

    from dotenv import load_dotenv

    from .config import BATCHES_DIR, ROOT_DIR

    load_dotenv(ROOT_DIR / ".env")
    parser = argparse.ArgumentParser(prog="python -m deep_research.hub")
    sub = parser.add_subparsers(dest="cmd", required=True)
    push = sub.add_parser("push-all", help="upload every saved batch to the hub")
    push.add_argument("--only", nargs="*", help="batch ids to upload (default: all)")
    sub.add_parser("status", help="show the hub settings and what it holds")
    args = parser.parse_args(argv)

    cfg = config()
    if cfg is None:
        print("The hub is not set up: add HUB_URL and HUB_TOKEN to .env")
        return 1
    if args.cmd == "status":
        rows = list_batches()
        print(f"hub {cfg.url} as {cfg.machine}: " + ("unreachable" if rows is None else f"{len(rows)} batches"))
        for r in rows or []:
            print(f"  {r['id']:20s} {r['machine']:20s} {r['phase']}")
        return 0 if rows is not None else 1

    p = Pusher(cfg)
    dirs = [d for d in sorted(BATCHES_DIR.iterdir()) if (d / "case" / "case.json").is_file()] if BATCHES_DIR.exists() else []
    if args.only:
        dirs = [d for d in dirs if d.name in set(args.only)]
    for d in dirs:
        n_logs, n_events = queue_batch(p, d)
        ok = p.flush()
        print(f"{d.name}: {n_logs} logs, {n_events} events {'sent' if ok else 'NOT sent (see the warnings above)'}")
    return 0 if p.flush() else 1


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv[1:]))
