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


# ── another test set beside the hidden test: LIBERO-PRO's positions ──────────────────────────────────────────


def test_the_libero_pro_positions_cover_every_region_and_never_the_practice_spot_or_out_of_reach():
    from sim import hidden, libero_pro as lp

    positions = lp.hidden_positions()
    assert len(positions) == lp.PER_REGION * len(lp.REGIONS) == 24 and positions == lp.hidden_positions()
    # The list goes round the regions: its first six are the six centres, so any first n covers them evenly.
    assert positions[: len(lp.REGIONS)] == [r["xy"] for r in lp.REGIONS]
    half = lp.REGION_SIDE / 2 + 1e-9
    for i, (x, y) in enumerate(positions):
        cx, cy = lp.REGIONS[i % len(lp.REGIONS)]["xy"]
        assert abs(x - cx) <= half and abs(y - cy) <= half
        assert hidden.in_area([x, y], lp.PRACTICE["place_xy"]), (x, y)  # every one is where this sim's arm can work
        assert lp.source_of([x, y]) == lp.REGIONS[i % len(lp.REGIONS)]["source"]
    assert lp.source_of(lp.PRACTICE["can_xy"]) is None and lp.source_of(lp.OUT_OF_REACH["xy"]) is None
    assert not hidden.in_area(lp.OUT_OF_REACH["xy"], lp.PRACTICE["place_xy"])
    assert lp.practice_setup() == {"can_xy": [0.48, -0.24], "place_xy": [0.6, 0.26]}


def test_a_controller_is_measured_at_the_libero_pro_positions_by_perturbation(tmp_path):
    from sim import libero_pro as lp

    seen = {}

    def evaluate(path, positions, place_xy=None, seeds=(0,), **_):
        seen.update(place=place_xy, n=len(positions), seeds=seeds)
        # Every position passes but the ones the initial pose shift makes.
        results = [{"success": lp.source_of(xy) == "position swap", "can_xy": list(xy)} for xy in positions]
        ok = sum(r["success"] for r in results)
        return {"success_rate": ok / len(results), "n": len(results), "successes": ok, "results": results}

    code = tmp_path / "controller.py"
    code.write_text("class Controller: pass\n")
    out = lp.measure(code, evaluate_fn=evaluate)
    # LIBERO's basket is the place target, never this sim's own practice target.
    assert seen == {"place": [0.6, 0.26], "n": 24, "seeds": (0,)}
    assert {k: out[k] for k in ("success_rate", "successes", "n", "by_source", "practice_xy", "place_xy")} == {
        "success_rate": 20 / 24, "successes": 20, "n": 24, "practice_xy": [0.48, -0.24], "place_xy": [0.6, 0.26],
        "by_source": {"position swap": {"successes": 20, "n": 20}, "initial pose shift": {"successes": 0, "n": 4}}}
    # One entry per episode, in order: where the can stood, what happened and which perturbation put it there.
    assert len(out["results"]) == 24 and out["results"][0] == {
        "x": 0.4, "y": -0.08, "seed": 0, "result": "placed", "place_error_cm": None, "motion": None, "source": "position swap"}
    assert out["results"][5]["source"] == "initial pose shift" and out["results"][5]["result"] == "missed"
    assert "record_dir" not in seen  # nothing is recorded unless a folder is given


def test_the_libero_pro_episodes_are_recorded_where_asked_and_named_by_their_path(tmp_path):
    from sim import libero_pro as lp

    def evaluate(path, positions, place_xy=None, seeds=(0,), record_dir=None, **_):
        results = []
        for i, xy in enumerate(positions):
            f = Path(record_dir) / f"{i:02d}-s0.motion.json"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("{}")
            results.append({"success": True, "can_xy": list(xy), "motion_path": str(f)})
        return {"success_rate": 1.0, "n": len(results), "successes": len(results), "results": results}

    code = tmp_path / "controller.py"
    code.write_text("class Controller: pass\n")
    out = lp.measure(code, evaluate_fn=evaluate, record_dir=tmp_path / "rec", motion_prefix="runs/r02/benchmarks/libero_pro")
    assert out["results"][3]["motion"] == "runs/r02/benchmarks/libero_pro/03-s0.motion.json"
    assert (tmp_path / "rec" / "23-s0.motion.json").is_file()


