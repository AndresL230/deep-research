"""The real LIBERO scene in this sim: the basket and the other objects stand as LIBERO's files say, an episode in it
counts the can as placed when it ends in the basket, and its recording carries the scene (sim/libero_scene.py)."""

import json
from pathlib import Path

import mujoco
import numpy as np

from sim import domain as d
from sim import libero_scene as ls
from sim.episode import _Sim, run_episode
from sim.motion import MAX_BYTES, dumps, validate_motion
from sim.run import LAYOUT_FPS
from sim.scene import LAYOUT_MODEL_ID, build_model

SIM = Path(__file__).resolve().parents[1]
COLLEAGUE = SIM / "controllers" / "colleague.py"
BASELINE = SIM / "controllers" / "baseline.py"
TEMPLATE = SIM / "controllers" / "template.py"


def test_the_practice_scene_is_liberos_task_and_nothing_in_it_moves_by_itself():
    p = ls.practice_setup()
    assert p["can_xy"] == [0.48, -0.24] and p["place_xy"] == [0.6, 0.26]
    layout = p["layout"]
    assert [o["name"] for o in layout["objects"]] == ["salad_dressing", "cream_cheese", "milk", "tomato_sauce", "butter"]
    assert layout["basket"]["xy"] == [0.6, 0.26] and layout["model_id"] == LAYOUT_MODEL_ID
    # What is picked is LIBERO's own alphabet soup, not this sim's cylinder.
    assert layout["target"]["name"] == "alphabet_soup" and 0.07 < layout["target"]["height"] < 0.08

    # The arm, the can, then the basket and the five objects: 16 qpos as ever, then 7 for each.
    m = build_model(p["can_xy"], p["place_xy"], layout=layout)
    assert m.nq == 16 + 7 * 6 and build_model([0.5, 0.0], [0.45, -0.3]).nq == 16
    assert [m.body(i).name for i in range(m.nbody)][-7:] == [
        "can", "basket", "obj_salad_dressing", "obj_cream_cheese", "obj_milk", "obj_tomato_sauce", "obj_butter"]

    sim = _Sim(p["can_xy"], p["place_xy"], 0.0, np.random.default_rng(0), layout)
    start = {name: sim.data.xpos[b].copy() for name, b in sim.object_ids.items()}
    basket = sim.basket_pos()
    for _ in range(1000):  # 2 s with the arm holding still
        mujoco.mj_step(sim.model, sim.data)
    assert max(float(np.linalg.norm(sim.data.xpos[b] - start[name])) for name, b in sim.object_ids.items()) < 0.002
    assert float(np.linalg.norm(sim.basket_pos() - basket)) < 0.002
    # The inside of the basket is over the place target, and the can is not in it yet.
    assert np.allclose(sim.contain_center()[:2], p["place_xy"], atol=0.002) and not sim.in_basket(sim.can_pos())


def test_an_episode_in_the_scene_is_placed_when_the_can_ends_in_the_basket():
    p = ls.practice_setup()
    idle, _ = run_episode(TEMPLATE, p["can_xy"], p["place_xy"], layout=p["layout"], max_time=1.0, record=False)
    assert idle["success"] is False and idle["in_basket"] is False and idle["place_error_cm"] > 40

    result, motion = run_episode(BASELINE, p["can_xy"], p["place_xy"], layout=p["layout"], motion_fps=LAYOUT_FPS)
    assert result["success"] is True and result["in_basket"] is True and result["dropped"] is False, result
    assert result["exception"] is None and d.outcome(result) == "placed"
    # The recording names the scene's model, carries the layout and every body's pose, and fits the size limit.
    assert validate_motion(motion) == [] and len(dumps(motion).encode()) < MAX_BYTES
    header = motion["header"]
    assert header["model_id"] == LAYOUT_MODEL_ID and header["nq"] == 58 and header["layout"] == p["layout"]
    assert len(motion["frames"][0]["qpos"]) == 58

    # The same controller in the bare scene is scored by the bare scene's rule, as ever.
    bare, bare_motion = run_episode(COLLEAGUE, [0.5, 0.0], [0.45, -0.3])
    assert "in_basket" not in bare and bare_motion["header"]["nq"] == 16 and "layout" not in bare_motion["header"]


