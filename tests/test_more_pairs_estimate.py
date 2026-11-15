"""The cost estimate of the "run more pairs" quote (`more_pairs_quote`), on hand-made case files.

The estimate is what one copy of the fork costs (model tokens and VM time, from its own finished copies, else a run on
the same model, else any run) times the new copies, plus a base VM, rounded up to the cent. No keys, no VMs.
"""

import pytest
from fastapi.testclient import TestClient

from deep_research import api
from deep_research.batch import more_pairs_quote
from deep_research.costs import CostTracker, usd_up
from tests.test_more_pairs_offline import _saved

HAIKU, SONNET = "anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"

# The spend of batch 1114-032554-c05a as its case file saved it: 8 copies of f1 (model, VM), its base VM, 12 runs at
# about $0.003 and the investigator, which is most of the batch's $0.55.
C05A_COPIES = {
    "control-1": (0.0025, 0.0005), "control-2": (0.0032, 0.0010), "control-3": (0.0018, 0.0004),
    "control-4": (0.0013, 0.0003), "forced-1": (0.0018, 0.0004), "forced-2": (0.0017, 0.0005),
    "forced-3": (0.0020, 0.0005), "forced-4": (0.0018, 0.0005),
}


def _scope(model_usd, vm_usd):
    return {"model_usd": model_usd, "vm_usd": vm_usd}


def _case(children: dict[str, str], runs: dict[str, str | None] | None = None, rounds: int = 0) -> dict:
    """A decided batch's case file: fork f1 of run r01 with `children` {id: status}, control 2 of 4 inflated against
    forced 0 of 4 (open), and `runs` {id: model or None for the batch's analyst model}."""
    runs = {"r01": None, "r02": None} if runs is None else runs
    return {
        "config": {"analyst_model": HAIKU, "investigator_model": SONNET},
        "runs": {r: {"status": "honest", **({"model": m} if m else {})} for r, m in runs.items()},
        "forks": {"f1": {
            "status": "done", "kind": "method", "source_run": "r01", "fork_at": 2, "label": "deduplicate",
            "children": {cid: {"arm": cid.rsplit("-", 1)[0], "status": s} for cid, s in children.items()},
            "arms": {"control": {"scored": 4, "inflated": 2}, "forced": {"scored": 4, "inflated": 0}},
            "more_pairs": [{"status": "done"}] * rounds,
        }},
        "verdict": {"sentence": "...", "arms": {"control": {"inflated": 2, "total": 4},
                                                 "forced": {"inflated": 0, "total": 4}}},
    }


def _tracker(scopes: dict, budget=10.0) -> CostTracker:
    t = CostTracker(budget_usd=budget)
    t.restore({"scopes": scopes})
    return t


FOUR_EACH = {f"{a}-{i}": "honest" for a in ("control", "forced") for i in (1, 2, 3, 4)}


def test_usd_up_rounds_up_to_the_cent_but_not_on_a_floats_last_bit():
    assert usd_up(0.0214) == 0.03
    assert usd_up(0.0001) == 0.01  # a small spend is never quoted as nothing
    assert usd_up(0.4) == 0.4 and usd_up(0.1 * 2 * 2) == 0.4 and usd_up(0.77) == 0.77
    assert usd_up(0.0) == 0.0 and usd_up(None) is None


def test_the_c05a_quote_is_its_copies_and_base_rounded_up_and_leaves_the_investigator_out():
    scopes = {f"fork:f1:{cid}": _scope(*c) for cid, c in C05A_COPIES.items()}
    scopes["fork:f1:base"] = _scope(0.0, 0.0011)
    scopes |= {f"run:r{i:02d}": _scope(0.0028, 0.0004) for i in range(1, 13)}
    scopes["investigator"] = _scope(0.486, 0.0)
    q = more_pairs_quote(_case(dict.fromkeys(C05A_COPIES, "honest")), _tracker(scopes), 4)
    per_copy = sum(m + v for m, v in C05A_COPIES.values()) / 8
    assert q["vm_count"] == 9 and per_copy * 8 + 0.0011 == pytest.approx(0.0214, abs=1e-4)
    # Rounded to the nearest cent this was $0.02, below what the 8 copies and the base of f1 really cost.
    assert q["estimate_usd"] == 0.03
    assert q["basis"] == ("8 new copies at $0.0025 each (the average of 8 earlier finished copies of f1), plus "
                          "$0.0011 for the base VM (what f1's base VM cost). Model tokens and VM time, rounded up "
                          "to the cent.")
    # One pair: a cent, not $0.00.
    assert more_pairs_quote(_case(dict.fromkeys(C05A_COPIES, "honest")), _tracker(scopes), 1)["estimate_usd"] == 0.01


def test_a_copy_that_failed_or_was_stopped_is_left_out_of_the_average():
    children = {**FOUR_EACH, "control-4": "failed", "forced-4": "running"}
    scopes = {f"fork:f1:{cid}": _scope(0.08, 0.02) for cid in FOUR_EACH}
    scopes["fork:f1:control-4"] = _scope(0.001, 0.0)  # failed early: cheap, but a whole copy is not
    scopes["fork:f1:forced-4"] = _scope(0.002, 0.001)
    scopes["fork:f1:base"] = _scope(0.0, 0.03)
    q = more_pairs_quote(_case(children), _tracker(scopes), 2)
    assert q["estimate_usd"] == usd_up(0.10 * 4 + 0.03) == 0.43
    assert "the average of 6 earlier finished copies of f1" in q["basis"]


