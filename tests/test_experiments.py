"""Experiments test a hypothesis the investigator chose, with its prediction registered first, and their outcome is
computed from the stored counts. Offline: the batch pipeline of test_batch_offline.py (local folders for VMs, a
scripted model)."""

from __future__ import annotations

import json

from deep_research import evidence
from deep_research.case_file import CaseFile
from tests.scripted import call, say, script_investigator, seed_hypotheses
from tests.test_batch_offline import _case, _run_batch, local_vms  # noqa: F401 - the fixture is used by name


# ---- the deterministic statistics ----

def test_method_outcomes_follow_the_counts_and_never_round_up():
    def out(ci, ct, fi, ft):
        return evidence.method_outcome(evidence.verdict_evidence(
            {"control": {"inflated": ci, "total": ct}, "forced": {"inflated": fi, "total": ft}}))

    assert out(8, 8, 0, 8) == "supported"
    assert out(4, 4, 0, 4) == "inconclusive"  # a perfect split on 4 pairs scores 13.03, under 20
    assert out(5, 5, 0, 5) == "supported"  # five agreeing pairs score 24.76
    assert out(4, 8, 5, 8) == "inconclusive"  # counts alone never clear a step
    assert out(5, 8, 3, 8) == "inconclusive"  # a reduction, not enough
    assert out(0, 0, 0, 3) == "no_data"
    # Five pairs whose forced gap is never smaller: score 1e-5, cleared, so the prediction is contradicted.
    worse = [{"i": i, "control_gap": 0.1, "changed_gap": 0.2, "agree": False} for i in range(1, 6)]
    ev = evidence.verdict_evidence({"control": {"inflated": 4, "total": 5}, "forced": {"inflated": 5, "total": 5}},
                                   pairs=worse)
    assert ev["level"] == "cleared" and evidence.method_outcome(ev) == "contradicted"


def test_fix_evidence_is_a_paired_sign_test_on_the_cases_that_changed():
    assert evidence.fix_evidence(5, 0)["level"] == "improved"  # 1/32 < 0.05
    assert evidence.fix_evidence(4, 0)["level"] == "no_detectable_change"  # 1/16: not enough
    assert evidence.fix_evidence(6, 1)["level"] == "no_detectable_change"  # 8/128 = 0.0625
    assert evidence.fix_evidence(0, 5)["level"] == "worse"
    assert evidence.fix_evidence(None, None)["level"] == "unpaired"
    assert evidence.fix_evidence(5, 0)["measures"] == "controller_performance"
    assert evidence.fix_outcome(evidence.fix_evidence(1, 0)) == "inconclusive"
    assert evidence.fix_outcome(evidence.fix_evidence(0, 5)) == "contradicted"


def test_a_fix_verdict_may_say_improved_only_when_the_evidence_does():
    weak = evidence.fix_evidence(2, 0)
    assert evidence.fix_wording_error("The patch improved the controller.", weak).startswith("error")
    assert evidence.fix_wording_error("The patch fixes the grasp.", weak).startswith("error")
    assert evidence.fix_wording_error("Success went from 65% to 75%; not shown to help (p = 0.25).", weak) is None
    assert evidence.fix_wording_error("The patch improved the controller.", evidence.fix_evidence(6, 0)) is None


# ---- hypotheses ----

def test_a_hypothesis_needs_a_prediction_and_a_falsification(tmp_path):
    cf = CaseFile(tmp_path / "case.json")
    cf.update_run("r01", status="inflated")
    base = dict(kind="method", statement="s", supporting_evidence="e", prediction="p", falsified_if="f",
                confidence="low", step_label="deduplicate")
    assert "falsified_if is empty" in cf.record_competing_hypothesis(**{**base, "falsified_if": " "})
    assert "prediction is empty" in cf.record_competing_hypothesis(**{**base, "prediction": ""})
    assert "needs a step_label" in cf.record_competing_hypothesis(**{**base, "step_label": None})
    assert "kind must be" in cf.record_competing_hypothesis(**{**base, "kind": "vibes"})
    assert cf.record_competing_hypothesis(**base) == "h1"
    assert cf.record_competing_hypothesis(**{**base, "kind": "code", "step_label": None, "run_id": "r01"}) == "h2"
    assert [h["status"] for h in cf.data["hypotheses"]] == ["untested", "untested"]


