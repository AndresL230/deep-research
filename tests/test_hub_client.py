"""The hub client against a fake hub (httpx.MockTransport): off without settings, keys, reads, and the pusher."""

import gzip
import json

import httpx
import pytest

from deep_research import hub


class FakeHub:
    """Enough of hub/src/index.ts to test the client: the token, runner keys, batches and events."""

    def __init__(self, token="t0k"):
        self.token = token
        self.batches: dict[str, dict] = {}
        self.events: dict[tuple[str, str], dict[int, dict]] = {}
        self.files: dict[tuple[str, str], bytes] = {}  # (batch, path) -> the JSON, unpacked
        self.takes_files = True  # False: a hub deployed before motion files (no such route)
        self.down = False
        self.requests: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        if self.down:
            raise httpx.ConnectError("hub is down")
        if req.headers.get("authorization") != f"Bearer {self.token}":
            return httpx.Response(401, json={"error": "missing or wrong team token"})
        parts = req.url.path.strip("/").split("/")
        if len(parts) > 4 and parts[:2] == ["v1", "batches"] and parts[3] == "files" and self.takes_files:
            key = (parts[2], "/".join(parts[4:]))
            if req.method == "PUT":
                body = req.content
                self.files[key] = gzip.decompress(body) if req.headers.get("content-encoding") == "gzip" else body
                return httpx.Response(200, json={"ok": True})
            if key not in self.files:
                return httpx.Response(404, json={"error": "no such file"})
            etag = f'"{hash(self.files[key]) & 0xffffff:x}"'
            if req.headers.get("if-none-match") == etag:
                return httpx.Response(304, headers={"etag": etag})
            return httpx.Response(200, content=gzip.compress(self.files[key]),
                                  headers={"content-type": "application/json", "content-encoding": "gzip", "etag": etag})
        if parts == ["v1", "runner-env"]:
            return httpx.Response(200, json={"ANTHROPIC_API_KEY": "sk-from-hub", "DAYTONA_API_KEY": "dtn-from-hub"})
        if parts == ["v1", "batches"]:
            return httpx.Response(200, json=[{k: v for k, v in b.items() if k != "case"} for b in self.batches.values()])
        if parts == ["v1", "cases"]:
            return httpx.Response(200, json=list(self.batches.values()))
        if len(parts) == 3 and parts[1] == "batches":
            bid = parts[2]
            if req.method == "PUT":
                body = json.loads(req.content)
                old = self.batches.get(bid)
                if old and old["revision"] > body["revision"]:
                    return httpx.Response(200, json={"ok": True, "stored": False})
                self.batches[bid] = {"id": bid, **body}
                return httpx.Response(200, json={"ok": True, "stored": True})
            if bid not in self.batches:
                return httpx.Response(404, json={"error": "no batch"})
            return httpx.Response(200, json=self.batches[bid])
        if len(parts) == 4 and parts[3] == "events":
            bid = parts[2]
            if req.method == "POST":
                body = json.loads(req.content)
                store = self.events.setdefault((bid, body["log"]), {})
                for e in body["events"]:
                    store.setdefault(e["seq"], e["event"])
                return httpx.Response(200, json={"ok": True})
            store = self.events.get((bid, req.url.params["log"]), {})
            return httpx.Response(200, json=[store[s] for s in sorted(store)])
        return httpx.Response(404, json={"error": "not found"})


@pytest.fixture
def fake(monkeypatch):
    f = FakeHub()
    monkeypatch.setenv("HUB_URL", "https://hub.test/")
    monkeypatch.setenv("HUB_TOKEN", "t0k")
    monkeypatch.setenv("HUB_MACHINE", "laptop-a")
    return f


def client_for(fake: FakeHub) -> httpx.Client:
    cfg = hub.config()
    return httpx.Client(base_url=cfg.url, headers=cfg.headers, transport=httpx.MockTransport(fake))


def test_off_without_settings(monkeypatch):
    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("HUB_TOKEN", raising=False)
    assert hub.config() is None and not hub.enabled()
    assert hub.pusher() is None
    assert hub.list_batches() is None and hub.get_case("x") is None
    assert hub.load_runner_env() == []


def test_config_reads_the_environment(fake):
    cfg = hub.config()
    assert cfg.url == "https://hub.test" and cfg.machine == "laptop-a"
    assert cfg.headers == {"authorization": "Bearer t0k"}


