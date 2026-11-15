"""The 3D viewer's routes for the humanoid: the G1 scene, and the poses and push of a `g1-push-motion/1` file."""

import gzip
import json

import pytest

pytest.importorskip("mujoco")

from fastapi.testclient import TestClient  # noqa: E402

from deep_research import api, robot_view  # noqa: E402
from sim.humanoid.scene import G1_SCENE  # noqa: E402

if not G1_SCENE.is_file():
    pytest.skip("the G1 meshes are not downloaded (python -m sim.fetch_assets --model unitree_g1)", allow_module_level=True)

MOTION = "runs/r01/outputs/live/front.motion.json"


@pytest.fixture(scope="module")
def batch(tmp_path_factory):
    from sim.humanoid.episode import run_episode
    from sim.motion import write_motion

    root = tmp_path_factory.mktemp("batches")
    d = root / "hb"
    (d / "case").mkdir(parents=True)
    (d / "case" / "case.json").write_text(json.dumps({"config": {"domain": "humanoid_push", "visual": "motion"}, "phase": "done",
                                                      "runs": {"r01": {"status": "inflated", "motion_files": [MOTION]}}}))
    _, motion = run_episode("sim/humanoid/controllers/one_spot.py", [180, 35])
    write_motion(motion, d / MOTION)
    return root, motion


@pytest.fixture(scope="module")
def client(batch):
    api.BATCHES_DIR, old = batch[0], api.BATCHES_DIR
    try:
        with TestClient(api.app) as c:
            yield c
    finally:
        api.BATCHES_DIR = old


def test_the_g1_scene_has_the_robot_and_a_view(client):
    res = client.get("/api/robot/scene", params={"model": "g1-push-v1"})
    assert res.status_code == 200
    assert len(gzip.compress(res.content)) < 600_000
    scene = res.json()
    assert scene["model_id"] == "g1-push-v1"
    names = {b["name"] for b in scene["bodies"]}
    assert {"pelvis", "torso_link", "left_ankle_roll_link", "right_wrist_yaw_link"} <= names
    assert scene["view"]["push_body"] == "torso_link"
    assert {b["name"]: b["id"] for b in scene["bodies"]}["torso_link"] == scene["view"]["push_body_id"]
    assert len(scene["view"]["camera"]) == 3 and len(scene["view"]["fog"]) == 2
    # No collision shapes: only the meshes that are drawn.
    assert {g["type"] for g in scene["geoms"]} <= {"mesh", "plane"}


def test_the_arm_scene_is_still_the_default(client):
    arm = client.get("/api/robot/scene").json()
    assert arm["model_id"] == "panda-can-v1" and "can" in {b["name"] for b in arm["bodies"]}
    assert arm["view"]["target"] == [0.36, -0.06, 0.24]
    assert client.get("/api/robot/scene", params={"model": "nope"}).status_code == 404


def test_a_humanoid_motion_gives_poses_and_the_push(client, batch):
    _, motion = batch
    res = client.get("/api/batches/hb/motion", params={"path": MOTION})
    assert res.status_code == 200, res.text
    data = res.json()
    n = len(motion["frames"])
    assert data["model_id"] == "g1-push-v1" and data["n"] == n and len(data["frames"]) == n
    assert len(data["bodies"]) == 30 and all(len(f) == 7 * 30 for f in data["frames"])
    assert data["push"]["angle_deg"] == 180.0 and data["push"]["force_n"] == 35.0 and data["push"]["duration_s"] == 0.2
    assert data["can_start"] is None and data["place_target"] is None
    r = data["result"]
    assert r["outcome"] == "fell" and r["fell"] is True and r["success"] is False and "max_tilt_deg" in r
    # The pelvis starts standing and ends on the floor.
    k = data["bodies"].index(1)
    assert data["frames"][0][7 * k + 2] > 0.7 and data["frames"][-1][7 * k + 2] < 0.45


def test_the_file_picker_summary_has_the_push(client):
    s = client.get("/api/batches/hb/motion-summaries", params={"path": [MOTION]}).json()[MOTION]
    assert s["push"]["angle_deg"] == 180.0 and s["result"]["outcome"] == "fell" and s["can_start"] is None


def test_an_unknown_model_is_refused():
    with pytest.raises(robot_view.MotionError):
        robot_view.poses({"header": {"model_id": "atlas-v9"}, "frames": [{"qpos": [0.0]}]})
