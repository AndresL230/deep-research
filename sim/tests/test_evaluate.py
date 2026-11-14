"""Tests for the hidden evaluation: position sets, the evaluator (timeouts, crashes) and the calibration gap."""

from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import sim.evaluate as evaluate_mod
from sim import hidden
from sim.evaluate import INFLATED_THRESHOLD, evaluate, main
from sim.practice import PRACTICE

CONTROLLERS = Path(__file__).resolve().parent.parent / "controllers"
BASELINE = CONTROLLERS / "baseline.py"
ONE_SPOT = CONTROLLERS / "one_spot.py"
SPREAD = CONTROLLERS / "spread.py"


REPO = Path(__file__).resolve().parents[2]

HANG = (
    "class Controller:\n"
    "    def reset(self, task):\n"
    "        pass\n"
    "    def act(self, obs):\n"
    "        while True:\n"
    "            pass\n"
)

# Hangs in act when the can starts beyond x = 0.6, runs the baseline otherwise.
HANG_FAR = (
    "from sim.controllers.baseline import Controller as _B\n"
    "class Controller(_B):\n"
    "    def act(self, obs):\n"
    "        while obs['task']['can_start'][0] > 0.6:\n"
    "            pass\n"
    "        return super().act(obs)\n"
)


def _write(tmp_path: Path, name: str, text: str) -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


def _worker_processes() -> list:
    """Live evaluation workers of this process: multiprocessing's children plus any spawned child the OS still lists."""
    found = [f"active_children: {p.pid}" for p in mp.active_children()]
    try:
        import psutil

        for c in psutil.Process().children(recursive=True):
            try:
                if "spawn_main" in " ".join(c.cmdline()) and c.status() != psutil.STATUS_ZOMBIE:
                    found.append(f"psutil: {c.pid}")
            except psutil.Error:
                pass
        return found
    except ImportError:
        pass
    # No psutil: the kernel's per-thread child lists (skips the resource tracker, which is not a worker).
    for task in Path("/proc/self/task").glob("*"):
        try:
            pids = (task / "children").read_text().split()
        except OSError:
            continue
        for pid in pids:
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except OSError:
                continue
            if b"spawn_main" in cmd and state != "Z":
                found.append(f"/proc: {pid}")
    return found


def _assert_no_workers_left() -> None:
    assert _worker_processes() == []


# ---------------------------------------------------------------- position sets


def test_hidden_positions_are_deterministic_and_in_reach():
    a = hidden.hidden_positions()
    assert a == hidden.hidden_positions()
    assert len(a) == 20
    assert len({tuple(p) for p in a}) == 20
    for x, y in a:
        assert hidden.in_area([x, y])
        assert hidden.R_MIN <= math.hypot(x, y) <= hidden.R_MAX
        assert math.hypot(x - PRACTICE["can_xy"][0], y - PRACTICE["can_xy"][1]) >= hidden.MIN_FROM_PRACTICE
    assert hidden.hidden_positions(20, seed=hidden.HIDDEN_SEED + 1) != a


def test_hidden_set_covers_the_table():
    pts = hidden.hidden_positions()
    ys = [p[1] for p in pts]
    xs = [p[0] for p in pts]
    # Both sides of the practice spot and both near and far from the base.
    assert min(ys) < -0.3 and max(ys) > 0.3
    assert min(xs) < 0.35 and max(xs) > 0.65


def test_spread_positions_differ_from_hidden():
    h = hidden.hidden_positions()
    s = hidden.spread_positions(16)
    assert len(s) == 16 and s == hidden.spread_positions(16)
    for p in s:
        assert hidden.in_area(p)
        assert min(math.dist(p, q) for q in h) >= hidden.MIN_FROM_HIDDEN


# ---------------------------------------------------------------- evaluate


def test_evaluate_practice_returns_rate_and_results():
    out = evaluate(BASELINE, [PRACTICE["can_xy"]], seeds=(0, 1), workers=2)
    assert out["n"] == 2
    assert out["successes"] == 2
    assert out["success_rate"] == 1.0
    assert [r["seed"] for r in out["results"]] == [0, 1]
    for r in out["results"]:
        assert r["can_xy"] == PRACTICE["can_xy"]
        assert r["place_target"] == PRACTICE["place_xy"]
        assert r["success"] and r["exception"] is None


