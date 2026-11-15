"""sim/libero_scene.json: the shape of the file and the numbers read straight off LIBERO's and LIBERO-PRO's task
files. Plain data checks, no mujoco. scripts/make_libero_scene.py writes the file."""

import json
import math
from pathlib import Path

import pytest

DATA = Path(__file__).resolve().parents[1] / "libero_scene.json"
BASKET = "basket"
# One LIBERO-Object task per grocery item: "pick the <item> and place it in the basket".
TARGETS = {"alphabet_soup", "bbq_sauce", "butter", "chocolate_pudding", "cream_cheese", "ketchup", "milk",
           "orange_juice", "salad_dressing", "tomato_sauce"}
KINDS = TARGETS | {BASKET}
# The two places LIBERO-Object stands the object to pick, in this sim's frame.
ORIGINAL_TARGETS = ([0.48, -0.24], [0.65, -0.1])
# The initial pose shift LIBERO-PRO applies to the object to pick.
POSE_SHIFT = (0.17, -0.06)


@pytest.fixture(scope="module")
def scene() -> dict:
    return json.loads(DATA.read_text())


def numbers(value, n: int) -> bool:
    return (isinstance(value, list) and len(value) == n
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value))


def unit(quat) -> bool:
    return numbers(quat, 4) and abs(math.sqrt(sum(v * v for v in quat)) - 1.0) < 1e-6


def standing_xy(variant: dict, kind: str) -> list:
    return next(o["xy"] for o in variant["others"] if o["kind"] == kind)


def same(a, b) -> bool:
    return a == pytest.approx(b)


def test_the_eleven_kinds(scene):
    assert set(scene["objects"]) == KINDS
    assert isinstance(scene["source"], str) and "LIBERO" in scene["source"]


def test_every_box_is_three_four_three_numbers_with_a_unit_quaternion(scene):
    for kind, obj in scene["objects"].items():
        assert obj["boxes"], kind
        for box in obj["boxes"]:
            assert set(box) == {"pos", "quat", "size"}, kind
            assert numbers(box["pos"], 3) and numbers(box["size"], 3), kind
            assert unit(box["quat"]), (kind, box["quat"])
            assert all(0 < h < 0.15 for h in box["size"]), (kind, box["size"])


def test_how_each_object_stands(scene):
    for kind, obj in scene["objects"].items():
        assert unit(obj["quat"]), kind
        assert isinstance(obj["z"], float) and abs(obj["z"]) < 0.3, kind
        assert 0 < obj["height"] < 0.3, kind
        assert numbers(obj["footprint"], 2) and all(0 < v < 0.3 for v in obj["footprint"]), kind
        assert obj["density"] > 0 and numbers(obj["friction"], 3), kind


def test_only_the_basket_contains(scene):
    assert [kind for kind, obj in scene["objects"].items() if "contain" in obj] == [BASKET]
    contain = scene["objects"][BASKET]["contain"]
    assert numbers(contain["pos"], 3) and numbers(contain["size"], 3)
    assert all(h > 0 for h in contain["size"])


def test_the_sites_and_the_placement_cover_every_kind(scene):
    assert set(scene["libero_sites"]) == KINDS
    assert set(scene["placement"]) == KINDS
    for kind, half in scene["placement"].items():
        assert isinstance(half, float) and 0 <= half <= 0.025, kind
        # The half-width LIBERO draws a centre in: its region's half side less the object's horizontal radius.
        side = 0.02 if kind == BASKET else 0.05
        radius = scene["libero_sites"][kind]["horizontal_radius_site"][0]
        assert half == pytest.approx(abs(side / 2 - radius)), kind
    assert scene["placement"]["alphabet_soup"] == 0.0
    assert scene["placement"]["milk"] == pytest.approx(0.005)
    assert scene["placement"]["butter"] == pytest.approx(0.005)
    assert scene["placement"][BASKET] == pytest.approx(0.015)


