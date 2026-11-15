"""`stop_all_vms` stops only this app's started VMs, and survives a failed stop. No network."""

from types import SimpleNamespace

from deep_research import sandboxes


class FakeVM(SimpleNamespace):
    def stop(self):
        if self.fail:
            raise RuntimeError("boom")
        self.stopped = True


def test_stop_all_vms_only_stops_our_started_vms(monkeypatch):
    vms = [
        FakeVM(id="a", labels={"app": "deep-research"}, state="SandboxState.STARTED", fail=False, stopped=False),
        FakeVM(id="b", labels={"app": "deep-research"}, state="SandboxState.STOPPED", fail=False, stopped=False),
        FakeVM(id="c", labels={"app": "other"}, state="SandboxState.STARTED", fail=False, stopped=False),
        FakeVM(id="d", labels=None, state="SandboxState.STARTED", fail=False, stopped=False),
        FakeVM(id="e", labels={"app": "deep-research"}, state="SandboxState.STARTED", fail=True, stopped=False),
    ]
    monkeypatch.setattr(sandboxes, "client", lambda: SimpleNamespace(list=lambda: iter(vms)))

    assert [v.id for v in sandboxes.running_vms()] == ["a", "e"]
    assert sandboxes.stop_all_vms() == (1, 1)
    assert [v.id for v in vms if v.stopped] == ["a"]


async def test_a_vm_still_being_made_when_the_batch_is_stopped_is_deleted_once_it_exists(tmp_path, monkeypatch):
    """The fork VMs are made in a thread; a cancel does not stop the thread, so its VM must be deleted on arrival."""
    import asyncio
    import threading

    from deep_research import batch as batch_mod
    from deep_research.batch import Batch
    from deep_research.config import BatchConfig

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(n_runs=1), batch_id="t", root=tmp_path)
    release, deleted = threading.Event(), []

    def slow_fork(base, label):
        release.wait(5)
        return f"vm:{label}"

    monkeypatch.setattr(batch_mod.vms, "delete_vm", deleted.append)
    task = asyncio.ensure_future(b._new_vm("f1-control-1", slow_fork, "base", "t-f1-control-1"))
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
    assert deleted == ["vm:t-f1-control-1"] and "f1-control-1" not in b.vms
