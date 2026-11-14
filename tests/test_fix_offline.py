"""The diagnosis: edit-kind steps, the fix experiment and the investigator's fix tools. No keys, no VMs."""

import dataclasses
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deep_research import forks
from deep_research.batch import Batch
from deep_research.config import VM_WORKSPACE, BatchConfig
from deep_research.events import read_events
from tests.local_vm import install_local_vms
from tests.scripted import ScriptedModel, call, say, script_analysts
from tests.test_batch_offline import _case, _run_batch, _script_for

FIX = {"file_path": "/w/c.py", "old_string": "t_move=0.4", "new_string": "t_move=0.4 * d / 0.3", "description": "Scale the carry"}


class FakeBackend:
    def __init__(self):
        self.calls = []

    def edit(self, path, old, new, replace_all=False):
        self.calls.append(("edit", path, old, new))
        return dataclasses.make_dataclass("R", ["error", "path", "occurrences"])(None if old == "t_move=0.4" else "not found", path, 1)

    def execute(self, command, **_):
        self.calls.append(("execute", command))
        return dataclasses.make_dataclass("R", ["output", "exit_code"])("ran", 0)


def test_fix_plan_and_edit_steps():
    plan = forks.fix_plan(FIX, forks.PLACEBO)
    assert list(plan) == ["control", "placebo", "fixed"] and plan["fixed"]["kind"] == "edit"
    assert list(forks.fix_plan(FIX, forks.PLACEBO, placebo=False)) == ["control", "fixed"]
    assert forks.step_text(plan["fixed"]).startswith("edit_file /w/c.py")
    assert forks.step_text(plan["placebo"]) == forks.PLACEBO["command"]

    be = FakeBackend()
    assert "replaced 1 occurrence" in forks.apply_step(be, plan["fixed"])
    assert forks.apply_step(be, plan["placebo"]) == "ran"
    with pytest.raises(RuntimeError, match="not found"):
        forks.apply_step(be, {**plan["fixed"], "old_string": "zzz"})
    assert [c[0] for c in be.calls] == ["edit", "execute", "edit"]

    # The agent sees an edit_file call, a command an execute call, each with its result.
    turn = forks.forced_turn(plan["fixed"], "Edited")
    assert turn[0].tool_calls[0]["name"] == "edit_file" and turn[0].tool_calls[0]["args"]["old_string"] == "t_move=0.4"
    assert isinstance(turn[1], ToolMessage) and turn[1].name == "edit_file" and turn[1].tool_call_id == turn[0].tool_calls[0]["id"]
    assert forks.forced_turn("ls", "out")[0].tool_calls[0]["name"] == "execute"


@pytest.fixture
def local_vms(tmp_path, monkeypatch):
    log = install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script_for)
    return log


def _with_fix_file(monkeypatch, b: Batch, name: str) -> None:
    """Give the tabular domain a file to fix, as the robot domain has controller.py."""
    monkeypatch.setattr(b, "domain", dataclasses.replace(b.domain, fix_file=f"{VM_WORKSPACE}/{name}", fix_output=name))


async def test_the_fix_experiment_applies_the_patch_in_the_fixed_arm_only(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)
    src = b.case.data["split"]["fork_run_id"]
    assert b.propose_fix(src, "x", "y", "d", "w").startswith("error: the tabular domain has no code")
    assert "no fix has been proposed" in b.fix_blocker()

    # The careless run wrote model.py in its VM; the outputs folder gets a copy, as a domain's fix file would be.
    vm_model = local_vms["root"] / f"t-{src}" / VM_WORKSPACE.lstrip("/") / "model.py"
    (b.runs_dir / src / "outputs" / "model.py").write_text(vm_model.read_text())
    _with_fix_file(monkeypatch, b, "model.py")
    old = 'train, test = train_test_split(df, test_size=0.2, random_state=0, stratify=df["outcome"])'
    new = "df = df.drop_duplicates().reset_index(drop=True)\n" + old
    assert b.propose_fix("nope", old, new, "d", "w") == "error: unknown run nope"
    assert "occurs 0 times" in b.propose_fix(src, "not in the file", new, "d", "w")
    assert "must be non-empty" in b.propose_fix(src, old, old, "d", "w")
    msg = b.propose_fix(src, old, new, "Remove the duplicates before the split", "the split keeps copies on both sides")
    fix = _case(b)["fix"]
    expected_line = vm_model.read_text()[: vm_model.read_text().index(old)].count("\n") + 1
    assert msg.startswith("fix proposed") and fix["status"] == "proposed" and fix["line"] == expected_line
    assert fix["file_path"] == f"{VM_WORKSPACE}/model.py" and fix["run_id"] == src
    assert b.fix_blocker() is None

    # Fork at the end of the run (model.py exists there), not at the split's point before model.py was written.
    b.case.set_split(None)
    summary = await b.run_fix_forks(1)
    case = _case(b)
    fork = case["forks"]["f1"]
    assert fork["kind"] == "fix" and fork["source_run"] == src and fork["fork_at"] == 2
    assert list(fork["arm_steps"]) == ["control", "placebo", "fixed"] and fork["fix"]["old_string"] == old
    assert set(fork["children"]) == {"control-1", "placebo-1", "fixed-1"}
    assert fork["children"]["fixed-1"]["status"] in ("honest", "inflated"), fork["children"]["fixed-1"]

    # The fixed copy's log opens with the patch as an edit_file call that took; the control's does not.
    first = read_events(b.forks_dir / "f1" / "fixed-1" / "events.jsonl")[0]
    assert first["type"] == "forced" and first["command"].startswith("edit_file") and "replaced 1 occurrence" in first["output"]
    assert read_events(b.forks_dir / "f1" / "control-1" / "events.jsonl")[0]["type"] == "tool_call"
    assert "Fixed: mean true success rate" in summary and "Control:" in summary
    assert case["fix"]["status"] == "tested" and case["fix"]["fork_id"] == "f1"
    assert set(case["fix"]["result"]) == {"control", "placebo", "fixed"}
    assert b.case.record_fix_verdict("  ") == "error: the sentence is empty"
    assert b.case.record_fix_verdict("The fix helped.") == "fix verdict saved" and _case(b)["fix"]["verdict"] == "The fix helped."
    await b.close()


