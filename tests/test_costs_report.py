"""The overall cost report (deep_research/cost_report.py): a pure function of case files."""

import json
from datetime import datetime

import pytest

from deep_research.config import FIXTURES_DIR
from deep_research.cost_report import cost_report, started_at

HAIKU, SONNET = "anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"


def scope(model_usd=0.0, vm_usd=0.0, vm_seconds=0.0, tokens=(0, 0, 0, 0)):
    total = None if model_usd is None or vm_usd is None else model_usd + vm_usd
    return {
        "input_tokens": tokens[0], "output_tokens": tokens[1], "cache_read_tokens": tokens[2], "cache_write_tokens": tokens[3],
        "model_usd": model_usd, "vm_seconds": vm_seconds, "vm_usd": vm_usd, "total_usd": total,
    }


def case(scopes, runs=("honest", "inflated", "failed"), phase="done", children=0, **config):
    return {
        "config": {"dataset": "pima", "trap": "duplicates", "analyst_model": HAIKU, "investigator_model": SONNET, **config},
        "phase": phase,
        "runs": {f"r{i + 1:02d}": {"id": f"r{i + 1:02d}", "status": s} for i, s in enumerate(runs)},
        "forks": {"f1": {"id": "f1", "children": {f"control-{i + 1}": {} for i in range(children)}}} if children else {},
        "costs": {"budget_usd": 10.0, "spent_usd": None, "prices_missing": False, "scopes": scopes},
    }


def entry(batch_id, c, kind="replay", mtime=None):
    return {"id": batch_id, "kind": kind, "case": c, "mtime": mtime}


FULL = {
    "run:r01": scope(0.10, 0.01, 600, (1000, 100, 400, 50)),
    "run:r02": scope(0.20, 0.02, 1200, (2000, 200, 800, 100)),
    "fork:f1:base": scope(0.0, 0.03, 1800),
    "fork:f1:control-1": scope(0.05, 0.005, 300, (500, 50, 0, 0)),
    "investigator": scope(0.40, 0.0, 0, (4000, 400, 0, 0)),
}


def test_one_batch_is_split_by_group_and_by_kind():
    report = cost_report([entry("1114-093012-a1b2", case(FULL, children=1), mtime=datetime(2026, 11, 14, 9, 50).timestamp())])
    b = report["batches"][0]
    assert b["usd"] == {
        "total": pytest.approx(0.815), "runs": pytest.approx(0.33), "forks": pytest.approx(0.085),
        "investigator": pytest.approx(0.40), "commentary": 0.0, "other": 0.0, "model": pytest.approx(0.75), "vm": pytest.approx(0.065),
    }
    assert b["tokens"] == {"input": 7500, "output": 750, "cache_read": 1200, "cache_write": 150}
    assert b["vm_seconds"] == 3900.0
    assert b["counts"] == {"runs": 3, "honest": 1, "inflated": 1, "failed": 1, "fork_runs": 1}
    assert (b["id"], b["kind"], b["phase"], b["dataset"], b["trap"]) == ("1114-093012-a1b2", "replay", "done", "pima", "duplicates")
    assert (b["analyst_model"], b["investigator_model"]) == (HAIKU, SONNET)
    assert b["started_at"] == "2026-11-14T09:30:12"
    assert b["simulated"] is False and b["usd_partial"] is False and b["prices_missing"] is False
    # One batch: the totals are that batch.
    t = report["totals"]
    assert t["usd"] == b["usd"] and t["tokens"] == b["tokens"] and t["vm_seconds"] == 3900.0
    assert (t["batches"], t["runs"], t["honest"], t["inflated"], t["failed"], t["fork_runs"]) == (1, 3, 1, 1, 1, 1)


def test_unclear_robot_runs_are_counted_only_where_there_are_some():
    report = cost_report([entry("1114-091608-d825", case(FULL, runs=("honest", "unclear", "unclear", "inflated"), domain="robot_arm")),
                          entry("1114-093012-a1b2", case(FULL))])
    by_id = {b["id"]: b for b in report["batches"]}
    assert by_id["1114-091608-d825"]["counts"] == {"runs": 4, "honest": 1, "inflated": 1, "failed": 0, "unclear": 2, "fork_runs": 0}
    assert "unclear" not in by_id["1114-093012-a1b2"]["counts"]
    assert report["totals"]["unclear"] == 2 and report["totals"]["runs"] == 7


