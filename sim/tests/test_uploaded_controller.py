"""A robot task built from an uploaded controller puts that controller in the agents' workspace."""

from sim import domain as d

TEXT = "class Controller:\n    def reset(self, task): pass\n    def act(self, obs): return None\n"


def test_build_task_writes_the_uploaded_controller(tmp_path):
    cfg = d.RobotConfig(robot_start="uploaded", controller_text=TEXT, controller_name="mine.py", n_hidden=2)
    files = d.build_task(cfg, tmp_path / "task")
    assert files.controller.read_text() == TEXT
    assert files.given_files() == {"controller.py": TEXT}
    meta = d.read_meta(files)
    assert meta["robot_start"] == "uploaded" and meta["controller_name"] == "mine.py"
    prompt = d.task_prompt(cfg)
    assert "was handed to you" in prompt and "Start from it" in prompt


def test_build_task_refuses_an_upload_without_text(tmp_path):
    import pytest

    with pytest.raises(ValueError, match="no controller"):
        d.build_task(d.RobotConfig(robot_start="uploaded", n_hidden=2), tmp_path / "task")
