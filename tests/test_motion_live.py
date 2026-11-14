"""A robot run's motion files come in while it runs (batch.MotionWatch, sandboxes.poll_live_files).

A fake VM holds the workspace as a dict and files appear in its live folder over time, as an agent saves its
episodes. The watch pulls each new file once, waits for a half-written one to parse, logs a `motion` event for each,
keeps the run's `motion_files` up to date and stops when the run ends. A tabular run is never watched.
"""

import asyncio
import json
from types import SimpleNamespace as NS

import pytest

from deep_research import batch as batch_mod
from deep_research import domains
from deep_research import sandboxes as vms
from deep_research.batch import Batch
from deep_research.config import VM_LIVE_DIR, VM_WORKSPACE, BatchConfig
from deep_research.events import read_events

POLL_S = 0.02


def _episode(name: str, x: float = 0.5) -> bytes:
    return json.dumps({"header": {"name": name, "can_start": [x, 0.0]}, "frames": []}).encode()


class FakeVM:
    """A Daytona sandbox whose workspace is a dict, with a size and a modification time per file, as Daytona lists."""

    def __init__(self):
        self.id = "vm-fake"
        self.files: dict[str, bytes] = {}
        self.mtime: dict[str, int] = {}
        self.clock = 0
        self.lists = 0
        self.downloads: list[str] = []
        self.fail_list = False
        self.fs = NS(upload_file=self.put_at, download_file=self._download, list_files=self._list)
        self.process = NS(exec=lambda command: NS(exit_code=0, result=""))

    def put_at(self, data: bytes, path: str) -> None:
        self.clock += 1
        self.files[path] = data
        self.mtime[path] = self.clock

    def put(self, rel: str, data: bytes) -> None:
        self.put_at(data, f"{VM_WORKSPACE}/{rel}")

    def touch(self, rel: str) -> None:
        self.clock += 1
        self.mtime[f"{VM_WORKSPACE}/{rel}"] = self.clock

    def _download(self, path: str) -> bytes:
        self.downloads.append(path)
        return self.files[path]

    def _list(self, folder: str) -> list:
        self.lists += 1
        if self.fail_list:
            raise RuntimeError("the toolbox is busy")
        folder = folder.rstrip("/") + "/"
        return [NS(name=p[len(folder):], is_dir=False, size=len(d), modified_at=f"2026-11-14T10:00:{self.mtime[p]:02d}Z")
                for p, d in self.files.items() if p.startswith(folder) and "/" not in p[len(folder):]]


PATTERNS = vms.live_globs(domains.get("robot_arm").output_globs)


# ---- one look at the live folder ----

def test_the_live_globs_are_the_robot_ones_in_the_live_folder():
    assert PATTERNS == ["live/*.motion.json", "live/motion*.json"]
    assert vms.live_globs(domains.get("tabular").output_globs) == []


def test_a_look_saves_each_new_file_once_and_waits_for_a_half_written_one(tmp_path):
    sb, seen = FakeVM(), {}
    sb.put("live/a.motion.json", _episode("a"))
    sb.put("live/notes.txt", b"not an episode")
    sb.put("live/b.motion.json", _episode("b")[:20])  # still being written

    assert vms.poll_live_files(sb, tmp_path, PATTERNS, seen, 30) == ["live/a.motion.json"]
    assert (tmp_path / "live" / "a.motion.json").read_bytes() == _episode("a")
    assert not (tmp_path / "live" / "b.motion.json").exists()
    assert not list((tmp_path / "live").glob(".*"))  # no partial file left behind

    # Nothing new: one list call, no download.
    sb.downloads.clear()
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, seen, 30) == []
    assert sb.downloads == [f"{VM_LIVE_DIR}/b.motion.json"]  # only the one that did not parse is tried again

    sb.put("live/b.motion.json", _episode("b"))
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, seen, 30) == ["live/b.motion.json"]

    # Saved again with the same bytes: not news. With new bytes: it is.
    sb.touch("live/a.motion.json")
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, seen, 30) == []
    sb.put("live/a.motion.json", _episode("a", 0.3))
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, seen, 30) == ["live/a.motion.json"]
    assert json.loads((tmp_path / "live" / "a.motion.json").read_bytes())["header"]["can_start"] == [0.3, 0.0]


