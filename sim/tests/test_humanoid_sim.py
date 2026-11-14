"""The humanoid push recovery sim: G1 assets, scene, episode runner, outcome rule, motion files, hidden pushes."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import mujoco
import numpy as np
import pytest

from sim import fetch_assets
from sim.humanoid import hidden
from sim.humanoid.control import FOOT_CORNERS, JOINT_INDEX, JOINTS, MASS, STAND_CTRL, index, tilt_deg
from sim.humanoid.episode import MAX_TIME, PUSH_DURATION, run_episode
from sim.humanoid.motion import FORMAT, MAX_BYTES, read_motion, validate_motion, write_motion
from sim.humanoid.outcome import OUTCOMES, failure_result, outcome
from sim.humanoid.practice import PRACTICE
from sim.humanoid.scene import MODEL_ID, build_model

ROOT = Path(__file__).resolve().parents[2]
CONTROLLERS = ROOT / "sim" / "humanoid" / "controllers"
TEMPLATE = CONTROLLERS / "template.py"
BASELINE = CONTROLLERS / "baseline.py"
ONE_SPOT = CONTROLLERS / "one_spot.py"
SPREAD = CONTROLLERS / "spread.py"
PRACTICE_PUSH = PRACTICE["push"]


def _write(tmp_path: Path, name: str, text: str) -> Path:
    p = tmp_path / name
    p.write_text(text)
    return p


# ---------------------------------------------------------------- assets and scene


def test_g1_assets_match_the_pinned_hashes():
    assert fetch_assets.missing_files(folder=fetch_assets.G1_FOLDER) == []
    assert set(fetch_assets.MODELS) == {"franka_emika_panda", "unitree_g1"}
    # Only what g1.xml and scene.xml need: no hand variant, no pictures.
    names = set(fetch_assets.G1_FILES)
    assert {"g1.xml", "scene.xml", "LICENSE"} <= names
    assert not any("hand_" in n or n.endswith(".png") or "mjx" in n for n in names)


def test_g1_license_is_kept_next_to_the_humanoid_sim():
    kept = (ROOT / "sim" / "humanoid" / "ASSETS_LICENSE").read_text()
    assert kept == (fetch_assets.DEFAULT_DEST / fetch_assets.G1_FOLDER / "LICENSE").read_text()
    assert "Unitree" in kept


def test_a_changed_g1_file_is_found(tmp_path):
    root = tmp_path / fetch_assets.G1_FOLDER
    shutil.copytree(fetch_assets.DEFAULT_DEST / fetch_assets.G1_FOLDER, root)
    assert fetch_assets.missing_files(tmp_path, fetch_assets.G1_FOLDER) == []
    (root / "g1.xml").write_text("<mujoco/>")
    assert fetch_assets.missing_files(tmp_path, fetch_assets.G1_FOLDER) == ["g1.xml"]
    # The panda's check is unchanged: by default it looks at the panda folder.
    assert sorted(fetch_assets.missing_files(tmp_path)) == sorted(fetch_assets.FILES)


def test_fetch_check_covers_both_models():
    assert fetch_assets.main(["--model", "all", "--check"]) == 0


def test_the_scene_is_the_g1_on_a_floor():
    m = build_model()
    assert (m.nq, m.nv, m.nu) == (36, 35, 29)
    assert m.opt.timestep == pytest.approx(0.002)
    assert len(JOINTS) == 29 and JOINTS[0] == "left_hip_pitch_joint" and JOINT_INDEX["left_ankle_pitch_joint"] == 4
    assert index("left_ankle_pitch") == index("left_ankle_pitch_joint") == 4
    assert STAND_CTRL.shape == (29,) and 30 < MASS < 37
    assert FOOT_CORNERS.shape == (4, 3)
    d = mujoco.MjData(m)
    mujoco.mj_resetDataKeyframe(m, d, m.key("stand").id)
    for _ in range(1000):  # 2 s holding the standing pose: it stays up
        mujoco.mj_step(m, d)
    assert d.qpos[2] > 0.75 and tilt_deg(d.qpos[3:7]) < 2


# ---------------------------------------------------------------- episodes


def test_the_template_falls_under_the_practice_push_and_the_baseline_does_not():
    r, _ = run_episode(TEMPLATE, PRACTICE_PUSH, record=False)
    assert r["fell"] and not r["success"] and r["outcome"] == "fell"
    assert r["fall_time"] > r["push_time"] and r["max_tilt_deg"] > 45
    b, _ = run_episode(BASELINE, PRACTICE_PUSH, record=False)
    assert b["success"] and b["outcome"] == "upright" and b["end_reason"] == "max_time"
    assert b["time_taken"] == pytest.approx(MAX_TIME)
    assert b["max_tilt_deg"] < 10


def test_without_a_push_even_the_template_stands():
    r, _ = run_episode(TEMPLATE, {"angle_deg": 0, "force_n": 0}, record=False)
    assert r["success"] and r["outcome"] == "upright" and r["min_pelvis_height"] > 0.75


@pytest.mark.parametrize("angle", [0, 90, 180, 270])
def test_the_push_moves_the_robot_its_way(angle):
    _, motion = run_episode(BASELINE, [angle, 40], record=True)
    t = np.array([f["t"] for f in motion["frames"]])
    com = np.array([f["com"] for f in motion["frames"]])
    t0 = motion["header"]["push"]["time_s"]
    k0, k1 = np.searchsorted(t, t0), np.searchsorted(t, t0 + PUSH_DURATION + 0.1)
    moved = com[k1, :2] - com[k0, :2]
    want = np.array([math.cos(math.radians(angle)), math.sin(math.radians(angle))])
    assert moved @ want > 0.005  # the center of mass moved at least 5 mm along the push


def test_the_lean_back_survives_from_behind_and_falls_from_the_front():
    # The trap in one pair: tuned on the shove from behind, the one-spot controller takes 70 N from there...
    assert run_episode(ONE_SPOT, [0, 70], record=False)[0]["success"]
    front, _ = run_episode(ONE_SPOT, [180, 30], record=False)
    assert front["outcome"] == "fell"
    # ...while the spread controller survives the same shove from the front.
    assert run_episode(SPREAD, [180, 30], record=False)[0]["outcome"] == "upright"


def test_same_seed_same_episode_and_seeds_differ():
    a, ma = run_episode(BASELINE, [135, 45], seed=3)
    b, mb = run_episode(BASELINE, [135, 45], seed=3)
    assert a == b and ma == mb
    c, _ = run_episode(BASELINE, [135, 45], seed=4, record=False)
    assert c["push_time"] != a["push_time"]
    assert abs(a["push_time"] - 1.5) <= 0.1 and a["push"]["duration_s"] == PUSH_DURATION


def test_a_push_given_as_a_dict_or_a_pair_is_the_same():
    a, _ = run_episode(BASELINE, {"angle_deg": 90, "force_n": 30}, record=False)
    b, _ = run_episode(BASELINE, (90, 30), record=False)
    assert a == b and a["push"]["angle_deg"] == 90.0 and a["push"]["force_n"] == 30.0


def test_controller_failures_are_scored_as_errors(tmp_path):
    raising = _write(tmp_path, "raising.py", "class Controller:\n    def reset(self, task): pass\n    def act(self, obs): raise RuntimeError('boom')\n")
    short = _write(tmp_path, "short.py", "class Controller:\n    def reset(self, task): pass\n    def act(self, obs): return [0.0] * 3\n")
    nan = _write(tmp_path, "nan.py", "class Controller:\n    def reset(self, task): pass\n    def act(self, obs): return [float('nan')] * 29\n")
    broken = _write(tmp_path, "broken.py", "def oops(:\n")
    for path, text in ((raising, "RuntimeError: boom"), (short, "29 numbers"), (nan, "non-finite"), (broken, "SyntaxError"),
                       (tmp_path / "missing.py", "FileNotFoundError")):
        r, m = run_episode(path, PRACTICE_PUSH)
        assert not r["success"] and r["outcome"] == "error" and text in r["exception"], (path, r["exception"])
        assert r["end_reason"] == "exception" and validate_motion(m) == []


def test_returning_none_keeps_the_targets(tmp_path):
    lazy = _write(tmp_path, "lazy.py", "class Controller:\n    def reset(self, task): self.task = task\n    def act(self, obs): return None\n")
    r, _ = run_episode(lazy, [0, 0], record=False)
    assert r["success"] and r["exception"] is None


def test_obs_has_what_the_docstring_promises(tmp_path):
    spy = _write(tmp_path, "spy.py", (
        "import json\n"
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        self.task = task\n"
        "    def act(self, obs):\n"
        "        if obs['time'] == 0.0:\n"
        f"            open({str(tmp_path / 'obs.json')!r}, 'w').write(json.dumps({{k: (v.tolist() if hasattr(v, 'tolist') else v) for k, v in obs.items()}}))\n"
        "        return None\n"
    ))
    run_episode(spy, [0, 0], record=False)
    obs = json.loads((tmp_path / "obs.json").read_text())
    sizes = {"qpos": 36, "qvel": 35, "joint_pos": 29, "joint_vel": 29, "com": 3, "com_vel": 3, "pelvis_pos": 3,
             "pelvis_quat": 4, "torso_quat": 4, "torso_angvel": 3, "left_foot": 3, "right_foot": 3, "foot_contact": 2}
    for key, n in sizes.items():
        assert len(obs[key]) == n, key
    assert obs["foot_contact"] == [True, True] and obs["left_foot"][1] > 0.1 > -0.1 > obs["right_foot"][1]
    assert 0.6 < obs["com"][2] < 0.75
    assert obs["task"] == {"control_hz": 50, "max_time": MAX_TIME, "joints": list(JOINTS)}
    assert "push" not in obs and "push" not in obs["task"]


# ---------------------------------------------------------------- outcome


def test_the_outcome_rule():
    assert OUTCOMES == ("upright", "stumbled", "fell", "error")
    assert outcome({"exception": "x", "fell": True}) == "error"
    assert outcome({"fell": True, "stumbled": False}) == "fell"
    assert outcome({"fell": False, "stumbled": True}) == "stumbled"
    assert outcome({"fell": False, "stumbled": False}) == "upright"
    f = failure_result({"push": [10, 20], "seed": 2}, "Timeout: no", "timeout")
    assert f["outcome"] == "error" and not f["success"] and f["push"] == {"angle_deg": 10.0, "force_n": 20.0} and f["seed"] == 2


def test_a_hard_shove_that_slides_the_feet_is_a_stumble():
    r, _ = run_episode(SPREAD, [124.1, 47.6], record=False)
    assert r["success"] and r["max_foot_shift_cm"] > 3.0 and r["outcome"] == "stumbled"


# ---------------------------------------------------------------- motion files


def test_motion_file_round_trip_and_size(tmp_path):
    from sim.motion import LOW_DECIMALS, LOW_FPS

    _, motion = run_episode(TEMPLATE, PRACTICE_PUSH)
    assert motion["format"] == FORMAT == "g1-motion/1"
    h = motion["header"]
    assert h["model_id"] == MODEL_ID and h["nq"] == 36 and len(h["actuator_names"]) == 29 and h["fps"] == 30
    assert set(h["push"]) == {"angle_deg", "force_n", "time_s", "duration_s"}
    assert validate_motion(motion) == []
    assert motion["frames"][0]["t"] == 0.0 and motion["frames"][-1]["t"] == motion["result"]["time_taken"]
    size = write_motion(motion, tmp_path / "m.motion.json")
    assert size < MAX_BYTES
    assert read_motion(tmp_path / "m.motion.json") == motion
    _, low = run_episode(BASELINE, PRACTICE_PUSH, motion_fps=LOW_FPS, motion_decimals=LOW_DECIMALS)
    assert validate_motion(low) == [] and len(json.dumps(low)) < 30_000


def test_validate_motion_finds_problems():
    _, motion = run_episode(TEMPLATE, [0, 0], max_time=0.2)
    bad = json.loads(json.dumps(motion))
    bad["format"] = "panda-motion/1"
    bad["frames"][1]["feet"] = [0.0]
    del bad["header"]["push"]
    problems = validate_motion(bad)
    assert any("format" in p for p in problems) and any("feet" in p for p in problems) and any("push" in p for p in problems)


def test_the_cli_writes_a_motion_file(tmp_path):
    out = tmp_path / "live" / "practice.motion.json"
    proc = subprocess.run([sys.executable, "-m", "sim.humanoid.run", "--controller", str(BASELINE), "--angle", "90",
                           "--force", "30", "--out", str(out)], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["success"] and result["push"]["angle_deg"] == 90.0
    assert read_motion(out)["header"]["push"]["force_n"] == 30.0


# ---------------------------------------------------------------- hidden pushes


def test_hidden_pushes_are_fixed_and_cover_every_direction_and_force():
    h = hidden.hidden_pushes()
    assert h == hidden.hidden_pushes() and len(h) == 20
    assert all(0 <= a < 360 and hidden.F_MIN <= f <= hidden.F_MAX for a, f in h)
    assert not any(hidden.near_practice(p) for p in h)
    octants = {int(a // 45) for a, _ in h}
    assert octants == set(range(8))
    forces = sorted(f for _, f in h)
    assert forces[0] < hidden.F_MIN + 2 and forces[-1] > hidden.F_MAX - 2
    assert hidden.hidden_pushes(10) != h[:10]  # a different n is a different stratification


def test_spread_pushes_stay_away_from_the_hidden_ones():
    h, s = hidden.hidden_pushes(), hidden.spread_pushes()
    assert len(s) == 16 and s != h[:16]
    assert all(hidden._distance(p, q) >= 1.0 for p in s for q in h)


def test_angle_diff_wraps():
    assert hidden.angle_diff(350, 10) == 20 and hidden.angle_diff(0, 180) == 180 and hidden.angle_diff(-90, 270) == 0
