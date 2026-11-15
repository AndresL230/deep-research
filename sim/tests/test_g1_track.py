"""The tracking sim (sim/g1/track/): the reference motions, an episode and its scoring, the sets, the evaluation, and
the code that fits a motion capture clip onto the robot.

Needs the G1 model, which is downloaded, not committed: `python -m sim.g1.fetch_assets`. The CMU clips themselves are
not needed: the fitted references are committed, and the fitting code is tried on a skeleton written out here.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from sim.g1 import fetch_assets
from sim.g1.track import hidden, motions
from sim.g1.track.practice import PRACTICE
from sim.g1.track.results import ERRORS, OUTCOMES, failure_result, outcome

CONTROLLERS = Path(__file__).resolve().parent.parent / "g1" / "track" / "controllers"
CALM = "cmu_26_03_t010"         # the practice motion
DEMANDING = "cmu_14_20_t014"    # a public one that needs balance


@pytest.fixture(autouse=True, scope="module")
def _g1_assets():
    missing = fetch_assets.missing_files()
    if missing:
        pytest.fail(f"{len(missing)} G1 asset files are missing from sim/assets/: run `python -m sim.g1.fetch_assets` first")


def run(controller: str, motion, **kwargs):
    from sim.g1.track.episode import run_episode

    return run_episode(CONTROLLERS / f"{controller}.py", motion, **kwargs)


# --- the reference motions ------------------------------------------------------------------------


def test_the_sets_are_apart_and_half_of_each_is_demanding():
    sets = {name: motions.names(name) for name in motions.SETS}
    assert [len(sets[s]) for s in ("public", "hidden", "diagnostic")] == [6, 20, 8]
    assert len(set(sum(sets.values(), []))) == 34  # no motion is in two sets
    for name, items in sets.items():
        kinds = [motions.load(n, name)["kind"] for n in items]
        assert kinds.count("demanding") == len(items) // 2 and kinds.count("calm") == len(items) // 2
    assert PRACTICE["motion"] == CALM and CALM in sets["public"] and motions.load(CALM)["kind"] == "calm"
    with pytest.raises(ValueError):
        motions.names("secret")


def test_every_motion_starts_in_the_same_pose_with_its_feet_planted_throughout():
    import mujoco

    from sim.g1.scene import build_track_model

    m = build_track_model()
    d = mujoco.MjData(m)
    feet = [m.body("left_ankle_roll_link").id, m.body("right_ankle_roll_link").id]
    ready = motions.load(CALM)["qpos"][0]
    for set_name in motions.SETS:
        for name in motions.names(set_name):
            mo = motions.load(name, set_name)
            assert mo["fps"] == motions.FPS and mo["lead_in"] == motions.LEAD_IN and mo["description"] and mo["source"]["clip"]
            assert 5.0 <= motions.duration(mo) - mo["lead_in"] <= 8.1
            assert np.allclose(mo["qpos"][0], ready, atol=0.01), name  # the smoothing leaves a hundredth of a radian
            where = []
            for q in mo["qpos"][::15]:
                d.qpos[:] = q
                mujoco.mj_kinematics(m, d)
                where.append(d.xpos[feet].copy())
            assert np.ptp(np.array(where), axis=0).max() < 0.01, name  # the ankles stay where they are, to a centimeter
            speed = np.abs(np.diff(mo["qpos"][:, 7:], axis=0)) * mo["fps"]
            # The legs move slowly; a shoulder can swing fast where the arm is nearly straight, but no joint jumps.
            assert speed[:, :12].max() < 3.0 and speed.max() < 30.0, name


def test_a_motion_is_checked_and_read_between_its_frames():
    mo = motions.load(CALM)
    saved = motions.to_file(mo)
    again = motions.check_motion(saved)
    assert again["name"] == CALM and np.allclose(again["qpos"], mo["qpos"], atol=1e-4) and saved["format"] == "g1-reference/1"
    a, b = mo["qpos"][60], mo["qpos"][61]
    mid = motions.reference(mo, 60.5 / mo["fps"])
    assert np.allclose(mid[7:], (a[7:] + b[7:]) / 2) and abs(np.linalg.norm(mid[3:7]) - 1) < 1e-9
    assert np.allclose(motions.reference(mo, -1.0), mo["qpos"][0]) and np.allclose(motions.reference(mo, 99.0), mo["qpos"][-1])
    assert motions.resolve(CALM)["name"] == CALM and motions.resolve({"set": "hidden", "name": motions.names("hidden")[0]})["kind"]
    assert motions.public_info(mo) == {"name": CALM, "kind": "calm", "description": mo["description"], "seconds": 8.0}
    for bad in ({"root": [[0, 0, 0.8, 0]] * 100, "joints": [[0.0] * 28] * 100}, {"root": [[0, 0, 0.8, 0]] * 3, "joints": [[0.0] * 29] * 3},
                {"joints": [[0.0] * 29] * 100}, "nothing"):
        with pytest.raises(ValueError):
            motions.check_motion(bad)
    for name in ("moonwalk", "../hidden/" + motions.names("hidden")[0]):
        with pytest.raises(ValueError):
            motions.load(name)


# --- episodes -------------------------------------------------------------------------------------


def test_the_template_stands_still_and_tracks_nothing():
    result, motion = run("template", CALM)
    assert result["success"] is False and result["fell"] is False and outcome(result) == "off_track"
    assert result["e_mpjpe"] > 0.05 and result["end_reason"] == "finished" and result["motion"] == CALM and result["kind"] == "calm"
    assert result["tracked_s"] == pytest.approx(8.0, abs=0.05) and result["time_taken"] == pytest.approx(10.5)
    assert motion["format"] == "g1-track-motion/1" and motion["header"]["model_id"] == "g1-track-v1"
    assert motion["header"]["motion"]["name"] == CALM and motion["header"]["motion_set"] == "public"
    assert len(motion["frames"][0]["qpos"]) == 36 and "reference" not in json.dumps(motion["header"])


def test_playback_tracks_a_calm_motion_and_falls_on_a_demanding_one_the_baseline_tracks():
    calm, _ = run("playback", CALM, record=False)
    assert calm["success"] and calm["e_mpkpe"] < 0.04 and calm["e_mpjpe"] < 0.03 and outcome(calm) == "tracked"
    assert calm["e_mpkpe_lower"] < calm["e_mpkpe_upper"] and calm["e_vel"] < 0.2
    fell, _ = run("playback", DEMANDING, record=False)
    assert fell["fell"] and not fell["success"] and fell["end_reason"] == "fell" and outcome(fell) == "fell"
    # The errors of a robot that fell are measured up to the fall.
    assert fell["tracked_s"] < 8.0 and fell["fell_at"] > 1.5 and fell["e_mpjpe"] is not None
    stood, _ = run("baseline", DEMANDING, record=False)
    assert stood["success"] and not stood["fell"] and stood["e_mpkpe"] < 0.04


def test_same_seed_same_episode_and_another_seed_another():
    a, _ = run("playback", CALM, seed=3, record=False)
    b, _ = run("playback", CALM, seed=3, record=False)
    c, _ = run("playback", CALM, seed=4, record=False)
    assert a == b and a["e_mpjpe"] != c["e_mpjpe"]


def test_a_controller_that_fails_ends_the_episode_as_a_failure(tmp_path):
    from sim.g1.track.episode import run_episode

    bad = tmp_path / "bad.py"
    bad.write_text("class Controller:\n    def reset(self, task):\n        pass\n    def act(self, obs):\n        return [0.0] * 8\n")
    result, _ = run_episode(bad, CALM, record=False)
    assert not result["success"] and result["end_reason"] == "exception" and "29 numbers" in result["exception"]
    assert outcome(result) == "error" and result["e_mpkpe"] is None
    with pytest.raises(ValueError):
        run_episode(bad, "moonwalk")


def test_the_task_gives_the_whole_reference_and_the_limits(tmp_path):
    from sim.g1.track.episode import MPJPE_MAX, MPKPE_MAX, run_episode

    spy = tmp_path / "spy.py"
    spy.write_text(
        "import json, numpy as np\n"
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        self.q = np.array(task['ready_qpos'])[7:]\n"
        f"        open({str(tmp_path / 'task.json')!r}, 'w').write(json.dumps(dict(shape=list(np.shape(task['reference']['qpos'])), "
        "fps=task['reference']['fps'], limits=task['limits'], motion=task['motion'], bodies=task['key_bodies'])))\n"
        "    def act(self, obs):\n"
        "        assert obs['ref_qpos'].shape == (36,) and obs['qpos'].shape == (36,) and obs['com'].shape == (3,)\n"
        "        self.done = obs['time'] > 0.3\n"
        "        return self.q\n"
    )
    result, _ = run_episode(spy, CALM, record=False)
    assert result["exception"] is None and result["end_reason"] == "controller_done"
    task = json.loads((tmp_path / "task.json").read_text())
    assert task["shape"] == [286, 36] and task["fps"] == 30 and task["limits"] == {"e_mpkpe": MPKPE_MAX, "e_mpjpe": MPJPE_MAX}
    assert task["motion"]["name"] == CALM and len(task["bodies"]) == 9


# --- results, the sets, evaluation ----------------------------------------------------------------


def test_outcome_words_and_the_failure_result():
    assert outcome({"success": True}) == "tracked" and outcome({"fell": True}) == "fell" and outcome({}) == "off_track"
    assert outcome({"fell": True, "exception": "x"}) == "error" and set(OUTCOMES) == {"tracked", "fell", "off_track", "error"}
    real, _ = run("template", CALM, record=False)
    failed = failure_result({"motion": {"set": "hidden", "name": "x", "kind": "calm"}, "seed": 2}, "Timeout: x", "timeout")
    assert set(failed) == set(real) and failed["motion"] == "x" and failed["kind"] == "calm" and outcome(failed) == "error"
    assert all(failed[k] is None for k in ERRORS) and failure_result({"motion": CALM, "seed": 0}, "x", "timeout")["motion"] == CALM


def test_the_hidden_and_diagnostic_sets_take_calm_and_demanding_in_turn():
    held = hidden.hidden_motions()
    assert len(held) == 20 and [m["kind"] for m in held[:4]] == ["calm", "demanding", "calm", "demanding"]
    assert all(m["set"] == "hidden" for m in held) and len(hidden.hidden_motions(6)) == 6
    diag = hidden.diagnostic_motions()
    assert len(diag) == 8 and not {m["name"] for m in diag} & {m["name"] for m in held}
    assert {m["name"] for m in hidden.public_motions()} == set(motions.names("public"))


def test_evaluate_runs_every_motion_and_seed_and_records(tmp_path):
    from sim.g1.track.evaluate import evaluate, motion_name, motion_set
    from sim.motion import read_motion

    pair = [{"set": "public", "name": CALM, "kind": "calm"}, {"set": "public", "name": DEMANDING, "kind": "demanding"}]
    out = evaluate(CONTROLLERS / "playback.py", pair, seeds=(0, 1), record_dir=tmp_path / "rec", workers=2)
    assert out["n"] == 4 and [r["index"] for r in out["results"]] == [0, 0, 1, 1]
    assert [r["success"] for r in out["results"]] == [True, True, False, False] and out["success_rate"] == 0.5
    motion = read_motion(tmp_path / "rec" / motion_name(1, 0))
    assert motion["header"]["motion"]["name"] == DEMANDING and motion["header"]["fps"] == 8
    assert [m["name"] for m in motion_set("practice")] == [CALM] and len(motion_set("hidden")) == 20
    missing = evaluate(tmp_path / "missing.py", pair[:1], workers=1)
    assert missing["successes"] == 0 and missing["results"][0]["kind"] == "calm" and "e_mpkpe" in missing["results"][0]


# --- fitting a clip onto the robot ----------------------------------------------------------------

ASF = """:version 1.10
:units
  mass 1.0
  length 0.45
  angle deg
