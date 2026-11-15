"""scripts/check_invariants.py (MASTER_PLAN 8.1): passes on the committed fixtures and fails on a batch that breaks them."""

import importlib.util
import json
from pathlib import Path

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


def _batch(tmp_path, **case) -> Path:
    root = tmp_path / "1115-000000-rule"
    (root / "case").mkdir(parents=True)
    base = {"config": {}, "phase": "done", "runs": {}, "step_labels": {}, "split": None, "hypotheses": [], "forks": {},
            "verdict": None}
    (root / "case" / "case.json").write_text(json.dumps({**base, **case}))
    return root


def _fails(tmp_path, capsys) -> str:
    assert ci.main(["--no-api", "--batches", str(tmp_path)]) == 1
    return capsys.readouterr().out


def test_a_suspect_whose_status_disagrees_with_its_ledger_fails(tmp_path, capsys):
    _batch(tmp_path, suspects=[{"id": "s1", "status": "supported"}, {"id": "s2", "status": "testing"},
                               {"id": "s3", "status": "cleared"}, {"id": "s4", "status": "testing"}],
           evidence={"s1": {"pairs": 2, "score": 3.61, "level": "open"},
                     "s2": {"pairs": 1, "score": 1.9, "level": "supported"},
                     "s4": {"pairs": 5, "score": 24.76, "level": "supported"}})
    out = _fails(tmp_path, capsys)
    assert "suspect s1 is supported, but its evidence (score 3.61, 2 pairs) is open" in out
    assert "evidence.s2 says supported, but a score of 1.9 over 1 pairs is open" in out
    assert "suspect s3 is cleared with no evidence.s3 behind it" in out
    # Supported by its ledger, and no experiment of it still running: the status should say so.
    assert "suspect s4 is testing, but its evidence (score 24.76, 5 pairs) is supported" in out


def test_a_verdict_naming_a_supported_suspect_under_20_fails(tmp_path, capsys):
    _batch(tmp_path, suspects=[{"id": "s1", "status": "testing"}, {"id": "s2", "status": "testing"}],
           evidence={"s1": {"pairs": 2, "score": 3.61, "level": "open"}},
           verdict={"sentence": "s", "step_label": "deduplicate", "numbers": {}, "supported": ["s1", "s2"]})
    out = _fails(tmp_path, capsys)
    assert "verdict.supported names s1, whose ledger score is 3.61 (under 20)" in out
    assert "verdict.supported names s2, whose ledger score is 0 (under 20)" in out


def test_a_banned_key_or_holdout_labels_on_any_investigator_route_fails(tmp_path, capsys):
    root = _batch(tmp_path)
    (tmp_path / "_memory" / "casebook").mkdir(parents=True)
    (tmp_path / "_memory" / "casebook" / "casebook.md").write_text('# Casebook\n\n{"overlap_share": 0.5}\n')
    (tmp_path / "_memory" / "robot_arm").mkdir(parents=True)
    (tmp_path / "_memory" / "robot_arm" / "AGENTS.md").write_text("see task/holdout_labels.csv\n")
    (root / "case" / "view").mkdir()
    (root / "case" / "view" / "notes.txt").write_text("'trap_strength': 0.5")
    out = _fails(tmp_path, capsys)
    assert "/memories/ casebook.md: banned key overlap_share" in out
    assert "/memory/ AGENTS.md: names holdout_labels" in out
    assert "/case/ notes.txt: banned key trap_strength" in out


def test_the_routes_are_found_on_the_investigators_backend_and_the_vm():
    routes = {prefix: (anchor, str(rel)) for prefix, anchor, rel in ci.investigator_routes()}
    assert {"/case/", "/runs/", "/skills/", "/memory/", "/memories/"} <= set(routes)
    assert routes["/memories/"] == ("root", "_memory/casebook") and routes["/case/"] == ("batch", "case/view")
    vm = [rel for prefix, (anchor, rel) in routes.items() if prefix.startswith("vm:")]
    assert "task/data.csv" in vm and not any("holdout_labels" in r for r in vm)


def test_a_holdout_labels_file_given_to_the_vm_fails(tmp_path):
    root = tmp_path / "b"
    (root / "task").mkdir(parents=True)
    (root / "task" / "holdout_labels.csv").write_text("y\n1\n")
    failures = []
    ci.check_agent_routes("b", root, [("vm:/home/daytona/workspace/y.csv", "batch", ci.Path("task/holdout_labels.csv"))],
                          lambda name, why: failures.append(why))
    assert failures and "holdout labels file on an agent route" in failures[0]


def test_every_get_route_of_the_api_is_probed_for_holdout_labels():
    from fastapi import FastAPI
    from fastapi.responses import PlainTextResponse

    app = FastAPI()

    @app.get("/api/batches/{batch_id}/leak/{run_id}")
    def leak(batch_id: str, run_id: str):
        return {"file": "task/holdout_labels.csv"}

    @app.get("/api/batches/{batch_id}/raw/{path:path}")
    def raw(batch_id: str, path: str):
        return PlainTextResponse("y\n1\n")  # serves whatever it is asked for

    @app.get("/api/batches/{batch_id}/odd/{widget}")
    def odd(batch_id: str, widget: str):
        return {}

    @app.get("/api/batches/{batch_id}/fine")
    def fine(batch_id: str):
        return {"ok": True}

    failures = []
    ci.check_api(["demo-batch"], lambda name, why: failures.append(why), app=app)
    assert any("/leak/" in f and "names holdout_labels" in f for f in failures)
    assert any("/raw/task/holdout_labels.csv" in f for f in failures)
    assert any("odd/{widget}" in f and "no probe" in f for f in failures)
    assert not any("/fine" in f for f in failures)