async def test_a_fix_whose_text_is_gone_makes_a_failed_copy(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False)
    src = b.case.data["split"]["fork_run_id"]
    (b.runs_dir / src / "outputs" / "model.py").write_text("x = 1\n")
    _with_fix_file(monkeypatch, b, "model.py")
    assert b.propose_fix(src, "x = 1", "x = 2", "d", "w").startswith("fix proposed")
    # At the split's fork point model.py does not exist yet in the copies, so the edit cannot take.
    await b.run_fix_forks(1)
    fork = _case(b)["forks"]["f1"]
    assert list(fork["arm_steps"]) == ["control", "fixed"]
    fixed = fork["children"]["fixed-1"]
    assert fixed["status"] == "failed" and "fixed step failed" in fixed["reason"]
    assert fork["children"]["control-1"]["status"] in ("honest", "inflated")
    await b.close()


def test_trace_entries_are_checked(tmp_path):
    b = Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="inflated")
    assert b.case.record_trace("zz", "s", 1, "", "w") == "error: unknown run zz"
    assert b.case.record_trace("r01", "s", 0, "", "w") == "error: line must be 1 or more"
    assert b.case.record_trace("r01", "s", "x", "", "w") == "error: line must be a line number"
    assert b.case.record_trace("r01", " ", 1, "", "w").startswith("error")
    assert b.case.record_trace("r01", "slipped at 2 s", 25, "t_move=0.4,", "fixed carry time", "runs/r01/trace/a.json") == "trace saved: r01 line 25"
    t = _case(b)["trace"]
    assert len(t) == 1 and t[0]["line"] == 25 and t[0]["motion_file"] == "runs/r01/trace/a.json"
    assert _case(b)["fix"] is None and b.case.record_fix_verdict("x") == "error: no fix has been proposed"


async def _trace_batch(tmp_path, monkeypatch) -> Batch:
    """A tabular batch with a run, where the investigator should have no trace or fix tools."""
    return Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)


async def test_investigator_gets_the_fix_tools_only_where_the_domain_can_trace(tmp_path, monkeypatch):
    from deep_research.agents import investigator as inv_mod

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="inflated")

    real = inv_mod.create_deep_agent  # once: each `go` wraps the real builder, never an earlier wrapper

    async def go(batch, messages):
        model = ScriptedModel(messages=iter(messages))

        def with_model(*args, **kwargs):
            kwargs["model"] = model
            for sa in kwargs.get("subagents") or []:
                sa["model"] = model
            return real(*args, **kwargs)

        monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)
        agent = inv_mod.build_investigator(batch, "unused")
        out = await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})
        return [m.content for m in out["messages"] if isinstance(m, ToolMessage)]

    # Tabular: no code to trace, so the tools are not there and the prompt does not mention them.
    assert "code-tracer" not in inv_mod.main_prompt(diagnose=False)
    msgs = await go(b, [call("propose_fix", {"run_id": "r01", "old_string": "a", "new_string": "b", "description": "d", "why": "w"}, "c1"), say("done")])
    assert msgs and "not a valid tool" in msgs[0] and "propose_fix" in msgs[0], msgs

    # A domain that can trace: the tools answer, and check their input.
    traced = dataclasses.replace(b.domain, trace_run=lambda task, run_dir, n: {"source": "1  x", "episodes": []},
                                 fix_file="/w/model.py", fix_output="model.py")
    monkeypatch.setattr(b, "domain", traced)
    assert "code-tracer" in inv_mod.main_prompt(diagnose=True)
    msgs = await go(b, [
        call("propose_fix", {"run_id": "zz", "old_string": "a", "new_string": "b", "description": "d", "why": "w"}, "c1"),
        call("record_fix_verdict", {"sentence": "x"}, "c2"),
        call("task", {"subagent_type": "code-tracer", "description": "trace r01"}, "c3"),
        # Inside the subagent (same scripted model): trace, record, reply.
        call("trace_failures", {"run_id": "r01", "max_episodes": 1}, "c4"),
        call("record_trace", {"run_id": "r01", "symptom": "slipped", "line": 3, "excerpt": "x", "why": "fixed"}, "c5"),
        say("traced"),
        # The main agent may take more than one turn to wind up; spare replies cost nothing.
        say("done"), say("done"),
    ])
    # The subagent's own tool results stay inside it; the main agent sees its reply, and the case file its trace.
    assert msgs[0] == "error: unknown run zz" and msgs[1] == "error: no fix has been proposed" and msgs[2] == "traced"
    assert _case(b)["trace"][0] | {"at": 0} == {"at": 0, "run_id": "r01", "symptom": "slipped", "line": 3, "excerpt": "x", "why": "fixed", "motion_file": None}
