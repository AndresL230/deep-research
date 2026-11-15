"""A pair counts only when its control copy reproduces the effect under test (evidence.pair_up). Batch
1115-040827-bfce, experiment f1: forced to drop the leaky column, from an inflated run, but all 6 control copies came
out honest, so no pair could show the change shrinking an inflation, and the sign rule cleared the true cause. Such
pairs are now dropped, and an experiment with none left is `inconclusive`, never cleared. Offline: local folders for
VMs and scripted models."""

from __future__ import annotations

import pytest

from deep_research import batch as batch_mod
from deep_research import evidence as ev
from deep_research import experiments as xp
from deep_research.config import BatchConfig
from tests.local_vm import install_local_vms, model_script
from tests.scripted import call, say, script_analysts

NOT_INFLATED = "the control copy did not reproduce the inflation"
CAME_INFLATED = "the control copy came out inflated"


def _kids(pairs: list[tuple[str, float, str, float]]) -> dict:
    out = {}
    for i, (cs, cg, fs, fg) in enumerate(pairs, 1):
        out[f"control-{i}"] = {"arm": "control", "status": cs, "gap": cg}
        out[f"forced-{i}"] = {"arm": "forced", "status": fs, "gap": fg, "held": True}
    return out


# The shape of 1115-040827-bfce f1: six honest control copies, six honest forced copies.
BFCE_F1 = _kids([("honest", -0.0702, "honest", -0.0702), ("honest", -0.0605, "honest", -0.0621),
                 ("honest", -0.0605, "honest", -0.0702), ("honest", -0.0605, "honest", -0.0702),
                 ("honest", -0.0621, "honest", -0.0377), ("honest", -0.0052, "honest", -0.0605)])


def test_honest_controls_drop_every_pair_and_the_level_is_inconclusive():
    kept, dropped = xp.pair_outcomes(BFCE_F1, 6, "smaller_gap")
    assert kept == [] and dropped == [{"i": i, "reason": NOT_INFLATED} for i in range(1, 7)]
    scored = xp.score_pairs(kept, "smaller_gap", dropped)
    assert scored["level"] == "inconclusive" and scored["n_pairs"] == 0 and scored["score"] == 1
    # Before the fix the same copies scored 0.13 (1 agreeing pair of 6) and read cleared.
    old = ev.running_score([ev.agrees(BFCE_F1[f"control-{i}"]["gap"], BFCE_F1[f"forced-{i}"]["gap"]) for i in range(1, 7)])
    assert ev.score_level(old, 6) == "cleared"
    # The fork path (verdicts, more pairs) says the same.
    fork = {"children": BFCE_F1, "prediction": "smaller_gap", "arms": {}}
    assert ev.fork_pairs(fork) == [] and ev.verdict_evidence(pairs=ev.fork_pairs(fork))["level"] == "inconclusive"
    assert ev.method_outcome({"level": "inconclusive", "control_total": 6, "forced_total": 6}) == "inconclusive"
    assert ev.INCONCLUSIVE_NOTE in ev.describe(ev.verdict_evidence(
        {"control": {"inflated": 0, "total": 6}, "forced": {"inflated": 0, "total": 6}}, pairs=ev.fork_pairs(fork)))
    # A suspect whose only experiment is this one is not cleared.
    sus = xp.suspect_evidence([{"id": "f1", "prediction": "smaller_gap", "pairs": kept, "dropped_pairs": dropped}])
    assert sus["level"] == "inconclusive" and sus["pairs"] == 0