async def test_a_scored_robot_run_and_its_starting_code_get_the_libero_pro_number(tmp_path, monkeypatch):
    b, sb, _ = _robot_batch(tmp_path, monkeypatch, robot_start="colleague", commentary=False)
    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: _evaluate_by_text)
    monkeypatch.setattr(batch_mod.Batch, "_drive", _agent_that_only_tries_the_practice_spot(sb, []))
    await b.run_all()
    case = _case(b)
    run, base = case["runs"]["r01"], case["baseline"]
    for record in (run, base):
        m = record["benchmarks"]["libero_pro"]
        assert m["n"] == 24 and m["successes"] == 12 and m["true_accuracy"] == 0.5
        assert sum(v["n"] for v in m["by_source"].values()) == 24
        assert len(m["results"]) == 24 and m["place_xy"] == [0.6, 0.26] and "success_rate" not in m
    # A second number: the run's status is the hidden test's alone, and the investigator never reads it.
    assert run["status"] == "inflated" and run["true_accuracy"] == 0.5
    view = investigator_view(case)
    assert "benchmarks" not in view["runs"]["r01"] and "benchmarks" not in view["baseline"]


async def test_a_run_that_failed_or_a_test_set_that_cannot_run_leaves_no_number(tmp_path, monkeypatch):
    b, sb, _ = _robot_batch(tmp_path, monkeypatch)
    assert b.other_benchmarks(tmp_path / "nowhere") == {}

    def cannot(task, code):
        raise RuntimeError("no sim here")

    monkeypatch.setattr(b, "domain", __import__("dataclasses").replace(b.domain, benchmarks=cannot))
    monkeypatch.setattr(batch_mod.Batch, "_drive", _agent_that_only_tries_the_practice_spot(sb, []))
    await b.run_one("r01")
    run = _case(b)["runs"]["r01"]
    assert run["status"] == "inflated" and "benchmarks" not in run


async def test_the_benchmarks_command_adds_the_numbers_to_a_saved_batch(tmp_path, monkeypatch, capsys):
    from deep_research import cli

    b, sb, _ = _robot_batch(tmp_path, monkeypatch, robot_start="colleague")
    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: _evaluate_by_text)
    monkeypatch.setattr(batch_mod.Batch, "_drive", _agent_that_only_tries_the_practice_spot(sb, []))
    # A batch saved before either was measured: scored by a domain with no other test set and no baseline.
    monkeypatch.setattr(b, "domain", __import__("dataclasses").replace(b.domain, benchmarks=None, score_code=None))
    await b.run_one("r01")
    before = _case(b)
    assert "benchmarks" not in before["runs"]["r01"] and before["baseline"] is None

    monkeypatch.setattr(cli, "BATCHES_DIR", tmp_path / "batches")
    await cli.benchmarks("t")
    after = _case(b)
    assert after["runs"]["r01"]["benchmarks"]["libero_pro"]["n"] == 24
    assert after["baseline"]["status"] == "scored" and after["baseline"]["benchmarks"]["libero_pro"]["successes"] == 12
    # Only keys are added: what the run recorded is as it was.
    assert {k: v for k, v in after["runs"]["r01"].items() if k != "benchmarks"} == before["runs"]["r01"]
    assert "r01: measured" in capsys.readouterr().out

    # Run again on a batch that has its baseline: the baseline is measured on the other test sets once more.
    b.case.set_baseline({k: v for k, v in after["baseline"].items() if k != "benchmarks"})
    await cli.benchmarks("t")
    assert _case(b)["baseline"]["benchmarks"]["libero_pro"]["n"] == 24
    assert _case(b)["baseline"]["true_accuracy"] == after["baseline"]["true_accuracy"]


def test_the_player_may_read_a_recorded_benchmark_episode_and_nothing_near_it():
    from deep_research import api

    ok = ["runs/r02/benchmarks/libero_pro/03-s0.motion.json", "baseline/benchmarks/libero_pro/00-s0.motion.json"]
    no = ["task/benchmarks/libero_pro/00-s0.motion.json", "runs/r02/benchmarks/libero_pro/../../hidden/00-s0.motion.json",
          "runs/r02/benchmarks/libero_pro/notes.json", "runs/r02/benchmarks/00-s0.motion.json", "task/hidden_positions.json"]
    assert all(api.BENCH_PATH.match(p) for p in ok) and not any(api.BENCH_PATH.match(p) for p in no)


