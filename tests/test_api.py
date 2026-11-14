"""The one FastAPI app: batch routes on the committed demo fixture, health, 404s, the SPA, shutdown."""

import json

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
    assert {"id": DEMO, "kind": "replay"} in client.get("/api/batches").json()
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
    assert res.json() == {"ok": True, "keys": {"anthropic": True, "daytona": False}}
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


def test_batch_close_stops_every_vm(tmp_path, monkeypatch):
    import asyncio

    from deep_research import batch as batch_mod
    from deep_research.config import BatchConfig

    stopped = []
    monkeypatch.setattr(batch_mod.vms, "stop_vm", stopped.append)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    b.vms.update({"r01": "vm-run", "f1-base": "vm-base", "f1-forced-1": "vm-child"})
    asyncio.run(b.close())
    assert sorted(stopped) == ["vm-base", "vm-child", "vm-run"]
    assert json.loads((tmp_path / "t" / "case" / "case.json").read_text())["config"]["n_runs"] == 1