def test_totals_add_up_across_batches_and_models():
    other = case({"run:r01": scope(1.0, 0.1, 60, (10, 1, 0, 0)), "investigator": scope(2.0, 0.0, 0, (20, 2, 0, 0))}, runs=("honest",))
    report = cost_report([entry("1114-093012-a1b2", case(FULL)), entry("1113-080000-ffff", other, kind="live")])
    t = report["totals"]
    assert t["usd"]["total"] == pytest.approx(0.815 + 3.1)
    assert t["usd"]["runs"] + t["usd"]["forks"] + t["usd"]["investigator"] + t["usd"]["commentary"] + t["usd"]["other"] == pytest.approx(t["usd"]["total"])
    assert t["usd"]["model"] + t["usd"]["vm"] == pytest.approx(t["usd"]["total"])
    assert (t["batches"], t["runs"]) == (2, 4)
    # Runs and forks are the analyst's model, the investigator scope the investigator's. Model spend only.
    models = {m["model"]: m for m in report["by_model"]}
    assert models[SONNET]["usd"] == pytest.approx(2.4) and models[SONNET]["roles"] == ["investigator"]
    assert models[HAIKU]["usd"] == pytest.approx(0.35 + 1.0) and models[HAIKU]["roles"] == ["analyst"]
    assert models[HAIKU]["usd_by_group"] == {"runs": pytest.approx(1.3), "forks": pytest.approx(0.05), "investigator": 0.0}
    assert models[SONNET]["usd_by_group"] == {"runs": 0.0, "forks": 0.0, "investigator": pytest.approx(2.4)}
    assert models[HAIKU]["tokens"]["input"] == 3510 and models[HAIKU]["batches"] == 2
    assert sum(m["usd"] for m in report["by_model"]) == pytest.approx(t["usd"]["model"])
    assert [m["model"] for m in report["by_model"]] == [SONNET, HAIKU]  # most spend first


def test_one_model_in_both_roles_is_one_row():
    c = case({"run:r01": scope(0.1, 0, 0, (10, 1, 0, 0)), "investigator": scope(0.2, 0, 0, (20, 2, 0, 0))}, investigator_model=HAIKU)
    (m,) = cost_report([entry("x", c)])["by_model"]
    assert m["model"] == HAIKU and m["roles"] == ["analyst", "investigator"] and m["usd"] == pytest.approx(0.3)


def test_unknown_prices_do_not_poison_the_totals():
    priced = case({"run:r01": scope(0.5, 0.05, 100, (10, 1, 0, 0))}, runs=("honest",))
    unpriced = case(
        {"run:r01": scope(None, 0.02, 100, (10, 1, 0, 0)), "investigator": scope(0.3, None, 50, (5, 1, 0, 0))}, runs=("inflated",)
    )
    unpriced["costs"]["prices_missing"] = True
    report = cost_report([entry("1114-093012-a1b2", priced), entry("1114-100000-bbbb", unpriced)])
    by_id = {b["id"]: b for b in report["batches"]}
    b = by_id["1114-100000-bbbb"]
    # What is known is summed; the flag says the real figure is higher.
    assert b["usd"]["total"] == pytest.approx(0.32) and b["usd"]["model"] == pytest.approx(0.3) and b["usd"]["vm"] == pytest.approx(0.02)
    assert b["usd_partial"] is True and b["prices_missing"] is True
    assert by_id["1114-093012-a1b2"]["usd_partial"] is False
    t = report["totals"]
    assert t["usd"]["total"] == pytest.approx(0.87) and t["usd_partial"] is True
    haiku = next(m for m in report["by_model"] if m["model"] == HAIKU)
    assert haiku["usd"] == pytest.approx(0.5) and haiku["usd_partial"] is True
    assert json.dumps(report)  # no NaN, nothing that is not JSON


