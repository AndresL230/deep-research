"""VM time is counted from the moment a VM is up until it is deleted, for runs, fork children and the fork base.

No network: the Daytona helpers are fakes that move a fake clock.
"""

from types import SimpleNamespace

import pytest

from deep_research import batch as batch_mod
from deep_research import costs
from deep_research.config import BatchConfig
from deep_research.costs import CostTracker

REBUILD_S, AGENT_S, DELETE_S = 60, 100, 5


@pytest.fixture
def clock(monkeypatch):
    """The tracker's clock, moved by hand. Only costs.py sees it; asyncio keeps the real one."""
    now = {"t": 1000.0}
    monkeypatch.setattr(costs, "time", SimpleNamespace(monotonic=lambda: now["t"]))
    return now


@pytest.fixture
def daytona(monkeypatch, clock):
    """Fake VMs: rebuilding, the agent and deleting each take a known time."""
    made, deleted = [], []

    def create_vm(label):
        made.append(label)
        return SimpleNamespace(id=label)

    def replay_actions(vm, actions):
        clock["t"] += REBUILD_S

    def delete_vm(vm):
        clock["t"] += DELETE_S
        deleted.append(vm.id)

    async def drive(self, *args, **kwargs):
        clock["t"] += AGENT_S
        return []

    monkeypatch.setattr(batch_mod.vms, "create_vm", create_vm)
    monkeypatch.setattr(batch_mod.vms, "load_task", lambda vm, task: None)
    monkeypatch.setattr(batch_mod.vms, "replay_actions", replay_actions)
    monkeypatch.setattr(batch_mod.vms, "start_lab_page", lambda vm: None)
    monkeypatch.setattr(batch_mod.vms, "download_outputs", lambda vm, dest: None)
    monkeypatch.setattr(batch_mod.vms, "download_charts", lambda vm, dest: [])
    monkeypatch.setattr(batch_mod.vms, "delete_vm", delete_vm)
    monkeypatch.setattr(batch_mod, "build_analyst", lambda backend, model: object())
    monkeypatch.setattr(batch_mod, "DaytonaSandbox", lambda sandbox: SimpleNamespace(execute=lambda cmd: SimpleNamespace(output="ok")))
    monkeypatch.setattr(batch_mod.Batch, "_drive", drive)
    # One VM at a time, so each one's time on the shared fake clock is its own.
    monkeypatch.setattr(batch_mod, "MAX_PARALLEL_VMS", 1)
    return SimpleNamespace(made=made, deleted=deleted)


async def test_a_run_is_billed_until_its_vm_is_deleted(tmp_path, daytona):
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    await b.run_one("r01")
    assert daytona.deleted == ["t-r01"]
    # Not only while the agent worked: deleting the VM takes time too, and it bills until it is gone.
    assert b.tracker.scopes["run:r01"].vm_seconds == AGENT_S + DELETE_S
    assert b.case.data["costs"]["scopes"]["run:r01"]["vm_seconds"] == AGENT_S + DELETE_S


async def test_a_run_that_fails_early_is_still_billed_for_its_vm(tmp_path, daytona, monkeypatch, clock):
    def broken(vm, task):
        clock["t"] += 30
        raise RuntimeError("upload failed")

    monkeypatch.setattr(batch_mod.vms, "load_task", broken)
    b = batch_mod.Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    await b.run_one("r01")
    assert b.case.data["runs"]["r01"]["status"] == "failed"
    assert b.tracker.scopes["run:r01"].vm_seconds == 30 + DELETE_S


def _ready_to_fork(tmp_path, monkeypatch):
    # Control and forced only: the billing in these tests is worked out for two children.
    b = batch_mod.Batch(BatchConfig(n_runs=1, placebo_arm=False, show_arm=False), batch_id="t", root=tmp_path)
    (b.runs_dir / "r01").mkdir(parents=True, exist_ok=True)
    (b.runs_dir / "r01" / "messages.json").write_text("[]")
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r01", "fork_at": 0})
    monkeypatch.setattr(batch_mod, "intervention_for", lambda *a, **k: {"description": "Remove the copies", "command": "true"})
    return b


async def test_fork_children_and_the_base_are_billed_until_deleted(tmp_path, daytona, monkeypatch):
    monkeypatch.setattr(batch_mod.vms, "fork_vm", lambda base, name: SimpleNamespace(id=name))
    b = _ready_to_fork(tmp_path, monkeypatch)
    await b.run_forks(1)
    scopes = b.tracker.scopes
    assert sorted(daytona.deleted) == ["t-f1-base", "t-f1-control-1", "t-f1-forced-1"] and b.vms == {}
    child = AGENT_S + DELETE_S
    assert scopes["fork:f1:control-1"].vm_seconds == child and scopes["fork:f1:forced-1"].vm_seconds == child
    # The base stays up while its children run, and is deleted after them.
    assert scopes["fork:f1:base"].vm_seconds == REBUILD_S + 2 * child + DELETE_S
    assert b.tracker._vm_started == {}  # no clock left running


async def test_a_fork_child_rebuilt_by_replay_is_billed_for_the_rebuild(tmp_path, daytona, monkeypatch):
    def no_fork(base, name):
        raise RuntimeError("forking is not available")

    monkeypatch.setattr(batch_mod.vms, "fork_vm", no_fork)
    b = _ready_to_fork(tmp_path, monkeypatch)
    await b.run_forks(1)
    children = b.case.data["forks"]["f1"]["children"]
    assert children["control-1"]["how"] == "replay"
    # The VM is up while it replays the run's first steps: that minute counts.
    assert b.tracker.scopes["fork:f1:control-1"].vm_seconds == REBUILD_S + AGENT_S + DELETE_S
    assert b.tracker._vm_started == {}


def test_a_running_vm_shows_in_the_snapshot_before_it_is_deleted(clock):
    t = CostTracker(budget_usd=1.0, prices={"models": {}, "daytona_vm_per_hour": 0.36})
    t.vm_started("run:r01")
    clock["t"] += 1800
    # Half an hour in, still up. A server killed now has this in the case file, not zero.
    live = t.snapshot()
    assert live["scopes"]["run:r01"]["vm_seconds"] == 1800 and live["scopes"]["run:r01"]["vm_usd"] == pytest.approx(0.18)
    assert live["spent_usd"] == pytest.approx(0.18) and t.total_usd() == pytest.approx(0.18)
    clock["t"] += 1800
    t.vm_stopped("run:r01")
    done = t.snapshot()
    # Counted once: the running time is not added on top of the final figure.
    assert done["scopes"]["run:r01"]["vm_seconds"] == 3600 and done["spent_usd"] == pytest.approx(0.36)
    clock["t"] += 999
    assert t.snapshot() == done


def test_a_running_vm_without_a_vm_price_leaves_dollars_unknown(clock):
    t = CostTracker(budget_usd=1.0, prices={"models": {}, "daytona_vm_per_hour": None})
    t.vm_started("fork:f1:base")
    clock["t"] += 60
    snap = t.snapshot()
    assert snap["scopes"]["fork:f1:base"]["vm_seconds"] == 60 and snap["scopes"]["fork:f1:base"]["vm_usd"] is None
    assert snap["spent_usd"] is None and snap["prices_missing"] is True