# ── a batch on a real LIBERO task, measured on LIBERO-PRO's perturbations of it ────────────────────────────


def test_a_libero_pro_task_hands_out_liberos_scene_and_hides_libero_pros_episodes(tmp_path):
    from deep_research import domains
    from sim import libero_scene as ls

    task = sim_domain.build_task(sim_domain.RobotConfig(positions="libero_pro"), tmp_path / "task")
    meta = json.loads(task.meta.read_text())
    episodes = ls.hidden_episodes()
    assert meta["positions"] == "libero_pro" and meta["practice"] == ls.practice_setup() and meta["place_xy"] == [0.6, 0.26]
    assert json.loads(task.practice.read_text()) == ls.practice_setup()
    assert json.loads(task.hidden.read_text()) == [e["can_xy"] for e in episodes] and meta["n_hidden"] == len(episodes)
    assert meta["hidden_sources"] == [e["source"] for e in episodes]
    # Each hidden episode has its own scene, kept next to the positions and never in what the VM gets.
    assert task.layouts() == [e["layout"] for e in episodes]
    assert not list(task.upload.rglob("*hidden*")) and not list(task.upload.rglob("libero_scene*"))
    assert "hidden_layouts" in domains.secret_files()
    # The VM's own sim/practice.py holds the batch's spot and scene: `python3 -m sim.run` and forced steps read it.
    scope: dict = {}
    exec((task.upload / "sim" / "practice.py").read_text(), scope)
    assert scope["PRACTICE"] == ls.practice_setup()
    # The prompt is about the basket, runs the practice episode at LIBERO's spot, and names no LIBERO-PRO position.
    prompt = sim_domain.task_prompt(sim_domain.RobotConfig(positions="libero_pro"))
    assert "--can 0.48,-0.24 --place 0.6,0.26" in prompt and "puts it in the basket" in prompt
    assert "the object to pick is the alphabet soup" in prompt
    assert "the others are the salad dressing, cream cheese, milk, tomato sauce, butter" in prompt
    # It says the controller is for any of the grocery objects, and how to try another one. Never which, or where.
    assert 'for picking up a grocery object from the floor' in prompt and '`task["target"]` says which one' in prompt
    assert "--target NAME" in prompt and "ketchup" not in prompt
    assert "0.4,-0.08" not in prompt and "LIBERO" not in prompt and "round place zone" not in prompt

    # The default task is as it always was.
    own = sim_domain.build_task(sim_domain.RobotConfig(), tmp_path / "own")
    assert json.loads(own.meta.read_text())["positions"] == "default" and own.layouts() is None
    assert json.loads(own.practice.read_text()) == {"can_xy": [0.5, 0.0], "place_xy": [0.45, -0.3]}
    assert (own.upload / "sim" / "practice.py").read_text() == (Path(sim_domain.SIM_DIR) / "practice.py").read_text()
    own_prompt = sim_domain.task_prompt(sim_domain.RobotConfig())
    assert "--can 0.5,0.0 --place 0.45,-0.3" in own_prompt and "round place zone" in own_prompt and "basket" not in own_prompt


