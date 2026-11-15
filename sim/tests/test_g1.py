"""The humanoid sim (sim/g1/): the scene, the whole-body helper, an episode and its scoring, the evaluation.

Needs the G1 model, which is downloaded, not committed: `python -m sim.g1.fetch_assets`.
"""

import shutil
from pathlib import Path

import numpy as np
import pytest

from sim.g1 import fetch_assets, hidden
from sim.g1.results import OUTCOMES, failure_result, outcome

CONTROLLERS = Path(__file__).resolve().parent.parent / "g1" / "controllers"
PRACTICE_BAG = [0.38, -0.15, 1.0]
LOW_BAG = [0.36, -0.04, 0.34]


@pytest.fixture(autouse=True, scope="module")
def _g1_assets():
    missing = fetch_assets.missing_files()
    if missing:
        pytest.fail(f"{len(missing)} G1 asset files are missing from sim/assets/: run `python -m sim.g1.fetch_assets` first")


def run(controller: str, bag, **kwargs):
    from sim.g1.episode import run_episode

    return run_episode(CONTROLLERS / f"{controller}.py", bag, **kwargs)


# --- assets ---------------------------------------------------------------------------------------


def test_missing_and_changed_asset_files_are_found(tmp_path):
    assert sorted(fetch_assets.missing_files(tmp_path)) == sorted(fetch_assets.FILES)
    root = tmp_path / fetch_assets.FOLDER
    shutil.copytree(fetch_assets.DEFAULT_DEST / fetch_assets.FOLDER, root)
    assert fetch_assets.missing_files(tmp_path) == []
    (root / "scene.xml").write_text("<mujoco/>")
    assert fetch_assets.missing_files(tmp_path) == ["scene.xml"]


# --- scene and helper -----------------------------------------------------------------------------


def test_scene_has_the_robot_and_a_bag_hanging_where_asked():
    import mujoco

    from sim.g1.control import JOINT_NAMES
    from sim.g1.scene import ROBOT_NQ, build_model

    m = build_model(PRACTICE_BAG)
    assert (m.nq, m.nu) == (40, 29) and ROBOT_NQ == 36
    assert tuple(m.joint(j).name for j in range(1, 30)) == JOINT_NAMES
    assert tuple(m.actuator(a).name for a in range(m.nu)) == JOINT_NAMES
    d = mujoco.MjData(m)
    d.qpos[36] = 1.0
    mujoco.mj_forward(m, d)
    assert np.allclose(d.site_xpos[m.site("bag_center").id], PRACTICE_BAG)


def test_standing_pose_has_both_soles_on_the_floor_and_the_weight_between_them():
    from sim.g1.control import STAND_QPOS, WholeBody

    p = WholeBody().points(STAND_QPOS.copy())
    assert abs(p["left_foot"][2]) < 0.005 and abs(p["right_foot"][2]) < 0.005
    assert p["left_foot"][1] > 0 > p["right_foot"][1]
    assert p["right_foot"][1] < p["com"][1] < p["left_foot"][1]
    assert p["left_toe"][0] > p["left_foot"][0]


def test_solve_moves_a_hand_to_its_target_and_keeps_the_feet_and_the_weight():
    from sim.g1.control import JOINT_LOWER, JOINT_UPPER, STAND_QPOS, WholeBody

    wb = WholeBody()
    q = STAND_QPOS.copy()
    start = wb.points(q)
    target = np.array([0.33, -0.15, 1.0])
    targets = {"left_foot": start["left_foot"], "right_foot": start["right_foot"], "com": start["com"][:2], "right_hand": target}
    for _ in range(40):
        q = wb.solve(q, targets)
    end = wb.points(q)
    assert np.linalg.norm(end["right_hand"] - target) < 0.02
    assert np.linalg.norm(end["left_foot"] - start["left_foot"]) < 0.005
    assert np.linalg.norm(end["right_foot"] - start["right_foot"]) < 0.005
    assert np.linalg.norm(end["com"][:2] - start["com"][:2]) < 0.01
    assert np.all(q[7:] >= np.asarray(JOINT_LOWER) - 1e-9) and np.all(q[7:] <= np.asarray(JOINT_UPPER) + 1e-9)


def test_solve_rejects_names_it_does_not_know():
    from sim.g1.control import STAND_QPOS, WholeBody

    wb = WholeBody()
    with pytest.raises(KeyError):
        wb.solve(STAND_QPOS.copy(), {"left_elbow": [0, 0, 1]})
    with pytest.raises(KeyError):
        wb.solve(STAND_QPOS.copy(), {}, weights={"left_elbow": 1.0})


def test_com_feedback_asks_for_more_when_the_real_weight_lags():
    from sim.g1.control import ComFeedback

    fb = ComFeedback()
    first = fb.update([0.0, 0.1], [0.0, 0.05])
    assert first[1] > 0.1
    assert np.all(np.abs(fb.update([0.0, 0.1], [0.0, -5.0]) - [0.0, 0.1]) <= fb.limit + 1e-12)


# --- episodes -------------------------------------------------------------------------------------


def test_the_template_stands_still_and_fails():
    result, motion = run("template", PRACTICE_BAG, max_time=3.0)
    assert result["success"] is False and result["fell"] is False and result["touched"] is False
    assert result["standing"] is True and result["end_reason"] == "max_time" and outcome(result) == "missed"
    assert motion["format"] == "g1-motion/1" and motion["header"]["nq"] == 40
    assert len(motion["frames"][0]["qpos"]) == 40 and len(motion["frames"][0]["bag"]) == 3
    assert motion["frames"][-1]["t"] == pytest.approx(3.0)


