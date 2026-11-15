"""The 3D robot viewer's routes (deep_research/robot_view.py): the scene and the poses of a motion file."""

import gzip
import json

import pytest

pytest.importorskip("mujoco")

from fastapi.testclient import TestClient  # noqa: E402

from deep_research import api  # noqa: E402
from deep_research.config import FIXTURES_DIR  # noqa: E402
from sim.scene import PANDA_SCENE  # noqa: E402

if not PANDA_SCENE.is_file():
    pytest.skip("the panda meshes are not downloaded (python -m sim.fetch_assets)", allow_module_level=True)

ROBOT = "robot-demo-batch"
MOTION = "runs/r01/outputs/live/practice.motion.json"
SCENE_BUDGET = 3_000_000


@pytest.fixture(scope="module")
def client():
    with TestClient(api.app) as c:
        yield c


def test_scene_has_the_arm_the_can_and_the_zone_within_budget(client):
    res = client.get("/api/robot/scene")
    assert res.status_code == 200
    assert len(res.content) < SCENE_BUDGET  # decoded JSON
    raw = gzip.compress(res.content)
    assert len(raw) < 1_000_000
    scene = res.json()
    names = {b["name"] for b in scene["bodies"]}
    assert {"link1", "link7", "hand", "left_finger", "right_finger", "can", "place_zone"} <= names
    types = {g["type"] for g in scene["geoms"]}
    assert {"mesh", "cylinder", "plane"} <= types
    for g in scene["geoms"]:
        assert len(g["pos"]) == 3 and len(g["quat"]) == 4 and len(g["rgba"]) == 4
        if g["type"] == "mesh":
            mesh = scene["meshes"][g["mesh"]]
            assert len(mesh["v"]) % 3 == 0 and len(mesh["f"]) % 3 == 0
            assert max(mesh["f"]) < len(mesh["v"]) // 3


def test_scene_is_sent_gzipped(client):
    res = client.get("/api/robot/scene", headers={"Accept-Encoding": "gzip"})
    assert res.headers.get("content-encoding") == "gzip"


def test_motion_gives_one_pose_set_per_frame(client):
    motion = json.loads((FIXTURES_DIR / ROBOT / MOTION).read_text())
    res = client.get(f"/api/batches/{ROBOT}/motion", params={"path": MOTION})
    assert res.status_code == 200
    data = res.json()
    n = len(motion["frames"])
    assert data["n"] == n and len(data["t"]) == n and len(data["frames"]) == n
    assert all(len(row) == 7 * len(data["bodies"]) for row in data["frames"])
    assert data["result"]["success"] == motion["result"]["success"]
    assert data["place_target"] == motion["header"]["place_target"]
    # The can body's pose is the frame's can position.
    scene = client.get("/api/robot/scene").json()
    can = next(b["id"] for b in scene["bodies"] if b["name"] == "can")
    k = data["bodies"].index(can) * 7
    for i in (0, n // 2, n - 1):
        assert data["frames"][i][k : k + 3] == pytest.approx(motion["frames"][i]["can_pos"], abs=1e-3)
    # The place zone is where this file has it.
    zone = next(b["id"] for b in scene["bodies"] if b["name"] == "place_zone")
    assert data["static"][str(zone)][:2] == pytest.approx(motion["header"]["place_target"])


def test_motion_of_a_fork_child(client):
    path = "forks/f1/forced-1/outputs/live/practice.motion.json"
    res = client.get(f"/api/batches/{ROBOT}/motion", params={"path": path})
    assert res.status_code == 200 and res.json()["n"] > 10


@pytest.mark.parametrize("path", [
    "task/hidden_positions.json",
    "case/case.json",
    "runs/r01/events.jsonl",
    "runs/r01/outputs/../../../task/hidden_positions.json",
    "/etc/passwd",
    "runs/r01/outputs/live/../../../../task/hidden_positions.json",
])
def test_motion_refuses_paths_outside_outputs(client, path):
    res = client.get(f"/api/batches/{ROBOT}/motion", params={"path": path})
    assert res.status_code in (400, 404)
    assert "hidden" not in res.text.replace(path, "")


def test_motion_of_a_missing_file_or_batch(client):
    assert client.get(f"/api/batches/{ROBOT}/motion", params={"path": "runs/r01/outputs/live/nope.motion.json"}).status_code == 404
    assert client.get("/api/batches/no-such-batch/motion", params={"path": MOTION}).status_code == 404


def test_motion_refuses_a_file_that_is_not_one(client):
    res = client.get(f"/api/batches/{ROBOT}/motion", params={"path": "runs/r01/outputs/report.json"})
    assert res.status_code == 422


def test_motion_summaries_for_the_file_picker(client):
    paths = [MOTION, "runs/r01/outputs/live/far_left.motion.json", "task/hidden_positions.json"]
    res = client.get(f"/api/batches/{ROBOT}/motion-summaries", params={"path": paths})
    assert res.status_code == 200
    data = res.json()
    first = data[MOTION]
    assert first["n"] > 10 and first["duration"] > 0 and first["can_start"] and "success" in first["result"]
    assert data[paths[1]]["can_start"] != first["can_start"]
    assert "error" in data[paths[2]] and len(data[paths[2]]) == 1


def test_motion_files_are_built_one_at_a_time(tmp_path, monkeypatch):
    """A run's page asks for several motion files at once. Built side by side they ran a 1 GB server out of memory, so
    only one is built at a time, and a file asked for twice is built once."""
    import threading
    import time

    from deep_research import robot_view

    running = {"now": 0, "most": 0, "calls": 0}
    guard = threading.Lock()

    def slow_poses(motion):
        with guard:
            running["now"] += 1
            running["calls"] += 1
            running["most"] = max(running["most"], running["now"])
        time.sleep(0.05)
        with guard:
            running["now"] -= 1
        return {"frames": []}

    monkeypatch.setattr(robot_view, "poses", slow_poses)
    files = []
    for i in range(4):
        f = tmp_path / f"m{i}.motion.json"
        f.write_text('{"frames": [], "n": %d}' % i)
        files.append(f)
    # Four different files, and the first one asked for three times.
    asks = [*files, files[0], files[0]]
    threads = [threading.Thread(target=robot_view.motion_poses, args=(f,)) for f in asks]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert running["most"] == 1
    assert running["calls"] == 4
