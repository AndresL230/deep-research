"""robot_start: the agent starts from the template ("blank") or from a colleague's working controller ("colleague")."""

from __future__ import annotations

import ast
import json
import re

import pytest

from sim import domain
from sim.domain import COLLEAGUE_CONTROLLER, RobotConfig, build_task, task_prompt, upload_files
from sim.tests.test_domain import REVEALING, _assert_upload_clean

W = domain.VM_WORKSPACE
COLLEAGUE_LINE = (
    "A colleague already wrote a controller for this task: `controller.py`. "
    "Start from it: read it, run it, and change it where you need to."
)
BLANK_LINE = f"`{W}/controller.py` starts as a copy of the template. Write your controller there."
# Words that would tell the agent where the colleague's controller is weak, or that the can is put elsewhere.
WEAKNESS = re.compile(
    r"tuned|one.spot|only|slip|weak|fling|drop|fall|far\b|long|distance|edge|elsewhere|\bpositions?\b|\bmov",
    re.IGNORECASE,
)


def test_blank_is_the_default_and_keeps_the_template(tmp_path):
    assert RobotConfig().robot_start == "blank"
    task = build_task(RobotConfig(), tmp_path / "task")
    assert task.controller.read_text() == (domain.SIM_DIR / "controllers" / "template.py").read_text()
    assert json.loads(task.meta.read_text())["robot_start"] == "blank"
    for hint in ("none", "light"):
        p = task_prompt(RobotConfig(hint_level=hint))
        assert p == task_prompt(RobotConfig(hint_level=hint, robot_start="blank"))
        assert BLANK_LINE in p and "colleague" not in p


def test_colleague_start_uploads_the_colleague_controller(tmp_path):
    hidden = pytest.importorskip("sim.hidden")
    task = build_task(RobotConfig(robot_start="colleague"), tmp_path / "task")
    text = task.controller.read_text()
    assert text == COLLEAGUE_CONTROLLER.read_text()
    assert task.given_files() == {"controller.py": text}
    assert json.loads(task.meta.read_text())["robot_start"] == "colleague"
    remote = {r for _, r in upload_files(task)}
    assert f"{W}/controller.py" in remote and f"{W}/sim/controllers/template.py" in remote
    # Only controller.py holds it: the calibration controllers stay on the server.
    assert not any(n in r for r in remote for n in ("colleague.py", "baseline.py", "one_spot.py", "spread.py"))
    _assert_upload_clean(task, hidden.hidden_positions(), skip_meshes=True)


def test_the_colleague_controller_is_self_contained_and_says_nothing_of_its_weakness():
    text = COLLEAGUE_CONTROLLER.read_text()
    tree = ast.parse(text)
    imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    imported |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert imported == {"numpy", "sim.control"}
    assert not REVEALING.search(text), REVEALING.search(text).group()
    assert not WEAKNESS.search(text), WEAKNESS.search(text).group()
    assert "PARAMS = {" in text.split("class Controller")[0]
    assert chr(0x2014) not in text


@pytest.mark.parametrize("robot_prompt", ["default", "practice"])
@pytest.mark.parametrize("hint", ["none", "light"])
def test_the_colleague_prompt_changes_one_line(hint, robot_prompt):
    blank = task_prompt(RobotConfig(hint_level=hint, robot_prompt=robot_prompt))
    p = task_prompt(RobotConfig(hint_level=hint, robot_prompt=robot_prompt, robot_start="colleague"))
    assert not REVEALING.search(p), REVEALING.search(p).group()
    assert not re.search(r"\bmov(?:e|es|ed|ing)\b", p, re.IGNORECASE)
    assert chr(0x2014) not in p
    changed = [(a, b) for a, b in zip(blank.splitlines(), p.splitlines()) if a != b]
    assert changed == [(BLANK_LINE, COLLEAGUE_LINE)]
    assert len(blank.splitlines()) == len(p.splitlines())


def test_the_uploaded_colleague_controller_succeeds_on_the_practice_spot(tmp_path):
    from sim.episode import run_episode

    task = build_task(RobotConfig(robot_start="colleague"), tmp_path / "task")
    practice = json.loads(task.practice.read_text())
    result, _ = run_episode(str(task.controller), practice["can_xy"], practice["place_xy"], seed=0, record=False)
    assert result["success"], result