def test_a_look_takes_only_the_newest_files_and_never_raises(tmp_path):
    sb = FakeVM()
    for i in range(5):
        sb.put(f"live/e{i}.motion.json", _episode(f"e{i}"))
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, {}, 2) == ["live/e3.motion.json", "live/e4.motion.json"]

    sb.fail_list = True
    assert vms.poll_live_files(sb, tmp_path, PATTERNS, {}, 30) == []
    sb.fail_list = False
    sb.fs.download_file = lambda path: (_ for _ in ()).throw(RuntimeError("gone"))
    assert vms.poll_live_files(sb, tmp_path / "other", PATTERNS, {}, 30) == []


# ---- a robot run, watched while it runs ----

sim_domain = pytest.importorskip("sim.domain")


def _robot_batch(tmp_path, monkeypatch) -> tuple[Batch, FakeVM]:
    sb = FakeVM()
    monkeypatch.setattr(batch_mod, "MOTION_POLL_S", POLL_S)
    monkeypatch.setattr(batch_mod.vms, "create_vm", lambda label, domain=None: sb)
    monkeypatch.setattr(batch_mod.vms, "start_lab_page", lambda sb: None)
    monkeypatch.setattr(batch_mod.vms, "download_charts", lambda sb, dest: [])
    monkeypatch.setattr(batch_mod.vms, "delete_vm", lambda sb: None)
    monkeypatch.setattr(batch_mod, "build_analyst", lambda backend, model: object())
    monkeypatch.setattr(batch_mod, "DaytonaSandbox", lambda sandbox: object())
    monkeypatch.setattr(sim_domain, "_evaluate_fn", lambda: lambda *a, **k: {"success_rate": 0.2})
    b = Batch(BatchConfig(domain="robot_arm", n_runs=1), batch_id="t", root=tmp_path / "batches")
    return b, sb


async def _until(cond, timeout: float = 3.0) -> None:
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


def _agent_that_practices(sb: FakeVM, seen_mid_run: list):
    async def drive(self, agent, inp, thread_id, scope, model, log, on_event):
        on_event(log.write({"type": "tool_call", "id": "c1", "name": "execute", "args": {"command": "python3 -m sim.run"}}))
        sb.put("live/first.motion.json", _episode("first"))
        await _until(lambda: self.case.data["runs"]["r01"].get("motion_files"))
        seen_mid_run.append(list(self.case.data["runs"]["r01"]["motion_files"]))

        sb.put("live/second.motion.json", _episode("second")[:30])  # half written
        await asyncio.sleep(POLL_S * 6)
        seen_mid_run.append(list(self.case.data["runs"]["r01"]["motion_files"]))
        sb.put("live/second.motion.json", _episode("second"))
        await _until(lambda: len(self.case.data["runs"]["r01"].get("motion_files", [])) == 2)

        # Saved again with a new result: it is the newest episode again.
        sb.put("live/first.motion.json", _episode("first", 0.3))
        await _until(lambda: self.case.data["runs"]["r01"]["motion_files"][-1].endswith("first.motion.json"))
        seen_mid_run.append(list(self.case.data["runs"]["r01"]["motion_files"]))

        # The last episode lands just before the run ends: the final download brings it in.
        sb.put("live/last.motion.json", _episode("last"))
        sb.put("controller.py", b"class Controller: pass\n")
        sb.put("report.json", b'{"success_rate": 1.0, "episodes_run": 3, "notes": ""}')
        on_event(log.write({"type": "tool_call", "id": "w", "name": "write_file",
                            "args": {"file_path": f"{VM_WORKSPACE}/report.json", "content": "{}"}}))
        return []

    return drive


