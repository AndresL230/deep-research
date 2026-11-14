"""Tests for sim.symptoms: real recordings from the sim plus hand-built ones for the rare branches."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from sim.episode import run_episode
from sim.hidden import hidden_positions
from sim.motion import read_motion, write_motion
from sim.symptoms import KINDS, Symptom, Timeline, describe, summarize, symptoms, timeline

CONTROLLERS = Path(__file__).resolve().parent.parent / "controllers"
BASELINE = CONTROLLERS / "baseline.py"
ONE_SPOT = CONTROLLERS / "one_spot.py"
PLACE = [0.45, -0.3]


@pytest.fixture(scope="module")
def baseline_file(tmp_path_factory) -> Path:
    result, motion = run_episode(BASELINE, [0.5, 0.0], PLACE, seed=0)
    assert result["success"], result
    path = tmp_path_factory.mktemp("motion") / "baseline_practice.json"
    write_motion(motion, path)
    return path


@pytest.fixture(scope="module")
def one_spot_far_file(tmp_path_factory) -> Path:
    """one_spot at the farthest hidden position (from the place target) where it fails."""
    positions = sorted(hidden_positions(20), key=lambda p: math.hypot(p[0] - PLACE[0], p[1] - PLACE[1]), reverse=True)
    for can_xy in positions:
        result, motion = run_episode(ONE_SPOT, can_xy, PLACE, seed=0)
        if not result["success"]:
            path = tmp_path_factory.mktemp("motion") / "one_spot_far.json"
            write_motion(motion, path)
            return path
    pytest.fail("one_spot succeeded at every hidden position; expected far carries to fail")


# ---------------------------------------------------------------- real recordings


def test_baseline_success_is_ok_only(baseline_file):
    motion = read_motion(baseline_file)
    out = symptoms(motion)
    assert [s.kind for s in out] == ["ok"]
    assert out[0].t is None
    assert "Succeeded" in out[0].text and "cm from the target" in out[0].text
    tl = timeline(motion)
    assert tl.closed_at is not None and tl.lifted_at is not None and tl.released_at is not None
    assert tl.closed_at < tl.lifted_at < tl.released_at
    assert tl.lost_grip_at is None
    assert tl.hand_to_can_at_close_m < 0.03
    assert tl.carry_distance_m == pytest.approx(math.hypot(0.05, 0.3), abs=0.01)
    assert tl.carry_moved_m == pytest.approx(tl.carry_distance_m, abs=0.03)
    assert tl.peak_hand_speed_mps is not None and 0.1 < tl.peak_hand_speed_mps < 1.0


def test_one_spot_far_carry_slips(one_spot_far_file):
    motion = read_motion(one_spot_far_file)
    tl = timeline(motion)
    out = symptoms(motion)
    slips = [s for s in out if s.kind == "slipped"]
    assert len(slips) == 1, [s.text for s in out]
    slip = slips[0]
    assert tl.lifted_at is not None and tl.lost_grip_at is not None
    assert tl.lifted_at < slip.t <= motion["frames"][-1]["t"]
    assert slip.t == tl.lost_grip_at
    assert tl.carry_moved_m < tl.carry_distance_m
    assert "slipped" in slip.text or "left the grip" in slip.text
    assert "m into" in slip.text
    assert slip.data["carry_distance_m"] == tl.carry_distance_m
    assert slip.data["hand_speed_mps"] is not None and slip.data["hand_speed_mps"] > 0.5
    assert all(s.kind in KINDS for s in out)
    assert not any(s.kind == "ok" for s in out)
    # Ordered by t with end-of-episode facts (t None) last.
    ts = [s.t for s in out]
    numbered = [t for t in ts if t is not None]
    assert numbered == sorted(numbered) and ts[: len(numbered)] == numbered


def test_describe_and_summarize(baseline_file, one_spot_far_file):
    text = describe(read_motion(one_spot_far_file))
    lines = text.splitlines()
    assert len(lines) >= 1
    assert all(line.startswith(f"{i}. ") for i, line in enumerate(lines, 1))
    assert describe(read_motion(baseline_file)).startswith("1. Succeeded")

    summary = summarize([baseline_file, str(one_spot_far_file)])
    assert [d["success"] for d in summary] == [True, False]
    assert summary[0]["path"] == str(baseline_file) and summary[1]["path"] == str(one_spot_far_file)
    assert summary[0]["can_start"] == [0.5, 0.0]
    assert summary[0]["end_reason"] == "controller_done"
    assert summary[0]["symptoms"][0]["kind"] == "ok"
    assert "slipped" in [s["kind"] for s in summary[1]["symptoms"]]
    json.dumps(summary)


# ---------------------------------------------------------------- hand-built recordings


def _frame(t, hand, can, grip, width=0.08):
    qpos = [0.0] * 7 + [width / 2, width / 2] + list(can) + [1.0, 0.0, 0.0, 0.0]
    return {"t": t, "qpos": qpos, "ctrl": [0.0] * 7 + [grip], "hand": list(hand), "can_pos": list(can), "can_quat": [1.0, 0.0, 0.0, 0.0]}


def _motion(frames, **result):
    base = {
        "success": False, "place_error_cm": 30.0, "upright": True, "dropped": False, "max_height_cm": 0.0,
        "time_taken": frames[-1]["t"], "exception": None, "can_start": [0.5, 0.0], "place_target": [0.45, -0.3],
        "seed": 0, "end_reason": "controller_done", "resting": True, "released": True, "tipped": False, "tilt_deg": 0.0,
    }  # fmt: skip
    header = {"model_id": "panda-can-v1", "can_start": [0.5, 0.0], "place_target": [0.45, -0.3], "fps": 30, "nq": 16}
    return {"format": "panda-motion/1", "header": header, "frames": frames, "result": dict(base, **result)}


def test_missed_grasp_hand_built():
    can = [0.5, 0.0, 0.05]
    frames = [
        _frame(0.0, [0.55, 0.0, 0.3], can, 255.0),
        _frame(1.0, [0.58, 0.0, 0.065], can, 255.0),
        _frame(1.95, [0.582, 0.0, 0.065], can, 0.0),  # closes 8.2 cm from the can
        _frame(2.1, [0.582, 0.0, 0.065], can, 0.0, width=0.02),
        _frame(2.3, [0.582, 0.0, 0.065], can, 0.0, width=0.0),
        _frame(3.0, [0.582, 0.0, 0.2], can, 0.0, width=0.0),
    ]
    out = symptoms(_motion(frames))
    assert [s.kind for s in out] == ["missed_grasp"]
    assert out[0].t == 1.95
    assert "8.2 cm" in out[0].text and "1.95 s" in out[0].text and "caught nothing" in out[0].text
    tl = timeline(_motion(frames))
    assert tl.closed_at == 1.95 and tl.lifted_at is None and tl.hand_to_can_at_close_m == pytest.approx(0.082, abs=1e-3)

    # Fingers over the can but shut on nothing: the width check catches it.
    frames = [
        _frame(0.0, [0.55, 0.0, 0.3], can, 255.0),
        _frame(1.0, [0.5, 0.0, 0.065], can, 255.0),
        _frame(2.0, [0.5, 0.0, 0.065], can, 0.0),
        _frame(2.4, [0.5, 0.0, 0.065], can, 0.0, width=0.004),
        _frame(3.0, [0.5, 0.0, 0.2], can, 0.0, width=0.004),
    ]
    out = symptoms(_motion(frames))
    assert [s.kind for s in out] == ["missed_grasp"]
    assert "0.4 cm" in out[0].text


def test_never_lifted_hand_built():
    can = [0.5, 0.0, 0.05]
    frames = [
        _frame(0.0, [0.55, 0.0, 0.3], can, 255.0),
        _frame(1.0, [0.5, 0.0, 0.065], can, 255.0),
        _frame(2.1, [0.5, 0.0, 0.065], can, 0.0, width=0.049),
        _frame(2.5, [0.5, 0.0, 0.07], can, 0.0, width=0.049),
        _frame(3.0, [0.5, 0.0, 0.15], can, 0.0, width=0.049),
        _frame(3.5, [0.5, 0.0, 0.195], can, 0.0, width=0.049),
    ]
    out = symptoms(_motion(frames))
    assert [s.kind for s in out] == ["never_lifted"]
    assert out[0].t == 2.1
    assert "2.10 s" in out[0].text and "stayed on the floor" in out[0].text and "13.0 cm" in out[0].text
    assert out[0].data["hand_rise_m"] == pytest.approx(0.13, abs=1e-3)


def test_result_facts_hand_built():
    can = [0.5, 0.0, 0.05]
    frames = [_frame(0.0, [0.55, 0.0, 0.3], can, 255.0), _frame(10.0, [0.55, 0.0, 0.3], can, 255.0)]
    out = symptoms(_motion(frames, end_reason="max_time", time_taken=10.0))
    assert [s.kind for s in out] == ["timeout"]
    out = symptoms(_motion(frames, end_reason="exception", exception="ValueError: boom\n  File x, line 1"))
    assert [s.kind for s in out] == ["exception"]
    assert "boom" in out[0].text and "File" not in out[0].text
    out = symptoms(_motion(frames, end_reason="out_of_bounds", place_error_cm=69.2, tipped=True, upright=False))
    assert [s.kind for s in out] == ["out_of_bounds", "tipped"]
    # A real pick, carry and release that ends 4.2 cm off: the can travels with the hand throughout.
    carried = []
    for i, (t, hz, grip) in enumerate([(0.0, 0.3, 255.0), (1.0, 0.065, 255.0), (1.5, 0.065, 0.0), (2.0, 0.18, 0.0), (3.0, 0.18, 0.0), (3.5, 0.075, 0.0), (4.0, 0.075, 255.0), (4.5, 0.2, 255.0)]):
        x, y = (0.5, 0.0) if t < 2.0 else (0.45, -0.258)
        can_z = 0.05 if t < 2.0 or t >= 3.5 else hz - 0.015
        carried.append(_frame(t, [x, y, hz], [x, y, can_z], grip, width=0.049 if grip == 0.0 else 0.08))
    out = symptoms(_motion(carried, place_error_cm=4.2, resting=True))
    assert [s.kind for s in out] == ["placed_off"]
    assert "4.2 cm" in out[0].text
    assert timeline(_motion(carried)).lost_grip_at is None


def test_single_frame_and_malformed_do_not_raise():
    one = _motion([_frame(0.0, [0.55, 0.0, 0.3], [0.5, 0.0, 0.05], 255.0)])
    out = symptoms(one)
    assert len(out) >= 1 and all(isinstance(s, Symptom) for s in out)
    assert isinstance(timeline(one), Timeline)
    assert timeline(one).closed_at is None
    closed_only = _motion([_frame(0.0, [0.55, 0.0, 0.3], [0.5, 0.0, 0.05], 0.0)])
    assert len(symptoms(closed_only)) >= 1
    for broken in ({}, {"frames": []}, {"frames": [{"t": 0.0}], "result": {}}, {"frames": [{}], "result": {"success": False}}):
        assert len(symptoms(broken)) >= 1
        assert isinstance(describe(broken), str)
    json.dumps([s.__dict__ for s in symptoms(one)])