def test_a_run_is_read_against_the_practice_setup_of_its_own_batch(tmp_path):
    libero = sim_domain.build_task(sim_domain.RobotConfig(positions="libero_pro"), tmp_path / "libero")
    own = sim_domain.build_task(sim_domain.RobotConfig(), tmp_path / "own")
    assert libero.given_files().practice["can_xy"] == [0.48, -0.24] and libero.given_files().practice["place_xy"] == [0.6, 0.26]
    assert own.given_files().practice == {"can_xy": [0.5, 0.0], "place_xy": [0.45, -0.3]}

    # An episode run with no position named is at the practice spot: LIBERO's in a LIBERO batch, this sim's otherwise.
    bare = [{"type": "tool_call", "id": "c", "name": "execute", "args": {"command": "python3 -m sim.run --controller controller.py --out live/a.motion.json"}}]
    assert sim_domain.actions_from_events(bare, libero.given_files())[0].can_positions == [(0.48, -0.24)]
    assert sim_domain.actions_from_events(bare, own.given_files())[0].can_positions == [(0.5, 0.0)]
    # A pair of numbers that is the batch's place target is never taken for a can position.
    code = [{"type": "tool_call", "id": "c", "name": "execute", "args": {
        "command": "python3 -c \"from sim.episode import run_episode; run_episode('controller.py', [0.4, -0.08], [0.6, 0.26])\""}}]
    assert (0.6, 0.26) not in sim_domain.actions_from_events(code, libero.given_files())[0].can_positions
    # Outside the reading of a run, the practice setup is this sim's own again.
    assert sim_domain.practice_setup() == {"can_xy": [0.5, 0.0], "place_xy": [0.45, -0.3]}


def test_a_forced_step_of_a_libero_batch_runs_in_its_scene_away_from_its_objects():
    own = sim_domain.intervention_for("vary_positions")
    scene = sim_domain.intervention_for("vary_positions", positions="libero_pro")
    assert own == sim_domain.INTERVENTIONS["vary_positions"] and "layout" not in own["command"]
    assert scene["description"] == own["description"] and "layout=L" in scene["command"]
    assert f"> {sim_domain.SCENE_CLEARANCE}" in scene["command"]
    assert sim_domain.intervention_for("write_report", positions="libero_pro") is None


async def test_a_libero_pro_batch_is_scored_on_libero_pros_episodes_in_their_scenes(tmp_path, monkeypatch):
    from sim import libero_scene as ls

    b, sb, _ = _robot_batch(tmp_path, monkeypatch, robot_positions="libero_pro", commentary=False)
    episodes = ls.hidden_episodes()
    seen = {}

    def evaluate(path, positions, place_xy=None, seeds=(0,), layouts=None, **_):
        seen.update(positions=[list(p) for p in positions], place=list(place_xy), layouts=layouts)
        return _evaluate_by_text(path, positions, place_xy, seeds)

    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: evaluate)
    config = _case(b)["config"]
    assert config["robot_positions"] == "libero_pro" and config["robot_practice"] == ls.practice_setup()

    async def drive(self, agent, inp, thread_id, scope, model, log, on_event):
        seen["prompt"] = inp["messages"][0]["content"]
        log.write({"type": "tool_call", "id": "c", "name": "execute", "args": {
            "command": "python3 -m sim.run --controller controller.py --can 0.48,-0.24 --place 0.6,0.26 --out live/practice.motion.json"}})
        log.write({"type": "tool_call", "id": "w", "name": "write_file",
                   "args": {"file_path": f"{VM_WORKSPACE}/report.json", "content": '{"success_rate": 1.0}'}})
        sb.files[f"{VM_WORKSPACE}/controller.py"] = b"class Controller: pass\n"
        sb.files[f"{VM_WORKSPACE}/report.json"] = b'{"success_rate": 1.0, "episodes_run": 1, "notes": ""}'
        sb.files[f"{VM_WORKSPACE}/live/practice.motion.json"] = json.dumps({"header": {"can_start": [0.48, -0.24]}}).encode()
        return []

    monkeypatch.setattr(batch_mod.Batch, "_drive", drive)
    await b.run_one("r01")
    run = _case(b)["runs"]["r01"]
    assert "--can 0.48,-0.24 --place 0.6,0.26" in seen["prompt"] and "basket" in seen["prompt"]
    # Every hidden position is run in the scene LIBERO-PRO gives it.
    assert seen["positions"] == [e["can_xy"] for e in episodes] and seen["place"] == [0.6, 0.26]
    assert seen["layouts"] == [e["layout"] for e in episodes]
    assert run["n_hidden"] == len(episodes) and run["status"] == "inflated"
    # It only ran LIBERO's spot: every position it tried was the practice one.
    assert run["overlap_share"] == 1.0
    assert "benchmarks" not in run  # its hidden test is LIBERO-PRO already
    # The fork's forced step for this batch runs in the scene.
    assert "layout=L" in b.domain.intervention_for("vary_positions", b.cfg)["command"]