def test_the_controller_is_told_the_basket_and_the_other_objects(tmp_path):
    seen = tmp_path / "seen.json"
    code = tmp_path / "controller.py"
    code.write_text(
        "import json\n"
        "from sim.control import GRIPPER_OPEN, HOME_QPOS\n"
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        self.task = task\n"
        "    def act(self, obs):\n"
        f"        json.dump({{'task': self.task, 'objects': sorted(obs['objects']), 'basket': list(map(float, obs['basket_pos'])),\n"
        f"                   'nq': len(obs['qpos'])}}, open({str(seen)!r}, 'w'))\n"
        "        return None\n"
    )
    p = ls.practice_setup()
    run_episode(code, p["can_xy"], p["place_xy"], layout=p["layout"], max_time=0.2, record=False)
    got = json.loads(seen.read_text())
    assert got["task"]["basket"]["xy"] == [0.6, 0.26] and 0.13 < got["task"]["basket"]["height"] < 0.15
    assert all(0.11 < side < 0.13 for side in got["task"]["basket"]["opening"])
    assert [o["name"] for o in got["task"]["objects"]] == ["salad_dressing", "cream_cheese", "milk", "tomato_sauce", "butter"]
    assert all(o["height"] > 0 and len(o["footprint"]) == 2 for o in got["task"]["objects"])
    assert got["objects"] == sorted(o["name"] for o in p["layout"]["objects"]) and got["nq"] == 58
    assert got["task"]["target"]["name"] == "alphabet_soup" and 0.07 < got["task"]["target"]["height"] < 0.08
    assert abs(got["basket"][0] - 0.6) < 0.01 and abs(got["basket"][1] - 0.26) < 0.01


def test_the_hidden_episodes_are_libero_pros_perturbations_within_reach():
    episodes = ls.hidden_episodes()
    assert episodes == ls.hidden_episodes() and len(episodes) % ls.DRAWS == 0
    pairs = len(episodes) // ls.DRAWS
    # The list goes round the (task, variant) pairs: its first `pairs` episodes are one of each, at region centres.
    first = episodes[:pairs]
    assert len({(e["task"], e["variant"]) for e in first}) == pairs
    assert {e["variant"] for e in episodes} == {"swap", "pose"}
    assert {e["source"] for e in episodes} == {"LIBERO-PRO position swap", "LIBERO-PRO initial pose shift"}
    for e in episodes:
        assert float(np.hypot(*e["can_xy"])) <= ls.MAX_REACH
        names = [o["name"] for o in e["layout"]["objects"]]
        assert len(names) == 5 and len(set(names)) == 5 and e["task"] not in names
        # Nothing stands where the can does: the object that was there has moved to the can's old region.
        assert all(float(np.hypot(o["xy"][0] - e["can_xy"][0], o["xy"][1] - e["can_xy"][1])) > 0.06 for o in e["layout"]["objects"])
    # Each episode picks its own task's object: ten kinds over the suite.
    assert all(e["layout"]["target"]["name"] == e["task"] for e in episodes)
    assert len({e["task"] for e in episodes}) == len(ls.tasks())
    soup_swap = next(e for e in first if e["task"] == "alphabet_soup" and e["variant"] == "swap")
    assert soup_swap["can_xy"] == [0.4, -0.08]
    assert next(o for o in soup_swap["layout"]["objects"] if o["name"] == "butter")["xy"] == [0.48, -0.24]
    # A later draw moves the basket and the boxes a little, as LIBERO does, and never the cans or the bottle.
    later = episodes[pairs:]
    assert any(e["layout"]["basket"]["xy"] != [0.6, 0.26] for e in later)
    assert all(abs(e["layout"]["basket"]["xy"][0] - 0.6) <= 0.015 + 1e-9 for e in later)
    for e in later:
        centre = {o["kind"]: o["xy"] for o in ls.tasks()[e["task"]]["variants"][e["variant"]]["others"]}
        for o in e["layout"]["objects"]:
            assert max(abs(o["xy"][0] - centre[o["name"]][0]), abs(o["xy"][1] - centre[o["name"]][1])) <= ls._spread(o["name"]) + 1e-4
    for gone in ls.left_out():
        assert float(np.hypot(*gone["target"])) > ls.MAX_REACH


