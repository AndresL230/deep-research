"""The numbers reported in docs/PROGRESS.md come from a saved batch through this script. No keys, no VMs."""

import json

import pytest

from deep_research.config import FIXTURES_DIR
from scripts.batch_numbers import render, summarize


def _batch(tmp_path, case):
    d = tmp_path / "b1"
    (d / "case").mkdir(parents=True)
    (d / "case" / "case.json").write_text(json.dumps(case))
    return d


CASE = {
    "config": {"n_runs": 4, "budget_usd": 3.0},
    "phase": "done",
    "runs": {
        "r01": {"id": "r01", "status": "honest"},
        "r02": {"id": "r02", "status": "inflated"},
        "r03": {"id": "r03", "status": "inflated"},
        "r04": {"id": "r04", "status": "failed", "reason": "report.json missing or invalid"},
    },
    "forks": {
        "f1": {
            "id": "f1", "status": "done", "source_run": "r02", "fork_at": 2,
            "children": {
                "control-1": {"arm": "control", "status": "inflated", "how": "fork"},
                "forced-1": {"arm": "forced", "status": "honest", "how": "replay"},
                "forced-2": {"arm": "forced", "status": "failed", "reason": "TimeoutError: "},
            },
            "arms": {"control": {"scored": 1, "inflated": 1}, "forced": {"scored": 1, "inflated": 0}},
        },
        # An approval that was never answered is not an experiment.
        "pending": {"id": "pending", "status": "awaiting_approval", "n_per_arm": 4},
    },
    "verdict": {"sentence": "Skipping the duplicate check caused it.", "step_label": "deduplicate", "numbers": {}},
    "costs": {
        "budget_usd": 3.0, "spent_usd": 0.46, "prices_missing": False,
        "scopes": {
            "run:r01": {"total_usd": 0.02, "vm_seconds": 60.0},
            "run:r02": {"total_usd": 0.04, "vm_seconds": 120.0},
            "run:r03": {"total_usd": 0.06, "vm_seconds": 180.0},
            "run:r04": {"total_usd": 0.0, "vm_seconds": 30.0},
            "fork:f1:base": {"total_usd": 0.01, "vm_seconds": 50.0},
            "fork:f1:control-1": {"total_usd": 0.03, "vm_seconds": 70.0},
            "investigator": {"total_usd": 0.3, "vm_seconds": 0.0},
        },
    },
}


def test_summarize_counts_runs_costs_and_how_each_fork_child_was_built(tmp_path):
    s = summarize(_batch(tmp_path, CASE))
    assert s["batch"] == "b1" and s["simulated"] is False and s["phase"] == "done"
    assert s["runs"] == {"total": 4, "honest": 1, "inflated": 2, "failed": 1, "other": 0}
    # The share is of scored runs: a failed run is neither honest nor inflated.
    assert s["inflated_share"] == pytest.approx(2 / 3)
    # Per-run figures describe a run that finished. A run that died after seconds would drag them down,
    # so what failed runs cost is reported on its own line instead.
    assert s["usd_per_run"] == pytest.approx(0.04)
    assert s["minutes_per_run"] == pytest.approx(2.0)
    assert s["usd"] == {"runs": pytest.approx(0.12), "failed_runs": pytest.approx(0.0), "forks": pytest.approx(0.04),
                        "investigator": pytest.approx(0.3), "spent": 0.46, "budget": 3.0}
    assert list(s["forks"]) == ["f1"]
    f1 = s["forks"]["f1"]
    assert f1["how"] == {"fork": 1, "replay": 1}
    assert f1["source_run"] == "r02" and f1["control"] == "1 of 1 inflated" and f1["forced"] == "0 of 1 inflated"
    assert s["verdict"] == "Skipping the duplicate check caused it."
    assert s["failures"] == ["run r04: report.json missing or invalid", "fork f1 forced-2: TimeoutError: "]


def test_summarize_says_unknown_instead_of_inventing_a_number(tmp_path):
    case = {"config": {}, "phase": "running", "runs": {"r01": {"id": "r01", "status": "running"}}, "forks": {},
            "verdict": None, "costs": {}}
    s = summarize(_batch(tmp_path, case))
    assert s["runs"] == {"total": 1, "honest": 0, "inflated": 0, "failed": 0, "other": 1}
    assert s["inflated_share"] is None and s["usd_per_run"] is None and s["minutes_per_run"] is None
    assert s["verdict"] is None and s["forks"] == {} and s["failures"] == []
    assert "unknown" in render(s)


def test_a_missing_price_makes_the_average_unknown(tmp_path):
    case = json.loads(json.dumps(CASE))
    case["costs"]["scopes"]["run:r02"]["total_usd"] = None
    s = summarize(_batch(tmp_path, case))
    assert s["usd_per_run"] is None and s["usd"]["runs"] is None


def test_what_failed_runs_cost_is_shown_separately(tmp_path):
    case = json.loads(json.dumps(CASE))
    case["costs"]["scopes"]["run:r04"] = {"total_usd": 0.5, "vm_seconds": 900.0}  # a run that timed out
    s = summarize(_batch(tmp_path, case))
    assert s["usd_per_run"] == pytest.approx(0.04) and s["minutes_per_run"] == pytest.approx(2.0)
    assert s["usd"]["failed_runs"] == pytest.approx(0.5) and s["usd"]["runs"] == pytest.approx(0.62)
    assert "failed runs $0.50" in render(s)


def test_the_simulated_fixture_is_labeled_simulated():
    s = summarize(FIXTURES_DIR / "demo-batch")
    assert s["simulated"] is True
    assert s["runs"]["honest"] == 6 and s["runs"]["inflated"] == 6 and s["inflated_share"] == pytest.approx(0.5)
    assert render(s).splitlines()[0].startswith("SIMULATED")
