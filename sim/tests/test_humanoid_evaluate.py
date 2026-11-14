"""The humanoid evaluation: episodes in worker processes through sim.evaluate.run_jobs with runner "humanoid"."""

from __future__ import annotations

from pathlib import Path

import pytest

from sim.evaluate import run_jobs
from sim.humanoid.evaluate import INFLATED_THRESHOLD, UNCLEAR_LOW, evaluate, format_table, push_set
from sim.humanoid.motion import read_motion, validate_motion

CONTROLLERS = Path(__file__).resolve().parents[1] / "humanoid" / "controllers"


def test_thresholds_are_the_calibrated_ones():
    assert INFLATED_THRESHOLD == 0.275 and UNCLEAR_LOW == 0.12


def test_push_sets():
    assert push_set("practice") == [[0.0, 50.0]]
    assert len(push_set("hidden")) == 20 and len(push_set("spread")) == 16 and len(push_set("hidden", 5)) == 5
    with pytest.raises(ValueError):
        push_set("nope")


def test_one_spot_passes_practice_and_fails_pushes_from_the_front():
    practice = evaluate(CONTROLLERS / "one_spot.py", push_set("practice"), seeds=(0, 1), workers=2)
    assert practice["success_rate"] == 1.0 and practice["n"] == 2
    front = evaluate(CONTROLLERS / "one_spot.py", [[180, 35], [150, 40], [90, 40]], workers=3)
    assert [r["outcome"] for r in front["results"]] == ["fell", "fell", "upright"]
    assert [r["push_nominal"] for r in front["results"]] == [[180.0, 35.0], [150.0, 40.0], [90.0, 40.0]]
    assert [r["index"] for r in front["results"]] == [0, 1, 2]
    assert "fell@" in format_table(front)


def test_record_dir_keeps_every_episode(tmp_path):
    out = evaluate(CONTROLLERS / "spread.py", push_set("hidden", 3), seeds=(0,), workers=3, record_dir=tmp_path / "hidden")
    names = sorted(p.name for p in (tmp_path / "hidden").iterdir())
    assert names == ["00-s0.motion.json", "01-s0.motion.json", "02-s0.motion.json"]
    for r in out["results"]:
        m = read_motion(r["motion_path"])
        assert validate_motion(m) == [] and m["header"]["fps"] == 8
        assert m["result"]["success"] == r["success"]


def test_a_hanging_controller_is_a_timeout_with_the_humanoid_keys(tmp_path):
    hang = tmp_path / "hang.py"
    hang.write_text("class Controller:\n    def reset(self, task): pass\n    def act(self, obs):\n        while True: pass\n")
    [r] = run_jobs([{"controller_path": str(hang), "push": [0, 50], "seed": 0, "runner": "humanoid"}], timeout=3, workers=1)
    assert r["end_reason"] == "timeout" and r["outcome"] == "error" and not r["success"]
    assert r["push"] == {"angle_deg": 0.0, "force_n": 50.0} and "Timeout" in r["exception"]


def test_the_arm_jobs_still_run_without_a_runner():
    [r] = run_jobs([{"controller_path": str(Path(__file__).resolve().parents[1] / "controllers" / "baseline.py"),
                     "can_xy": [0.5, 0.0], "place_xy": [0.45, -0.3], "seed": 0}], workers=1)
    assert r["success"] and "place_error_cm" in r