def test_simulated_batches_are_listed_last_and_never_totalled():
    demo = json.loads((FIXTURES_DIR / "demo-batch" / "case" / "case.json").read_text())
    report = cost_report([entry("demo-batch", demo), entry("1114-093012-a1b2", case(FULL))])
    assert [b["id"] for b in report["batches"]] == ["1114-093012-a1b2", "demo-batch"]
    sim = report["batches"][1]
    assert sim["simulated"] is True and sim["usd"] is None and sim["usd_partial"] is False and sim["started_at"] is None
    assert sim["tokens"]["input"] == 516707 and sim["counts"]["runs"] == 12 and sim["counts"]["honest"] == 6
    t = report["totals"]
    assert t["excludes_simulated"] is True
    assert (t["batches"], t["runs"], t["tokens"]["input"]) == (1, 3, 7500)
    assert t["usd"]["total"] == pytest.approx(0.815)
    assert report["simulated"] == {"batches": 1, "runs": 12, "tokens": sim["tokens"]}
    assert all(HAIKU != m["model"] or m["batches"] == 1 for m in report["by_model"])


def test_simulated_dollars_are_dropped_even_when_a_fixture_has_them():
    report = cost_report([entry("fake", case(FULL, simulated=True))])
    assert report["batches"][0]["usd"] is None and report["totals"]["usd"]["total"] == 0.0 and report["by_model"] == []


def test_batches_come_newest_first():
    ids = ["1101-120000-aaaa", "1114-093012-a1b2", "1114-093012-a1b1", "old-style-id"]
    report = cost_report([entry(i, case({})) for i in ids] + [entry("with-mtime", case({}), mtime=datetime(2026, 11, 20).timestamp())])
    assert [b["id"] for b in report["batches"]] == ["with-mtime", "1114-093012-a1b1", "1114-093012-a1b2", "1101-120000-aaaa", "old-style-id"]


def test_started_at_reads_the_id_and_falls_back_to_the_file_time():
    nov = datetime(2026, 11, 14, 10, 0).timestamp()
    assert started_at("1114-093012-a1b2", nov) == "2026-11-14T09:30:12"
    # The id has no year: a batch from December seen in January belongs to the year before.
    assert started_at("1231-235900-a1b2", datetime(2027, 1, 1, 0, 5).timestamp()) == "2026-12-31T23:59:00"
    assert started_at("1231-235900-a1b2", None, now=datetime(2027, 1, 3)) == "2026-12-31T23:59:00"
    assert started_at("1114-093012-a1b2", None, now=datetime(2026, 11, 14, 12)) == "2026-11-14T09:30:12"
    # Not a batch id, or not a real date: the case file's last change, or nothing.
    assert started_at("my-batch", nov) == "2026-11-14T10:00:00"
    assert started_at("1340-093012-a1b2", nov) == "2026-11-14T10:00:00"
    assert started_at("demo-batch", None) is None


def test_empty_and_broken_cases_still_make_a_report():
    report = cost_report([])
    assert report["batches"] == [] and report["by_model"] == [] and report["totals"]["usd"]["total"] == 0.0
    assert report["totals"]["batches"] == 0 and report["not_counted"]
    odd = cost_report([entry("a", {}), entry("b", {"runs": [], "costs": {"scopes": {"run:r01": "?", "weird": scope(0.1, 0.0)}}}), entry("c", None)])
    assert len(odd["batches"]) == 3 and odd["totals"]["usd"] == {**odd["totals"]["usd"], "total": 0.1, "other": 0.1}
    assert odd["batches"][0]["counts"] == {"runs": 0, "honest": 0, "inflated": 0, "failed": 0, "fork_runs": 0}


# ---- GET /api/costs ----

from deep_research import api  # noqa: E402
from tests.test_api import client  # noqa: E402, F401 - the fixture: BATCHES_DIR in a tmp folder, the real fixtures


class _LiveCase:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class _LiveBatch:
    def __init__(self, data):
        self.case = _LiveCase(data)

    async def close(self):  # the server closes open batches on shutdown
        pass


# The committed recordings of real batches (config.recording.kind = "live").
REAL_RECORDINGS = ("humanoid-time-travel-investigation", "1115-041219-b0a7", "1115-041132-f331", "robot-live-investigation", "tabular-leaky-column-investigation",
                   "tabular-live-investigation", "tabular-time-travel-investigation")