def test_every_kind_of_object_stands_as_the_thing_to_pick_and_an_object_aware_controller_baskets_the_tall_ones(tmp_path):
    """The body "can" is made of each task's own object. A controller that reads `task["target"]` for the grasp
    height puts the cans, the cartons and the bottles in the basket."""
    code = tmp_path / "controller.py"
    code.write_text(
        "import numpy as np\n"
        "from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik\n"
        "class Controller:\n"
        "    def reset(self, task):\n"
        "        (cx, cy), (px, py) = task['can_start'], task['place_target']\n"
        "        h, rim = task['target']['height'], task['basket']['height']\n"
        "        g = max(0.012, min(h - 0.025, h * 0.6)); carry = rim + h + 0.10; rel = rim + (h - g) + 0.03\n"
        "        P = lambda x, y, z: np.array([x, y, z]); O, C = GRIPPER_OPEN, GRIPPER_CLOSED\n"
        "        self.ph = [(0.9, P(cx, cy, g + 0.15), O), (0.7, P(cx, cy, g), O), (0.5, P(cx, cy, g), C), (1.0, P(cx, cy, carry), C),\n"
        "                   (1.8, P(px, py, carry), C), (0.6, P(px, py, rel), C), (0.3, P(px, py, rel), C), (0.3, P(px, py, rel), O)]\n"
        "        self.start = hand_position(HOME_QPOS); self.q = np.array(HOME_QPOS, dtype=float); self.done = False\n"
        "    def act(self, obs):\n"
        "        t, prev, t0 = obs['time'], self.start, 0.0\n"
        "        target, grip = self.ph[-1][1], self.ph[-1][2]\n"
        "        for dur, end, g in self.ph:\n"
        "            if t < t0 + dur:\n"
        "                s = (t - t0) / dur; s = s * s * (3 - 2 * s); target, grip = prev + (end - prev) * s, g; break\n"
        "            prev, t0 = end, t0 + dur\n"
        "        else:\n"
        "            self.done = True\n"
        "        self.q = np.asarray(ik(target, q_init=self.q, down_weight=0.5), dtype=float)\n"
        "        return list(self.q) + [grip]\n"
    )
    for kind, t in ls.tasks().items():
        layout = ls.layout("original", None, kind)
        m = build_model(t["variants"]["original"]["target"], t["basket"], layout=layout)
        assert m.nq == 58 and layout["target"]["name"] == kind
        # Standing: the object's lowest point is on the floor, and its origin at half its height or so.
        assert abs(layout["target"]["z"] - layout["target"]["height"] / 2) < 0.02
    for kind in ("alphabet_soup", "milk", "ketchup"):
        t = ls.tasks()[kind]
        result, _ = run_episode(code, t["variants"]["original"]["target"], t["basket"], layout=ls.layout("original", None, kind), record=False)
        assert result["success"] is True and result["in_basket"] is True, (kind, result)


def test_another_object_of_the_scene_can_be_made_the_one_to_pick():
    from sim.scene import retarget

    p = ls.practice_setup()
    layout, stands = retarget(p["layout"], "milk", p["can_xy"])
    assert layout["target"]["name"] == "milk" and stands == [0.7, -0.2]
    # The soup is now one of the others, where it stood; the scene has the same six bodies besides the picked one.
    names = {o["name"]: o["xy"] for o in layout["objects"]}
    assert names["alphabet_soup"] == p["can_xy"] and "milk" not in names and len(names) == 5
    assert build_model(stands, p["place_xy"], layout=layout).nq == 58
    assert p["layout"]["target"]["name"] == "alphabet_soup"  # the layout it was made from is untouched
    try:
        retarget(p["layout"], "pineapple", p["can_xy"])
    except KeyError as e:
        assert "salad_dressing" in str(e)
    else:
        raise AssertionError("an object the scene does not have was accepted")
