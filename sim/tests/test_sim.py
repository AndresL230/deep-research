"""Tests for the robot sim core: scene, IK, episode runner, motion files and the baseline controller."""

from __future__ import annotations

from pathlib import Path

import mujoco
import numpy as np
import pytest

from sim.control import HOME_QPOS, JOINT_LOWER, JOINT_UPPER, hand_down_error, hand_position, ik
from sim.episode import MAX_TIME, load_controller, run_episode
from sim.motion import MAX_BYTES, MOTION_FPS, read_motion, validate_motion, write_motion
from sim.practice import PRACTICE
from sim.scene import CAN_HALF_HEIGHT, build_model

CONTROLLERS = Path(__file__).resolve().parent.parent / "controllers"
BASELINE = CONTROLLERS / "baseline.py"
TEMPLATE = CONTROLLERS / "template.py"


def _write(tmp_path: Path, name: str, text: str) -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


# ---------------------------------------------------------------- scene


def test_scene_builds_with_can_and_place_zone():
    model = build_model([0.5, 0.0], [0.45, -0.3])
    assert model.nq == 16
    assert model.nu == 8
    can = model.body("can")
    zone_geom = model.geom("place_zone")
    assert model.geom_contype[zone_geom.id] == 0
    assert model.geom_conaffinity[zone_geom.id] == 0
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("home").id)
    mujoco.mj_forward(model, data)
    np.testing.assert_allclose(data.xpos[can.id], [0.5, 0.0, CAN_HALF_HEIGHT], atol=1e-9)
    np.testing.assert_allclose(data.geom_xpos[zone_geom.id][:2], [0.45, -0.3], atol=1e-9)


def test_place_zone_never_collides():
    # Can standing right on the place zone: after settling nothing should touch the zone geom.
    model = build_model([0.45, -0.3], [0.45, -0.3])
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("home").id)
    zone = model.geom("place_zone").id
    for _ in range(200):
        mujoco.mj_step(model, data)
        for i in range(data.ncon):
            assert zone not in (data.contact[i].geom1, data.contact[i].geom2)
    # The can rests on the floor, not on the disc.
    assert abs(data.body("can").xpos[2] - CAN_HALF_HEIGHT) < 0.002


# ---------------------------------------------------------------- ik


@pytest.mark.parametrize(
    "target", [(0.5, 0.0, 0.07), (0.45, -0.3, 0.2), (0.35, 0.2, 0.1), (0.65, -0.15, 0.07), (0.4, -0.25, 0.3)]
)
def test_ik_reaches_targets(target):
    q = ik(target)
    assert q.shape == (7,)
    assert np.all(q >= JOINT_LOWER - 1e-9) and np.all(q <= JOINT_UPPER + 1e-9)
    assert np.linalg.norm(hand_position(q) - np.array(target)) < 0.01
    q_down = ik(target, down_weight=0.5)
    assert np.linalg.norm(hand_position(q_down) - np.array(target)) < 0.01
    assert hand_down_error(q_down) < 2.0


def test_ik_is_deterministic():
    a = ik((0.5, 0.1, 0.1), q_init=HOME_QPOS)
    b = ik((0.5, 0.1, 0.1), q_init=HOME_QPOS)
    np.testing.assert_array_equal(a, b)


# ---------------------------------------------------------------- baseline


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_baseline_succeeds_on_practice_spot(seed):
    result, motion = run_episode(BASELINE, PRACTICE["can_xy"], PRACTICE["place_xy"], seed=seed)
    assert result["exception"] is None
    assert result["success"], result
    assert result["upright"] and not result["dropped"]
    assert result["max_height_cm"] > 5
    assert validate_motion(motion) == []


def test_seeds_vary_but_repeat():
    r0a, _ = run_episode(BASELINE, PRACTICE["can_xy"], PRACTICE["place_xy"], seed=0, record=False)
    r0b, _ = run_episode(BASELINE, PRACTICE["can_xy"], PRACTICE["place_xy"], seed=0, record=False)
    r1, _ = run_episode(BASELINE, PRACTICE["can_xy"], PRACTICE["place_xy"], seed=1, record=False)
    assert r0a == r0b
    assert r0a["can_start_actual"] != r1["can_start_actual"]
    jitter = np.abs(np.array(r1["can_start_actual"][:2]) - np.array(PRACTICE["can_xy"]))
    assert np.all(jitter <= 0.0031)


# ---------------------------------------------------------------- motion


def test_full_episode_motion_matches_format(tmp_path):
    result, motion = run_episode(TEMPLATE, PRACTICE["can_xy"], PRACTICE["place_xy"], seed=0)
    assert result["exception"] is None
    assert not result["success"]
    assert result["end_reason"] == "max_time"
    assert result["time_taken"] == pytest.approx(MAX_TIME)
    assert validate_motion(motion) == []
    frames = motion["frames"]
    assert abs(len(frames) - (MAX_TIME * MOTION_FPS + 1)) <= 2
    assert frames[0]["t"] == 0.0 and frames[-1]["t"] == pytest.approx(MAX_TIME)
    assert len(motion["header"]["joint_names"]) == 10 and motion["header"]["nq"] == 16
    path = tmp_path / "motion.json"
    size = write_motion(motion, path)
    assert size < MAX_BYTES
    assert path.stat().st_size == size
    loaded = read_motion(path)
    assert validate_motion(loaded) == []
    assert loaded["result"] == result


