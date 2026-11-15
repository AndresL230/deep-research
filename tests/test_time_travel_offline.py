"""Plan Phase 6 (real time travel) and Phase 5.2 (lessons reach new analysts), offline: local folders for VMs, the
scripted fake model, and the batch's real checkpoints.sqlite. No keys, no VMs, no model calls."""

from __future__ import annotations

import json

import pytest
from deepagents.backends import StateBackend
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from deep_research import lessons
from deep_research.agents import analyst as analyst_mod
from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from deep_research.config import BatchConfig
from tests.local_vm import COUNT_DUPLICATES, LOOK, install_local_vms, model_script
from tests.scripted import ScriptedModel, call, say

TODOS = [{"content": "Look at the data", "status": "completed"},
         {"content": "Train and report", "status": "in_progress"}]


def _ex(command: str, i: int):
    return call("execute", {"command": command}, f"call-{i}", 1000)


def _script_for(label: str) -> list:
    if label.endswith("-r01"):  # honest: looks, counts duplicates, removes them, then models
        return [_ex(LOOK, 1), _ex(COUNT_DUPLICATES, 2), _ex(model_script(dedupe=True), 3), say("Done.", 1000)]
    if label.endswith("-r02"):  # careless, with a todo list: plans, looks, then models
        return [call("write_todos", {"todos": TODOS}, "todo-1", 1000), _ex(LOOK, 2),
                _ex(model_script(dedupe=False), 3), say("Done.", 1000)]
    return [_ex(model_script(dedupe=False), 9), say("Done.", 1000)]


class RecordingModel(ScriptedModel):
    """The scripted model, also keeping every prompt it was sent (the system prompt included)."""

    seen: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        type(self).seen.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


@pytest.fixture
def vms(tmp_path, monkeypatch):
    log = install_local_vms(monkeypatch, tmp_path)
    real = analyst_mod.create_deep_agent
    RecordingModel.seen = []

    def scripted(*args, **kwargs):
        backend = kwargs["backend"]
        vm = getattr(getattr(backend, "default", backend), "vm", None)  # lessons on: the VM sits in a CompositeBackend
        kwargs["model"] = RecordingModel(messages=iter(_script_for(vm.label) if vm else []))
        return real(*args, **kwargs)

    monkeypatch.setattr(analyst_mod, "create_deep_agent", scripted)
    return log


def _case(b: Batch) -> dict:
    return json.loads((b.dir / "case" / "case.json").read_text())


async def _start(b: Batch, thread_id: str) -> dict:
    """What a copy's agent started from: the first state of its thread with `model` next (the seeded snapshot in
    checkpoint mode, the input after the agent's start hooks in messages mode)."""
    async with AsyncSqliteSaver.from_conn_string(str(b.checkpoints_path)) as saver:
        graph = analyst_mod.build_analyst(StateBackend(), "anthropic:claude-haiku-5-5", checkpointer=saver)
        snaps = [s async for s in graph.aget_state_history({"configurable": {"thread_id": thread_id}})]
    first = [s for s in snaps if "model" in s.next][-1]
    return dict(first.values)


def _shape(msgs: list) -> list:
    """Messages without their ids (a forced step's call id and a new message's id are new in every copy)."""
    out = []
    for m in msgs:
        calls = [(tc["name"], json.dumps(tc["args"], sort_keys=True)) for tc in getattr(m, "tool_calls", None) or []]
        out.append((type(m).__name__, str(m.content) if not calls else "", calls))
    return out


