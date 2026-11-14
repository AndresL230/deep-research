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