def test_validate_motion_reports_problems():
    _, motion = run_episode(TEMPLATE, PRACTICE["can_xy"], PRACTICE["place_xy"], max_time=0.5)
    assert validate_motion(motion) == []
    motion["frames"][1]["qpos"] = motion["frames"][1]["qpos"][:5]
    del motion["header"]["fps"]
    problems = validate_motion(motion)
    assert any("qpos" in p for p in problems)
    assert any("fps" in p for p in problems)
    assert validate_motion({"format": "nope"})
    for bad in (0, 31, 7.5, True):
        motion["header"]["fps"] = bad
        assert any("fps" in p for p in validate_motion(motion)), bad


def test_low_rate_recording_is_small_valid_and_changes_nothing():
    """The hidden episodes' recordings (sim.motion.LOW_FPS, LOW_DECIMALS): a 10 s episode in about 20 KB, and the
    episode itself is the same bit for bit, recorded or not."""
    from sim.motion import LOW_DECIMALS, LOW_FPS, dumps

    plain, none = run_episode(BASELINE, [0.6, 0.2], PRACTICE["place_xy"], seed=3, record=False)
    result, motion = run_episode(BASELINE, [0.6, 0.2], PRACTICE["place_xy"], seed=3, motion_fps=LOW_FPS,
                                 motion_decimals=LOW_DECIMALS)
    assert none is None and result == plain
    assert validate_motion(motion) == [] and motion["header"]["fps"] == LOW_FPS
    assert abs(len(motion["frames"]) - (result["time_taken"] * LOW_FPS + 1)) <= 2
    assert all(len(str(v).split(".")[-1]) <= LOW_DECIMALS for v in motion["frames"][5]["qpos"])
    _, full = run_episode(TEMPLATE, PRACTICE["can_xy"], PRACTICE["place_xy"], motion_fps=LOW_FPS,
                          motion_decimals=LOW_DECIMALS)
    assert len(dumps(full)) < 25_000


# ---------------------------------------------------------------- broken controllers


def test_controller_that_raises_in_act(tmp_path):
    path = _write(
        tmp_path,
        "boom.py",
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        pass\n"
        "    def act(self, obs):\n"
        "        if obs['time'] > 0.1:\n"
        "            raise RuntimeError('kaboom')\n"
        "        return [0, 0, 0, -1.57, 0, 1.57, -0.785, 255]\n",
    )
    result, motion = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"])
    assert not result["success"]
    assert result["exception"].startswith("RuntimeError: kaboom")
    assert result["end_reason"] == "exception"
    assert result["time_taken"] < 0.2
    assert validate_motion(motion) == []


def test_controller_that_raises_in_reset(tmp_path):
    path = _write(
        tmp_path,
        "bad_reset.py",
        "class Controller:\n    def reset(self, task):\n        raise KeyError('nope')\n"
        "    def act(self, obs):\n        return None\n",
    )
    result, _ = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"])
    assert not result["success"]
    assert result["exception"].startswith("KeyError")


def test_controller_with_syntax_error(tmp_path):
    path = _write(tmp_path, "syntax.py", "class Controller:\n    def act(self obs):\n        return 1\n")
    result, motion = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"])
    assert not result["success"]
    assert result["exception"].startswith("SyntaxError")
    assert motion is not None and validate_motion(motion) == []


def test_controller_file_without_class(tmp_path):
    path = _write(tmp_path, "empty.py", "x = 1\n")
    result, _ = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"])
    assert not result["success"]
    assert result["exception"].startswith("AttributeError")
    with pytest.raises(AttributeError):
        load_controller(path)


def test_missing_controller_file(tmp_path):
    result, _ = run_episode(tmp_path / "missing.py", PRACTICE["can_xy"], PRACTICE["place_xy"], record=False)
    assert not result["success"]
    assert result["exception"].startswith("FileNotFoundError")


@pytest.mark.parametrize(
    "ret, kind",
    [("[0.0] * 7", "ValueError"), ("[0.0] * 9", "ValueError"), ("[float('nan')] * 8", "ValueError")],
)
def test_controller_bad_action(tmp_path, ret, kind):
    path = _write(
        tmp_path,
        "bad_action.py",
        f"class Controller:\n    def reset(self, task):\n        pass\n    def act(self, obs):\n        return {ret}\n",
    )
    result, _ = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"], record=False)
    assert not result["success"]
    assert result["exception"].startswith(kind)
    assert result["time_taken"] == 0.0


def test_controller_done_signal(tmp_path):
    path = _write(
        tmp_path,
        "quits.py",
        "class Controller:\n    def reset(self, task):\n        pass\n    def act(self, obs):\n        return None\n",
    )
    result, _ = run_episode(path, PRACTICE["can_xy"], PRACTICE["place_xy"], record=False)
    assert result["exception"] is None
    assert result["end_reason"] == "controller_done"
    assert not result["success"]
    assert result["time_taken"] <= 1.1
