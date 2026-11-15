"""The 3D viewer's server side for the humanoid: the G1 scene and a strike recording as body poses per frame.

Needs mujoco and the G1 model (`python -m sim.g1.fetch_assets`); skipped without them.
"""

import json

import pytest
from fastapi.testclient import TestClient

from deep_research import api, robot_view

pytest.importorskip("mujoco")
fetch_assets = pytest.importorskip("sim.g1.fetch_assets")
pytestmark = pytest.mark.skipif(bool(fetch_assets.missing_files()), reason="the G1 model is not downloaded: python -m sim.g1.fetch_assets")

BAG = [0.33, 0.1, 1.05]


@pytest.fixture(scope="module")
def recording():
    from sim.g1.domain import G1_DIR
    from sim.g1.episode import run_episode

    result, motion = run_episode(G1_DIR / "controllers" / "one_spot.py", BAG, motion_fps=8, motion_decimals=3)
    return result, motion


def test_the_g1_scene_has_the_robot_the_bag_and_no_collision_shapes():
    data, packed = robot_view.scene(robot_view.G1)
    assert data["model_id"] == "g1-bag-v1" and len(packed) < 1_500_000
    names = {b["name"] for b in data["bodies"]}
    assert {"pelvis", "torso_link", "left_ankle_roll_link", "right_wrist_yaw_link", "bag"} <= names
    by_name = {g["name"]: g for g in data["geoms"] if g["name"]}
    assert by_name["bag"]["type"] == "sphere" and by_name["bag_rope"]["type"] == "capsule"
    meshes = [g for g in data["geoms"] if g["type"] == "mesh"]
    assert len(meshes) >= 30 and all(g["mesh"] in data["meshes"] for g in meshes)
    # The feet's contact spheres are collision shapes: only the bag is a sphere.
    assert [g["name"] for g in data["geoms"] if g["type"] == "sphere"] == ["bag"]
    # The arm's scene is still the default, and is another model.
    assert robot_view.scene()[0]["model_id"] != data["model_id"]
    with pytest.raises(ValueError):
        robot_view.scene("spot")


def test_a_strike_recording_becomes_poses_in_the_g1_scene(recording):
    result, motion = recording
    out = robot_view.poses(motion)
    assert out["scene"] == "g1" and out["bag_pos"] == BAG and out["can_start"] is None and out["place_target"] is None
    assert out["n"] == len(motion["frames"]) == len(out["t"]) and out["static"] == {}
    scene_bodies = {b["id"] for b in robot_view.scene(robot_view.G1)[0]["bodies"]}
    assert scene_bodies - {0} <= set(out["bodies"])
    assert all(len(row) == 7 * len(out["bodies"]) for row in out["frames"])
    # The bag's body is the rope's top end, straight above where this file's bag hung.
    import mujoco

    bag_body = mujoco.mj_name2id(robot_view.g1_model(), mujoco.mjtObj.mjOBJ_BODY, "bag")
    k = out["bodies"].index(bag_body) * 7
    assert out["frames"][0][k:k + 3] == pytest.approx([BAG[0], BAG[1], BAG[2] + 0.8], abs=0.01)
    # The pelvis starts where the robot stands.
    p = out["bodies"].index(mujoco.mj_name2id(robot_view.g1_model(), mujoco.mjtObj.mjOBJ_BODY, "pelvis")) * 7
    assert out["frames"][0][p:p + 3] == pytest.approx([0.0, 0.0, 0.79], abs=0.02)
    assert out["result"]["struck_with"] == result["struck_with"] and out["result"]["fell"] is result["fell"]
    assert "bag_pos" not in out["result"] and "pelvis_min_z" not in out["result"]
    # Reading another file's bag never moves the shared model's.
    moved = robot_view.poses({**motion, "header": {**motion["header"], "bag_pos": [0.4, -0.2, 0.3]}})
    k2 = moved["bodies"].index(bag_body) * 7
    assert moved["frames"][0][k2:k2 + 3] == pytest.approx([0.4, -0.2, 1.1], abs=0.01)
    assert robot_view.poses(motion)["frames"][0][k:k + 3] == pytest.approx([BAG[0], BAG[1], BAG[2] + 0.8], abs=0.01)


def test_a_broken_strike_recording_is_refused(recording):
    _, motion = recording
    with pytest.raises(robot_view.MotionError):
        robot_view.poses({**motion, "header": {**motion["header"], "bag_pos": "here"}, "result": {}})
    with pytest.raises(robot_view.MotionError):
        robot_view.poses({**motion, "frames": [{"t": 0, "qpos": [0.0] * 16}]})


def test_the_summary_says_where_the_bag_hung(recording, tmp_path):
    _, motion = recording
    path = tmp_path / "a.motion.json"
    path.write_text(json.dumps(motion))
    s = robot_view.motion_summary(path)
    assert s["bag_pos"] == BAG and s["can_start"] is None and s["n"] == len(motion["frames"]) and "struck" in s["result"]


def test_the_scene_route_serves_both_scenes_and_no_other():
    with TestClient(api.app) as client:
        g1 = client.get("/api/robot/scene", params={"model": "g1"})
        assert g1.status_code == 200 and g1.json()["model_id"] == "g1-bag-v1"
        assert client.get("/api/robot/scene", params={"model": "spot"}).status_code == 404
