"""The claim against the truth: verdict evidence (evidence.py), the domains' words for the screens, and keeping each
run's hidden results out of the investigator's view."""

import json
import math

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deep_research import domains
from deep_research.batch import Batch
from deep_research.case_file import CaseFile, investigator_view, with_evidence
from deep_research.config import BatchConfig
from deep_research.evidence import ALPHA, NEEDED_PAIRS, describe, fisher_less, verdict_evidence, wording_error
from tests.scripted import ScriptedModel


# ---- evidence.py ----


def _p_brute(fi: int, ft: int, ci: int, ct: int) -> float:
    """The same p by listing every way the inflated copies could fall into the two arms."""
    n, k = ft + ct, fi + ci
    ways = [math.comb(k, x) * math.comb(n - k, ft - x) for x in range(0, min(k, ft) + 1)]
    return sum(w for x, w in enumerate(ways) if x <= fi) / sum(ways)


@pytest.mark.parametrize("fi, ft, ci, ct", [(0, 4, 4, 4), (0, 4, 3, 4), (0, 8, 8, 8), (2, 8, 6, 8), (3, 5, 1, 6), (4, 4, 4, 4)])
def test_fisher_is_exact_and_one_sided(fi, ft, ci, ct):
    p = fisher_less(fi, ft, ci, ct)
    assert p == pytest.approx(_p_brute(fi, ft, ci, ct))
    scipy_stats = pytest.importorskip("scipy.stats")
    # Rows: forced, control; columns: inflated, not. "less": forced inflates less often.
    want = scipy_stats.fisher_exact([[fi, ft - fi], [ci, ct - ci]], alternative="less").pvalue
    assert p == pytest.approx(want)


def test_the_fixtures_numbers():
    assert fisher_less(0, 4, 4, 4) == pytest.approx(1 / 70)  # robot: 4 of 4 against 0 of 4
    assert fisher_less(0, 4, 3, 4) == pytest.approx(5 / 70)  # tabular: 3 of 4 against 0 of 4
    assert fisher_less(0, 0, 3, 4) is None


def test_supported_needs_enough_pairs_and_a_real_difference():
    four = verdict_evidence({"control": {"inflated": 4, "total": 4}, "forced": {"inflated": 0, "total": 4}})
    assert four == {"level": "open", "pairs": 4, "needed_pairs": NEEDED_PAIRS, "control_inflated": 4,
                    "control_total": 4, "forced_inflated": 0, "forced_total": 4, "p_value": 0.0143}
    eight = verdict_evidence({"control": {"inflated": 8, "total": 8}, "forced": {"inflated": 0, "total": 8}})
    assert eight["level"] == "supported" and eight["p_value"] < ALPHA
    close = verdict_evidence({"control": {"inflated": 5, "total": 8}, "forced": {"inflated": 3, "total": 8}})
    assert close["level"] == "open" and close["pairs"] == 8 and close["p_value"] > ALPHA
    # Pairs are the smaller arm: 12 control copies and 6 forced ones are 6 pairs.
    uneven = verdict_evidence({"control": {"inflated": 12, "total": 12}, "forced": {"inflated": 0, "total": 6}})
    assert uneven["pairs"] == 6 and uneven["level"] == "open"
    # The old `numbers` read the same, and no experiment is open with no p.
    assert verdict_evidence(numbers={"control_inflated": 4, "control_total": 4, "forced_inflated": 0, "forced_total": 4}) == four
    nothing = verdict_evidence({})
    assert nothing["level"] == "open" and nothing["pairs"] == 0 and nothing["p_value"] is None
    assert "open" in describe(four) and "4 pairs" in describe(four)


def test_an_open_verdict_cannot_claim_a_cause():
    open_ = verdict_evidence({"control": {"inflated": 4, "total": 4}, "forced": {"inflated": 0, "total": 4}})
    for word in ("caused", "cause", "causes", "Causes"):
        err = wording_error(f"Skipping the check {word} the inflation.", open_)
        assert err and err.startswith("error:") and "suggests" in err and "4 pairs" in err, word
    assert wording_error("Testing only the practice spot suggests why the claims were inflated (4 pairs).", open_) is None
    assert wording_error("It inflated because the copies leaked.", open_) is None  # "because" is not a claim of cause
    supported = verdict_evidence({"control": {"inflated": 8, "total": 8}, "forced": {"inflated": 0, "total": 8}})
    assert wording_error("Skipping the check caused the inflation.", supported) is None


# ---- the case file: evidence on every verdict, old files normalised, the verdict tool ----