def test_the_baseline_punches_a_high_bag_and_kicks_a_low_one():
    high, _ = run("baseline", PRACTICE_BAG, record=False)
    assert high["success"] and high["struck_with"] == "right hand" and outcome(high) == "struck"
    low, _ = run("baseline", LOW_BAG, record=False)
    assert low["success"] and low["struck_with"] in ("right foot", "right leg") and not low["fell"]
    assert low["bag_peak_cm"] >= 20.0 and low["standing"]


def test_a_practice_only_punch_fails_on_a_low_bag():
    practice, _ = run("one_spot", PRACTICE_BAG, record=False)
    assert practice["success"]
    low, _ = run("one_spot", LOW_BAG, record=False)
    assert not low["success"] and outcome(low) in ("fell", "missed", "weak")


def test_same_seed_same_episode_and_another_seed_another_bag():
    a, _ = run("baseline", PRACTICE_BAG, seed=3, record=False)
    b, _ = run("baseline", PRACTICE_BAG, seed=3, record=False)
    c, _ = run("baseline", PRACTICE_BAG, seed=4, record=False)
    assert a == b
    assert a["bag_start_actual"] != c["bag_start_actual"]
    assert np.max(np.abs(np.array(a["bag_start_actual"]) - PRACTICE_BAG)) <= 0.005 + 1e-9


def test_a_controller_that_fails_ends_the_episode_as_a_failure(tmp_path):
    from sim.g1.episode import run_episode

    bad = tmp_path / "bad.py"
    bad.write_text("class Controller:\n    def reset(self, task):\n        pass\n    def act(self, obs):\n        return [0.0] * 8\n")
    result, _ = run_episode(bad, PRACTICE_BAG, record=False)
    assert not result["success"] and result["end_reason"] == "exception" and "29 numbers" in result["exception"]
    missing, _ = run_episode(tmp_path / "none.py", PRACTICE_BAG, record=False)
    assert missing["end_reason"] == "exception" and "FileNotFoundError" in missing["exception"]


def test_a_robot_that_falls_does_not_succeed_even_when_it_hit_the_bag(tmp_path):
    from sim.g1.episode import run_episode

    # Every leg joint let go at once: the robot drops.
    limp = tmp_path / "limp.py"
    limp.write_text(
        "from sim.g1.control import STAND_QPOS\n"
        "class Controller:\n"
        "    def reset(self, task):\n        self.q = STAND_QPOS.copy()[7:]\n"
        "    def act(self, obs):\n        a = list(self.q)\n        a[0] = a[6] = -1.5\n        a[3] = a[9] = 2.5\n        return a\n"
    )
    result, _ = run_episode(limp, [0.3, 0.0, 0.9], record=False)
    assert result["fell"] and not result["success"] and result["end_reason"] == "fell" and outcome(result) == "fell"


# --- results, hidden positions, evaluation --------------------------------------------------------


def test_outcome_words_cover_every_case():
    assert outcome({"success": True}) == "struck"
    assert outcome({"fell": True, "touched": True}) == "fell"
    assert outcome({"touched": True}) == "weak"
    assert outcome({}) == "missed"
    failed = failure_result({"bag_pos": [0.3, 0, 1], "seed": 2}, "Timeout: x", "timeout")
    assert outcome(failed) == "missed" and failed["seed"] == 2 and failed["bag_pos"] == [0.3, 0.0, 1.0]
    assert set(OUTCOMES) == {"struck", "fell", "weak", "missed"}


def test_failure_result_has_the_keys_of_a_real_result():
    real, _ = run("template", PRACTICE_BAG, max_time=0.1, record=False)
    assert set(failure_result({"bag_pos": PRACTICE_BAG, "seed": 0}, "x", "timeout")) == set(real)


def test_hidden_positions_are_fixed_half_high_half_low_and_never_the_practice_one():
    from sim.g1.practice import PRACTICE

    pos = hidden.hidden_positions()
    assert pos == hidden.hidden_positions() and len(pos) == 20
    assert all(hidden.in_space(p) for p in pos)
    assert sum(hidden.band_of(p) == "low" for p in pos) == 10
    assert all(np.linalg.norm(np.array(p) - PRACTICE["bag_pos"]) > 0.03 for p in pos)
    assert hidden.in_space(PRACTICE["bag_pos"]) and hidden.band_of(PRACTICE["bag_pos"]) == "high"
    assert hidden.spread_positions() != pos[:16] and all(hidden.in_space(p) for p in hidden.spread_positions())
    assert not hidden.in_space([0.35, 0.0, 0.65])


def test_evaluate_runs_every_position_and_seed_and_records(tmp_path):
    from sim.g1.evaluate import evaluate, motion_name
    from sim.motion import read_motion

    out = evaluate(CONTROLLERS / "one_spot.py", [PRACTICE_BAG, LOW_BAG], seeds=(0, 1), record_dir=tmp_path / "rec", workers=2)
    assert out["n"] == 4 and [r["index"] for r in out["results"]] == [0, 0, 1, 1]
    assert [r["success"] for r in out["results"]] == [True, True, False, False] and out["success_rate"] == 0.5
    motion = read_motion(tmp_path / "rec" / motion_name(1, 0))
    assert motion["header"]["bag_pos"] == LOW_BAG and motion["header"]["fps"] == 8


def test_evaluate_gives_a_failure_in_this_sims_keys_when_the_controller_cannot_load(tmp_path):
    from sim.g1.evaluate import evaluate

    out = evaluate(tmp_path / "missing.py", [PRACTICE_BAG], workers=1)
    assert out["successes"] == 0 and out["results"][0]["bag_pos"] == PRACTICE_BAG and "struck" in out["results"][0]
