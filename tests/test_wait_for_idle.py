"""The deploy hold (scripts/wait_for_idle.py): a deploy waits while a live batch is working, never on one that waits
on a person, and never on a server it cannot read."""

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("wait_for_idle", Path(__file__).parent.parent / "scripts" / "wait_for_idle.py")
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def b(id_, kind, phase):
    return {"id": id_, "kind": kind, "summary": {"phase": phase}}


def test_only_live_batches_with_work_running_hold_a_deploy():
    batches = [b("a", "live", "running"), b("b", "live", "awaiting_approval"), b("c", "live", "ready"),
               b("d", "replay", "investigating"), b("e", "live", "investigating"), b("f", "live", "done"), {"id": "g"}]
    assert w.working(batches) == ["a (running)", "e (investigating)"]


def test_waits_until_they_finish_then_deploys(capsys):
    answers = iter([[b("a", "live", "running")], [b("a", "live", "forking")], [b("a", "live", "done")]])
    clock = iter([0, 0, 60, 120])
    slept = []
    assert w.main(["--url", "https://x", "--every", "60"], sleep=slept.append, now=lambda: next(clock),
                  get=lambda url: next(answers)) == 0
    assert slept == [60, 60]
    out = capsys.readouterr().out
    assert "waiting for 1 running batch(es): a (running)" in out and out.rstrip().endswith("deploying")


def test_gives_up_after_the_max_wait_and_names_them(capsys):
    clock = iter([0, 100])
    assert w.main(["--url", "https://x", "--max-wait", "90"], sleep=lambda s: None, now=lambda: next(clock),
                  get=lambda url: [b("a", "live", "investigating")]) == 1
    assert "::error::still running after 2 min: a (investigating)" in capsys.readouterr().out


def test_a_server_it_cannot_read_does_not_hold_a_deploy(capsys):
    def down(url):
        raise OSError("connection refused")

    assert w.main(["--url", "https://x"], sleep=lambda s: None, get=down) == 0
    assert "::warning::could not read https://x/api/batches" in capsys.readouterr().out