:root
   order TX TY TZ RX RY RZ
   axis XYZ
   position 0 0 0
   orientation 0 0 0
:bonedata
  begin
     id 1
     name spine
     direction 0 1 0
     length 10
     axis 0 0 0  XYZ
  end
  begin
     id 2
     name larm
     direction 1 0 0
     length 5
     axis 0 0 0  XYZ
     dof rz
  end
:hierarchy
  begin
    root spine
    spine larm
  end
"""


def test_a_skeleton_file_is_read_and_turned_into_our_axes(tmp_path):
    from sim.g1.track import retarget

    (tmp_path / "s.asf").write_text(ASF)
    (tmp_path / "s.amc").write_text("#!OML:ASF\n:FULLY-SPECIFIED\n:DEGREES\n1\nroot 0 20 0 0 0 0\nlarm 0\n2\nroot 0 20 0 0 0 0\nlarm 90\n")
    sk = retarget.Skeleton(tmp_path / "s.asf")
    inch = retarget.ASF_TO_M
    rest = sk.points()
    # CMU's y is up and its x is the person's left: ours are z up and y left.
    assert np.allclose(rest["spine"][0], [0, 0, 10 * inch]) and np.allclose(rest["larm"][0], [0, 5 * inch, 10 * inch])
    p = sk.points(sk.read_amc(tmp_path / "s.amc"))
    assert np.allclose(p["root"], [[0, 0, 20 * inch]] * 2)
    assert np.allclose(p["larm"][0], [0, 5 * inch, 30 * inch])   # the arm out to the left
    assert np.allclose(p["larm"][1], [0, 0, 35 * inch])          # turned a quarter about the forward axis: straight up


def _person(n: int, fps: int) -> dict[str, np.ndarray]:
    """A person standing still who raises the left wrist, and whose right foot steps away for the last second."""
    t = np.arange(n) / fps
    still = lambda x, y, z: np.tile([x, y, z], (n, 1)).astype(float)  # noqa: E731
    p = {"pelvis": still(0, 0, 1.0), "neck": still(0, 0, 1.5), "head": still(0, 0, 1.7),
         "left_hip": still(0, 0.1, 0.95), "right_hip": still(0, -0.1, 0.95), "left_knee": still(0, 0.1, 0.5), "right_knee": still(0, -0.1, 0.5),
         "left_ankle": still(0, 0.1, 0.08), "right_ankle": still(0, -0.1, 0.08),
         "left_shoulder": still(0, 0.2, 1.45), "right_shoulder": still(0, -0.2, 1.45),
         "left_elbow": still(0, 0.25, 1.15), "right_elbow": still(0, -0.25, 1.15),
         "left_wrist": still(0.05, 0.25, 0.9), "right_wrist": still(0.05, -0.25, 0.9)}
    lift = np.clip((t - 1.0) / 2.0, 0, 1)
    p["left_elbow"][:, 2] += 0.3 * lift
    p["left_elbow"][:, 0] += 0.2 * lift
    p["left_wrist"][:, 2] += 0.7 * lift
    p["left_wrist"][:, 0] += 0.3 * lift
    p["right_ankle"][t > 7.0, 0] += 0.4
    return p


def test_a_planted_stretch_is_found_and_fitted_with_the_feet_down_and_the_weight_over_them():
    import mujoco

    from sim.g1.track import retarget

    fps = 30
    person = _person(8 * fps + 1, fps)
    assert retarget.planted_stretches(person, fps) == [(0, 7 * fps + 1)]
    assert retarget.planted_stretches(person, fps, min_seconds=7.5) == []
    stretch = {k: v[: 4 * fps] for k, v in person.items()}
    fitter = retarget.make_fitter()
    q = fitter.fit(stretch, {k: v[:1] for k, v in person.items()}, fps)
    lead = int(retarget.LEAD_IN * fps)
    assert q.shape == (lead + 4 * fps, 36) and np.all(np.isfinite(q))
    m, d = fitter.m, mujoco.MjData(fitter.m)
    wrist, ankle = m.body("left_wrist_yaw_link").id, m.body("left_ankle_roll_link").id
    heights = []
    for row in q[::10]:
        d.qpos[:] = row
        mujoco.mj_kinematics(m, d)
        mujoco.mj_comPos(m, d)
        assert np.linalg.norm(d.xpos[ankle] - fitter.feet["left"]) < 0.005
        com = d.subtree_com[0][:2] - fitter.support
        assert retarget.COM_BOX[0][0] - 0.01 <= com[0] <= retarget.COM_BOX[0][1] + 0.01 and abs(com[1]) <= retarget.COM_BOX[1][1] + 0.01
        heights.append(float(d.xpos[wrist][2]))
    assert heights[-1] - heights[lead // 10] > 0.25      # the robot's left wrist goes up with the person's
    assert retarget.PELVIS_Z[0] <= q[:, 2].min() and q[:, 2].max() <= retarget.PELVIS_Z[1] + 1e-6
