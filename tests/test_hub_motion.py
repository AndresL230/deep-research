"""A robot batch another machine ran: its episodes play from the team hub's copy of its motion files.

The hub is faked at `hub.get_case` / `hub.get_file`, serving the robot fixture's files as if another machine had sent them.
"""

import json

import pytest
from fastapi.testclient import TestClient

from deep_research import api, hub
from deep_research.config import FIXTURES_DIR

SRC = FIXTURES_DIR / "robot-demo-batch"
REMOTE = "1114-090000-beef"
LIVE = "runs/r01/outputs/live/practice.motion.json"
HIDDEN = "runs/r01/hidden/00-s0.motion.json"


class FakeFiles:
    """The hub's files: the fixture's, except those `missing` names; `down` makes every read fail."""

    def __init__(self):
        self.missing: set[str] = set()
        self.down = False
        self.calls: list[tuple[str, str, str | None]] = []
        self.version = 1

    def __call__(self, batch_id, rel, etag=None, client=None):
        self.calls.append((batch_id, rel, etag))
        if self.down:
            return hub.Fetched("error")
        f = SRC / rel
        if batch_id != REMOTE or rel in self.missing or not f.is_file():
            return hub.Fetched("missing")
        tag = f'"v{self.version}"'
        if etag == tag:
            return hub.Fetched("unchanged", etag=etag)
        return hub.Fetched("ok", f.read_bytes(), tag)


@pytest.fixture
def remote(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "_hub_cache", {})
    monkeypatch.setattr(api, "_hub_file_checked", {})
    monkeypatch.setenv("HUB_URL", "https://hub.test")
    monkeypatch.setenv("HUB_TOKEN", "t0k")
    case = json.loads((SRC / "case" / "case.json").read_text())
    monkeypatch.setattr(api.hub, "load_runner_env", lambda client=None: [])
    monkeypatch.setattr(api.hub, "pusher", lambda: None)
    monkeypatch.setattr(api.hub, "get_case", lambda bid, client=None: case if bid == REMOTE else None)
    files = FakeFiles()
    monkeypatch.setattr(api.hub, "get_file", files)
    with TestClient(api.app) as c:
        yield c, files, case


def test_summaries_of_a_hub_batch_come_from_the_hubs_files(remote):
    c, files, _ = remote
    paths = [LIVE, "runs/r01/outputs/live/far_left.motion.json", HIDDEN, "task/hidden_positions.json"]
    data = c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": paths}).json()
    assert data[LIVE]["n"] > 10 and data[LIVE]["can_start"]
    assert data[paths[1]]["can_start"] != data[LIVE]["can_start"]
    assert data[HIDDEN]["n"] > 0  # a scored run's hidden episode, listed in its hidden_results
    assert "error" in data["task/hidden_positions.json"]
    assert not any(rel.startswith("task/") for _, rel, _ in files.calls)  # never even asked for
    # Kept on disk: the batch is over, so the next look does not ask the hub again.
    n = len(files.calls)
    c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": paths[:3]})
    assert len(files.calls) == n
    assert (api.BATCHES_DIR / "_hub_files" / REMOTE / LIVE).is_file()


def test_a_recording_not_on_the_hub_says_so_not_no_batch(remote):
    c, files, _ = remote
    files.missing.add(LIVE)
    res = c.get(f"/api/batches/{REMOTE}/motion", params={"path": LIVE})
    assert res.status_code == 404
    assert res.json()["detail"].startswith("This episode's recording isn't on the hub")
    assert "no batch" not in res.text
    summary = c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [LIVE]}).json()
    assert summary[LIVE]["error"].startswith("This episode's recording isn't on the hub")


def test_an_unreachable_hub_is_named(remote):
    c, files, _ = remote
    files.down = True
    res = c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [LIVE]})
    assert "could not be reached" in res.json()[LIVE]["error"]


def test_hub_paths_are_checked_like_local_ones(remote, monkeypatch):
    c, files, case = remote
    for bad in ("task/hidden_positions.json", "case/case.json", "runs/r01/outputs/../../../task/hidden_positions.json",
                "/etc/passwd", "runs/r01/events.jsonl"):
        assert c.get(f"/api/batches/{REMOTE}/motion", params={"path": bad}).status_code in (400, 404), bad
    # A hidden episode of a run that is not scored yet is never fetched.
    unscored = json.loads(json.dumps(case))
    unscored["runs"]["r01"]["status"] = "running"
    monkeypatch.setattr(api.hub, "get_case", lambda bid, client=None: unscored)
    api._hub_cache.clear()
    files.calls.clear()
    assert c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [HIDDEN]}).json()[HIDDEN]["error"] == "no such motion file"
    assert files.calls == []
    assert c.get("/api/batches/..%2F..%2Fetc/motion-summaries", params={"path": [LIVE]}).status_code == 404


def test_a_batch_on_neither_this_machine_nor_the_hub_is_still_no_batch(remote):
    c, _, _ = remote
    res = c.get("/api/batches/1114-000000-none/motion", params={"path": LIVE})
    assert res.status_code == 404 and res.json()["detail"] == "no batch 1114-000000-none"


def test_a_running_hub_batch_asks_again_with_its_etag(remote, monkeypatch):
    c, files, case = remote
    running = {**case, "phase": "running"}
    monkeypatch.setattr(api.hub, "get_case", lambda bid, client=None: running)
    monkeypatch.setattr(api, "HUB_CACHE_SECONDS", 0.0)
    c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [LIVE]})
    c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [LIVE]})
    assert [e for _, rel, e in files.calls if rel == LIVE] == [None, '"v1"']  # the second only asks if it changed
    files.version = 2  # the other machine saved it again
    c.get(f"/api/batches/{REMOTE}/motion-summaries", params={"path": [LIVE]})
    assert (api.BATCHES_DIR / "_hub_files" / REMOTE / (LIVE + ".etag")).read_text() == '"v2"'


def test_the_poses_of_a_hub_batchs_episode(remote):
    pytest.importorskip("mujoco")
    from sim.scene import PANDA_SCENE

    if not PANDA_SCENE.is_file():
        pytest.skip("the panda meshes are not downloaded (python -m sim.fetch_assets)")
    c, _, _ = remote
    res = c.get(f"/api/batches/{REMOTE}/motion", params={"path": LIVE})
    assert res.status_code == 200
    motion = json.loads((SRC / LIVE).read_text())
    assert res.json()["n"] == len(motion["frames"]) == len(res.json()["frames"])


def test_a_comma_in_a_practice_files_name_is_a_motion_path():
    assert api.MOTION_PATH.match("runs/r15/outputs/live/v5_0.3,0.25_0.25,-0.25_s0.motion.json")
