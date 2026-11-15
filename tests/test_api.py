"""The one FastAPI app: batch routes on the committed demo fixture, health, 404s, the SPA, shutdown."""

import json
import os

import pytest
from fastapi.testclient import TestClient

from deep_research import api

DEMO = "demo-batch"


@pytest.fixture
def client(tmp_path, monkeypatch):
    # No live batches and no saved stats from a developer's machine leak into the tests.
    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>app</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    monkeypatch.setattr(api, "WEB_DIST", dist)
    with TestClient(api.app) as c:
        yield c


def test_lists_and_serves_the_demo_batch(client):
    listed = {b["id"]: b for b in client.get("/api/batches").json()}
    assert listed[DEMO]["kind"] == "replay" and listed[DEMO]["summary"]["simulated"] is True
    assert listed[DEMO]["fixture"] is True
    case = client.get(f"/api/batches/{DEMO}/case").json()
    assert case["config"]["simulated"] is True and case["runs"]
    events = client.get(f"/api/batches/{DEMO}/runs/r01/events").json()
    assert events and {"type", "t"} <= set(events[0])


def test_unknown_batch_is_404(client):
    assert client.get("/api/batches/nope/case").status_code == 404


def test_holdout_labels_are_never_served(client):
    assert (api.FIXTURES_DIR / DEMO / "task" / "holdout_labels.csv").is_file()  # the file exists on disk
    assert client.get(f"/api/batches/{DEMO}/files/task/holdout_labels.csv").status_code == 404
    assert client.get(f"/api/batches/{DEMO}/files/../{DEMO}/task/holdout_labels.csv").status_code == 404
    assert "holdout_labels" not in client.get(f"/api/batches/{DEMO}/case").text
    # macOS file systems ignore case: another spelling of the name opens the same secret file.
    for spelling in ("HOLDOUT_LABELS.csv", "Holdout_Labels.csv"):
        assert client.get(f"/api/batches/{DEMO}/files/task/{spelling}").status_code == 404


def test_batch_files_are_served_with_a_locked_down_csp(client):
    res = client.get(f"/api/batches/{DEMO}/files/runs/r01/live/02_confusion.png")
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    assert "default-src 'none'" in res.headers["content-security-policy"]
    assert client.get(f"/api/batches/{DEMO}/files/runs/r01/nope.png").status_code == 404


def test_websocket_sends_a_snapshot_for_a_replay(client):
    with client.websocket_connect(f"/api/batches/{DEMO}/ws") as ws:
        msg = ws.receive_json()
    assert msg["kind"] == "snapshot" and msg["live"] is False
    assert msg["case"] == client.get(f"/api/batches/{DEMO}/case").json()


def test_websocket_reports_an_unknown_batch(client):
    with client.websocket_connect("/api/batches/nope/ws") as ws:
        assert ws.receive_json()["kind"] == "error"