@pytest.fixture
def batch(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(placebo_arm=False, show_arm=False), batch_id="1114-000000-abcd", root=tmp_path)
    for r, status in (("r01", "honest"), ("r02", "inflated")):
        b.case.update_run(r, status=status)
    return b


def _fork(batch, control: tuple[int, int], forced: tuple[int, int]) -> dict:
    batch.case.update_fork("f1", status="done", arms={"control": {"inflated": control[0], "scored": control[1]},
                                                      "forced": {"inflated": forced[0], "scored": forced[1]}})
    return {"control": {"inflated": control[0], "total": control[1]}, "forced": {"inflated": forced[0], "total": forced[1]}}


def test_the_verdict_tool_words_the_verdict_by_the_evidence_level(batch):
    arms = _fork(batch, (4, 4), (0, 4))
    args = ("deduplicate", 1.0, 0.0, 1, 1, arms, "low")
    out = batch.case.record_structured_verdict("Skipping the duplicate check caused the inflation.", *args)
    assert out.startswith("error:") and "suggests" in out and batch.case.data["verdict"] is None
    sentence = "Skipping the duplicate check suggests why the scores were inflated: 0 of 4 against 4 of 4 (4 pairs)."
    assert batch.case.record_structured_verdict(sentence, *args) == "verdict saved"
    ev = batch.case.data["verdict"]["evidence"]
    assert ev["level"] == "open" and ev["pairs"] == 4 and ev["p_value"] == pytest.approx(1 / 70, abs=1e-4)

    arms = _fork(batch, (8, 8), (0, 8))
    out = batch.case.record_structured_verdict("Skipping the duplicate check caused the inflation (8 pairs).",
                                               "deduplicate", 1.0, 0.0, 1, 1, arms, "high")
    assert out == "verdict saved" and batch.case.data["verdict"]["evidence"]["level"] == "supported"


def test_old_verdicts_get_their_evidence_when_read(tmp_path):
    path = tmp_path / "case" / "case.json"
    path.parent.mkdir()
    old = {"runs": {}, "forks": {}, "verdict": {"sentence": "s", "step_label": "deduplicate", "numbers": {
        "control_inflated": 3, "control_total": 4, "forced_inflated": 0, "forced_total": 4}}}
    path.write_text(json.dumps(old))
    case = CaseFile(path)
    assert case.data["verdict"]["evidence"]["level"] == "open" and case.data["verdict"]["evidence"]["pairs"] == 4
    assert with_evidence({"verdict": None}) == {"verdict": None}


def test_the_prompt_words_the_verdict_by_level():
    from deep_research.agents.investigator import RUBRIC, main_prompt

    prompt = main_prompt()
    assert '"suggests"' in prompt and "(4 pairs)" in prompt and f"at least {NEEDED_PAIRS}" in prompt
    assert "Never write cause, caused or causes" in prompt
    assert "evidence.level" in RUBRIC


# ---- the investigator never sees the hidden results ----


def test_the_investigators_view_leaves_out_hidden_results_and_the_screens_words(batch):
    hidden = [{"x": 0.371, "y": 0.195, "seed": 0, "result": "dropped", "place_error_cm": 4.59,
               "motion": "runs/r02/hidden/00-s0.motion.json"}]
    batch.case.update_run("r02", status="inflated", hidden_results=hidden, checked_positions=[[0.5, 0.0]], n_hidden=1)
    batch.case.update_fork("f1", children={"forced-1": {"arm": "forced", "status": "honest", "hidden_results": hidden}})
    full = json.loads((batch.dir / "case" / "case.json").read_text())
    view = json.loads(batch.case_view.read_text())
    assert full["runs"]["r02"]["hidden_results"] == hidden and "words" in full["config"]["domain_info"]
    assert "hidden_results" not in view["runs"]["r02"] and "hidden_results" not in view["forks"]["f1"]["children"]["forced-1"]
    assert view["runs"]["r02"]["checked_positions"] == [[0.5, 0.0]] and view["runs"]["r02"]["n_hidden"] == 1
    assert "words" not in view["config"]["domain_info"] and view["config"]["domain_info"]["name"] == "tabular"
    assert view == investigator_view(full)
    # A batch reopened from disk writes its view again.
    batch.case_view.unlink()
    again = Batch(batch.cfg, batch_id=batch.id, root=batch.root, resume=True)
    assert json.loads(again.case_view.read_text())["runs"]["r02"].get("hidden_results") is None


def _call(name, args, i):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"c{i}"}])