def test_runner_keys_fill_only_what_is_missing(fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-local")
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    assert hub.load_runner_env(client_for(fake)) == ["DAYTONA_API_KEY"]
    import os

    assert os.environ["ANTHROPIC_API_KEY"] == "sk-local"  # the local .env wins
    assert os.environ["DAYTONA_API_KEY"] == "dtn-from-hub"


def test_runner_keys_never_fail_the_caller(fake):
    fake.down = True
    assert hub.load_runner_env(client_for(fake)) == []
    fake.down, fake.token = False, "other"
    assert hub.load_runner_env(client_for(fake)) == []


def test_pusher_sends_the_newest_case_and_every_event_once(fake):
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    p.push_case("b1", {"phase": "running"}, started_at="2026-11-14T08:45:46Z")
    p.push_case("b1", {"phase": "done"})
    for seq in range(3):
        p.push_event("b1", "r01", seq, {"t": seq, "type": "thought", "text": str(seq)})
    p.push_event("b1", "r01", 1, {"t": 1, "type": "thought", "text": "1"})  # a duplicate position is kept once
    assert p.flush(c) is True
    puts = [r for r in fake.requests if r.method == "PUT"]
    assert len(puts) == 1  # only the newest case went
    stored = fake.batches["b1"]
    assert stored["case"] == {"phase": "done"} and stored["machine"] == "laptop-a"
    assert hub.get_case("b1", client=c) == {"phase": "done"}
    assert [e["t"] for e in hub.get_events("b1", "r01", client=c)] == [0, 1, 2]
    assert hub.list_batches(client=c)[0]["id"] == "b1"
    assert "case" not in hub.list_batches(client=c)[0]
    assert hub.all_cases(client=c)[0]["case"] == {"phase": "done"}


def test_pusher_keeps_what_failed_and_sends_it_later(fake):
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    fake.down = True
    p.push_case("b1", {"phase": "running"})
    p.push_event("b1", "r01", 0, {"t": 0, "type": "thought", "text": "a"})
    assert p.flush(c) is False and p.failures == 2
    fake.down = False
    assert p.flush(c) is True
    assert fake.batches["b1"]["case"] == {"phase": "running"}
    assert fake.events[("b1", "r01")] == {0: {"t": 0, "type": "thought", "text": "a"}}


def test_a_newer_case_queued_during_a_failed_push_is_not_replaced(fake):
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    p.push_case("b1", {"phase": "running"})
    real_send = p._send

    def failing_send(client, method, path, body):
        p.push_case("b1", {"phase": "done"})  # arrives while the old one is in flight
        return False

    p._send = failing_send
    p.flush(c)
    p._send = real_send
    assert p.flush(c) is True
    assert fake.batches["b1"]["case"] == {"phase": "done"}


def test_large_logs_go_in_chunks(fake):
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    for seq in range(1200):
        p.push_event("b1", "investigator", seq, {"t": seq})
    assert p.flush(c) is True
    posts = [r for r in fake.requests if r.method == "POST"]
    assert [len(json.loads(r.content)["events"]) for r in posts] == [500, 500, 200]
    assert len(fake.events[("b1", "investigator")]) == 1200


def test_reads_return_none_when_the_hub_is_down(fake):
    fake.down = True
    c = client_for(fake)
    assert hub.list_batches(client=c) is None
    assert hub.get_case("b1", client=c) is None


# ---- wiring: event logs, batches, the API, the backfill ----


class RecordingPusher:
    """Stands in for hub.Pusher: records what would be sent."""

    def __init__(self):
        self.cases: list[tuple[str, dict, str | None]] = []
        self.events: list[tuple[str, str, int, dict]] = []
        self.files: list[tuple[str, str, str]] = []

    def push_case(self, batch_id, case, started_at=None):
        self.cases.append((batch_id, case, started_at))

    def push_event(self, batch_id, log_key, seq, event):
        self.events.append((batch_id, log_key, seq, event))

    def push_file(self, batch_id, rel, path):
        self.files.append((batch_id, rel, str(path)))

    def push_case_files(self, batch_id, batch_dir, case_part):
        for rel in sorted(hub.motion_paths(case_part)):
            self.push_file(batch_id, rel, batch_dir / rel)

    def close(self, timeout=5.0):
        pass


def test_event_log_numbers_events_and_continues_after_a_reopen(tmp_path):
    from deep_research.events import EventLog

    seen = []
    log = EventLog(tmp_path / "events.jsonl", on_write=lambda seq, ev: seen.append((seq, ev["type"])))
    log.write({"type": "thought", "text": "a"})
    log.write({"type": "thought", "text": "b"})
    log.close()
    again = EventLog(tmp_path / "events.jsonl", on_write=lambda seq, ev: seen.append((seq, ev["type"])))
    again.write({"type": "todos", "todos": []})
    again.close()
    assert seen == [(0, "thought"), (1, "thought"), (2, "todos")]


def test_a_failing_callback_never_loses_the_event(tmp_path):
    from deep_research.events import EventLog, read_events

    def boom(seq, ev):
        raise RuntimeError("hub down")

    log = EventLog(tmp_path / "events.jsonl", on_write=boom)
    log.write({"type": "thought", "text": "kept"})
    log.close()
    assert read_events(tmp_path / "events.jsonl")[0]["text"] == "kept"


def test_a_batch_pushes_its_case_and_its_events(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    rec = RecordingPusher()
    monkeypatch.setattr(batch_mod.hub, "pusher", lambda: rec)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="b1", root=tmp_path)
    assert rec.cases and rec.cases[-1][0] == "b1" and rec.cases[-1][1]["config"]["n_runs"] == 1
    b.case.update_run("r01", status="running")
    assert rec.cases[-1][1]["runs"]["r01"]["status"] == "running"
    # A copy is pushed: later changes do not reach what was queued.
    queued = rec.cases[-1][1]
    b.case.update_run("r01", status="honest")
    assert queued["runs"]["r01"]["status"] == "running"
    log = b._log(tmp_path / "r01.jsonl", "r01")
    log.write({"type": "thought", "text": "hi"})
    flog = b._log(tmp_path / "c1.jsonl", "f1/control-1")
    flog.write({"type": "forced", "command": "x", "output": "y"})
    assert [(e[1], e[2], e[3]["type"]) for e in rec.events] == [("r01", 0, "thought"), ("f1/control-1", 0, "forced")]


def test_without_the_hub_a_batch_pushes_nothing(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    monkeypatch.delenv("HUB_URL", raising=False)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="b2", root=tmp_path)
    assert b._hub is None
    b._log(tmp_path / "r.jsonl", "r01").write({"type": "thought", "text": "local only"})


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from deep_research import api

    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    monkeypatch.setattr(api, "_hub_cache", {})
    monkeypatch.setenv("HUB_URL", "https://hub.test")
    monkeypatch.setenv("HUB_TOKEN", "t0k")
    remote_case = {"phase": "done", "config": {"dataset": "pima", "analyst_model": "m"}, "runs": {"r01": {"id": "r01", "status": "honest"}},
                   "forks": {}, "costs": {"spent_usd": 0.5, "scopes": {"run:r01": {"input_tokens": 10, "output_tokens": 2, "total_usd": 0.5, "model_usd": 0.5, "vm_usd": 0.0}}}}
    monkeypatch.setattr(api.hub, "load_runner_env", lambda client=None: [])
    monkeypatch.setattr(api.hub, "list_batches", lambda client=None: [{"id": "1114-050000-abcd", "machine": "laptop-b", "phase": "done"}])
    monkeypatch.setattr(api.hub, "all_cases", lambda client=None: [{"id": "1114-050000-abcd", "machine": "laptop-b", "case": remote_case}])
    monkeypatch.setattr(api.hub, "get_case", lambda bid, client=None: remote_case if bid == "1114-050000-abcd" else None)
    monkeypatch.setattr(api.hub, "get_events", lambda bid, key, client=None: [{"t": 1, "type": "thought", "text": f"{bid}:{key}"}])
    monkeypatch.setattr(api.hub, "pusher", lambda: None)
    with TestClient(api.app) as c:
        yield c


def test_the_api_lists_and_opens_batches_from_the_hub(api_client):
    batches = api_client.get("/api/batches").json()
    remote = [b for b in batches if b["id"] == "1114-050000-abcd"]
    assert [{k: v for k, v in b.items() if k != "summary"} for b in remote] == [
        {"id": "1114-050000-abcd", "kind": "replay", "machine": "laptop-b", "remote": True}]
    # Summarised from the hub's case file, like a saved batch.
    summary = remote[0]["summary"]
    assert summary["counts"]["honest"] == 1 and summary["analyst_models"] == ["m"] and summary["spend"]["usd"] == 0.5
    assert any(b["id"] == "demo-batch" and "remote" not in b for b in batches)
    assert api_client.get("/api/batches/1114-050000-abcd/case").json()["phase"] == "done"
    assert api_client.get("/api/batches/1114-050000-abcd/runs/r01/events").json()[0]["text"] == "1114-050000-abcd:r01"
    assert api_client.get("/api/batches/1114-050000-abcd/forks/f1/control-1/events").json()[0]["text"].endswith(":f1/control-1")
    assert api_client.get("/api/batches/1114-050000-abcd/investigator/events").json()[0]["text"].endswith(":investigator")
    assert api_client.get("/api/batches/nope/case").status_code == 404
    with api_client.websocket_connect("/api/batches/1114-050000-abcd/ws") as ws:
        assert ws.receive_json()["case"]["phase"] == "done"


def test_hub_summaries_fetch_case_files_only_for_a_new_revision(api_client, monkeypatch):
    from deep_research import api

    rows = [{"id": "1114-070000-aaaa", "machine": "laptop-b", "revision": 1}]
    cases = [{"id": "1114-070000-aaaa", "machine": "laptop-b", "revision": 1, "started_at": "2026-11-14T07:00:00-0500",
              "case": {"phase": "done", "runs": {"r01": {"id": "r01", "status": "inflated"}}}}]
    calls = []

    def all_cases(client=None):
        calls.append(1)
        return cases

    monkeypatch.setattr(api, "_HUB_SUMMARIES", {})
    monkeypatch.setattr(api.hub, "list_batches", lambda client=None: rows)
    monkeypatch.setattr(api.hub, "all_cases", all_cases)

    def remote():
        api._hub_cache.clear()  # every call reads the hub list afresh; the case files only when a revision is new
        return {b["id"]: b for b in api_client.get("/api/batches").json()}["1114-070000-aaaa"]["summary"]

    assert remote()["counts"]["inflated"] == 1 and len(calls) == 1
    assert remote()["counts"]["inflated"] == 1 and len(calls) == 1
    rows[0]["revision"] = 2
    cases[0] = {**cases[0], "revision": 2, "case": {"phase": "done", "runs": {"r01": {"id": "r01", "status": "honest"}}}}
    assert remote()["counts"]["honest"] == 1 and len(calls) == 2


def test_the_cost_screen_includes_the_team(api_client):
    report = api_client.get("/api/costs").json()
    assert "1114-050000-abcd" in [b["id"] for b in report["batches"]]
    assert report["totals"]["usd"]["total"] >= 0.5


def test_push_all_uploads_a_saved_batch(fake, tmp_path):
    d = tmp_path / "1114-024515-6bad"
    (d / "case").mkdir(parents=True)
    (d / "case" / "case.json").write_text(json.dumps({"phase": "done", "runs": {}}))
    (d / "runs" / "r01").mkdir(parents=True)
    (d / "runs" / "r01" / "events.jsonl").write_text('{"t": 1, "type": "thought", "text": "a"}\n{"t": 2, "type": "thought", "text": "b"}\n')
    (d / "forks" / "f1" / "control-1").mkdir(parents=True)
    (d / "forks" / "f1" / "control-1" / "events.jsonl").write_text('{"t": 1, "type": "forced", "command": "x", "output": "y"}\n')
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    assert hub.queue_batch(p, d) == (2, 3, 0)
    assert p.flush(c)
    assert fake.batches["1114-024515-6bad"]["started_at"].startswith(f"{__import__('time').localtime().tm_year}-11-14T02:45:15")
    assert sorted(fake.events) == [("1114-024515-6bad", "f1/control-1"), ("1114-024515-6bad", "r01")]
    assert hub.started_from_id("demo-batch") is None


# ---- status, for the badge ----


def test_status_is_off_without_settings(monkeypatch):
    monkeypatch.delenv("HUB_URL", raising=False)
    assert hub.status() == {"state": "off"}


def test_status_reports_connected_wrong_token_and_unreachable(fake):
    def ping(req):
        if req.url.path == "/v1/ping" and req.headers.get("authorization") == "Bearer t0k":
            return httpx.Response(200, json={"ok": True, "batches": 4, "machines": 2, "last_update": "2026-11-14T10:00:00Z"})
        return fake(req)

    def client(handler):
        cfg = hub.config()
        return httpx.Client(base_url=cfg.url, headers=cfg.headers, transport=httpx.MockTransport(handler))

    ok = hub.status(client(ping))
    assert ok["state"] == "connected" and ok["batches"] == 4 and ok["machines"] == 2 and ok["machine"] == "laptop-a"
    assert "t0k" not in json.dumps(ok)
    fake.token = "something-else"
    bad = hub.status(client(fake))
    assert bad["state"] == "wrong_token" and "token" in bad["error"]
    fake.down = True
    assert hub.status(client(fake))["state"] == "unreachable"


def test_the_pusher_remembers_its_last_success_and_what_waits(fake):
    c = client_for(fake)
    p = hub.Pusher(hub.config(), client=c)
    p.push_event("b1", "r01", 0, {"t": 0})
    assert p.queued() == 1 and p.last_ok_at is None
    fake.down = True
    p.flush(c)
    assert p.queued() == 1 and p.last_error == "the hub could not be reached"
    fake.down = False
    p.flush(c)
    assert p.queued() == 0 and p.last_ok_at is not None and p.last_error is None


def test_health_carries_the_hub_status(monkeypatch):
    from fastapi.testclient import TestClient

    from deep_research import api

    monkeypatch.setattr(api, "_hub_status", None)
    with TestClient(api.app) as c:
        assert c.get("/api/health").json()["hub"] == {"state": "off"}
    monkeypatch.setenv("HUB_URL", "https://hub.test")
    monkeypatch.setenv("HUB_TOKEN", "t0k")
    monkeypatch.setattr(api.hub, "load_runner_env", lambda client=None: [])
    monkeypatch.setattr(api.hub, "status", lambda client=None: {"state": "connected", "url": "https://hub.test", "machine": "m", "batches": 3})
    with TestClient(api.app) as c:
        h = c.get("/api/health").json()["hub"]
    assert h["state"] == "connected" and h["batches"] == 3 and h["queued"] == 0


def test_machine_defaults_to_the_git_user_name(monkeypatch):
    monkeypatch.setenv("HUB_URL", "https://hub.test")
    monkeypatch.setenv("HUB_TOKEN", "t")
    monkeypatch.delenv("HUB_MACHINE", raising=False)
    hub.default_machine.cache_clear()
    monkeypatch.setattr(hub.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": "Ada L\n"})())
    assert hub.config().machine == "Ada L"
    hub.default_machine.cache_clear()
    monkeypatch.setattr(hub.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    monkeypatch.setattr(hub.socket, "gethostname", lambda: "box-1")
    assert hub.config().machine == "box-1"
    hub.default_machine.cache_clear()


# ---- motion files ----

MOTION = {"header": {"can_start": [0.3, 0.25]}, "frames": [{"t": 0}, {"t": 0.5}], "result": {"success": True}}
LIVE = "runs/r01/outputs/live/v5_0.3,0.25_s0.motion.json"


def quiet_pusher(c):
    """A pusher that sends only when the test flushes it: no background thread, so the counts are exact."""
    p = hub.Pusher(hub.config(), client=c)
    p._start = lambda: None
    return p


def _motion(path, motion=MOTION):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(motion))
    return path


def test_motion_paths_are_only_a_runs_motion_files():
    assert hub.is_motion_path(LIVE)
    assert hub.is_motion_path("runs/r02/hidden/07-s0.motion.json")
    assert hub.is_motion_path("forks/f1/control-1/outputs/live/x.motion.json")
    assert hub.is_motion_path("runs/r01/outputs/motion_01.json")
    for bad in ("task/hidden_positions.json", "runs/r01/outputs/report.json", "runs/r01/events.jsonl",
                "runs/r01/outputs/../../task/x.motion.json", "runs/r01/hidden/sub/x.motion.json",
                "runs/r01/outputs/hidden_positions.motion.json", "/etc/x.motion.json", "forks/f1/outputs/x.motion.json"):
        assert not hub.is_motion_path(bad), bad
    case = {"runs": {"r01": {"motion_files": [LIVE, "runs/r01/outputs/report.json"],
                             "hidden_results": [{"motion": "runs/r01/hidden/01-s0.motion.json", "success": True}]}},
            "forks": {"f1": {"children": {"c1": {"motion_files": ["forks/f1/c1/outputs/live/a.motion.json"]}}}}}
    assert hub.motion_paths(case) == {LIVE, "runs/r01/hidden/01-s0.motion.json", "forks/f1/c1/outputs/live/a.motion.json"}


def test_pusher_sends_a_motion_file_gzipped_and_again_only_when_it_changed(fake, tmp_path):
    import os

    c = client_for(fake)
    p = quiet_pusher(c)
    f = _motion(tmp_path / LIVE)
    p.push_file("b1", LIVE, f)
    p.push_file("b1", "task/hidden_positions.json", tmp_path / "x")  # never queued
    assert p.queued() == 1
    assert p.flush(c) is True and p.queued() == 0
    put = [r for r in fake.requests if r.method == "PUT"][0]
    assert put.headers["content-encoding"] == "gzip"
    assert put.url.raw_path.endswith(b"/files/runs/r01/outputs/live/v5_0.3%2C0.25_s0.motion.json")
    assert json.loads(fake.files[("b1", LIVE)]) == MOTION
    got = hub.get_file("b1", LIVE, client=c)
    assert got.status == "ok" and json.loads(got.content) == MOTION and got.etag
    assert hub.get_file("b1", LIVE, etag=got.etag, client=c).status == "unchanged"
    # Unchanged on disk: queued again (each case change does) but not sent again.
    n = len(fake.requests)
    p.push_file("b1", LIVE, f)
    assert p.flush(c) and len(fake.requests) == n
    # Saved again with new content (a live run's practice file): sent again.
    _motion(f, {**MOTION, "frames": [{"t": 0}]})
    os.utime(f, ns=(f.stat().st_atime_ns, f.stat().st_mtime_ns + 1_000_000))
    p.push_file("b1", LIVE, f)
    assert p.flush(c) and json.loads(fake.files[("b1", LIVE)])["frames"] == [{"t": 0}]
    assert hub.get_file("b1", LIVE, etag=got.etag, client=c).status == "ok"


def test_a_file_gone_from_disk_is_dropped(fake, tmp_path):
    c = client_for(fake)
    p = quiet_pusher(c)
    p.push_file("b1", LIVE, tmp_path / "nope.motion.json")
    assert p.flush(c) is True and p.queued() == 0 and not fake.files


def test_files_wait_while_the_hub_is_down_and_go_in_rounds(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(hub, "MAX_FILES_PER_FLUSH", 3)
    c = client_for(fake)
    p = quiet_pusher(c)
    for i in range(7):
        rel = f"runs/r01/outputs/live/e{i}.motion.json"
        p.push_file("b1", rel, _motion(tmp_path / rel))
    fake.down = True
    assert p.flush(c) is False and p.queued() == 7  # nothing lost
    fake.down = False
    p.push_case("b1", {"phase": "running"})
    assert p.flush(c) is True and p.queued() == 4  # the case went first, then one round of files
    assert fake.batches["b1"]["case"] == {"phase": "running"} and len(fake.files) == 3
    assert p.drain(c) is True and len(fake.files) == 7


def test_a_hub_without_the_files_route_still_gets_cases_and_events(fake, tmp_path):
    fake.takes_files = False
    c = client_for(fake)
    p = quiet_pusher(c)
    p.push_file("b1", LIVE, _motion(tmp_path / LIVE))
    p.push_case("b1", {"phase": "running"})
    p.push_event("b1", "r01", 0, {"t": 0})
    assert p.flush(c) is True and p.queued() == 0 and p.last_error is None
    assert not p.files_supported and fake.batches["b1"] and fake.events[("b1", "r01")]
    p.push_file("b1", LIVE, tmp_path / LIVE)  # no longer queued, so never retried
    assert p.queued() == 0
    assert hub.get_file("b1", LIVE, client=c).status == "missing"


def test_get_file_says_why_it_has_no_file(fake, monkeypatch):
    c = client_for(fake)
    assert hub.get_file("b1", LIVE, client=c).status == "missing"
    assert hub.get_file("b1", "task/hidden_positions.json", client=c).status == "missing"
    fake.down = True
    assert hub.get_file("b1", LIVE, client=c).status == "error"
    monkeypatch.delenv("HUB_URL")
    assert hub.get_file("b1", LIVE).status == "off"


def test_a_batch_queues_the_motion_files_its_case_names(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    rec = RecordingPusher()
    monkeypatch.setattr(batch_mod.hub, "pusher", lambda: rec)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="b1", root=tmp_path)
    # A live practice file as MotionWatch publishes it, then the scored run's hidden episodes, then a fork child's.
    b.case.update_run("r01", motion_files=[LIVE])
    assert rec.files == [("b1", LIVE, str(tmp_path / "b1" / LIVE))]
    hidden = "runs/r01/hidden/01-s0.motion.json"
    b.case.update_run("r01", status="honest", hidden_results=[{"motion": hidden}])
    assert ("b1", hidden, str(tmp_path / "b1" / hidden)) in rec.files
    b.case.update_fork("f1", children={"control-1": {"motion_files": ["forks/f1/control-1/outputs/live/a.motion.json"]}})
    assert any(r == "forks/f1/control-1/outputs/live/a.motion.json" for _, r, _ in rec.files)
    b.case.update_run("r01", motion_files=["task/hidden_positions.json"])
    assert not any("task/" in r for _, r, _ in rec.files)


def test_a_batch_really_uploads_a_live_motion_file(fake, tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    c = client_for(fake)
    p = quiet_pusher(c)
    monkeypatch.setattr(batch_mod.hub, "pusher", lambda: p)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="b1", root=tmp_path)
    _motion(b.dir / LIVE)
    b.case.update_run("r01", motion_files=[LIVE])
    assert p.drain(c) and json.loads(fake.files[("b1", LIVE)]) == MOTION


def _saved_robot_batch(root):
    d = root / "1114-173444-418b"
    (d / "case").mkdir(parents=True)
    case = {"phase": "done", "forks": {}, "runs": {
        "r01": {"status": "honest", "motion_files": [LIVE], "hidden_results": [{"motion": "runs/r01/hidden/01-s0.motion.json"}]},
        "r02": {"status": "failed"}}}
    (d / "case" / "case.json").write_text(json.dumps(case))
    (d / "runs" / "r01").mkdir(parents=True)
    (d / "runs" / "r01" / "events.jsonl").write_text('{"t": 1, "type": "thought", "text": "a"}\n')
    _motion(d / LIVE)
    _motion(d / "runs/r01/outputs/live/older.motion.json")  # dropped from the case's list, still on disk
    _motion(d / "runs/r01/outputs/report.json", {"not": "motion"})
    _motion(d / "runs/r01/hidden/01-s0.motion.json")
    _motion(d / "runs/r02/hidden/01-s0.motion.json")  # a run never scored: its case lists no hidden episodes
    _motion(d / "forks/f1/control-1/outputs/live/a.motion.json")
    (d / "task").mkdir()
    (d / "task" / "hidden_positions.json").write_text("[]")
    return d


def test_queue_batch_also_sends_a_saved_batchs_motion_files(fake, tmp_path):
    d = _saved_robot_batch(tmp_path)
    c = client_for(fake)
    p = quiet_pusher(c)
    assert hub.queue_batch(p, d) == (1, 1, 4)
    assert p.drain(c)
    assert sorted(r for _, r in fake.files) == [
        "forks/f1/control-1/outputs/live/a.motion.json", "runs/r01/hidden/01-s0.motion.json",
        "runs/r01/outputs/live/older.motion.json", LIVE]
    fake.files.clear()
    fake.batches.clear()
    p2 = quiet_pusher(c)
    assert hub.queue_batch(p2, d, files_only=True) == (0, 0, 4)
    assert p2.drain(c) and len(fake.files) == 4 and not fake.batches


def test_the_push_command_backfills_a_batch_folder(fake, tmp_path, monkeypatch, capsys):
    d = _saved_robot_batch(tmp_path)
    monkeypatch.setattr(hub, "_client", lambda cfg, timeout=hub.TIMEOUT: client_for(fake))
    assert hub._main(["push", str(d), "--files-only"]) == 0
    assert len(fake.files) == 4 and not fake.batches
    assert "1114-173444-418b: 4 motion files sent" in capsys.readouterr().out
    assert hub._main(["push", str(d)]) == 0
    assert fake.batches["1114-173444-418b"]["case"]["phase"] == "done"
    assert hub._main(["push", str(tmp_path / "nope")]) == 1
