"""A server restart (a deploy, a machine out of memory) cuts batches off mid-way. What it leaves behind is closed when
the server starts again (batch.recover_interrupted): no batch says "running" or "investigating" forever, an event log
with a half-written last line still reads, and an investigation cut off continues on its saved thread."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from deep_research import api
from deep_research.batch import RESTARTED, RUN_CUT, Batch, recover_interrupted, resume_problem
from deep_research.config import BatchConfig
from deep_research.events import read_events
from tests.test_time_travel_offline import _case, vms  # noqa: F401 - the fixture is used by name


def _write(path, case: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(case))


def test_a_log_cut_off_mid_line_still_reads(tmp_path, caplog):
    log = tmp_path / "events.jsonl"
    log.write_text('{"t": 1, "type": "thought", "text": "a"}\n{"t": 2, "type": "tool_call", "na\n'
                   '\n{"t": 3, "type": "thought", "text": "b"}\n[1, 2]\n{"t": 4, "type": "tool_re')
    assert [e["t"] for e in read_events(log)] == [1, 3]
    assert "skipped 3 line(s)" in caplog.text


async def test_a_restart_closes_what_it_cut_off_and_leaves_the_rest(vms, tmp_path):  # noqa: F811
    root = tmp_path / "batches"
    # A real batch whose runs finished and split, cut off while its investigator worked.
    b = Batch(BatchConfig(n_runs=3), batch_id="inv", root=root)
    await b.run_all()
    await b.close()
    assert _case(b)["phase"] == "ready"
    # Each run says how long the server's own scoring took.
    assert all(isinstance(r["score_s"], float) and r["score_s"] >= 0 for r in _case(b)["runs"].values())
    case = _case(b)
    case["phase"] = "investigating"
    case["investigator"] = {"thread_id": "inv-investigator"}
    _write(b.dir / "case" / "case.json", case)
    # A batch cut off while its agents ran: one scored, one running on a VM, one still queued; and an experiment.
    _write(root / "run" / "case" / "case.json", {
        "config": {"domain": "robot_arm"}, "phase": "running", "forks": {
            "f1": {"id": "f1", "status": "running", "children": {"control-1": {"status": "honest"}, "forced-1": {"status": "running"}}},
            "f0": {"id": "f0", "status": "done", "children": {}}},
        "runs": {"r01": {"id": "r01", "status": "honest", "vm_id": "vm-1"},
                 "r02": {"id": "r02", "status": "running", "vm_id": "vm-2", "lab_url": "https://lab"},
                 "r03": {"id": "r03", "status": "queued"}}})
    # Batches waiting on a person, or over, are left alone.
    for name, phase in (("ready", "ready"), ("waiting", "awaiting_approval"), ("over", "done")):
        _write(root / name / "case" / "case.json", {"config": {}, "phase": phase, "runs": {}, "forks": {}})

    closed = recover_interrupted(root)
    assert closed == [{"id": "inv", "phase": "investigating", "vm_ids": []},
                      {"id": "run", "phase": "running", "vm_ids": ["vm-2"]}]

    run = json.loads((root / "run" / "case" / "case.json").read_text())
    assert run["phase"] == "stopped"
    assert run["interrupted"]["phase"] == "running" and run["interrupted"]["reason"] == RESTARTED
    assert run["runs"]["r01"]["status"] == "honest"
    assert run["runs"]["r02"] == {"id": "r02", "status": "failed", "vm_id": "vm-2", "lab_url": None, "reason": RUN_CUT}
    assert run["runs"]["r03"]["status"] == "failed"
    assert run["forks"]["f1"]["status"] == "stopped"
    assert run["forks"]["f1"]["children"] == {"control-1": {"status": "honest"}, "forced-1": {"status": "failed", "reason": RUN_CUT}}
    assert run["forks"]["f0"]["status"] == "done"
    # The investigator's view of the case is rewritten with it.
    assert json.loads((root / "run" / "case" / "view" / "case.json").read_text())["phase"] == "stopped"
    for name, phase in (("ready", "ready"), ("waiting", "awaiting_approval"), ("over", "done")):
        assert json.loads((root / name / "case" / "case.json").read_text())["phase"] == phase
    # Run again (a second restart): nothing more to close.
    assert recover_interrupted(root) == []

    # The investigation cut off can be picked up again, and comes back ready to continue.
    inv = json.loads((root / "inv" / "case" / "case.json").read_text())
    assert inv["phase"] == "stopped" and inv["interrupted"]["phase"] == "investigating"
    assert resume_problem(inv, root / "inv") is None
    back = Batch.resume("inv", root)
    assert back.case.data["phase"] == "ready"
    assert back.can_continue() == back.checkpoints_path.is_file()
    await back.close()


async def test_continuing_without_a_saved_thread_starts_a_new_investigation(tmp_path, monkeypatch):
    b = Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    started = []

    async def investigate(self, opening="Investigate this batch."):
        started.append("new")

    monkeypatch.setattr(Batch, "investigate", investigate)
    assert not b.can_continue()
    await b.continue_investigation()
    assert started == ["new"]
    await b.close()


def test_the_server_closes_cut_off_batches_when_it_starts_and_continues_on_request(tmp_path, monkeypatch):
    root = tmp_path / "batches"
    monkeypatch.setattr(api, "BATCHES_DIR", root)
    monkeypatch.setattr(api, "STATS_FILE", root / "_stats.json")
    _write(root / "b1" / "case" / "case.json", {"config": {}, "phase": "running", "forks": {},
                                                 "runs": {"r01": {"id": "r01", "status": "running", "vm_id": "vm-9"}}})
    deleted = []
    monkeypatch.setattr(api, "_delete_vms", lambda ids: deleted.extend(ids))
    with TestClient(api.app) as c:
        case = c.get("/api/batches/b1/case").json()
    assert case["phase"] == "stopped" and case["interrupted"]["phase"] == "running"
    assert deleted == ["vm-9"]


async def test_resume_with_continue_picks_the_saved_investigator_up(vms, tmp_path, monkeypatch):  # noqa: F811
    root = tmp_path / "batches"
    b = Batch(BatchConfig(n_runs=3), batch_id="inv", root=root)
    await b.run_all()
    await b.close()
    case = _case(b)
    case.update(phase="stopped", interrupted={"at": 0, "phase": "investigating", "reason": RESTARTED})
    _write(b.dir / "case" / "case.json", case)
    monkeypatch.setattr(api, "BATCHES_DIR", root)
    calls = []

    async def cont(self):
        calls.append("continue")

    async def new(self, opening="Investigate this batch."):
        calls.append("new")

    monkeypatch.setattr(Batch, "continue_investigation", cont)
    monkeypatch.setattr(Batch, "investigate", new)
    out = await api._resume("inv", investigate=True, cont=True)
    await api.TASKS["inv"]
    assert out["phase"] == "ready" and calls == ["continue"]
    await api.BATCHES.pop("inv").close()
    api.TASKS.pop("inv", None)