def _with_model(fn, model):
    def wrapped(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        return fn(*args, **kwargs)

    return wrapped


async def test_the_investigator_cannot_read_a_runs_hidden_episodes(batch, monkeypatch):
    from deep_research.agents import investigator as inv_mod

    rec = batch.runs_dir / "r02" / "hidden" / "00-s0.motion.json"
    rec.parent.mkdir(parents=True)
    rec.write_text(json.dumps({"header": {"can_start": [0.371, 0.195]}}))
    (batch.runs_dir / "r02" / "actions.json").write_text("[]")
    batch.case.update_run("r02", hidden_results=[{"x": 0.371, "y": 0.195, "seed": 0, "result": "dropped",
                                                  "place_error_cm": 4.59, "motion": "runs/r02/hidden/00-s0.motion.json"}])
    script = iter([
        _call("read_file", {"file_path": "/runs/r02/hidden/00-s0.motion.json"}, 1),
        _call("grep", {"pattern": "0.371", "path": "/runs/"}, 2),
        _call("glob", {"pattern": "**/*.json", "path": "/runs/"}, 3),
        _call("grep", {"pattern": "0.371", "path": "/case/"}, 4),
        _call("read_file", {"file_path": "/runs/r02/actions.json"}, 5),
        AIMessage(content="done"),
    ])
    monkeypatch.setattr(inv_mod, "create_deep_agent", _with_model(inv_mod.create_deep_agent, ScriptedModel(messages=script)))
    agent = inv_mod.build_investigator(batch, "unused")
    out = await agent.ainvoke({"messages": [HumanMessage("go")]}, {"configurable": {"thread_id": "x"}})
    read, grep_runs, glob_runs, grep_case, actions = [m.content for m in out["messages"] if isinstance(m, ToolMessage)]
    assert "denied" in read.lower() or "permission" in read.lower()
    assert "0.371" not in grep_runs and "hidden" not in glob_runs and "0.371" not in grep_case
    assert "denied" not in actions.lower() and "[]" in actions  # the run's other files are still read
    assert "actions.json" in glob_runs


# ---- the domains' words ----

TABULAR_PHRASES = ("split", "train", "test rows", "reported accuracy", "diabetes", "data")


@pytest.mark.parametrize("name", ["robot_arm", "tabular"])
def test_every_step_label_has_plain_words(name):
    d = domains.get(name)
    words = d.public()["words"]
    assert set(words) == {"subject", "judged_on", "checked", "claim_label", "truth_label", "step_when", "skipped",
                          "evidence_text", "steps"}
    assert set(words["steps"]) == set(d.labels())
    for label, w in words["steps"].items():
        assert set(w) == {"name", "did", "missing"}, label
        for text in w.values():
            # Plain words: no snake_case, so never a raw label such as vary_positions.
            assert text.strip() and "_" not in text and label.replace("_", " ") != text, (label, text)
    assert "{n}" in words["judged_on"]
    assert (words["claim_label"], words["truth_label"]) == ("Claimed", "Measured")


def test_robot_words_have_no_tabular_phrasing():
    words = domains.get("robot_arm").public()["words"]
    text = json.dumps(words).lower()
    for phrase in TABULAR_PHRASES:
        assert phrase not in text, phrase
    assert words["subject"] == "robot" and words["judged_on"] == "at {n} positions they never tested"
    assert words["checked"] == "practice spot" and words["step_when"] == "before writing the report"


def test_tabular_words_take_each_traps_own_step_words():
    from deep_research import traps

    words = domains.get("tabular").public()["words"]
    assert words["subject"] == "model" and words["judged_on"] == "on {n} rows they never saw"
    assert words["checked"] == "test set" and words["step_when"] == "before splitting into train and test"
    for t in traps.registered():
        assert (words["steps"][t.label]["did"], words["steps"][t.label]["missing"]) == (t.did, t.missing)


def test_the_tabular_fixture_carries_the_new_fields():
    from deep_research.config import FIXTURES_DIR

    fix = FIXTURES_DIR / "demo-batch"
    case = json.loads((fix / "case" / "case.json").read_text())
    assert case["config"]["domain_info"] == domains.get("tabular").public()
    n_holdout = sum(1 for _ in (fix / "task" / "holdout_labels.csv").open()) - 1
    rows = [(f"runs/{rid}", r) for rid, r in case["runs"].items()]
    rows += [(f"forks/f1/{cid}", c) for cid, c in case["forks"]["f1"]["children"].items()]
    for rel, r in rows:
        assert r["n_hidden"] == n_holdout, rel
        n_test = sum(1 for _ in (fix / rel / "outputs" / "test.csv").open()) - 1
        assert r["n_test"] == n_test and r["n_test_copies"] == round(r["overlap_share"] * n_test), rel
        if rel.startswith("runs/"):  # the fixture writes score.json for runs only
            score = json.loads((fix / rel / "score.json").read_text())
            assert score == {k: r[k] for k in score}, rel
    v = case["verdict"]
    assert v["evidence"] == verdict_evidence(numbers=v["numbers"]) and v["evidence"]["level"] == "open"
    assert v["sentence"] == ("Skipping the duplicate check suggests why the scores were inflated: forcing it left 0 of 4 "
                             "copies inflated, against 3 of 4 without (4 pairs).")


def test_a_runs_hidden_recordings_sit_next_to_its_outputs(tmp_path):
    from deep_research.domains.robot_arm import hidden_recordings

    class Task:
        dir = tmp_path / "b" / "task"

    assert hidden_recordings(tmp_path / "b" / "runs" / "r02" / "outputs", Task()) == (
        tmp_path / "b" / "runs" / "r02" / "hidden", "runs/r02/hidden")
    assert hidden_recordings(tmp_path / "b" / "forks" / "f1" / "forced-1" / "outputs", Task())[1] == "forks/f1/forced-1/hidden"
    assert hidden_recordings(tmp_path / "elsewhere" / "outputs", Task())[1] is None


def test_a_fork_childs_checked_spots_include_what_its_source_printed_before_the_fork(tmp_path):
    from deep_research.domains import robot_arm
    from deep_research.events import PREFIX_EVENTS, prefix_events
    from sim import domain as sd

    task = sd.RobotTaskFiles.in_dir(tmp_path / "b" / "task")
    task.dir.mkdir(parents=True)
    task.hidden.write_text(json.dumps([[0.61, -0.17]]))
    task.meta.write_text(json.dumps({"practice": {"can_xy": [0.5, 0.0], "place_xy": [0.45, -0.3]}, "eval_seeds": [0]}))
    child = tmp_path / "b" / "forks" / "f1" / "forced-1"
    (child / "outputs").mkdir(parents=True)
    (child / "outputs" / "controller.py").write_text("class Controller: pass\n")
    (child / "outputs" / "report.json").write_text(json.dumps({"success_rate": 0.5}))

    def ran(i: int, can: str, output: str) -> list[dict]:
        cmd = f"python3 -m sim.run --controller controller.py --can {can}"
        return [{"type": "tool_call", "id": f"c{i}", "name": "execute", "args": {"command": cmd}},
                {"type": "tool_result", "id": f"c{i}", "name": "execute", "content": output}]

    source = ran(0, "0.5,0.0", '{"can_start": [0.5, 0.0]}') + ran(1, "0.3,0.2", '{"can_start": [0.3, 0.2]}')
    assert prefix_events(source, 1) == source[:2]
    (child / PREFIX_EVENTS).write_text("".join(json.dumps(e) + "\n" for e in prefix_events(source, 1)))
    (child / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in [
        {"type": "forced", "command": sd.INTERVENTIONS["vary_positions"]["command"],
         "output": "can at (0.506, 0.453): fail, place error 39.66 cm\n0 of 1 can positions succeeded"},
        *ran(5, "0.7,-0.2", '{"can_start": [0.7, -0.2]}'),
    ]))
    s = robot_arm.score_run(child / "outputs", task, 0.2, evaluate_fn=lambda *a, **k: {"success_rate": 0.5, "results": []})
    # The source's episode before the cut, the forced step's, then the copy's own; not the source's after the cut.
    assert s.checked_positions == [[0.5, 0.0], [0.506, 0.453], [0.7, -0.2]]


from tests.test_api import client  # noqa: E402, F401 - BATCHES_DIR in a tmp folder


def test_the_api_adds_evidence_to_an_old_verdict(client):  # noqa: F811
    from deep_research import api

    d = api.BATCHES_DIR / "old"
    (d / "case").mkdir(parents=True)
    (d / "case" / "case.json").write_text(json.dumps({"phase": "done", "runs": {}, "forks": {}, "verdict": {
        "sentence": "s", "step_label": "deduplicate",
        "numbers": {"control_inflated": 3, "control_total": 4, "forced_inflated": 0, "forced_total": 4}}}))
    ev = client.get("/api/batches/old/case").json()["verdict"]["evidence"]
    assert ev["level"] == "open" and ev["pairs"] == 4 and ev["p_value"] == pytest.approx(5 / 70, abs=1e-4)
