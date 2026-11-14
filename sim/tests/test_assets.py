"""The panda assets come from sim/fetch_assets.py, not git. No network here."""

import shutil

from sim import fetch_assets
from sim.domain import RobotConfig, build_task, upload_files


def test_local_assets_match_the_pinned_hashes():
    assert fetch_assets.missing_files() == []


def test_missing_and_changed_files_are_found(tmp_path):
    assert sorted(fetch_assets.missing_files(tmp_path)) == sorted(fetch_assets.FILES)
    root = tmp_path / fetch_assets.FOLDER
    shutil.copytree(fetch_assets.DEFAULT_DEST / fetch_assets.FOLDER, root)
    assert fetch_assets.missing_files(tmp_path) == []
    (root / "scene.xml").write_text("<mujoco/>")
    assert fetch_assets.missing_files(tmp_path) == ["scene.xml"]


def test_fetch_downloads_nothing_when_everything_is_present(monkeypatch):
    monkeypatch.setattr(fetch_assets, "_download", lambda *a, **k: (_ for _ in ()).throw(AssertionError("downloaded")))
    assert fetch_assets.fetch(quiet=True) == 0


def test_assets_are_never_uploaded(tmp_path):
    task = build_task(RobotConfig(), tmp_path / "task")
    remote = [r for _, r in upload_files(task)]
    assert remote and not any("/assets/" in r or r.endswith((".obj", ".stl")) for r in remote)
