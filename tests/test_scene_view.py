"""The 3D viewer's data for an episode recorded in a scene with a basket and other objects (robot_view.py)."""

import copy

import pytest

from deep_research import robot_view as rv
from sim import libero_scene as ls
from sim.episode import run_episode
from sim.run import LAYOUT_FPS

TEMPLATE = "sim/controllers/template.py"


def _recording(max_time: float = 0.4) -> dict:
    p = ls.practice_setup()
    return run_episode(TEMPLATE, p["can_xy"], p["place_xy"], layout=p["layout"], max_time=max_time, motion_fps=LAYOUT_FPS)[1]


def test_a_recording_in_the_scene_brings_its_basket_and_objects_to_the_viewer():
    motion = _recording()
    poses = rv.poses(motion)
    base = rv.model()
    # The arm and the can keep the body ids the scene endpoint gives them; the layout's six bodies come after.
    new = list(range(base.nbody, base.nbody + 6))
    assert poses["bodies"][-6:] == new and len(poses["frames"][0]) == 7 * len(poses["bodies"])
    # The object to pick is one of LIBERO's too: the body "can", drawn from its boxes in place of the cylinder.
    can = base.body("can").id
    assert {g["body"] for g in poses["extra"]} == {can, *new} and all(g["type"] == "box" for g in poses["extra"])
    # One box per collision box of LIBERO's files, in the color of its kind.
    layout = motion["header"]["layout"]
    assert layout["target"]["name"] == "alphabet_soup"
    assert len(poses["extra"]) == len(layout["target"]["boxes"]) + len(layout["basket"]["boxes"]) + sum(len(o["boxes"]) for o in layout["objects"])
    assert {tuple(g["rgba"]) for g in poses["extra"] if g["body"] == can} == {(0.85, 0.15, 0.1, 1.0)}
    # The basket stands in place of the place zone's disc, and the soup in place of the cylinder.
    assert poses["hide"] == ["place_zone", "can"] and poses["place_target"] == [0.6, 0.26]
    # The basket's pose in the first frame is where the layout stands it.
    k = poses["bodies"].index(base.nbody) * 7
    assert poses["frames"][0][k:k + 2] == pytest.approx([0.6, 0.26], abs=0.002)

    # A recording of the bare scene is as it always was.
    bare = rv.poses(run_episode(TEMPLATE, [0.5, 0.0], [0.45, -0.3], max_time=0.2)[1])
    assert "extra" not in bare and "hide" not in bare and len(bare["bodies"]) == len(poses["bodies"]) - 6


def test_two_recordings_of_one_set_of_objects_share_a_model_wherever_the_objects_stand():
    a = _recording(0.1)
    moved = copy.deepcopy(a["header"]["layout"])
    moved["objects"][0]["xy"] = [0.3, 0.3]
    assert rv.layout_model(a["header"]["layout"]) is rv.layout_model(moved)


@pytest.mark.parametrize("spoil", [
    lambda L: L["objects"].extend(copy.deepcopy(L["objects"][:1]) * 20),                # too many objects
    lambda L: L["objects"][0].update(boxes=L["objects"][0]["boxes"] * 60),               # too many boxes
    lambda L: L["objects"][0]["boxes"][0].update(size=[1e9, 0.01, 0.01]),               # a box the size of a planet
    lambda L: L["objects"][0]["boxes"][0].update(size=[0.0, 0.01, 0.01]),               # a box with no size
    lambda L: L["objects"][0].update(xy="here"),                                         # not numbers
    lambda L: L["basket"].update(boxes=[]),                                              # nothing to draw
])
def test_a_scene_layout_from_a_file_is_checked_before_anything_is_built(spoil):
    motion = _recording(0.1)
    spoil(motion["header"]["layout"])
    with pytest.raises(rv.MotionError, match="scene layout"):
        rv.poses(motion)