async def test_an_experiment_needs_two_competing_hypotheses_and_a_testable_one(local_vms, tmp_path):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    assert "name the hypothesis" in await b.run_forks(1, hypothesis_id="")
    assert b.case.record_competing_hypothesis("method", "s", "e", "p", "f", "low", step_label="deduplicate") == "h1"
    assert "at least 2 competing hypotheses" in await b.run_forks(1, hypothesis_id="h1")
    assert b.case.record_competing_hypothesis("method", "s", "e", "p", "f", "low", step_label="evaluate") == "h2"
    assert b.case.record_competing_hypothesis("code", "s", "e", "p", "f", "low") == "h3"
    # A step no validated intervention exists for cannot be forced: the error says which can.
    out = await b.run_forks(1, hypothesis_id="h2")
    assert "no validated intervention exists for 'evaluate'" in out and "deduplicate" in out
    assert "is a code hypothesis" in await b.run_forks(1, hypothesis_id="h3")
    assert _case(b)["forks"] == {}


async def test_the_prediction_is_registered_before_the_copies_run_and_the_outcome_is_computed(local_vms, tmp_path):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    split = _case(b)["split"]
    assert split["label"] == "deduplicate" and split["by_label"][0]["margin"] == 1.0
    # Looking at the data first separates the groups just as well here: the tie is shown, not broken in silence by
    # the domain's preference (which knows what was planted).
    assert "inspect" in split["tied_with"]
    seed_hypotheses(b.case)
    seen_at_start = {}
    real_set_child = b._set_child

    def spy(fork_id, cid, **fields):
        # The first time a copy is recorded as running, the fork already carries the prediction.
        if fields.get("status") == "running" and fork_id not in seen_at_start:
            seen_at_start[fork_id] = dict(b.case.data["forks"][fork_id])
        return real_set_child(fork_id, cid, **fields)

    b._set_child = spy
    said = await b.run_forks(1, hypothesis_id="h1")
    f = _case(b)["forks"]["f1"]
    assert seen_at_start["f1"]["prediction"] == "forced copies come out inflated less often than control copies"
    assert seen_at_start["f1"]["preregistered_at"] <= f["children"]["control-1"].get("started_at", float("inf"))
    assert f["hypothesis_id"] == "h1" and f["measures"] == "reporting_accuracy"
    assert f["built"]["fork"] + f["built"]["replay"] == 2
    # One pair is far from enough, whatever it shows: the computed outcome says so, and so does the hypothesis.
    assert f["evidence"]["pairs"] == 1 and f["outcome"] == "inconclusive"
    h1 = next(h for h in _case(b)["hypotheses"] if h["id"] == "h1")
    assert h1["status"] == "inconclusive" and h1["tested_by"] == "f1"
    assert "Pre-registered prediction for h1" in said and "Outcome, computed from the counts: inconclusive" in said
    assert "already tested" in await b.run_forks(1, hypothesis_id="h1")


async def test_a_declined_experiment_runs_nothing_and_the_investigator_carries_on(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    seed_hypotheses(b.case)
    verdict = {"sentence": "No experiment ran: the person declined it, so the split only suggests a step.",
               "step_label": "deduplicate", "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1,
               "confidence": "low", "arms": {}}
    script_investigator(monkeypatch, [
        call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 1}, "i1"),
        call("record_verdict", verdict, "i2"),
        say("The verdict is saved."),
    ])
    await b.investigate()
    pending = _case(b)["forks"]["pending"]
    # The person sees what they are approving: the hypothesis and what it predicts.
    assert pending["hypothesis_id"] == "h1" and pending["prediction"].startswith("forced copies")
    await b.decide(False)
    case = _case(b)
    assert case["phase"] == "done" and case["forks"] == {}
    assert case["verdict"]["sentence"] == verdict["sentence"] and case["verdict"]["arms"] == {}
    assert next(h for h in case["hypotheses"] if h["id"] == "h1")["status"] == "untested"
    events = [json.loads(line) for line in (b.dir / "investigator" / "events.jsonl").read_text().splitlines()]
    assert any("declined" in json.dumps(e) for e in events)


def test_a_verdict_too_long_to_keep_is_refused_not_cut(tmp_path):
    cf = CaseFile(tmp_path / "case.json")
    out = cf.record_structured_verdict("x " * 300, "deduplicate", 1.0, 0.0, 1, 1, {}, "low")
    assert out.startswith("error: the sentence is 599 characters") and cf.data["verdict"] is None
