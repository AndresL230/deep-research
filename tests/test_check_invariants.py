"""scripts/check_invariants.py (MASTER_PLAN 8.1): passes on the committed fixtures and fails on a batch that breaks them."""

import importlib.util
import json

from deep_research.config import ROOT_DIR

spec = importlib.util.spec_from_file_location("check_invariants", ROOT_DIR / "scripts" / "check_invariants.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def test_the_fixtures_pass(capsys):
    assert ci.main(["--no-api"]) == 0, capsys.readouterr().out


def test_a_batch_that_breaks_the_invariants_fails(tmp_path, capsys):
    root = tmp_path / "1114-000000-badd"
    (root / "case").mkdir(parents=True)
    (root / "runs" / "r01").mkdir(parents=True)
    (root / "runs" / "r01" / "notes.json").write_text(json.dumps({"overlap_share": 0.5}))
    (root / "runs" / "r01" / "score.json").write_text(json.dumps({"overlap_share": 0.5}))  # denied: not a failure
    case = {
        "config": {"seed": 3}, "phase": "done", "runs": {}, "step_labels": {}, "split": None, "hypotheses": [],
        "forks": {"f1": {"status": "done", "label": "deduplicate",
                         "children": {"forced-1": {"arm": "forced", "status": "honest", "gap": 0.0}},
                         "arms": {"forced": {"inflated": 0, "scored": 1}}}},
        "verdict": {"sentence": "s", "step_label": "deduplicate", "numbers": {},
                    "evidence": {"level": "supported", "score": 5.0, "rule": "running_score", "pairs": 1}},
        "costs": {"simulated": True},
    }
    (root / "case" / "case.json").write_text(json.dumps(case))
    assert ci.main(["--no-api", "--batches", str(tmp_path)]) == 1
    out = capsys.readouterr().out
    assert "fork f1 has changed copies" in out
    assert "verdict supported at a score of 5.0" in out
    assert "notes.json: banned key overlap_share" in out and "score.json" not in out
    assert "costs say simulated but config.simulated is not set" in out
    assert "verdict evidence field needed_score" in out