def test_the_ten_tasks(scene):
    tasks = scene["tasks"]
    assert set(tasks) == TARGETS
    assert scene["task"] == tasks["alphabet_soup"]
    for target, task in tasks.items():
        assert task["name"] == f"pick_up_the_{target}_and_place_it_in_the_basket"
        assert task["language"] == f"Pick the {target.replace('_', ' ')} and place it in the basket"
        assert task["target"] == target
        assert task["region_side"] == pytest.approx(0.05)
        assert task["basket"] == pytest.approx([0.6, 0.26])


def test_every_variant_of_every_task(scene):
    for target, task in scene["tasks"].items():
        variants = task["variants"]
        assert set(variants) == {"original", "swap", "pose"}, target
        for name, variant in variants.items():
            where = (target, name)
            assert isinstance(variant["source"], str) and variant["source"], where
            assert numbers(variant["target"], 2), where
            assert variant["reach"] == pytest.approx(math.hypot(*variant["target"]), abs=5.1e-4), where
            assert variant["reach"] == round(variant["reach"], 3), where
            kinds = [o["kind"] for o in variant["others"]]
            assert len(kinds) == 5 and len(set(kinds)) == 5, where
            assert all(kind in scene["objects"] for kind in kinds), where
            assert target not in kinds and BASKET not in kinds, where
            assert all(numbers(o["xy"], 2) for o in variant["others"]), where
            # No two objects stand in one place.
            places = [tuple(o["xy"]) for o in variant["others"]] + [tuple(task["basket"])]
            assert len(set(places)) == 6, where
        assert [o["kind"] for o in variants["swap"]["others"]] == [o["kind"] for o in variants["original"]["others"]]
        assert variants["original"]["source"] == "LIBERO"
        assert variants["swap"]["source"].startswith("LIBERO-PRO")
        assert variants["pose"]["source"].startswith("LIBERO-PRO")
        assert "target_yaw" not in variants["original"] and "target_yaw" not in variants["swap"]


def test_every_original_target_is_one_of_the_two_places(scene):
    for target, task in scene["tasks"].items():
        original = task["variants"]["original"]["target"]
        assert any(same(original, place) for place in ORIGINAL_TARGETS), target
    # Both places are used: the suite has two layouts.
    used = {tuple(task["variants"]["original"]["target"]) for task in scene["tasks"].values()}
    assert len(used) == 2


def test_every_swap_trades_two_places_and_nothing_else(scene):
    for target, task in scene["tasks"].items():
        original, swap = task["variants"]["original"], task["variants"]["swap"]
        assert not same(swap["target"], original["target"]), target
        # The target now stands where one of the others stood, and that one stands where the target stood.
        traded = [o["kind"] for o in original["others"] if same(o["xy"], swap["target"])]
        assert len(traded) == 1, target
        assert same(standing_xy(swap, traded[0]), original["target"]), target
        for o in original["others"]:
            if o["kind"] != traded[0]:
                assert same(standing_xy(swap, o["kind"]), o["xy"]), (target, o["kind"])


def test_every_pose_shift_moves_only_the_target(scene):
    for target, task in scene["tasks"].items():
        original, pose = task["variants"]["original"], task["variants"]["pose"]
        assert pose["others"] == original["others"], target
        shifted = [original["target"][0] + POSE_SHIFT[0], original["target"][1] + POSE_SHIFT[1]]
        assert same(pose["target"], shifted), target
        assert pose["target_yaw"] == pytest.approx(math.pi / 4), target


def test_the_alphabet_soup_task(scene):
    task = scene["task"]
    assert task["name"] == "pick_up_the_alphabet_soup_and_place_it_in_the_basket"
    assert task["language"] == "Pick the alphabet soup and place it in the basket"
    variants = task["variants"]
    assert same(variants["original"]["target"], [0.48, -0.24])
    assert same(variants["swap"]["target"], [0.4, -0.08])
    assert same(variants["pose"]["target"], [0.65, -0.3])
    assert {o["kind"] for o in variants["original"]["others"]} == {
        "salad_dressing", "cream_cheese", "milk", "tomato_sauce", "butter"}
    # The object that stood where the swap puts the soup now stands where the soup stood.
    moved = [o["kind"] for o in variants["original"]["others"] if same(o["xy"], [0.4, -0.08])]
    assert moved == ["butter"]
    assert same(standing_xy(variants["swap"], "butter"), [0.48, -0.24])
