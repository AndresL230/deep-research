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


async def test_the_plan_and_the_subagents_reach_the_case_file(tmp_path, monkeypatch):
    """The investigator's `write_todos` plan and every `task` call it makes land in the case file's `investigator`
    section, which the investigator panel reads: the plan, and which subagents ran how often."""
    from tests.scripted import call, say, script_investigator

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(n_runs=2, analyst_model="anthropic:claude-haiku-4-5"), batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="honest")
    b.case.update_run("r02", status="inflated")
    b.case.set_phase("ready")
    plan = [{"content": "Tag the runs", "status": "in_progress"}, {"content": "Ask the lenses", "status": "pending"}]
    done = [{"content": "Tag the runs", "status": "completed"}, {"content": "Ask the lenses", "status": "in_progress"}]
    tags = {"run_id": "r02", "saved": False, "changed": []}
    script_investigator(monkeypatch, [
        call("write_todos", {"todos": plan}, "c1"),
        call("task", {"subagent_type": "step-tagger", "description": "Check run r02's labels."}, "c2"),
        call("StepTags", tags, "c3"),  # the step-tagger's typed report
        call("task", {"subagent_type": "skeptic", "description": "Cheapest disproof of s1?"}, "c4"),
        call("SkepticReport", {"checks": []}, "c5"),
        call("write_todos", {"todos": done}, "c6"),
        say("Done for now."),
    ])
    await b.investigate()

    inv = b.case.read()["investigator"]
    assert inv["todos"] == done
    assert inv["subagent_calls"] == {"step-tagger": 1, "skeptic": 1}
    assert inv["subagent"] is None  # nobody is at work once it has finished
    events = [json.loads(line) for line in (b.dir / "investigator" / "events.jsonl").read_text().splitlines()]
    assert {"step-tagger", "skeptic"} <= {e["agent"] for e in events}  # the subagents' own steps are logged as theirs


async def test_the_built_investigator_has_the_plan_and_the_task_tools(batch, monkeypatch):
    """`write_todos` (TodoListMiddleware) and `task` (the subagents) are really in the compiled agent's tool list."""
    from deep_research.agents import investigator as inv_mod

    seen: list[set] = []

    class Recording(ScriptedModel):
        def bind_tools(self, tools, **kwargs):
            seen.append({getattr(t, "name", None) or (t.get("name") if isinstance(t, dict) else None) for t in tools})
            return self

    model = Recording(messages=iter([AIMessage(content="done")]))
    monkeypatch.setattr(inv_mod, "create_deep_agent", _with_model(inv_mod.create_deep_agent, model))
    monkeypatch.setattr(inv_mod, "GRADER_MODEL", ScriptedModel(messages=iter([])))
    agent = inv_mod.build_investigator(batch, "unused")
    try:
        await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})
    except Exception:  # noqa: BLE001 - only the tools bound on the first turn matter here
        pass
    assert seen and {"write_todos", "task", "record_suspects", "run_experiment"} <= seen[0]
    prompt = inv_mod.main_prompt()
    assert "write_todos" in prompt and "step-tagger" in prompt and "skeptic" in prompt


async def test_a_finished_investigator_can_be_asked_to_test_an_untested_suspect(tmp_path, monkeypatch):
    """`test_suspect_problem` says when a finished batch's untested suspect can be tested; `test_suspect` resumes the
    investigator on its own saved thread with the request, and it runs like any other turn of the investigator."""
    from deep_research.batch import test_suspect_problem, testable_suspects
    from tests.scripted import say, script_investigator

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(n_runs=2, analyst_model="anthropic:claude-haiku-4-5"), batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="inflated")
    b.case.update_run("r02", status="inflated")
    assert b.case.record_suspects([
        {"target": "deduplicate", "kind": "omission", "rationale": "inflated runs skip it"},
        {"target": "evaluate", "kind": "omission", "rationale": "inflated runs skip it too"},
    ]) == "suspects saved: s1, s2"
    b.case.set_phase("ready")
    script_investigator(monkeypatch, [say("Verdict written.")])
    await b.investigate()
    case = b.case.read()
    # No task files on disk, and nothing to fork: refused with the reason.
    assert test_suspect_problem(case, b.dir, "s2") == "the files needed to fork a run are missing"
    (b.dir / "task").mkdir(exist_ok=True)
    (b.dir / "task" / "data.csv").write_text("x\n")
    (b.dir / "runs" / "r01").mkdir(parents=True, exist_ok=True)
    (b.dir / "runs" / "r01" / "messages.json").write_text("[]")
    assert test_suspect_problem(case, b.dir, "s2") is None
    assert testable_suspects(case, b.dir) == ["s1", "s2"]
    assert test_suspect_problem(case, b.dir, "s9") == "there is no suspect s9"
    assert "simulated" in test_suspect_problem({**case, "config": {**case["config"], "simulated": True}}, b.dir, "s2")
    assert test_suspect_problem({**case, "phase": "investigating"}, b.dir, "s2") == "the investigation has not finished"
    tested = {**case, "forks": {"f1": {"suspect_id": "s2", "status": "done"}}}
    assert test_suspect_problem(tested, b.dir, "s2") == "s2 has been tested already"

    script_investigator(monkeypatch, [say("I will ask the skeptic and request one experiment on s2.")])
    b2 = Batch.reopen("t", tmp_path, suspect_id="s2")
    b2.claim_test("s2")
    assert b2.case.read()["phase"] == "investigating"
    await b2.test_suspect("s2")
    assert b2.case.read()["phase"] == "done"
    asks = [json.loads(line) for line in (b2.dir / "investigator" / "events.jsonl").read_text().splitlines()]
    assert any("ask the skeptic" in (e.get("text") or "") for e in asks)


def _tool_names(agent) -> dict:
    """The compiled agent's tools by name (its `tools` node)."""
    return agent.nodes["tools"].bound.tools_by_name


def test_a_flat_analyst_leaves_other_agents_on_its_model_their_subagents(batch):
    """The analyst has no `task` tool and no subagents (plan invariant 3), and that is its own: an investigator and a
    plain deep agent built afterwards on the same model, in the same process, keep theirs."""
    from deepagents import create_deep_agent
    from deepagents.backends import StateBackend

    from deep_research.agents import investigator as inv_mod
    from deep_research.agents.analyst import build_analyst

    model = "anthropic:claude-haiku-4-5"
    analyst = build_analyst(StateBackend(), model)
    assert "task" not in _tool_names(analyst)
    assert {"write_todos", "read_file"} <= set(_tool_names(analyst))

    task = _tool_names(inv_mod.build_investigator(batch, model))["task"].description
    for name in ("general-purpose", "step-tagger", "lens-omission", "lens-commission", "lens-data", "skeptic"):
        assert f"- {name}:" in task
    assert "Cannot record, run, approve or write anything" in task  # its own restricted general-purpose one

    plain = _tool_names(create_deep_agent(model=model, backend=StateBackend()))
    assert "task" in plain and "- general-purpose:" in plain["task"].description
    assert "task" not in _tool_names(build_analyst(StateBackend(), model))  # and the next analyst is flat again
