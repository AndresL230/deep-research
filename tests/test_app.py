from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from server import config
from server.agent import build_agent
from server.app import create_app
from server.conversations import Services
from tests.fakes import PNG, FakeChatModel, FakeSession, ScriptedAgent, keys, parse_sse

CONV = "3f2b8c1e-0000-4000-8000-000000000001"
META = {"langgraph_node": "model"}


def scripted_turn() -> list[Any]:
    def make_chart(backend):
        backend.session.files[f"{config.OUTPUTS_DIR}/revenue_by_region.png"] = PNG

    return [
        ("messages", (AIMessageChunk(content="Looking ", id="a"), META)),
        ("tools", {"event": "tool-started", "tool_call_id": "c1", "tool_name": "execute",
                   "input": {"command": "python plot.py"}}),
        make_chart,
        ("tools", {"event": "tool-finished", "tool_call_id": "c1",
                   "output": ToolMessage("ok\n[Command succeeded with exit code 0]", tool_call_id="c1")}),
        ("messages", (AIMessageChunk(content="North leads.", id="b",
                                     usage_metadata={"input_tokens": 50, "output_tokens": 5, "total_tokens": 55}), META)),
    ]


class Harness:
    def __init__(self, tmp_path, *, anthropic=True, daytona=True, script=None, agent_factory=None):
        FakeSession.created = 0
        FakeSession.deleted = []
        self.sessions: list[FakeSession] = []
        self.agents: list[ScriptedAgent] = []
        self.script = script if script is not None else scripted_turn()

        def sandbox_factory() -> FakeSession:
            session = FakeSession()
            self.sessions.append(session)
            return session

        def scripted_agent_factory(backend) -> ScriptedAgent:
            agent = ScriptedAgent(backend, self.script)
            self.agents.append(agent)
            return agent

        self.services = Services(
            sandbox_factory=sandbox_factory,
            agent_factory=agent_factory or scripted_agent_factory,
            key_status=keys(anthropic, daytona),
            runs_dir=tmp_path / "runs",
        )
        self.app = create_app(self.services)

    def ask(self, client: TestClient, message="What sells best?", files=None, conversation=CONV):
        r = client.post("/api/ask", data={"conversation": conversation, "message": message}, files=files)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse(r.text)


def test_health(tmp_path):
    h = Harness(tmp_path, anthropic=True, daytona=False)
    with TestClient(h.app) as client:
        assert client.get("/api/health").json() == {"ok": True, "keys": {"anthropic": True, "daytona": False}}


def test_sample(tmp_path):
    with TestClient(Harness(tmp_path).app) as client:
        r = client.get("/api/sample")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        assert r.headers["content-disposition"] == 'attachment; filename="sales.csv"'
        assert r.text.startswith("date,region,product")


@pytest.mark.parametrize(
    "path",
    [
        f"/api/files/{CONV}/..%2F..%2Fpyproject.toml",
        f"/api/files/{CONV}/..",
        f"/api/files/{CONV}/.secret",
        "/api/files/..%2F..%2Fserver/app.py",
        "/api/files/../server/app.py",
        f"/api/files/{CONV}/%2Fetc%2Fpasswd",
        f"/api/files/{CONV}/missing.png",
    ],
)
def test_files_rejects_traversal_and_missing(tmp_path, path):
    h = Harness(tmp_path)
    (tmp_path / "runs" / CONV).mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text("secret")
    with TestClient(h.app) as client:
        r = client.get(path)
        assert r.status_code == 404
        assert "secret" not in r.text


def test_ask_streams_contract_events_and_downloads_image(tmp_path):
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        events = h.ask(client)
        assert [(n, d.get("state")) for n, d in events] == [
            ("thinking", "run"),
            ("thinking", "done"),
            ("text", None),
            ("activity", "run"),
            ("activity", "done"),
            ("block", None),
            ("text", None),
            ("done", None),
        ]
        assert events[3][1] == {"step": 1, "state": "run", "tool": "execute", "icon": "ci", "label": "Running plot.py"}
        assert events[4][1] == {"step": 1, "state": "done", "resultLine": "exit 0 · 1 line of output"}
        url = f"/api/files/{CONV}/revenue_by_region.png"
        assert events[5][1] == {"kind": "image", "url": url, "alt": "revenue by region"}
        assert events[-1][1] == {"messageId": 1, "cites": [], "tokens": {"in": 50, "out": 5, "cached": 0}}
        assert (tmp_path / "runs" / CONV / "revenue_by_region.png").read_bytes() == PNG

        r = client.get(url)
        assert r.status_code == 200 and r.content == PNG
        assert r.headers["content-type"] == "image/png"
        assert "default-src 'none'" in r.headers["content-security-policy"]

        # Follow-up: same sandbox + thread, no duplicate image, next messageId.
        events2 = h.ask(client, message="And by channel?")
        assert len(h.sessions) == 1 and h.sessions[0].ensure_running_calls == 1
        assert [n for n, _ in events2].count("block") == 0
        assert events2[-1][1]["messageId"] == 2
        agent = h.agents[0]
        assert agent.calls[0][1] == agent.calls[1][1]  # same thread id
        assert agent.calls[0][2] == ["messages", "tools"]