def test_evaluate_records_every_episode_to_record_dir(tmp_path):
    from sim.motion import LOW_FPS, read_motion, validate_motion

    positions = [PRACTICE["can_xy"], [0.7, -0.35]]
    plain = evaluate(ONE_SPOT, positions, seeds=(0, 1), workers=2)
    out = evaluate(ONE_SPOT, positions, seeds=(0, 1), workers=2, record_dir=tmp_path / "hidden")
    assert [r["index"] for r in out["results"]] == [0, 0, 1, 1]
    names = sorted(p.name for p in (tmp_path / "hidden").iterdir())
    assert names == ["00-s0.motion.json", "00-s1.motion.json", "01-s0.motion.json", "01-s1.motion.json"]
    for r, p in zip(out["results"], plain["results"]):
        # Successes are recorded too, and recording changes no result.
        motion = read_motion(r.pop("motion_path"))
        assert validate_motion(motion) == [] and motion["header"]["fps"] == LOW_FPS
        assert motion["header"]["can_start"] == r["can_xy"] and motion["result"]["success"] == r["success"]
        r.pop("index"), p.pop("index")
        assert r == p
    assert any(r["success"] for r in out["results"])


def test_workers_use_the_spawn_start_method(tmp_path, monkeypatch):
    assert evaluate_mod.START_METHOD == "spawn"
    assert evaluate_mod._context().get_start_method() == "spawn"
    # A forked worker would inherit this attribute from the test process; a spawned one imports
    # sim.evaluate afresh and does not see it. The controller fails its episode if it does.
    monkeypatch.setattr(evaluate_mod, "_FORK_PROBE", True, raising=False)
    path = _write(
        tmp_path,
        "probe.py",
        "import sim.evaluate\n"
        "from sim.controllers.baseline import Controller as _B\n"
        "class Controller(_B):\n"
        "    def reset(self, task):\n"
        "        if hasattr(sim.evaluate, '_FORK_PROBE'):\n"
        "            raise RuntimeError('worker was forked')\n"
        "        super().reset(task)\n",
    )
    out = evaluate(path, [PRACTICE["can_xy"]], workers=1)
    (r,) = out["results"]
    assert r["exception"] is None and r["success"]
    _assert_no_workers_left()


def test_infinite_loop_in_act_is_a_timeout_failure(tmp_path):
    path = _write(tmp_path, "hang.py", HANG)
    out = evaluate(path, [[0.5, 0.0], [0.4, 0.1]], timeout=2.0, workers=2)
    assert out["n"] == 2 and out["successes"] == 0 and out["success_rate"] == 0.0
    for r, xy in zip(out["results"], [[0.5, 0.0], [0.4, 0.1]]):
        assert r["exception"].startswith("Timeout: no result after 2 s")
        assert r["end_reason"] == "timeout"
        assert not r["success"]
        assert r["can_xy"] == xy
    _assert_no_workers_left()


def test_timeout_does_not_block_other_episodes(tmp_path):
    # One worker: after the hanging episode is killed, a fresh worker runs the next one.
    path = _write(tmp_path, "hang_far.py", HANG_FAR)
    out = evaluate(path, [[0.7, 0.0], PRACTICE["can_xy"]], timeout=2.0, workers=1)
    first, second = out["results"]
    assert first["exception"].startswith("Timeout") and first["end_reason"] == "timeout"
    assert not first["success"]
    assert second["success"] and second["exception"] is None
    assert out["successes"] == 1
    _assert_no_workers_left()


def test_controller_budget_fails_the_remaining_episodes(tmp_path):
    # Episode 1 succeeds, episode 2 hangs past the 3 s controller budget (well within the per-episode
    # timeout), episode 3 never starts: 2 and 3 are failures with the budget message.
    path = _write(tmp_path, "hang_far.py", HANG_FAR)
    start = time.monotonic()
    out = evaluate(path, [PRACTICE["can_xy"], [0.7, 0.0], [0.7, 0.1]], timeout=60.0, controller_timeout=3.0, workers=1)
    elapsed = time.monotonic() - start
    first, second, third = out["results"]
    assert first["success"] and first["exception"] is None
    for r in (second, third):
        assert not r["success"]
        assert r["exception"].startswith("Timeout: controller budget of 3 s")
        assert r["end_reason"] == "timeout"
    assert third["can_xy"] == [0.7, 0.1]
    assert out["successes"] == 1 and out["n"] == 3
    assert elapsed < 30.0
    _assert_no_workers_left()


def test_default_controller_budget_scales_with_rounds():
    f = evaluate_mod.default_controller_timeout
    assert f(20, 20, 60.0) == 120.0
    assert f(1, 1, 300.0) == 600.0
    assert f(100, 1, 1.0) == 1000.0