def test_an_unclear_copy_ran_to_its_end_and_counts():
    children = {**FOUR_EACH, "forced-1": "unclear"}
    scopes = {f"fork:f1:{cid}": _scope(0.1, 0.0) for cid in FOUR_EACH}
    scopes["fork:f1:forced-1"] = _scope(0.9, 0.0)
    q = more_pairs_quote(_case(children), _tracker(scopes), 1)
    assert q["estimate_usd"] == usd_up((0.1 * 7 + 0.9) / 8 * 2) == 0.4


def test_the_base_vm_is_the_costliest_of_the_forks_bases_else_one_copys_vm_time():
    scopes = {f"fork:f1:{cid}": _scope(0.05, 0.01) for cid in FOUR_EACH}
    scopes |= {"fork:f1:base": _scope(0.0, 0.02), "fork:f1:base-2": _scope(0.0, 0.07), "fork:f2:base": _scope(0, 5.0)}
    q = more_pairs_quote(_case(FOUR_EACH, rounds=1), _tracker(scopes), 1)
    assert q["estimate_usd"] == usd_up(0.06 * 2 + 0.07) == 0.19
    assert "$0.0700 for the base VM (the most one of f1's 2 base VMs cost)" in q["basis"]
    # No base VM recorded: it is priced as one copy's VM time, never as nothing.
    del scopes["fork:f1:base"], scopes["fork:f1:base-2"]
    q = more_pairs_quote(_case(FOUR_EACH, rounds=1), _tracker(scopes), 1)
    assert q["estimate_usd"] == usd_up(0.06 * 2 + 0.01) == 0.13
    assert "$0.0100 for the base VM (priced as one copy's VM time)" in q["basis"]


def test_without_a_finished_copy_it_is_a_whole_run_on_the_source_runs_model_else_any_run():
    children = dict.fromkeys(FOUR_EACH, "failed")
    scopes = {"run:r01": _scope(0.04, 0.01), "run:r02": _scope(0.06, 0.01), "run:r03": _scope(0.9, 0.1)}
    case = _case(children, runs={"r01": None, "r02": HAIKU, "r03": SONNET})
    q = more_pairs_quote(case, _tracker(scopes), 1)
    assert q["estimate_usd"] == usd_up(0.06 * 2 + 0.01) == 0.13  # the r03 run on another model is left out
    assert f"no copy of f1 finished yet, so the average whole run on {HAIKU} (2 runs)" in q["basis"]
    # The source run's model has no priced run: any run.
    case = _case(children, runs={"r01": SONNET, "r02": HAIKU})
    q = more_pairs_quote(case, _tracker({"run:r02": _scope(0.05, 0.01)}), 1)
    assert q["estimate_usd"] == usd_up(0.06 * 2 + 0.01)
    assert "so the average whole run (1 run)" in q["basis"]


def test_no_known_price_means_no_estimate_and_says_so():
    q = more_pairs_quote(_case(FOUR_EACH), _tracker({"fork:f1:control-1": _scope(None, 0.01)}))
    assert q["estimate_usd"] is None and q["basis"].startswith("No estimate")
    assert q["over_budget"] is False


def test_the_budget_check_uses_the_rounded_up_estimate():
    # 8 copies at $0.06 plus a $0.01 base is $0.49: with $9.505 spent of $10.00 it fits.
    scopes = {f"fork:f1:{cid}": _scope(0.05, 0.01) for cid in FOUR_EACH}
    scopes["fork:f1:base"] = _scope(0.0, 0.01)
    scopes["investigator"] = _scope(9.015, 0.0)
    q = more_pairs_quote(_case(FOUR_EACH), _tracker(scopes), 4)
    assert q["estimate_usd"] == 0.49 and q["over_budget"] is False
    # A $0.011 base makes $0.491, quoted $0.50: $9.506 plus that is over, though $0.491 alone would have fit.
    scopes["fork:f1:base"] = _scope(0.0, 0.011)
    q = more_pairs_quote(_case(FOUR_EACH), _tracker(scopes), 4)
    assert q["estimate_usd"] == 0.5 and q["over_budget"] is True and "about $0.50" in q["budget_problem"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    monkeypatch.setattr(api, "BATCHES", {})
    monkeypatch.setattr(api, "TASKS", {})
    with TestClient(api.app) as c:
        yield c


def test_the_endpoint_answers_the_estimate_and_its_basis_from_the_saved_spend(client, tmp_path):
    b = _saved(tmp_path, control=(2, 4), forced=(0, 4))
    scopes = {f"fork:f1:{cid}": _scope(*c) for cid, c in C05A_COPIES.items()}
    scopes["fork:f1:base"] = _scope(0.0, 0.0011)
    scopes["investigator"] = _scope(0.486, 0.0)
    b.tracker.restore({"scopes": scopes})
    b.case.set_costs(b.tracker.snapshot())
    q = client.get("/api/batches/saved/more-pairs?n=4").json()
    assert q["vm_count"] == 9 and q["estimate_usd"] == 0.03
    assert q["basis"].startswith("8 new copies at $0.0025 each (the average of 8 earlier finished copies of f1)")
    assert "saved" not in api.BATCHES  # nothing loaded or started