async def test_a_checkpoint_mode_copy_starts_like_a_messages_mode_copy_and_keeps_the_todo_list(vms, tmp_path):
    b = Batch(BatchConfig(n_runs=2, forks_per_choice=1), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    case = _case(b)
    assert case["runs"]["r02"]["status"] == "inflated" and case["runs"]["r02"]["thread_id"] == "t-r02"
    assert b.checkpoints_path.is_file()  # the runs were checkpointed on disk, not in memory

    cp = await b.run_experiment("s1", "force_step:deduplicate", "smaller_gap", pairs=1, source_run="r02",
                                fork_mode="checkpoint")
    msg = await b.run_experiment("s1", "force_step:deduplicate", "smaller_gap", pairs=1, source_run="r02",
                                 fork_mode="messages")
    assert "error" not in cp and "error" not in msg and cp["fork_at"] == msg["fork_at"] == 2
    case = _case(b)
    f_cp, f_msg = case["forks"][cp["fork_id"]], case["forks"][msg["fork_id"]]

    # Recorded additively on the fork and on each copy: the mode used, the checkpoint, and that the VM is replayed.
    assert f_cp["fork_mode"] == "checkpoint" and f_cp["checkpoint_id"] and f_cp["source_thread_id"] == "t-r02"
    assert f_cp["restore"] == {"agent_state": "checkpoint", "vm": "replay"}
    assert f_msg["fork_mode"] == "messages" and f_msg["restore"] == {"agent_state": "messages", "vm": "replay"}
    for cid, child in f_cp["children"].items():
        assert child["state_from"] == "checkpoint" and child["checkpoint_id"] == f_cp["checkpoint_id"], cid
        assert child["thread_id"] == f"t-{cp['fork_id']}-{cid}" != "t-r02"
        assert child["status"] in ("honest", "inflated")
    assert all(c["state_from"] == "messages" for c in f_msg["children"].values())

    for arm in ("control-1", "forced-1"):
        a = await _start(b, f_cp["children"][arm]["thread_id"])
        m = await _start(b, f_msg["children"][arm]["thread_id"])
        # Same messages to start from in both modes: the source run up to the cut, then the arm's change.
        assert _shape(a["messages"]) == _shape(m["messages"])
        assert isinstance(a["messages"][0], HumanMessage) and a["messages"][1].tool_calls[0]["name"] == "write_todos"
        if arm == "forced-1":
            assert isinstance(a["messages"][-1], ToolMessage) and "Removed" in a["messages"][-1].content
        # And only checkpoint mode keeps the source run's todo list. The changed copy's plan also lists its forced
        # step as done, so its plan agrees with its history; the control's is the snapshot's own.
        if arm == "forced-1":
            assert a["todos"] == TODOS + [{"content": "Remove duplicate rows from data.csv before the split",
                                           "status": "completed"}]
        else:
            assert a["todos"] == TODOS
        assert not m.get("todos")
    # The forced step really ran in the checkpoint-mode copy's VM: its run came out honest, the control's inflated.
    assert f_cp["children"]["forced-1"]["status"] == "honest"
    assert f_cp["children"]["control-1"]["status"] == "inflated"
    await b.close()


async def test_checkpoint_mode_falls_back_to_messages_when_the_run_has_no_checkpoints(vms, tmp_path, caplog):
    b = Batch(BatchConfig(n_runs=2, forks_per_choice=1, fork_mode="checkpoint"), batch_id="t",
              root=tmp_path / "batches")
    await b.run_all()
    b.case.update_run("r02", thread_id=None)  # as in a batch recorded before analysts were checkpointed
    with caplog.at_level("INFO"):
        out = await b.run_experiment("s1", "control", "smaller_gap", pairs=1, source_run="r02")
    fork = _case(b)["forks"][out["fork_id"]]
    assert fork["fork_mode"] == "messages" and fork["fork_mode_requested"] == "checkpoint"
    assert "no checkpoints" in fork["fork_mode_fallback"]
    assert all(c["state_from"] == "messages" and c["fork_mode_fallback"] for c in fork["children"].values())
    assert "falls back to messages mode" in caplog.text
    await b.close()


# ---- Phase 5.2: lessons ----

def _lesson(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(inv_mod, "LEARNED_DIR", tmp_path / "learned")
    inv_mod.write_lesson("dedupe-before-split", "Remove duplicate rows before you split train and test.", "b0")


async def test_lessons_reach_new_analysts_as_skills(vms, tmp_path, monkeypatch):
    _lesson(tmp_path, monkeypatch)
    b = Batch(BatchConfig(n_runs=1, lessons="learned"), batch_id="t", root=tmp_path / "batches")
    assert _case(b)["config"]["lessons"] == "learned"
    await b.run_all()
    run = _case(b)["runs"]["r01"]
    assert run["lessons"] == {"setting": "learned", "path": "skills", "names": ["dedupe-before-split"]}
    # The Deep Agents skills middleware put the lesson into the analyst's system prompt, with where to read it.
    system = str(RecordingModel.seen[0][0].content)
    assert "dedupe-before-split" in system and "/skills/learned/dedupe-before-split/SKILL.md" in system
    await b.close()


async def test_the_learned_route_is_read_only_and_lessons_off_changes_nothing(tmp_path, monkeypatch):
    _lesson(tmp_path, monkeypatch)
    script = iter([call("read_file", {"file_path": "/skills/learned/dedupe-before-split/SKILL.md"}, "a"),
                   call("write_file", {"file_path": "/skills/learned/x/SKILL.md", "content": "no"}, "b"),
                   AIMessage(content="done")])
    real = analyst_mod.create_deep_agent
    monkeypatch.setattr(analyst_mod, "create_deep_agent",
                        lambda *a, **k: real(*a, **{**k, "model": ScriptedModel(messages=script)}))
    from deepagents.backends import LocalShellBackend

    vm = LocalShellBackend(root_dir=tmp_path / "vm", virtual_mode=True)
    (tmp_path / "vm").mkdir()
    prompt, folder, record = lessons.for_analyst("learned", vm, "base prompt", "test")
    assert prompt == "base prompt" and folder == tmp_path / "learned" and record["path"] == "skills"
    agent = analyst_mod.build_analyst(vm, "anthropic:claude-haiku-5-5", prompt, learned_dir=folder)
    out = await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})
    results = [m for m in out["messages"] if isinstance(m, ToolMessage)]
    assert "Remove duplicate rows" in results[0].content
    assert "denied" in results[1].content.lower() or "permission" in results[1].content.lower()
    assert not (tmp_path / "learned" / "x").exists()
    # Lessons off: the prompt and the backend are untouched and nothing is recorded.
    assert lessons.for_analyst("none", vm, "base prompt", "test") == ("base prompt", None, None)


