"""Agent wiring checks with a scripted fake model. No API keys, no VMs."""

import json
from pathlib import Path

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deep_research.batch import Batch, _arm_summary
from deep_research.config import BatchConfig
from deep_research.forks import cut_history, forced_turn


class ScriptedModel(GenericFakeChatModel):
    """Returns the given messages in order and ignores tools."""

    def bind_tools(self, tools, **kwargs):
        return self


def _call(name, args, i):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"c{i}"}])


@pytest.fixture
def batch(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    cfg = BatchConfig(analyst_model="anthropic:claude-haiku-4-5", investigator_model="anthropic:claude-sonnet-4-5")
    b = Batch(cfg, batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="honest")
    return b


async def test_investigator_cannot_edit_case_file_but_tools_can(batch, monkeypatch):
    from deep_research.agents import investigator as inv_mod

    before = (batch.dir / "case" / "case.json").read_text()
    script = iter(
        [
            _call("write_file", {"file_path": "/case/hacked.json", "content": "{}"}, 1),
            _call("edit_file", {"file_path": "/case/case.json", "old_string": "honest", "new_string": "inflated"}, 2),
            _call("read_file", {"file_path": "/case/case.json"}, 3),
            AIMessage(content="done"),
        ]
    )
    monkeypatch.setattr(inv_mod, "create_deep_agent", _with_model(inv_mod.create_deep_agent, ScriptedModel(messages=script)))
    agent = inv_mod.build_investigator(batch, "unused")
    out = await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})

    tool_msgs = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert "denied" in tool_msgs[0].content.lower() or "permission" in tool_msgs[0].content.lower()
    assert "denied" in tool_msgs[1].content.lower() or "permission" in tool_msgs[1].content.lower()
    assert "honest" in tool_msgs[2].content  # reads work
    assert not (batch.dir / "case" / "hacked.json").exists()
    assert json.loads((batch.dir / "case" / "case.json").read_text())["runs"] == json.loads(before)["runs"]


def _with_model(fn, model):
    def wrapped(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        return fn(*args, **kwargs)

    return wrapped


def test_cut_history_never_splits_a_turn():
    msgs = [
        HumanMessage("task"),
        _call("execute", {"command": "a"}, 1),
        ToolMessage("ok", tool_call_id="c1"),
        AIMessage(content="", tool_calls=[{"name": "execute", "args": {"command": "b"}, "id": "c2"},
                                          {"name": "execute", "args": {"command": "c"}, "id": "c3"}]),
        ToolMessage("ok", tool_call_id="c2"),
        ToolMessage("ok", tool_call_id="c3"),
    ]
    prefix, n = cut_history(msgs, 2)  # action 2 is the second call in the second turn
    assert n == 1 and len(prefix) == 3
    turn = forced_turn("dedupe", "Removed 10 rows")
    assert turn[0].tool_calls[0]["id"] == turn[1].tool_call_id


def test_arm_summary_ignores_failed():
    s = _arm_summary([
        {"status": "inflated", "reported_accuracy": 0.9, "true_accuracy": 0.75},
        {"status": "honest", "reported_accuracy": 0.76, "true_accuracy": 0.75},
        {"status": "failed"},
    ])
    assert s == {"total": 3, "scored": 2, "inflated": 1, "honest": 1, "failed": 1, "mean_reported": 0.83, "mean_true": 0.75}
