"""More pairs (Andres's `Batch.run_more_pairs`) together with pre-registered hypotheses (scientific-autonomy).

A round of more pairs adds copies to the experiment that tested a hypothesis. The outcome computed for that hypothesis
must then follow every copy, while the prediction registered before the first copy stays exactly as registered. More
pairs continue the same experiment; they are not a second, independent test of the same hypothesis, which the
investigator still cannot start. Offline, on the decided batches of test_more_pairs_offline.py.
"""

from __future__ import annotations

import asyncio
import json
import threading

from deep_research import batch as batch_mod
from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from tests.scripted import seed_hypotheses
from tests.test_more_pairs_offline import _decided, _fake_copies

PREDICTION = "forced copies come out inflated less often than control copies"


def _registered(b: Batch, at: float = 1_000.0) -> dict:
    """f1 tests h1, with its prediction registered at `at`; its first round's outcome computed as the experiment does."""
    seed_hypotheses(b.case)
    h1 = b.case.hypothesis("h1")
    b.case.update_fork("f1", hypothesis_id="h1", prediction=h1["prediction"], falsified_if=h1["falsified_if"],
                       preregistered_at=at)
    b._fork_findings("f1", b.case.data["forks"]["f1"]["arms"])
    return {k: b.case.data["forks"]["f1"][k] for k in ("hypothesis_id", "prediction", "falsified_if", "preregistered_at")}


def _case(b: Batch) -> dict:
    return json.loads((b.dir / "case" / "case.json").read_text())


async def test_more_pairs_recompute_the_outcome_and_keep_the_registered_prediction(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    b = _decided(tmp_path, control=(4, 4), forced=(0, 4))
    registered = _registered(b)
    f1 = _case(b)["forks"]["f1"]
    assert f1["outcome"] == "inconclusive" and f1["evidence"]["pairs"] == 4  # 4 of the 8 pairs needed
    assert b.case.hypothesis("h1")["status"] == "inconclusive"

    await b.run_more_pairs(4)

    case = _case(b)
    f1 = case["forks"]["f1"]
    # Every copy counts now: 8 of 8 control inflated, 0 of 8 forced, so the outcome follows to supported ...
    assert f1["evidence"]["pairs"] == 8 and f1["evidence"]["level"] == "supported" and f1["outcome"] == "supported"
    assert sum(f1["built"].values()) == 16
    h1 = next(h for h in case["hypotheses"] if h["id"] == "h1")
    assert h1["status"] == "supported" and h1["tested_by"] == "f1"
    # ... and the prediction is the one registered before the first copy, untouched, with its time.
    assert {k: f1[k] for k in registered} == registered and f1["prediction"] == PREDICTION
    assert h1["prediction"] == PREDICTION
    # The verdict follows too (Andres's rewording), and agrees with the outcome.
    assert case["verdict"]["evidence"]["level"] == "supported"


async def test_more_pairs_can_contradict_a_prediction_the_first_round_left_inconclusive(tmp_path, monkeypatch):
    gaps = {"inflated": 0.2, "honest": 0.0}
    # The new round's control copies still reproduce the inflation (a pair counts only then), but so do the forced ones.
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "inflated"}, gaps=gaps)
    b = _decided(tmp_path, control=(4, 4), forced=(0, 4), gaps=gaps)
    _registered(b)
    await b.run_more_pairs(4)
    f1 = _case(b)["forks"]["f1"]
    # 4 agreeing pairs, then 4 ties (a tie disagrees): score 13.03 x 0.1^4, under 1 after 8 pairs, cleared.
    assert f1["evidence"]["pairs"] == 8 and f1["level"] == "cleared" and f1["outcome"] == "contradicted"
    assert round(f1["score"], 6) == 0.001303 and [p["agree"] for p in f1["pairs"]] == [True] * 4 + [False] * 4
    assert b.case.hypothesis("h1")["status"] == "contradicted" and f1["prediction"] == PREDICTION


async def test_more_pairs_continue_the_experiment_but_no_second_independent_test_can_start(tmp_path, monkeypatch):
    rounds = _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    b = _decided(tmp_path, control=(2, 4), forced=(1, 4))
    _registered(b)
    await b.run_more_pairs(2)  # still open at 6 pairs
    assert len(rounds) == 1 and _case(b)["forks"]["f1"]["evidence"]["level"] == "open"

    # The investigator cannot test h1 again as a new experiment: that would be a second, independent test of it.
    out = await b.run_forks(1, hypothesis_id="h1")
    assert "already tested" in out and set(_case(b)["forks"]) == {"f1"}
    # More pairs for the same experiment are still allowed: they only add copies to f1.
    quote = b.reserve_more_pairs(2)
    assert quote["fork_id"] == "f1" and quote["children"] == ["control-7", "control-8", "forced-7", "forced-8"]


def test_the_investigator_cannot_start_more_pairs_and_every_experiment_still_needs_approval(tmp_path, monkeypatch):
    """More pairs are a person's request (the API's POST); the investigator has no tool for them."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = _decided(tmp_path)
    seen = {}

    def capture(*args, **kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(inv_mod, "create_deep_agent", capture)
    inv_mod.build_investigator(b, "unused")
    names = {t.name for t in seen["tools"]}
    assert not any("pair" in n for n in names), names
    assert "request_forks" in seen["interrupt_on"]


async def test_the_base_vm_of_a_round_is_deleted_if_the_batch_is_stopped_while_it_is_being_made(tmp_path, monkeypatch):
    """`_build_base` serves the first round and every round of more pairs; it makes its VM cancel-safely."""
    b = _decided(tmp_path)
    release, deleted = threading.Event(), []

    def slow_create(label, **kw):
        release.wait(5)
        return f"vm:{label}"

    monkeypatch.setattr(batch_mod.vms, "create_vm", slow_create)
    monkeypatch.setattr(batch_mod.vms, "delete_vm", deleted.append)
    task = asyncio.ensure_future(b._build_base("f1-base-2", "b1-f1-base-2", "fork:f1:base-2", []))
    await asyncio.sleep(0.05)
    task.cancel()
    release.set()
    try:
        await task
    except asyncio.CancelledError:
        pass
    for _ in range(100):
        if deleted:
            break
        await asyncio.sleep(0.02)
    assert deleted == ["vm:b1-f1-base-2"] and "f1-base-2" not in b.vms