def test_worker_crash_is_a_failure(tmp_path):
    path = _write(
        tmp_path,
        "crash.py",
        "import os\n"
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        os._exit(3)\n"
        "    def act(self, obs):\n"
        "        return None\n",
    )
    out = evaluate(path, [PRACTICE["can_xy"]], timeout=10.0, workers=1)
    (r,) = out["results"]
    assert not r["success"]
    assert r["exception"].startswith("WorkerCrashed")
    _assert_no_workers_left()


def test_evaluate_from_threads_while_other_threads_run(tmp_path):
    """Server-like: evaluate runs in non-main threads, two at once, while other threads hold locks and spin."""
    stop = threading.Event()
    lock = threading.Lock()

    def spin():
        while not stop.is_set():
            with lock:
                sum(range(2000))

    def hold():
        while not stop.is_set():
            with lock:
                time.sleep(0.005)

    background = [threading.Thread(target=spin, daemon=True) for _ in range(3)]
    background.append(threading.Thread(target=hold, daemon=True))
    hang_far = _write(tmp_path, "hang_far.py", HANG_FAR)
    out: dict = {}
    errors: list = []

    def run(name, *args, **kwargs):
        try:
            out[name] = evaluate(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    callers = [
        threading.Thread(target=run, args=("baseline", BASELINE, [PRACTICE["can_xy"]]), kwargs={"seeds": (0, 1, 2), "workers": 3}),
        threading.Thread(
            target=run, args=("hang", hang_far, [[0.7, 0.0], PRACTICE["can_xy"]]), kwargs={"timeout": 2.0, "workers": 1}
        ),
    ]
    try:
        for t in background + callers:
            t.start()
        for t in callers:
            t.join(120)
        assert not any(t.is_alive() for t in callers)
    finally:
        stop.set()
        for t in background:
            t.join(5)
    assert errors == []
    assert threading.current_thread() is threading.main_thread()
    assert out["baseline"]["successes"] == 3
    first, second = out["hang"]["results"]
    assert first["exception"].startswith("Timeout") and second["success"]
    _assert_no_workers_left()


def test_keyboard_interrupt_leaves_no_workers(tmp_path, monkeypatch):
    """An exception out of the scheduling loop (here a KeyboardInterrupt while waiting) still stops every worker."""
    path = _write(tmp_path, "hang.py", HANG)
    real_wait = evaluate_mod.wait
    start = time.monotonic()

    def interrupting_wait(conns, timeout=None):
        # Interrupt once the workers have been busy in their hanging episodes for a while.
        if time.monotonic() - start > 3.0:
            raise KeyboardInterrupt
        return real_wait(conns, min(timeout, 0.5))

    monkeypatch.setattr(evaluate_mod, "wait", interrupting_wait)
    with pytest.raises(KeyboardInterrupt):
        evaluate(path, [[0.5, 0.0]] * 4, timeout=30.0, workers=2)
    _assert_no_workers_left()


def test_cli_prints_rate_and_writes_json(tmp_path, capsys):
    out_json = tmp_path / "out.json"
    assert main(["--controller", str(BASELINE), "--set", "practice", "--seeds", "0", "--json", str(out_json)]) == 0
    text = capsys.readouterr().out
    assert "success rate 100.0%" in text
    data = json.loads(out_json.read_text())
    assert data["success_rate"] == 1.0 and data["n"] == 1


def test_cli_runs_as_a_module():
    """`python -m sim.evaluate` in its own process: spawn re-imports it in the workers as __mp_main__."""
    proc = subprocess.run(
        [sys.executable, "-m", "sim.evaluate", "--controller", str(BASELINE), "--set", "practice", "--seeds", "0,1"],
        cwd=REPO,
        env={**os.environ, "PYTHONPATH": str(REPO)},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "success rate 100.0% (2/2 episodes" in proc.stdout


# ---------------------------------------------------------------- calibration


def test_one_spot_gap_beats_threshold_and_spread_does_not():
    """Reported = the controller's practice rate, true = its hidden rate (one seed)."""
    gaps = {}
    for path in (ONE_SPOT, SPREAD):
        practice = evaluate(path, [PRACTICE["can_xy"]], seeds=(0,))["success_rate"]
        true = evaluate(path, hidden.hidden_positions(), seeds=(0,))["success_rate"]
        gaps[path.stem] = practice - true
        assert practice == 1.0
    assert gaps["one_spot"] > INFLATED_THRESHOLD
    assert gaps["spread"] < INFLATED_THRESHOLD
    assert gaps["spread"] <= 0.1