def test_costs_endpoint_reads_live_batches_from_memory_and_saved_ones_from_disk(client, tmp_path, monkeypatch):  # noqa: F811
    def save(batch_id, text):
        d = tmp_path / "batches" / batch_id / "case"
        d.mkdir(parents=True)
        (d / "case.json").write_text(text)

    save("1113-080000-ffff", json.dumps(case(FULL, children=1)))
    # A live batch: the file on disk is behind what the server holds in memory.
    save("1114-093012-a1b2", json.dumps(case({}, runs=("running",), phase="running")))
    in_memory = case({"run:r01": scope(0.25, 0.0, 0, (100, 10, 0, 0))}, runs=("running",), phase="running")
    monkeypatch.setattr(api, "BATCHES", {"1114-093012-a1b2": _LiveBatch(in_memory)})
    save("broken", "{not json")
    (tmp_path / "batches" / "_stats.json").write_text("{}")

    res = client.get("/api/costs")
    assert res.status_code == 200
    report = res.json()
    rows = {b["id"]: b for b in report["batches"]}
    assert [b["id"] for b in report["batches"]] == [
        "1115-041219-b0a7", "1115-041132-f331", "1114-093012-a1b2", "1113-080000-ffff", "humanoid-time-travel-investigation", "robot-live-investigation", "tabular-leaky-column-investigation", "tabular-live-investigation",
        "tabular-time-travel-investigation", "demo-batch", "humanoid-demo-batch", "robot-demo-batch", "suspects-demo-batch", "track-demo-batch"]
    assert rows["1114-093012-a1b2"]["kind"] == "live" and rows["1114-093012-a1b2"]["usd"]["total"] == 0.25
    assert rows["1113-080000-ffff"]["kind"] == "replay" and rows["1113-080000-ffff"]["started_at"].endswith("-11-13T08:00:00")
    assert rows["demo-batch"]["simulated"] is True and rows["demo-batch"]["usd"] is None and rows["demo-batch"]["started_at"] is None
    t = report["totals"]
    # The real recordings (fixtures/robot-live-investigation, fixtures/tabular-live-investigation,
    # fixtures/tabular-time-travel-investigation, fixtures/tabular-leaky-column-investigation,
    # fixtures/humanoid-time-travel-investigation and the fool-rate arms
    # fixtures/1115-041132-f331 and fixtures/1115-041219-b0a7) are real spend, counted like any saved batch.
    recordings = [rows[k] for k in REAL_RECORDINGS]
    for r in recordings:
        assert r["kind"] == "replay" and not r.get("simulated") and r["usd"]["total"] > 0
    assert rows["tabular-leaky-column-investigation"]["usd"]["total"] == pytest.approx(1.0573, abs=1e-3)
    assert t["usd"]["total"] == pytest.approx(0.815 + 0.25 + sum(r["usd"]["total"] for r in recordings))
    assert t["batches"] == 2 + len(REAL_RECORDINGS) and t["excludes_simulated"] is True
    assert report["simulated"]["batches"] == 5


def test_costs_endpoint_with_only_the_demo_batch(client):  # noqa: F811
    report = client.get("/api/costs").json()
    assert [b["id"] for b in report["batches"]] == ["1115-041219-b0a7", "1115-041132-f331", "humanoid-time-travel-investigation", "robot-live-investigation", "tabular-leaky-column-investigation", "tabular-live-investigation",
        "tabular-time-travel-investigation", "demo-batch",
                                                    "humanoid-demo-batch", "robot-demo-batch", "suspects-demo-batch",
                                                    "track-demo-batch"]
    # Only the real recordings count: the simulated fixtures are tokens only.
    live = report["batches"][:len(REAL_RECORDINGS)]
    assert sorted(b["id"] for b in live) == sorted(REAL_RECORDINGS)
    assert report["totals"]["batches"] == len(REAL_RECORDINGS)
    assert report["totals"]["usd"]["total"] == pytest.approx(sum(b["usd"]["total"] for b in live))


def test_commentary_is_its_own_group_on_its_own_model():
    c = case({"run:r01": scope(0.1, 0, 0, (10, 1, 0, 0)), "commentary": scope(0.02, 0, 0, (300, 20, 0, 0))},
             runs=("honest",), commentary_model=SONNET)
    report = cost_report([entry("1114-093012-a1b2", c)])
    b = report["batches"][0]
    assert b["usd"]["commentary"] == pytest.approx(0.02) and b["usd"]["other"] == 0.0
    models = {m["model"]: m for m in report["by_model"]}
    assert models[SONNET]["roles"] == ["commentary"] and models[SONNET]["usd_by_group"]["commentary"] == pytest.approx(0.02)
    assert models[HAIKU]["roles"] == ["analyst"]