def test_health_reports_key_status_never_values(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-value")
    monkeypatch.setenv("DAYTONA_API_KEY", "")
    monkeypatch.setattr(api, "ROOT_DIR", api.ROOT_DIR / "no-such-dir")  # ignore a local .env
    res = client.get("/api/health")
    assert res.json() == {"ok": True, "keys": {"anthropic": True, "daytona": False}, "hub": {"state": "off"}}
    assert "sk-secret-value" not in res.text


def test_unknown_api_paths_are_json_404s(client):
    for method in ("get", "post", "delete"):
        res = getattr(client, method)("/api/no/such/route")
        assert res.status_code == 404 and res.json() == {"error": "not found"}


def test_serves_the_web_app_with_spa_fallback(client):
    assert "<title>app</title>" in client.get("/").text
    assert "<title>app</title>" in client.get("/batches/demo-batch").text
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert "<title>app</title>" in client.get("/../pyproject.toml").text


def test_defaults_and_estimate(client):
    d = client.get("/api/defaults").json()
    assert d["config"]["n_runs"] == 12 and isinstance(d["prices_missing"], bool)
    est = client.post("/api/estimate", json=d["config"]).json()
    assert est["basis"] == "no earlier runs yet" and est["total_usd"] is None


class FakeBatch:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


async def test_shutdown_closes_open_batches(monkeypatch):
    b = FakeBatch()
    monkeypatch.setattr(api, "BATCHES", {"x": b})
    monkeypatch.setattr(api, "TASKS", {})
    await api.close_all()
    assert b.closed


def test_batch_close_deletes_every_vm(tmp_path, monkeypatch):
    import asyncio

    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    deleted = []
    monkeypatch.setattr(batch_mod.vms, "delete_vm", deleted.append)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    b.vms.update({"r01": "vm-run", "f1-base": "vm-base", "f1-forced-1": "vm-child"})
    asyncio.run(b.close())
    assert sorted(deleted) == ["vm-base", "vm-child", "vm-run"] and b.vms == {}
    assert json.loads((tmp_path / "t" / "case" / "case.json").read_text())["config"]["n_runs"] == 1


# ---- the lab page proxy ----

LAB = "https://8080-signed.proxy.daytona.example"


@pytest.fixture
def lab(client, tmp_path, monkeypatch):
    """A saved batch whose run r01 and fork child f1/control-1 have lab pages, and a fake Daytona proxy."""
    import httpx

    case_dir = tmp_path / "batches" / "lab-batch" / "case"
    case_dir.mkdir(parents=True)
    (case_dir / "case.json").write_text(json.dumps({
        "config": {}, "phase": "running", "step_labels": {}, "split": None, "hypotheses": [], "verdict": None, "costs": {},
        "runs": {"r01": {"id": "r01", "status": "running", "lab_url": f"{LAB}?tkn=abc"}, "r02": {"id": "r02", "status": "queued"}},
        "forks": {"f1": {"id": "f1", "children": {"control-1": {"arm": "control", "status": "running", "lab_url": LAB}}}},
    }))
    seen = []

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path in ("/", "/index.html"):
            return httpx.Response(200, html="<html>lab</html>")
        if req.url.path == "/state.json":
            return httpx.Response(200, json={"charts": [], "report": None})
        if req.url.path == "/live/01_counts.png":
            return httpx.Response(200, content=b"\x89PNG", headers={"content-type": "image/png"})
        if req.url.path == "/live/page.html":
            return httpx.Response(200, html="<script>bad()</script>")
        return httpx.Response(404)

    monkeypatch.setattr(api, "_lab_client", httpx.AsyncClient(transport=httpx.MockTransport(handle), headers=api.LAB_SKIP_WARNING))
    return seen


def test_lab_proxy_skips_the_preview_warning(client, lab):
    res = client.get("/api/batches/lab-batch/runs/r01/lab/")
    assert res.status_code == 200 and res.text == "<html>lab</html>"
    assert res.headers["content-security-policy"] == "sandbox allow-scripts"
    req = lab[0]
    assert req.headers["x-daytona-skip-preview-warning"] == "true"
    assert str(req.url) == f"{LAB}/?tkn=abc"  # the signed token is kept


def test_lab_proxy_serves_state_and_charts(client, lab):
    assert client.get("/api/batches/lab-batch/runs/r01/lab/state.json").json() == {"charts": [], "report": None}
    img = client.get("/api/batches/lab-batch/runs/r01/lab/live/01_counts.png")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert client.get("/api/batches/lab-batch/forks/f1/control-1/lab/state.json").status_code == 200


def test_lab_proxy_refuses_other_paths_and_content(client, lab):
    assert client.get("/api/batches/lab-batch/runs/r01/lab/live/page.html").status_code == 404  # not an image
    assert client.get("/api/batches/lab-batch/runs/r01/lab/etc/passwd").status_code == 404
    assert client.get("/api/batches/lab-batch/runs/r01/lab/live/../../x").status_code == 404
    assert client.get("/api/batches/lab-batch/runs/r02/lab/").status_code == 404  # no lab page yet
    assert client.get("/api/batches/lab-batch/runs/r01/lab/live/missing.png").status_code == 502
    assert len([r for r in lab if r.url.path.startswith("/etc")]) == 0


# ---- charts saved with a batch ----

def test_case_lists_charts_found_on_disk(client):
    case = client.get(f"/api/batches/{DEMO}/case").json()
    # The fixture's fork children have chart files but no list in the case file.
    child = case["forks"]["f1"]["children"]["control-1"]
    assert child["charts"] == ["forks/f1/control-1/live/02_confusion.png"]
    assert client.get(f"/api/batches/{DEMO}/files/{child['charts'][0]}").status_code == 200
    # Runs keep the list the case file already has.
    assert case["runs"]["r01"]["charts"][-1] == "runs/r01/live/02_confusion.png"


def test_download_charts_saves_images_only(tmp_path):
    from types import SimpleNamespace as NS

    from deep_research import sandboxes

    files = {"b.png": b"png2", "a.png": b"png1", "notes.txt": b"x", "c.svg": b"<svg/>"}

    class FS:
        def list_files(self, path):
            return [NS(name=n, is_dir=False, mod_time={"a.png": "1", "b.png": "2", "c.svg": "3"}.get(n, "0")) for n in files] + [NS(name="sub", is_dir=True, mod_time="9")]

        def download_file(self, path):
            return files[path.rsplit("/", 1)[-1]]

    assert sandboxes.download_charts(NS(fs=FS()), tmp_path / "live") == ["a.png", "b.png", "c.svg"]
    assert sorted(p.name for p in (tmp_path / "live").iterdir()) == ["a.png", "b.png", "c.svg"]

    class Broken:
        def list_files(self, path):
            raise RuntimeError("no such dir")

    assert sandboxes.download_charts(NS(fs=Broken()), tmp_path / "none") == []


# ---- whatever VMs are left go when the batch is over ----

def _batch_with_vms(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    stopped = []
    # A batch deletes what it closes: a stopped VM would still hold its disk.
    monkeypatch.setattr(batch_mod.vms, "delete_vm", stopped.append)
    b = batch_mod.Batch(BatchConfig(n_runs=2), batch_id="t", root=tmp_path)
    return b, stopped


async def test_vms_stop_once_the_verdict_is_in(tmp_path, monkeypatch):
    b, stopped = _batch_with_vms(tmp_path, monkeypatch)
    b.case.update_run("r01", status="honest", lab_url="https://lab.example/r01")
    b.case.update_fork("f1", status="done", children={"control-1": {"arm": "control", "status": "inflated", "lab_url": "https://lab.example/c1"}})
    b.vms.update({"r01": "vm-run", "f1-base": "vm-base", "f1-control-1": "vm-child"})

    class Investigator:
        async def astream(self, *args, **kwargs):
            b.case.record_verdict("Skipping the duplicate check caused it.", "deduplicate", {})
            return
            yield  # an async generator that ends at once

    b._investigator, b._inv_config = Investigator(), {}
    await b._stream_investigator({})
    case = b.case.read()
    assert case["phase"] == "done" and case["verdict"]["step_label"] == "deduplicate"
    assert sorted(stopped) == ["vm-base", "vm-child", "vm-run"]
    assert b.vms == {}
    # The lab pages are gone with the VMs, so the UI is not pointed at them.
    assert case["runs"]["r01"]["lab_url"] is None
    assert case["forks"]["f1"]["children"]["control-1"]["lab_url"] is None
    await b.close()  # again: nothing left to stop
    assert len(stopped) == 3


async def test_vms_stay_up_while_the_investigator_waits_for_approval(tmp_path, monkeypatch):
    b, stopped = _batch_with_vms(tmp_path, monkeypatch)
    b.vms["r01"] = "vm-run"

    class Investigator:
        async def astream(self, *args, **kwargs):
            yield {"__interrupt__": []}

    b._investigator, b._inv_config = Investigator(), {}
    await b._stream_investigator({})
    assert b.case.read()["phase"] == "awaiting_approval"
    assert stopped == [] and b.vms == {"r01": "vm-run"}


async def test_vms_stop_when_no_step_separates_the_runs(tmp_path, monkeypatch):
    b, stopped = _batch_with_vms(tmp_path, monkeypatch)

    async def run_one(run_id):
        b.vms[run_id] = f"vm-{run_id}"
        b.case.update_run(run_id, status="inflated")

    monkeypatch.setattr(b, "run_one", run_one)
    await b.run_all()
    assert b.case.read()["phase"] == "no_split"
    assert sorted(stopped) == ["vm-r01", "vm-r02"]


# ---- a finished batch is a replay ----

class _FakeCase:
    def __init__(self, phase):
        self.data = {"phase": phase}

    def read(self):
        return {"phase": self.data["phase"], "runs": {}}


class _FakeLiveBatch:
    def __init__(self, phase):
        self.case = _FakeCase(phase)

    async def close(self):  # the server closes open batches on shutdown
        pass


def test_a_batch_stops_being_live_once_it_is_over(client, tmp_path, monkeypatch):
    for bid, phase in (("b-run", "running"), ("b-done", "done"), ("b-nosplit", "no_split"), ("b-wait", "awaiting_approval")):
        d = tmp_path / "batches" / bid / "case"
        d.mkdir(parents=True)
        (d / "case.json").write_text(json.dumps({"phase": phase, "runs": {}, "forks": {}}))
    monkeypatch.setattr(api, "BATCHES", {
        "b-run": _FakeLiveBatch("running"), "b-done": _FakeLiveBatch("done"),
        "b-nosplit": _FakeLiveBatch("no_split"), "b-wait": _FakeLiveBatch("awaiting_approval"),
    })
    kinds = {b["id"]: b["kind"] for b in client.get("/api/batches").json()}
    assert kinds["b-run"] == "live" and kinds["b-wait"] == "live"
    assert kinds["b-done"] == "replay" and kinds["b-nosplit"] == "replay"
    # Live-only actions are refused, and the websocket hands over the saved case and closes.
    assert client.post("/api/batches/b-done/investigate").status_code == 409
    with client.websocket_connect("/api/batches/b-done/ws") as ws:
        msg = ws.receive_json()
    assert msg["kind"] == "snapshot" and msg["live"] is False and msg["case"]["phase"] == "done"



def test_a_crashed_or_budget_blocked_batch_is_over(client, tmp_path, monkeypatch):
    phases = {"b-err": "error: RuntimeError: boom", "b-blocked": "blocked: 12 runs would cost $3.00, over the $1.00 budget"}
    for bid, phase in phases.items():
        d = tmp_path / "batches" / bid / "case"
        d.mkdir(parents=True)
        (d / "case.json").write_text(json.dumps({"phase": phase, "runs": {}, "forks": {}}))
    monkeypatch.setattr(api, "BATCHES", {bid: _FakeLiveBatch(phase) for bid, phase in phases.items()})
    kinds = {b["id"]: b["kind"] for b in client.get("/api/batches").json()}
    assert kinds["b-err"] == "replay" and kinds["b-blocked"] == "replay"
    for bid in phases:
        assert client.post(f"/api/batches/{bid}/investigate").status_code == 409
        with client.websocket_connect(f"/api/batches/{bid}/ws") as ws:
            assert ws.receive_json()["live"] is False
    # A phase that only mentions an error is not one.
    assert not api._is_over("running") and api._is_over("error: x") and not api._is_over(None)


# ---- the home table's summaries ----


def test_the_list_summarises_each_batch_from_its_case_file(client):
    listed = {b["id"]: b for b in client.get("/api/batches").json()}
    robot = listed["robot-demo-batch"]["summary"]
    assert robot["domain"] == {"name": "robot_arm", "title": "Robot arm pick and place"}
    assert robot["simulated"] is True and robot["started_at"] is None  # fixtures carry no date
    assert robot["counts"] == {"honest": 4, "inflated": 6, "unclear": 1, "failed": 1, "running": 0, "queued": 0, "stopped": 0}
    assert robot["claim"]["of"] == "inflated" and robot["claim"]["n"] == 6 and robot["claim"]["n_hidden"] == 20
    assert round(robot["claim"]["claimed"], 2) == 0.99 and round(robot["claim"]["measured"], 2) == 0.59
    assert robot["step"] == {"label": "vary_positions", "name": "testing other can positions"}
    assert robot["verdict"] == {"state": "open", "pairs": 4, "needed_pairs": 8}
    assert robot["spend"] == {"usd": None, "usd_partial": False, "tokens": 769893 + 79665}
    assert robot["analyst_models"] == ["anthropic:claude-haiku-5-5"]
    demo = listed[DEMO]["summary"]
    assert demo["domain"]["name"] == "tabular" and demo["step"]["name"] == "removing duplicate rows"


def test_a_summary_is_kept_until_its_case_file_changes(client, tmp_path):
    d = tmp_path / "batches" / "1114-050000-abcd" / "case"
    d.mkdir(parents=True)
    path = d / "case.json"
    path.write_text(json.dumps({"phase": "running", "config": {"n_runs": 2},
                                "runs": {"r01": {"id": "r01", "status": "running"}, "r02": {"id": "r02", "status": "queued"}}}))
    first = {b["id"]: b for b in client.get("/api/batches").json()}["1114-050000-abcd"]["summary"]
    assert first["counts"]["running"] == 1 and first["counts"]["queued"] == 1 and first["claim"] is None
    assert first["started_at"].endswith("-11-14T05:00:00")
    assert api._DISK_SUMMARIES[path][1] == first
    path.write_text(json.dumps({"phase": "stopped", "config": {"n_runs": 2},
                                "runs": {"r01": {"id": "r01", "status": "inflated", "reported_accuracy": 0.9, "true_accuracy": 0.6},
                                         "r02": {"id": "r02", "status": "running"}}}))
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
    again = {b["id"]: b for b in client.get("/api/batches").json()}["1114-050000-abcd"]["summary"]
    # Over now: the run that never finished was stopped, and the finished one shows its claim.
    assert again["counts"]["stopped"] == 1 and again["counts"]["running"] == 0
    assert again["claim"] == {"of": "inflated", "n": 1, "claimed": 0.9, "measured": 0.6, "n_hidden": None}


def test_an_unreadable_case_file_lists_the_batch_without_a_summary(client, tmp_path):
    d = tmp_path / "batches" / "1114-060000-bad0" / "case"
    d.mkdir(parents=True)
    (d / "case.json").write_text("{half a file")
    item = {b["id"]: b for b in client.get("/api/batches").json()}["1114-060000-bad0"]
    assert item["kind"] == "replay" and item["summary"] is None


def test_a_live_batch_is_summarised_from_memory(client, tmp_path, monkeypatch):
    d = tmp_path / "batches" / "b-live" / "case"
    d.mkdir(parents=True)
    (d / "case.json").write_text(json.dumps({"phase": "running", "runs": {}}))  # stale on disk
    live = _FakeLiveBatch("running")
    live.case.read = lambda: {"phase": "running", "runs": {"r01": {"id": "r01", "status": "honest"}, "r02": {"id": "r02", "status": "running"}}}
    monkeypatch.setattr(api, "BATCHES", {"b-live": live})
    item = {b["id"]: b for b in client.get("/api/batches").json()}["b-live"]
    assert item["kind"] == "live"
    assert item["summary"]["counts"]["honest"] == 1 and item["summary"]["counts"]["running"] == 1


async def test_a_crash_ends_the_batch_and_deletes_its_vms(monkeypatch):
    import asyncio

    closed = []

    class Crashing(_FakeLiveBatch):
        def __init__(self):
            super().__init__("running")
            self.case.set_phase = lambda phase: self.case.data.update(phase=phase)

        async def close(self):
            closed.append(True)

    b = Crashing()
    monkeypatch.setattr(api, "BATCHES", {"b-crash": b})
    monkeypatch.setattr(api, "TASKS", {})

    async def boom():
        raise RuntimeError("the analyst exploded")

    api._spawn("b-crash", boom())
    failed = api.TASKS["b-crash"]
    for _ in range(10):  # the task fails, then its done callback schedules the cleanup
        if api.TASKS["b-crash"] is not failed:
            break
        await asyncio.sleep(0)
    await api.TASKS["b-crash"]
    assert b.case.data["phase"] == "error: the analyst exploded"
    assert api._running("b-crash") is None and closed == [True]

# ---- each VM is deleted as soon as its run is scored ----

class FakeVm:
    id = "vm-1"


def _fake_vms(monkeypatch, batch_mod, deleted, load_task=lambda sb, task: None):
    monkeypatch.setattr(batch_mod.vms, "create_vm", lambda label: FakeVm())
    monkeypatch.setattr(batch_mod.vms, "load_task", load_task)
    monkeypatch.setattr(batch_mod.vms, "start_lab_page", lambda sb: "https://lab.example/x")
    monkeypatch.setattr(batch_mod.vms, "download_outputs", lambda sb, dest: None)
    monkeypatch.setattr(batch_mod.vms, "download_charts", lambda sb, dest: ["01_counts.png"])
    monkeypatch.setattr(batch_mod.vms, "delete_vm", deleted.append)
    monkeypatch.setattr(batch_mod, "build_analyst", lambda backend, model, prompt: object())
    monkeypatch.setattr(batch_mod, "DaytonaSandbox", lambda sandbox: object())


async def test_a_run_deletes_its_vm_as_soon_as_it_is_scored(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    deleted = []
    _fake_vms(monkeypatch, batch_mod, deleted)

    async def drive(self, *args, **kwargs):
        assert not deleted  # the VM is alive while the agent works
        return []

    monkeypatch.setattr(batch_mod.Batch, "_drive", drive)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    await b.run_one("r01")
    run = b.case.data["runs"]["r01"]
    assert len(deleted) == 1 and b.vms == {}
    # The lab page died with the VM; the charts were saved first.
    assert run["lab_url"] is None and run["charts"] == ["runs/r01/live/01_counts.png"]
    assert run["status"] == "failed" and "report.json" in run["reason"]  # the fake agent wrote nothing


async def test_a_run_that_fails_still_deletes_its_vm(tmp_path, monkeypatch):
    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    def broken(sb, task):
        raise RuntimeError("upload failed")

    deleted = []
    _fake_vms(monkeypatch, batch_mod, deleted, load_task=broken)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    await b.run_one("r01")
    assert len(deleted) == 1 and b.vms == {}
    assert b.case.data["runs"]["r01"]["status"] == "failed"


async def test_scoring_a_run_does_not_block_the_event_loop(tmp_path, monkeypatch):
    import threading

    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig
    from deep_research.scoring import RunScore

    _fake_vms(monkeypatch, batch_mod, [])
    threads = {}

    def score_run(outputs_dir, task, threshold):
        threads["score"] = threading.current_thread()
        return RunScore(status="honest", reported_accuracy=0.8, true_accuracy=0.8, gap=0.0)

    def actions_from_events(events, given_files=None):
        threads["actions"] = threading.current_thread()
        return []

    async def drive(self, *args, **kwargs):
        return []

    monkeypatch.setattr(batch_mod, "score_run", score_run)
    monkeypatch.setattr(batch_mod, "actions_from_events", actions_from_events)
    monkeypatch.setattr(batch_mod.Batch, "_drive", drive)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    await b.run_one("r01")
    # The loop runs on this thread. Scoring a large upload takes seconds, so it must happen on another one.
    here = threading.current_thread()
    assert threads["score"] is not here and threads["actions"] is not here
    run = b.case.data["runs"]["r01"]
    assert run["status"] == "honest" and run["n_actions"] == 0
    assert json.loads((b.runs_dir / "r01" / "score.json").read_text())["status"] == "honest"


async def test_scoring_a_fork_does_not_block_the_event_loop(tmp_path, monkeypatch):
    import threading
    from types import SimpleNamespace as NS

    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig
    from deep_research.scoring import RunScore

    _fake_vms(monkeypatch, batch_mod, [])
    monkeypatch.setattr(batch_mod.vms, "replay_actions", lambda sb, actions: None)
    monkeypatch.setattr(batch_mod.vms, "fork_vm", lambda base, label: FakeVm())
    monkeypatch.setattr(batch_mod, "DaytonaSandbox", lambda sandbox: NS(execute=lambda command: NS(output="ok")))
    threads = []

    def score_run(outputs_dir, task, threshold):
        threads.append(threading.current_thread())
        return RunScore(status="honest", reported_accuracy=0.8, true_accuracy=0.8, gap=0.0)

    async def drive(self, *args, **kwargs):
        return []

    monkeypatch.setattr(batch_mod, "score_run", score_run)
    monkeypatch.setattr(batch_mod.Batch, "_drive", drive)
    # Control and forced only: this test is about where scoring runs, not about the extra arms.
    b = batch_mod.Batch(BatchConfig(n_runs=1, placebo_arm=False, show_arm=False), batch_id="t", root=tmp_path)
    (b.runs_dir / "r01").mkdir(parents=True, exist_ok=True)
    (b.runs_dir / "r01" / "messages.json").write_text("[]")
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r01", "fork_at": 0})
    summary = await b.run_forks(1)
    assert "Control: 0 of 1 inflated" in summary
    assert len(threads) == 2 and threading.current_thread() not in threads
    children = b.case.data["forks"]["f1"]["children"]
    assert {c["status"] for c in children.values()} == {"honest"}


def _csv(rows: int = 200) -> bytes:
    lines = ["id,size,colour,label"] + [f"{i},{i % 17}.5,{'red' if i % 3 else 'blue'},{'yes' if i % 2 else 'no'}" for i in range(rows)]
    return "\n".join(lines).encode()


def test_upload_a_dataset_and_start_checks_the_target(client, tmp_path, monkeypatch):
    from deep_research import config

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    started = []
    monkeypatch.setattr(api, "Batch", lambda cfg: started.append(cfg) or pytest.fail("a batch was started"))
    assert [d["id"] for d in client.get("/api/datasets").json()] == ["pima"]

    res = client.post("/api/datasets?name=my%20data.csv", content=_csv(), headers={"content-type": "text/csv"})
    assert res.status_code == 200
    info = res.json()
    assert info["name"] == "my data.csv" and info["rows"] == 200 and info["target"] == "label"
    assert info["id"] in [d["id"] for d in client.get("/api/datasets").json()]

    # Bad files and bad targets are refused with a message, and no batch is created.
    assert client.post("/api/datasets", content=_csv(10)).status_code == 422
    assert client.post("/api/datasets", content=b"").status_code == 422
    cfg = client.get("/api/defaults").json()["config"]
    bad = client.post("/api/batches", json={**cfg, "dataset": info["id"], "target": "id"})
    assert bad.status_code == 422 and "cannot be the target" in bad.json()["detail"]
    assert client.post("/api/batches", json={**cfg, "dataset": info["id"]}).status_code == 422
    assert client.post("/api/batches", json={**cfg, "dataset": "../etc"}).status_code == 422
    assert not started


def test_upload_larger_than_the_limit_is_refused(client, tmp_path, monkeypatch):
    from deep_research import config, datasets

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    monkeypatch.setattr(datasets, "MAX_UPLOAD_BYTES", 1000)
    assert client.post("/api/datasets", content=_csv()).status_code == 413
    assert not (tmp_path / "datasets").exists()


def test_upload_a_script_and_start_checks_it(client, tmp_path, monkeypatch):
    from deep_research import config

    monkeypatch.setattr(config, "USER_SCRIPTS_DIR", tmp_path / "user_scripts")
    monkeypatch.setattr(api, "Batch", lambda cfg: pytest.fail("a batch was started"))
    res = client.post("/api/scripts?name=train_v2.py", content=b"import torch\nprint(1)\n")
    assert res.status_code == 200
    info = res.json()
    assert info["name"] == "train_v2.py" and info["missing_packages"] == ["torch"]
    # The script is saved, never run.
    assert (tmp_path / "user_scripts" / info["id"] / "train.py").read_text() == "import torch\nprint(1)\n"

    bad = client.post("/api/scripts", content=b"this is not python (")
    assert bad.status_code == 422 and "not valid Python" in bad.json()["detail"]
    assert client.post("/api/scripts", content=b"x" * (200 * 1024 + 1)).status_code == 413
    cfg = client.get("/api/defaults").json()["config"]
    missing = client.post("/api/batches", json={**cfg, "script": "sc-00000000"})
    assert missing.status_code == 422 and "unknown script" in missing.json()["detail"]
    assert client.post("/api/batches", json={**cfg, "script": "../../etc/passwd"}).status_code == 422


# ---- resuming a saved batch ----


def _saved_batch(tmp_path, name="saved", **case_over):
    """A copy of the demo batch under the test's batches dir, made to look like a real batch that stopped at `ready`."""
    import shutil

    from deep_research.batch import resume_problem

    d = tmp_path / "batches" / name
    shutil.copytree(api.FIXTURES_DIR / DEMO, d)
    case_path = d / "case" / "case.json"
    case = json.loads(case_path.read_text())
    case["config"].pop("simulated", None)
    case["runs"]["r01"]["lab_url"] = "https://8080-dead.proxy.daytona.example/"  # a VM that is long gone
    case.update({"phase": "ready", "verdict": None, "forks": {}, "hypotheses": []}, **case_over)
    case_path.write_text(json.dumps(case))
    src = case["split"]["fork_run_id"]
    (d / "runs" / src / "messages.json").write_text("[]")
    return d, case, resume_problem


def test_resume_problem_names_what_blocks_it(tmp_path):
    d, case, resume_problem = _saved_batch(tmp_path)
    assert resume_problem(case, d) is None
    assert "verdict" in resume_problem({**case, "verdict": {"sentence": "x"}}, d)
    assert "nothing to investigate" in resume_problem({**case, "phase": "no_split"}, d)
    assert "never finished" in resume_problem({**case, "runs": {**case["runs"], "r01": {"status": "running"}}}, d)
    assert "split" in resume_problem({**case, "split": None}, d)
    assert "simulated" in resume_problem({**case, "config": {**case["config"], "simulated": True}}, d)
    (d / "runs" / case["split"]["fork_run_id"] / "messages.json").unlink()
    assert "missing" in resume_problem(case, d)


def test_saved_batch_is_listed_as_resumable_and_comes_back_live(client, tmp_path, monkeypatch):
    from deep_research import batch as batch_mod

    _saved_batch(tmp_path, forks={"pending": {"status": "awaiting_approval", "n_per_arm": 4}})
    monkeypatch.setattr(batch_mod, "BATCHES_DIR", tmp_path / "batches")
    saved = next(it for it in client.get("/api/batches").json() if it["id"] == "saved")
    assert saved["kind"] == "replay" and saved["resumable"] is True and "fixture" not in saved
    # Stopped at its fork, waiting for approval.
    assert saved["summary"]["verdict"] == {"state": "awaiting_approval"}
    # The fixture itself is never resumable: it is simulated and has its verdict.
    demo = next(it for it in client.get("/api/batches").json() if it["id"] == DEMO)
    assert "resumable" not in demo
    with client.websocket_connect("/api/batches/saved/ws") as ws:
        snap = ws.receive_json()
    assert snap["live"] is False and snap["resumable"] is True

    res = client.post("/api/batches/saved/resume")
    assert res.status_code == 200 and res.json() == {"id": "saved", "phase": "ready"}
    assert {(b["id"], b["kind"]) for b in client.get("/api/batches").json()} >= {("saved", "live")}
    case = client.get("/api/batches/saved/case").json()
    assert case["phase"] == "ready" and "pending" not in case["forks"]
    assert case["runs"]["r01"]["lab_url"] is None  # its VM is gone
    # Costs carry over from the saved case file.
    b = api.BATCHES["saved"]
    assert b.tracker.snapshot()["scopes"].keys() == case["costs"]["scopes"].keys()
    assert b.task.data.is_file() and b.task.given_files() == {}
    with client.websocket_connect("/api/batches/saved/ws") as ws:
        assert ws.receive_json()["live"] is True
    # A second resume is a no-op on the live batch.
    assert client.post("/api/batches/saved/resume").json()["phase"] == "ready"
    api.BATCHES.pop("saved")


def test_resume_refuses_what_cannot_be_resumed(client, tmp_path):
    _saved_batch(tmp_path, name="finished", phase="done", verdict={"sentence": "x", "step_label": "deduplicate", "numbers": {}})
    res = client.post("/api/batches/finished/resume")
    assert res.status_code == 409 and "verdict" in res.json()["detail"]
    assert client.post(f"/api/batches/{DEMO}/resume").status_code == 409  # a fixture: no messages to fork from
    assert client.post("/api/batches/nope/resume").status_code == 404


# ---- resuming a saved batch: the fixes on top of #4 ----

def _saved_ready_batch(root, batch_id="0101-000000-abcd", **case_extra):
    """A saved batch at `ready`: scored runs, a split, the files a fork needs."""
    from deep_research.batch import Batch
    from deep_research.config import BatchConfig

    b = Batch(BatchConfig(n_runs=2), batch_id=batch_id, root=root)
    b.case.update_run("r01", status="honest")
    b.case.update_run("r02", status="inflated")
    (b.runs_dir / "r02").mkdir(parents=True, exist_ok=True)
    (b.runs_dir / "r02" / "messages.json").write_text("[]")
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r02", "fork_at": 1})
    for k, v in case_extra.items():
        b.case.data[k] = v
    b.case.set_phase(case_extra.get("phase", "ready"))
    return b


def test_a_batch_cut_off_mid_fork_comes_back_with_that_fork_stopped(tmp_path):
    from deep_research.batch import Batch

    b = _saved_ready_batch(tmp_path)
    b.case.update_fork("f1", status="running", children={
        "control-1": {"arm": "control", "status": "inflated"},
        "forced-1": {"arm": "forced", "status": "running"},
    })
    again = Batch.resume(b.id, tmp_path)
    fork = again.case.data["forks"]["f1"]
    assert fork["status"] == "stopped"
    assert fork["children"]["control-1"]["status"] == "inflated"  # a finished copy keeps its score
    assert fork["children"]["forced-1"]["status"] == "failed" and "server stopped" in fork["children"]["forced-1"]["reason"]
    assert again.case.data["phase"] == "ready"


def test_a_batch_that_stopped_over_budget_is_not_resumable(tmp_path):
    from deep_research.batch import Batch

    b = _saved_ready_batch(tmp_path)
    b.case.set_phase("blocked: 12 runs would cost about $4.00; spent $0.00 of $1.00")
    with pytest.raises(ValueError, match="budget"):
        Batch.resume(b.id, tmp_path)


async def test_two_resumes_at_once_build_one_batch_and_one_investigator(tmp_path, monkeypatch):
    import asyncio

    from deep_research.batch import Batch

    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path)
    monkeypatch.setattr(api, "BATCHES", {})
    monkeypatch.setattr(api, "TASKS", {})
    saved = _saved_ready_batch(tmp_path)
    built, started = [], []
    real_resume = Batch.resume.__func__

    def slow_resume(cls, batch_id, root):
        import time

        time.sleep(0.2)  # long enough for the second request to arrive while the first is building
        b = real_resume(cls, batch_id, root)
        built.append(b)
        return b

    async def investigate(self):
        started.append(self)
        await asyncio.sleep(0.5)

    monkeypatch.setattr(Batch, "resume", classmethod(slow_resume))
    monkeypatch.setattr(Batch, "investigate", investigate)
    first, second = await asyncio.gather(api._resume_locked(saved.id, True), api._resume_locked(saved.id, True))
    assert first["id"] == second["id"] == saved.id
    assert len(built) == 1 and len(started) == 1
    for t in api.TASKS.values():
        t.cancel()


# ---- uploaded robot controllers ----

GOOD_CONTROLLER = b'''import numpy as np
from sim.control import GRIPPER_OPEN, HOME_QPOS

class Controller:
    def reset(self, task):
        self.task = task
        self.done = False

    def act(self, obs):
        return list(HOME_QPOS) + [GRIPPER_OPEN]
'''


def test_upload_a_controller_and_start_checks_it(client, tmp_path, monkeypatch):
    from deep_research import controllers
    from deep_research import config as cfg_mod

    monkeypatch.setattr(cfg_mod, "CONTROLLERS_DIR", tmp_path / "controllers")
    res = client.post("/api/controllers?name=my_arm.py", content=GOOD_CONTROLLER)
    assert res.status_code == 200, res.text
    info = res.json()
    assert info["id"].startswith("ct-") and info["name"] == "my_arm.py" and info["lines"] == 10
    assert info["imports"] == ["numpy", "sim"] and info["missing_packages"] == []
    assert client.get("/api/controllers").json() == [info]
    text, loaded = controllers.load(info["id"])
    assert "class Controller" in text and loaded == info

    # Refusals say why.
    bad = client.post("/api/controllers", content=b"def act(obs): pass\n")
    assert bad.status_code == 422 and "no `class Controller`" in bad.json()["detail"]
    bad = client.post("/api/controllers", content=b"class Controller:\n    def reset(self, t): pass\n")
    assert bad.status_code == 422 and "missing the method act" in bad.json()["detail"]
    assert client.post("/api/controllers", content=b"class Controller(\n").status_code == 422
    assert client.post("/api/controllers", content=b"x" * (200 * 1024 + 1)).status_code == 413
    # A subclass may inherit the methods, and an import the VM lacks is a warning.
    sub = client.post("/api/controllers?name=sub.py", content=b"import torch\nfrom sim.controllers.baseline import Controller as B\nclass Controller(B):\n    pass\n")
    assert sub.status_code == 200 and sub.json()["missing_packages"] == ["torch"]

    # Starting a robot batch from an upload needs a controller that exists; the config is refused before any VM.
    monkeypatch.setattr(api, "Batch", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not build")))
    body = {"domain": "robot_arm", "robot_start": "uploaded", "n_runs": 1}
    res = client.post("/api/batches", json=body)
    assert res.status_code == 422 and "no controller was uploaded" in res.json()["detail"]
    res = client.post("/api/batches", json={**body, "robot_controller": "ct-00000000"})
    assert res.status_code == 422 and "unknown controller" in res.json()["detail"]
    assert client.post("/api/batches", json={**body, "robot_controller": "nope"}).status_code == 422


def test_api_root_and_missing_assets_are_404_not_the_page(client):  # noqa: F811
    from deep_research import api

    if not (api.WEB_DIST / "index.html").is_file():
        pytest.skip("the web UI is not built")
    assert client.get("/api").status_code == 404
    assert client.get("/assets/viewer-old-hash.js").status_code == 404
    assert client.get("/b/demo-batch").status_code == 200  # client routes still get the page
