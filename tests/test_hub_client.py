"""The hub client against a fake hub (httpx.MockTransport): off without settings, keys, reads, and the pusher."""

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
        self.down = False
        self.requests: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        if self.down:
            raise httpx.ConnectError("hub is down")
        if req.headers.get("authorization") != f"Bearer {self.token}":
            return httpx.Response(401, json={"error": "missing or wrong team token"})
        parts = req.url.path.strip("/").split("/")
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