def test_ask_uploads_csv_into_sandbox(tmp_path):
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        events = h.ask(client, files={"file": ("../My Sales.csv", b"a,b\n1,2\n", "text/csv")})
        assert events[-1][0] == "done"
        session = h.sessions[0]
        assert session.files[f"{config.DATA_DIR}/My_Sales.csv"] == b"a,b\n1,2\n"
        sent = h.agents[0].calls[0][0]["messages"][0]["content"]
        assert f"{config.DATA_DIR}/My_Sales.csv" in sent


def test_no_key_error_before_sandbox(tmp_path):
    h = Harness(tmp_path, anthropic=False, daytona=False)
    with TestClient(h.app) as client:
        events = h.ask(client)
        assert len(events) == 1
        name, data = events[0]
        assert name == "error" and data["code"] == "no_key"
        assert "ANTHROPIC_API_KEY" in data["message"] and "DAYTONA_API_KEY" in data["message"]
        assert h.sessions == []


def test_too_large_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "MAX_UPLOAD_BYTES", 10)
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        events = h.ask(client, files={"file": ("big.csv", b"x" * 11, "text/csv")})
        assert events == [("error", {"code": "too_large", "message": "The file is larger than 0 MB."})]
        assert h.sessions == []


def test_agent_failure_becomes_failed_error(tmp_path):
    def boom(backend):
        raise ValueError("model exploded")

    h = Harness(tmp_path, script=[("messages", (AIMessageChunk(content="hi", id="a"), META)), boom])
    with TestClient(h.app) as client:
        events = h.ask(client)
        assert events[-1] == ("error", {"code": "failed", "message": "ValueError: model exploded"})
        assert [n for n, _ in events][:2] == ["thinking", "thinking"]


def test_invalid_conversation_id(tmp_path):
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        events = h.ask(client, conversation="../etc")
        assert events[0][0] == "error" and events[0][1]["code"] == "failed"


def test_delete_conversation_and_shutdown_delete_sandboxes(tmp_path):
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        h.ask(client)
        h.ask(client, conversation="second-conversation")
        assert client.delete(f"/api/conversations/{CONV}").status_code == 204
        assert FakeSession.deleted == ["sb-1"]
        assert not (tmp_path / "runs" / CONV).exists()
        assert client.delete("/api/conversations/unknown").status_code == 204
        # A new turn on the deleted id starts a fresh sandbox.
        h.ask(client)
        assert len(h.sessions) == 3
    # Leaving the client runs the lifespan shutdown.
    assert sorted(FakeSession.deleted) == ["sb-1", "sb-2", "sb-3"]


def test_spa_fallback(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    monkeypatch.setattr(config, "WEB_DIST", dist)
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        assert client.get("/").status_code == 404  # not built yet: tolerated
        dist.mkdir()
        (dist / "index.html").write_text("<html>app</html>")
        (dist / "assets").mkdir()
        (dist / "assets" / "app.js").write_text("console.log(1)")
        assert client.get("/").text == "<html>app</html>"
        assert client.get("/some/route").text == "<html>app</html>"
        assert client.get("/assets/app.js").text == "console.log(1)"
        assert client.get("/api/nope").status_code == 404


def test_real_deep_agent_with_fake_model(tmp_path):
    """The real create_deep_agent graph, a scripted model, and a fake sandbox backend."""
    todos = [{"content": "Plot revenue", "status": "in_progress"}, {"content": "Answer", "status": "pending"}]
    model = FakeChatModel(script=[
        AIMessage(content="I'll plan first.", id="m1",
                  tool_calls=[{"name": "write_todos", "args": {"todos": todos}, "id": "t1"}]),
        AIMessage(content="", id="m2",
                  tool_calls=[{"name": "execute", "args": {"command": "python plot.py"}, "id": "t2"}]),
        AIMessage(content="North leads; see `revenue_by_region.png`.", id="m3"),
    ])
    h = Harness(tmp_path, agent_factory=lambda backend: build_agent(backend, model=model))
    with TestClient(h.app) as client:
        events = h.ask(client)
    kinds = [(n, d.get("state")) for n, d in events]
    assert kinds[:2] == [("thinking", "run"), ("thinking", "done")]
    activities = [d for n, d in events if n == "activity"]
    assert activities[0]["tool"] == "write_todos" and activities[0]["icon"] == "sprint"
    assert activities[1] == {"step": 1, "state": "done", "results": ["[~] Plot revenue", "[ ] Answer"],
                             "resultLine": "0 of 2 done"}
    assert activities[2]["tool"] == "execute" and activities[2]["step"] == 2
    assert activities[3]["resultLine"].startswith("exit 0")
    block_index = next(i for i, (n, _) in enumerate(events) if n == "block")
    assert block_index > kinds.index(("activity", "done"), 4)
    text = "".join(d["delta"] for n, d in events if n == "text")
    assert "I'll plan first." in text and "North leads; see `revenue_by_region.png`." in text
    assert events[-1][0] == "done"
    assert events[-1][1]["tokens"] == {"in": 300, "out": 30, "cached": 120}