async def test_a_robot_run_shows_its_episodes_as_they_are_saved(tmp_path, monkeypatch):
    b, sb = _robot_batch(tmp_path, monkeypatch)
    seen_mid_run: list = []
    monkeypatch.setattr(Batch, "_drive", _agent_that_practices(sb, seen_mid_run))
    q = b.subscribe()
    updates: list = []
    b.case.subscribe(lambda section, value: updates.append(json.loads(json.dumps(value))) if section == "runs" else None)
    await b.run_one("r01")

    first, second, last = (f"runs/r01/outputs/live/{n}.motion.json" for n in ("first", "second", "last"))
    assert seen_mid_run == [[first], [first], [second, first]]
    run = b.case.data["runs"]["r01"]
    assert run["status"] in ("honest", "inflated")
    assert run["motion_files"] == [second, first, last]
    assert all((b.dir / p).is_file() for p in run["motion_files"])
    assert json.loads((b.dir / first).read_text())["header"]["can_start"] == [0.3, 0.0]  # the final version

    # One event per arrival, on the run's clock, never one for the half-written file or the final re-download.
    events = read_events(b.runs_dir / "r01" / "events.jsonl")
    motion = [e for e in events if e["type"] == "motion"]
    assert [e["path"] for e in motion] == [first, second, first, last]
    assert all(isinstance(e["t"], float) for e in motion)
    assert [e["t"] for e in motion] == sorted(e["t"] for e in motion)
    # They never count as the agent's actions.
    assert run["n_actions"] == 2

    # The websocket got each one, and the case updates with the files.
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    pushed = [m["event"]["path"] for m in msgs if m["kind"] == "event" and m["event"]["type"] == "motion"]
    assert pushed == [first, second, first, last]
    assert any(m["kind"] == "case" and m["section"] == "runs" for m in msgs)
    files_seen = [u["r01"].get("motion_files") for u in updates]
    assert [first] in files_seen and [first, second] in files_seen and [second, first] in files_seen
    assert files_seen.index([first]) < files_seen.index([first, second]) < files_seen.index([second, first])

    # The watch stopped with the run: no more looks at the VM.
    lists = sb.lists
    await asyncio.sleep(POLL_S * 5)
    assert sb.lists == lists


async def test_a_failing_look_never_stops_the_run(tmp_path, monkeypatch, caplog):
    b, sb = _robot_batch(tmp_path, monkeypatch)

    def broken(*a, **k):
        raise RuntimeError("the toolbox is down")

    monkeypatch.setattr(batch_mod.vms, "poll_live_files", broken)

    async def drive(self, agent, inp, thread_id, scope, model, log, on_event):
        await asyncio.sleep(POLL_S * 5)
        sb.put("live/practice.motion.json", _episode("practice"))
        sb.put("controller.py", b"class Controller: pass\n")
        sb.put("report.json", b'{"success_rate": 1.0, "episodes_run": 1, "notes": ""}')
        return []

    monkeypatch.setattr(Batch, "_drive", drive)
    with caplog.at_level("WARNING"):
        await b.run_one("r01")
    run = b.case.data["runs"]["r01"]
    assert run["status"] != "failed", run
    assert run["motion_files"] == ["runs/r01/outputs/live/practice.motion.json"]  # from the final download
    assert "the toolbox is down" in caplog.text


async def test_a_run_that_fails_keeps_the_episodes_it_saved_and_stops_watching(tmp_path, monkeypatch):
    b, sb = _robot_batch(tmp_path, monkeypatch)

    async def drive(self, agent, inp, thread_id, scope, model, log, on_event):
        sb.put("live/practice.motion.json", _episode("practice"))
        await _until(lambda: self.case.data["runs"]["r01"].get("motion_files"))
        raise RuntimeError("the model went away")

    monkeypatch.setattr(Batch, "_drive", drive)
    await b.run_one("r01")
    run = b.case.data["runs"]["r01"]
    assert run["status"] == "failed" and "the model went away" in run["reason"]
    assert run["motion_files"] == ["runs/r01/outputs/live/practice.motion.json"]
    lists = sb.lists
    await asyncio.sleep(POLL_S * 5)
    assert sb.lists == lists


async def test_a_tabular_run_is_never_watched(tmp_path, monkeypatch):
    from tests.local_vm import install_local_vms
    from tests.scripted import script_analysts
    from tests.test_batch_offline import _script_for

    install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script_for)
    looks = []
    monkeypatch.setattr(batch_mod, "MOTION_POLL_S", POLL_S)
    monkeypatch.setattr(batch_mod.vms, "poll_live_files", lambda *a, **k: looks.append(a) or [])
    b = Batch(BatchConfig(n_runs=2), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    case = b.case.data
    assert all(r["status"] in ("honest", "inflated") for r in case["runs"].values())
    assert looks == []
    assert not any("motion_files" in r for r in case["runs"].values())
    for r in case["runs"]:
        assert not [e for e in read_events(b.runs_dir / r / "events.jsonl") if e["type"] == "motion"]
    await b.close()