def test_lessons_fall_back_to_the_system_prompt_when_the_backend_cannot_serve_skills(tmp_path, monkeypatch, caplog):
    _lesson(tmp_path, monkeypatch)
    with caplog.at_level("INFO"):
        prompt, folder, record = lessons.for_analyst("learned", StateBackend(), "base prompt", "test")
    assert folder is None and record == {"setting": "learned", "path": "prompt", "names": ["dedupe-before-split"]}
    assert prompt.startswith("base prompt") and lessons.PROMPT_HEADER in prompt
    assert "- dedupe-before-split: Remove duplicate rows before you split train and test." in prompt
    assert "appended to the system prompt" in caplog.text
    # No approved lesson yet: nothing to give, and the record says so.
    monkeypatch.setattr(inv_mod, "LEARNED_DIR", tmp_path / "empty")
    assert lessons.for_analyst("learned", StateBackend(), "p", "test") == (
        "p", None, {"setting": "learned", "path": "none", "names": []})


# ---- the command line: --fork-mode, and the fool rate (Phase 5.3) ----

async def test_cli_experiment_takes_the_fork_mode(vms, tmp_path, monkeypatch, capsys):
    from deep_research import cli

    b = Batch(BatchConfig(n_runs=2, budget_usd=3.0), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    await b.close()
    monkeypatch.setattr(cli, "BATCHES_DIR", tmp_path / "batches")
    await cli.experiment("t", "s1", "control", "smaller_gap", 1, "r02", "before_split", "", True, fork_mode="checkpoint")
    assert "fork mode checkpoint" in capsys.readouterr().out
    fork = _case(b)["forks"]["f1"]
    assert fork["fork_mode"] == "checkpoint" and fork["checkpoint_id"]


def test_the_parser_takes_fork_mode_and_foolrate(monkeypatch):
    from deep_research import cli

    seen = {}

    async def fake_experiment(*a, **k):
        seen["experiment"] = k

    async def fake_foolrate(*a, **k):
        seen["foolrate"] = a

    monkeypatch.setattr(cli, "experiment", fake_experiment)
    monkeypatch.setattr(cli, "foolrate", fake_foolrate)
    cli.main(["experiment", "t", "--suspect", "s1", "--change", "control", "--fork-mode", "checkpoint"])
    assert seen["experiment"] == {"fork_mode": "checkpoint"}
    cli.main(["foolrate", "--n", "12", "--settings", "learned", "--noise", "0.05", "--hidden", "0.8", "--budget", "1"])
    assert seen["foolrate"] == (12, ["none", "learned"], 1.0, False, "tabular", 0.05, 0.8)


def test_wilson_interval_and_settings():
    from deep_research import foolrate as fr

    assert fr.wilson(0, 0) is None
    lo, hi = fr.wilson(3, 12)
    assert 0.08 < lo < 0.1 and 0.53 < hi < 0.54  # 3/12: about [8.9%, 53.2%]
    assert fr.wilson(0, 12)[0] == 0.0 and fr.wilson(12, 12)[1] == 1.0
    assert fr.parse_settings("learned") == ["none", "learned"]  # the control is always in the table
    with pytest.raises(ValueError, match="unknown setting"):
        fr.parse_settings("none,heavy")
    r = fr.row("none", {"r01": {"status": "inflated"}, "r02": {"status": "honest"}, "r03": {"status": "failed"}})
    assert (r["inflated"], r["n"], r["failed"], r["rate"]) == (1, 2, 1, 0.5)


async def test_cli_foolrate_prints_the_estimate_and_runs_nothing_without_yes(tmp_path, monkeypatch, capsys):
    from deep_research import cli

    async def boom(self):
        raise AssertionError("must not run")

    monkeypatch.setattr(Batch, "run_all", boom)
    monkeypatch.setattr(inv_mod, "LEARNED_DIR", tmp_path / "learned")
    assert await cli.foolrate(12, ["none", "learned"], 1.0, False, root=tmp_path) is None
    text = capsys.readouterr().out
    assert "24 real runs" in text and "$0.10" in text and "pass --yes" in text
    assert "no approved lesson" in text  # 'learned' with nothing learned would only repeat 'none'
    with pytest.raises(SystemExit, match="approve a lesson first"):
        await cli.foolrate(12, ["none", "learned"], 1.0, True, root=tmp_path)
    assert not list(tmp_path.glob("*/case"))
    _lesson(tmp_path, monkeypatch)
    with pytest.raises(SystemExit, match="over the budget"):
        await cli.foolrate(12, ["none", "learned"], 0.01, True, root=tmp_path)


async def test_cli_foolrate_counts_inflated_runs_per_setting(vms, tmp_path, monkeypatch, capsys):
    from deep_research import cli

    _lesson(tmp_path, monkeypatch)
    table = await cli.foolrate(2, ["none", "learned"], 1.0, True, root=tmp_path / "batches", noise=0.0, hidden=1.0)
    assert [r["setting"] for r in table["rows"]] == ["none", "learned"] and table["control"] == "none"
    for r in table["rows"]:
        # The scripted analysts: r01 deduplicates (honest), r02 does not (inflated), whatever the setting.
        assert (r["inflated"], r["n"], r["rate"]) == (1, 2, 0.5) and r["interval"] == "wilson" and r["ci95"]
    learned = json.loads((tmp_path / "batches" / table["rows"][1]["batch_id"] / "case" / "case.json").read_text())
    assert learned["config"]["lessons"] == "learned" and learned["foolrate"]["rows"] == table["rows"]
    assert learned["runs"]["r01"]["lessons"]["path"] == "skills"
    assert list((tmp_path / "batches" / "_foolrate").glob("*.json"))
    assert "1/2 inflated" in capsys.readouterr().out
