"""Code scored by itself, with no agent: the controller a batch starts from (its baseline) and a proposed fix
measured on the patched file. No keys, no VMs, no sim: a stand-in evaluation reads the file it is given."""

import json
import shutil
from pathlib import Path

from langchain_core.messages import HumanMessage, ToolMessage

from deep_research import batch as batch_mod
from deep_research.case_file import investigator_view
from deep_research.config import VM_WORKSPACE
from sim import domain as sim_domain
from tests.scripted import ScriptedModel, call, say
from tests.test_batch_offline import _case, _run_batch, _script_for
from tests.test_fix_offline import _with_fix_file
from tests.test_robot_domain import _agent_that_only_tries_the_practice_spot, _robot_batch

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "robot-demo-batch"
POSITIONS = [[0.4, 0.1], [0.5, 0.2], [0.6, -0.1], [0.45, 0.0]]


def _evaluate_by_text(path, positions, place_xy=None, seeds=(0,), **_):
    """A stand-in for sim.evaluate.evaluate: a controller with "x = 1" in it places the can everywhere, one that
    says "boom" raises everywhere, and any other places it at the first half of the positions."""
    text = Path(path).read_text()
    results = []
    for i, xy in enumerate(positions):
        ok = "boom" not in text and ("x = 1" in text or i < len(positions) // 2)
        results.append({"success": ok, "can_xy": list(xy), "seed": seeds[0], "place_error_cm": 1.0 if ok else 9.0,
                        "exception": "NameError: name 'boom' is not defined\n  line 3" if "boom" in text else None})
    n = len(results)
    return {"success_rate": sum(r["success"] for r in results) / n, "n": n,
            "successes": sum(r["success"] for r in results), "results": results}


def test_a_controller_is_scored_on_the_hidden_positions_with_its_counts_and_errors(tmp_path):
    task = sim_domain.RobotTaskFiles.in_dir(FIXTURE / "task")
    n = len(json.loads(task.hidden.read_text()))
    half = tmp_path / "half.py"
    half.write_text("class Controller: pass\n")
    out = sim_domain.score_controller(task, half, evaluate_fn=_evaluate_by_text)
    assert out["n"] == out["n_hidden"] == n and out["successes"] == n // 2 and out["success_rate"] == (n // 2) / n
    assert out["passed"] == [i < n // 2 for i in range(n)] and out["exceptions"] == []
    assert [r["result"] for r in out["hidden_results"]] == ["placed" if p else "missed" for p in out["passed"]]

    broken = tmp_path / "broken.py"
    broken.write_text("boom\n")
    out = sim_domain.score_controller(task, broken, evaluate_fn=_evaluate_by_text)
    # One line per distinct error, however many episodes raised it.
    assert out["success_rate"] == 0 and out["exceptions"] == ["NameError: name 'boom' is not defined"]


async def test_a_batch_that_hands_out_a_controller_scores_it_as_handed_over(tmp_path, monkeypatch):
    b, _, _ = _robot_batch(tmp_path, monkeypatch, robot_start="colleague")
    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: _evaluate_by_text)
    assert _case(b)["baseline"] is None
    await b.score_baseline()
    base = _case(b)["baseline"]
    n = len(json.loads((b.dir / "task" / "hidden_positions.json").read_text()))
    assert base["status"] == "scored" and base["name"] == "controller.py"
    assert base["true_accuracy"] == round((n // 2) / n, 4) and base["successes"] == n // 2 and base["n"] == n
    assert len(base["hidden_results"]) == n
    # The investigator reads the rate, never where the starting code fails.
    view = investigator_view(_case(b))["baseline"]
    assert view["true_accuracy"] == base["true_accuracy"] and "hidden_results" not in view


async def test_a_batch_that_starts_from_the_template_has_no_baseline(tmp_path, monkeypatch):
    b, _, _ = _robot_batch(tmp_path, monkeypatch)
    await b.score_baseline()
    assert _case(b)["baseline"] is None


async def test_a_baseline_that_cannot_be_scored_is_recorded_and_the_runs_go_on(tmp_path, monkeypatch):
    b, sb, _ = _robot_batch(tmp_path, monkeypatch, robot_start="colleague", commentary=False)

    def cannot(*a, **k):
        raise RuntimeError("no sim here")

    monkeypatch.setattr(b, "domain", __import__("dataclasses").replace(b.domain, score_code=cannot))
    monkeypatch.setattr(batch_mod.Batch, "_drive", _agent_that_only_tries_the_practice_spot(sb, []))
    await b.run_all()
    case = _case(b)
    assert case["baseline"]["status"] == "failed" and "no sim here" in case["baseline"]["reason"]
    assert case["runs"]["r01"]["status"] == "inflated"


async def _robot_run_with_a_fix(tmp_path, monkeypatch, new_string: str):
    b, sb, _ = _robot_batch(tmp_path, monkeypatch)
    monkeypatch.setattr(batch_mod.Batch, "_drive", _agent_that_only_tries_the_practice_spot(sb, []))
    await b.run_one("r01")
    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: _evaluate_by_text)
    assert b.propose_fix("r01", "pass", new_string, "Set x", "x was never set").startswith("fix proposed")
    return b


async def test_a_fix_is_measured_on_the_patched_file_with_no_fork(tmp_path, monkeypatch):
    b = await _robot_run_with_a_fix(tmp_path, monkeypatch, "x = 1")
    n = len(json.loads((b.dir / "task" / "hidden_positions.json").read_text()))
    said = await b.measure_fix()
    case = _case(b)
    fix, m = case["fix"], case["fix"]["measured"]
    assert fix["status"] == "tested" and "fork_id" not in fix and case["forks"] == {}
    assert m["before"] == {"true_accuracy": round((n // 2) / n, 4), "successes": n // 2, "n": n}
    assert m["after"] == {"true_accuracy": 1.0, "successes": n, "n": n}
    assert m["gained"] == n - n // 2 and m["lost"] == 0 and m["exceptions"] == [] and len(m["hidden_results"]) == n
    # The patched file is kept, and the run's own file is left as the run wrote it.
    assert fix["patched_file"] == "fix/controller.py" and "x = 1" in (b.dir / "fix" / "controller.py").read_text()
    assert "x = 1" not in (b.runs_dir / "r01" / "outputs" / "controller.py").read_text()
    assert said.startswith("The fix was measured on run r01's controller.py")
    assert f"({n // 2} of {n}) without the patch and 100% ({n} of {n}) with it" in said
    assert f"{n - n // 2} setups that failed now succeed and 0 that succeeded now fail" in said
    assert "hidden_results" not in investigator_view(case)["fix"]["measured"]


async def test_a_fix_that_breaks_the_code_says_what_it_raised(tmp_path, monkeypatch):
    b = await _robot_run_with_a_fix(tmp_path, monkeypatch, "boom")
    said = await b.measure_fix()
    m = _case(b)["fix"]["measured"]
    assert m["after"]["true_accuracy"] == 0 and m["gained"] == 0 and m["lost"] == m["before"]["successes"]
    assert m["exceptions"] == ["NameError: name 'boom' is not defined"]
    assert "The patched code raised: NameError: name 'boom' is not defined" in said


async def test_measuring_needs_a_fix_and_a_domain_that_scores_code(tmp_path, monkeypatch):
    b, _, _ = _robot_batch(tmp_path, monkeypatch)
    assert (await b.measure_fix()).startswith("error: no fix has been proposed")
    b.case.set_fix({"run_id": "r09", "old_string": "a", "new_string": "b"})
    assert await b.measure_fix() == "error: r09 has no controller.py in its outputs"
    monkeypatch.setattr(b, "domain", __import__("dataclasses").replace(b.domain, score_code=None))
    assert "cannot score code without a run" in await b.measure_fix()


async def test_the_robot_investigator_tests_a_fix_without_asking_for_approval(tmp_path, monkeypatch):
    from deep_research.agents import investigator as inv_mod

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = await _robot_run_with_a_fix(tmp_path, monkeypatch, "x = 1")
    b.case.set_fix(None)
    assert "needs no approval" in inv_mod.main_prompt(diagnose=True, direct_fix=True)
    forked = "one arm with the patch applied"
    assert forked in inv_mod.main_prompt(diagnose=True) and forked not in inv_mod.main_prompt(diagnose=True, direct_fix=True)

    model = ScriptedModel(messages=iter([
        call("propose_fix", {"run_id": "r01", "old_string": "pass", "new_string": "x = 1", "description": "d", "why": "w"}, "c1"),
        call("request_fix_test", {}, "c2"),
        call("record_fix_verdict", {"sentence": "The fix helped."}, "c3"),
        say("done"), say("done"),
    ]))
    real = inv_mod.create_deep_agent

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        kwargs["middleware"] = []  # no grader: it would ask the scripted model for a rubric check
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)
    agent = inv_mod.build_investigator(b, "unused")
    out = await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})
    said = [m.content for m in out["messages"] if isinstance(m, ToolMessage)]
    # No pause for approval: the test's result came straight back, and the verdict after it.
    assert said[0].startswith("fix proposed") and said[1].startswith("The fix was measured") and said[2] == "fix verdict saved"
    assert _case(b)["fix"]["status"] == "tested" and _case(b)["forks"] == {}


async def test_a_fork_copy_that_undoes_the_fix_is_not_a_result_of_the_fixed_arm(tmp_path, monkeypatch):
    """Where a domain cannot score code by itself the fix still runs as a fork experiment. A copy's agent may then
    rewrite the patched file: scored, it would be a second control and the fix would look useless."""
    from tests.local_vm import install_local_vms
    from tests.scripted import script_analysts

    log = install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script_for)
    b = await _run_batch(tmp_path, placebo_arm=False)
    src = b.case.data["split"]["fork_run_id"]
    vm_model = log["root"] / f"t-{src}" / VM_WORKSPACE.lstrip("/") / "model.py"
    (b.runs_dir / src / "outputs" / "model.py").write_text(vm_model.read_text())
    _with_fix_file(monkeypatch, b, "model.py")
    old = 'train, test = train_test_split(df, test_size=0.2, random_state=0, stratify=df["outcome"])'
    assert b.propose_fix(src, old, "df = df.drop_duplicates().reset_index(drop=True)\n" + old, "d", "w").startswith("fix proposed")

    plain = batch_mod.vms.download_outputs

    def with_the_fix_file(sb, dest, **kw):
        plain(sb, dest, **kw)
        if (sb.workspace / "model.py").exists():
            shutil.copy(sb.workspace / "model.py", dest / "model.py")

    monkeypatch.setattr(batch_mod.vms, "download_outputs", with_the_fix_file)
    b.case.set_split(None)  # fork at the end of the run, where model.py exists
    await b.run_fix_forks(1)
    children = _case(b)["forks"]["f1"]["children"]
    # The scripted copy writes model.py again from scratch, without the patch.
    assert children["fixed-1"]["status"] == "failed" and "undid the fix" in children["fixed-1"]["reason"]
    assert children["control-1"]["status"] in ("honest", "inflated")
    await b.close()