def test_mixed_controls_only_the_reproducing_pairs_count():
    kids = _kids([("inflated", 0.30, "honest", 0.00), ("honest", 0.05, "honest", 0.06),
                  ("inflated", 0.25, "inflated", 0.25), ("honest", -0.02, "inflated", 0.20),
                  ("inflated", 0.28, "honest", -0.01)])
    kept, dropped = xp.pair_outcomes(kids, 5, "smaller_gap")
    assert [p["i"] for p in kept] == [1, 3, 5] and [p["agree"] for p in kept] == [True, False, True]
    assert dropped == [{"i": 2, "reason": NOT_INFLATED}, {"i": 4, "reason": NOT_INFLATED}]
    scored = xp.score_pairs(kept, "smaller_gap", dropped)
    assert scored["n_pairs"] == 3 and scored["score"] == pytest.approx(1.9 * 0.1 * 1.9) and scored["level"] == "open"


def test_larger_gap_needs_honest_controls():
    kids = _kids([("honest", -0.02, "inflated", 0.30), ("inflated", 0.20, "inflated", 0.30),
                  ("honest", -0.06, "inflated", 0.30)])
    kept, dropped = xp.pair_outcomes(kids, 3, "larger_gap")
    assert [p["i"] for p in kept] == [1, 3] and all(p["agree"] for p in kept)
    assert dropped == [{"i": 2, "reason": CAME_INFLATED}]
    # Every control inflated: nothing counts, inconclusive.
    all_inflated = _kids([("inflated", 0.2, "inflated", 0.3)] * 5)
    kept, dropped = xp.pair_outcomes(all_inflated, 5, "larger_gap")
    assert kept == [] and xp.score_pairs(kept, "larger_gap", dropped)["level"] == "inconclusive"


def test_cleared_still_needs_five_counted_pairs():
    five = _kids([("inflated", 0.2, "inflated", 0.2)] * 5)  # five ties: 0.1^5, five counted pairs
    kept, dropped = xp.pair_outcomes(five, 5, "smaller_gap")
    assert xp.score_pairs(kept, "smaller_gap", dropped)["level"] == "cleared"
    four = _kids([("inflated", 0.2, "inflated", 0.2)] * 4 + [("honest", 0.0, "honest", 0.0)])
    kept, dropped = xp.pair_outcomes(four, 5, "smaller_gap")
    assert len(kept) == 4 and xp.score_pairs(kept, "smaller_gap", dropped)["level"] == "open"


def _script(label: str) -> list:
    ex = lambda dedupe, i: call("execute", {"command": model_script(dedupe=dedupe)}, f"call-{i}", 1000)  # noqa: E731
    if label.endswith("-r01"):  # honest
        return [ex(True, 1), say("Done.", 1000)]
    if label.endswith("-r02"):  # careless: inflated
        return [ex(False, 1), say("Done.", 1000)]
    # Every copy from the fork point removes the duplicates itself: no control copy reproduces the inflation.
    return [ex(True, 9), say("Done.", 1000)]


async def test_run_experiment_with_no_reproducing_control_is_inconclusive_and_keeps_the_suspect(tmp_path, monkeypatch):
    install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script)
    b = batch_mod.Batch(BatchConfig(n_runs=2, forks_per_choice=1), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    assert b.case.data["runs"]["r02"]["status"] == "inflated"
    assert not b.case.record_suspects([{"target": "deduplicate", "kind": "omission",
                                        "rationale": "the inflated run never removed duplicates"}]).startswith("error")
    before = b.case.suspect("s1")["status"]
    out = await b.run_experiment("s1", "force_step:deduplicate", "smaller_gap", pairs=5, source_run="r02")
    assert "error" not in out, out
    kids = b.case.data["forks"][out["fork_id"]]["children"]
    assert all(kids[f"control-{i}"]["status"] == "honest" for i in range(1, 6))
    assert out["pairs"] == [] and [d["reason"] for d in out["dropped"]] == [NOT_INFLATED] * 5
    assert out["level"] == "inconclusive" and out["note"] == ev.INCONCLUSIVE_NOTE
    assert out["evidence"]["level"] == "inconclusive"
    assert b.case.suspect("s1")["status"] == before != "cleared"
    assert b.case.data["forks"][out["fork_id"]]["level"] == "inconclusive"
    await b.close()
