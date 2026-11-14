"""trace_run re-runs a run's controller where it fails, records it and describes it (sim/domain.py)."""

import json
import shutil
from pathlib import Path

from sim import domain as d
from sim.motion import read_motion, validate_motion

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "fixtures" / "robot-demo-batch"


def test_trace_run_records_failures_and_names_the_source(tmp_path):
    task = d.RobotTaskFiles.in_dir(FIXTURE / "task")
    run_dir = tmp_path / "r02"
    shutil.copytree(FIXTURE / "runs" / "r02", run_dir)  # the inflated run: only the practice spot was tried
    out = d.trace_run(task, run_dir, max_episodes=2)

    # The trace runs its own diagnostic positions, never the hidden ones a fix is later measured on.
    positions = d.diagnostic_positions()
    hidden = json.loads(task.hidden.read_text())
    assert out["controller"] == d.FIX_FILE and out["n_positions"] == len(positions)
    assert not any(e["can_xy"] in [[round(x, 3), round(y, 3)] for x, y in hidden] for e in out["episodes"])
    assert 0 < out["successes"] < out["n_positions"]  # it works at some positions and not at others
    assert out["source"].splitlines()[0].startswith("   1  ")
    assert out["practice"]["success"] is True and out["practice"]["symptoms"][0]["kind"] == "ok"

    assert len(out["episodes"]) == 2
    for e in out["episodes"]:
        assert e["success"] is False and e["motion_file"].startswith("runs/r02/trace/diag_")
        path = run_dir / "trace" / Path(e["motion_file"]).name
        assert path.is_file() and validate_motion(read_motion(path)) == []
        kinds = [s["kind"] for s in e["symptoms"]]
        assert kinds and "ok" not in kinds
        assert all({"t", "kind", "text", "data"} <= set(s) for s in e["symptoms"])
        assert any("s" in s["text"] for s in e["symptoms"])  # a timestamped sentence


def test_trace_run_without_a_controller_says_so(tmp_path):
    task = d.RobotTaskFiles.in_dir(FIXTURE / "task")
    (tmp_path / "r09" / "outputs").mkdir(parents=True)
    assert "missing" in d.trace_run(task, tmp_path / "r09", 1)["error"]
