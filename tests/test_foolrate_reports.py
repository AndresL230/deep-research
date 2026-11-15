"""GET /api/foolrate: the fool-rate reports (`cli foolrate`), newest first, from batches/ and fixtures/, read-only,
with only the counts going out; and check_invariants' rule on the reports. All data here is SIMULATED, for tests."""

import importlib.util
import json

import pytest
from fastapi.testclient import TestClient

from deep_research import api
from deep_research import foolrate as fr
from deep_research import lessons as lessons_mod
from deep_research.agents import investigator
from deep_research.config import ROOT_DIR

spec = importlib.util.spec_from_file_location("check_invariants", ROOT_DIR / "scripts" / "check_invariants.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def simulated_report(created_at="2026-11-15T04:00:00-0500", **extra) -> dict:
    """A SIMULATED report in the shape `foolrate.table` writes. Not a real run."""
    rows = [{**fr.row("none", {f"r{i:02}": {"status": "inflated"} for i in range(5)}, "sim-none"), "usd": 0.02},
            {**fr.row("learned", {"r00": {"status": "inflated"}, **{f"r{i:02}": {"status": "honest"} for i in range(1, 5)}},
                      "sim-learned"), "usd": 0.03}]
    return {**fr.table(rows, n=5, domain="tabular", trap={}, estimate=0.04), "created_at": created_at,
            "simulated": True, "note": "SIMULATED for tests, not a real run", **extra}


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    batches, fixtures = tmp_path / "batches", tmp_path / "fixtures"
    (batches / "_foolrate").mkdir(parents=True)
    (fixtures / "_foolrate").mkdir(parents=True)
    monkeypatch.setattr(api, "BATCHES_DIR", batches)
    monkeypatch.setattr(api, "FIXTURES_DIR", fixtures)
    monkeypatch.setattr(api, "STATS_FILE", batches / "_stats.json")
    monkeypatch.setattr(investigator, "LEARNED_DIR", tmp_path / "learned")
    return batches, fixtures


def test_lists_reports_newest_first_from_batches_and_fixtures(dirs):
    batches, fixtures = dirs
    (batches / "_foolrate" / "1115-040000.json").write_text(json.dumps(simulated_report("2026-11-15T04:00:00-0500")))
    (fixtures / "_foolrate" / "1114-090000.json").write_text(json.dumps(simulated_report("2026-11-14T09:00:00-0500")))
    (batches / "_foolrate" / "broken.json").write_text("{not json")
    with TestClient(api.app) as c:
        res = c.get("/api/foolrate")
    assert res.status_code == 200
    got = res.json()
    assert [r["id"] for r in got] == ["1115-040000", "1114-090000"]
    assert [r["fixture"] for r in got] == [False, True]
    none, learned = got[0]["rows"]
    assert (none["setting"], none["inflated"], none["n"], none["interval"]) == ("none", 5, 5, "wilson")
    assert learned["inflated"] == 1 and learned["ci95"] == list(fr.wilson(1, 5)) and learned["usd"] == 0.03
    assert got[0]["simulated"] is True


def test_no_reports_is_an_empty_list(dirs):
    with TestClient(api.app) as c:
        assert c.get("/api/foolrate").json() == []


def test_only_the_counts_go_out(dirs):
    batches, _ = dirs
    rep = simulated_report()
    rep["rows"][0]["holdout_labels"] = [1, 0, 1]
    rep["holdout_labels"] = "task/holdout_labels.csv"
    (batches / "_foolrate" / "x.json").write_text(json.dumps(rep))
    with TestClient(api.app) as c:
        text = c.get("/api/foolrate").text
    assert "holdout_labels" not in text


def test_an_older_report_gets_its_lessons_and_costs_from_its_batches(dirs, tmp_path):
    batches, _ = dirs
    investigator.write_lesson("dedupe-before-split", "Drop near-duplicate rows before you split.", "1115-033734-e892",
                              root=tmp_path / "learned")
    rep = simulated_report()
    for r in rep["rows"]:
        r.pop("usd")
    (batches / "_foolrate" / "old.json").write_text(json.dumps(rep))
    case = {"runs": {"r01": {"status": "honest", "lessons": {"setting": "learned", "path": "skills",
                                                             "names": ["dedupe-before-split"]}}},
            "costs": {"scopes": {"run:r01": {"model_usd": 0.01, "vm_usd": 0.005}}}}
    (batches / "sim-learned" / "case").mkdir(parents=True)
    (batches / "sim-learned" / "case" / "case.json").write_text(json.dumps(case))
    with TestClient(api.app) as c:
        got = c.get("/api/foolrate").json()[0]
    assert got["lessons"] == [{"name": "dedupe-before-split", "rule": "Drop near-duplicate rows before you split.",
                               "learned_from": "1115-033734-e892"}]
    none, learned = got["rows"]
    assert none["usd"] is None and learned["usd"] == pytest.approx(0.015)


def test_approved_lessons_say_which_batch_they_came_from(tmp_path):
    investigator.write_lesson("a-rule", "Do the thing.", "1115-033734-e892", root=tmp_path)
    assert lessons_mod.approved(tmp_path)[0]["learned_from"] == "1115-033734-e892"


def test_check_invariants_rules_on_reports(tmp_path, capsys):
    (tmp_path / "_foolrate").mkdir()
    rep = simulated_report()
    rep["rows"][0]["labels"] = "holdout_labels.csv"
    (tmp_path / "_foolrate" / "bad.json").write_text(json.dumps(rep))
    fails = []
    assert ci.check_foolrate(tmp_path, True, lambda n, why: fails.append(why)) == 1
    assert any("holdout_labels" in f for f in fails) and any("more than the counts" in f for f in fails)
    unflagged = simulated_report()
    unflagged.pop("simulated")
    (tmp_path / "_foolrate" / "bad.json").write_text(json.dumps(unflagged))
    fails.clear()
    ci.check_foolrate(tmp_path, True, lambda n, why: fails.append(why))
    assert fails == ["a committed fool-rate report is neither `simulated: true` nor a `recording`"]
    fails.clear()
    ci.check_foolrate(tmp_path, False, lambda n, why: fails.append(why))  # a local report needs no flag
    assert fails == []
