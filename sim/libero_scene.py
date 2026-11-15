"""One real LIBERO task in this sim: "pick the alphabet soup and place it in the basket", measured where LIBERO-PRO
moves it. Server side only: this module and its data never go to an agent's sandbox.

What is real here
-----------------
`sim/libero_scene.json` (made by scripts/make_libero_scene.py from LIBERO's and LIBERO-PRO's own text files, which
it names) holds:
  * the collision boxes LIBERO gives its basket and the five other grocery objects of the task, the orientation it
    stands each in, and the box that makes an object count as "in" the basket;
  * where the task stands every object: the region of the object to pick, the basket's, and the five others';
  * the same for LIBERO-PRO's two position perturbations of the task: the position swap (the object to pick
    changes places with another object) and the initial pose shift (it is moved by a fixed offset).

What is this sim's own: the arm model and its controller interface, and the colors: the objects are drawn as
their collision boxes in one plain color each, not as LIBERO's textured meshes.

What is picked is the task's own object (`layout["target"]`: the alphabet soup, the milk, the ketchup, ...), made
of LIBERO's boxes for it, not this sim's cylinder. In the code and the recordings it is still the body "can".

A layout
--------
`layout(variant, rng, task)` is what `sim.scene.build_spec(..., layout=...)` takes: the basket and the objects with
their boxes and where each stands. LIBERO keeps an object's whole footprint inside its 5 cm region, so its centre
is drawn in a much smaller square (`placement` in the data: nothing for the cans and the bottle, half a centimeter
for the cartons and boxes, 1.5 cm for the basket in its own region). `rng` draws the same way; without one each
stands at its region's centre.

The batch
---------
The agents get the first task as LIBERO has it (`practice_setup`): the alphabet soup task, original layout. Their
controller is measured on `hidden_episodes()`: for every task of the suite the data has, LIBERO-PRO's two position
perturbations of it, each with its own draw of every object's place and its own object to pick. A perturbed
position this sim's arm cannot reach (`MAX_REACH`) is left out.
"""

from __future__ import annotations

import copy
import functools
import json
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / "libero_scene.json"
MODEL_ID = "panda-libero-object-v1"
SEED = 20261114
HIDDEN_VARIANTS = ("swap", "pose")
# How each kind is drawn (its collision boxes carry no texture): a color that suggests the product.
KIND_RGBA = {
    "alphabet_soup": [0.85, 0.15, 0.10, 1.0], "tomato_sauce": [0.70, 0.22, 0.12, 1.0], "milk": [0.92, 0.94, 0.97, 1.0],
    "orange_juice": [0.96, 0.60, 0.15, 1.0], "ketchup": [0.75, 0.08, 0.10, 1.0], "bbq_sauce": [0.36, 0.20, 0.12, 1.0],
    "salad_dressing": [0.90, 0.86, 0.62, 1.0], "butter": [0.96, 0.84, 0.36, 1.0], "cream_cheese": [0.30, 0.52, 0.82, 1.0],
    "chocolate_pudding": [0.42, 0.28, 0.20, 1.0],
}
PRACTICE_TASK = "alphabet_soup"
# This sim's arm reaches a can pointing down out to about here (sim/hidden.py R_MAX, sim/CALIBRATION.md).
MAX_REACH = 0.78
# How many times each (task, variant) is run, each with its own draw of the objects' places.
DRAWS = 2


@functools.lru_cache(maxsize=1)
def data() -> dict:
    return json.loads(DATA.read_text())


def _standing(kind: str, name: str, xy, yaw: float = 0.0) -> dict:
    """An object of the data file as a layout entry: its boxes and how it stands, at `xy`."""
    # A copy: a layout is handed around and written to files, and the data is read once and kept.
    o = copy.deepcopy(data()["objects"][kind])
    entry = {
        "name": name, "kind": kind, "xy": [round(float(xy[0]), 4), round(float(xy[1]), 4)], "yaw": float(yaw),
        "boxes": o["boxes"], "quat": o["quat"], "z": o["z"], "density": o.get("density", 100.0),
        "friction": o.get("friction", [0.95, 0.3, 0.1]), "height": o["height"], "footprint": o["footprint"],
    }
    if o.get("contain"):
        entry["contain"] = o["contain"]
    if kind in KIND_RGBA:
        entry["rgba"] = list(KIND_RGBA[kind])
    return entry


def tasks() -> dict:
    """The suite's tasks by the kind of their object to pick. A data file with the one task has just that one."""
    d = data()
    return d.get("tasks") or {d["task"]["target"]: d["task"]}


def _spread(kind: str) -> float:
    """Half the side of the square LIBERO draws `kind`'s centre in (`placement` in the data)."""
    placement = data().get("placement") or {}
    if kind in placement:
        return float(placement[kind])
    # A data file without it: LIBERO shrinks the region by the object's radius on both sides.
    side = 0.02 if kind == "basket" else float(data()["task"].get("region_side", 0.05))
    radius = ((data().get("libero_sites") or {}).get(kind) or {}).get("horizontal_radius_site") or [side / 2]
    return abs(side / 2 - float(radius[0]))


def _draw(center, kind: str, rng: np.random.Generator | None) -> list[float]:
    spread = _spread(kind) if rng is not None else 0.0
    if spread <= 0:
        return [float(center[0]), float(center[1])]
    dx, dy = rng.uniform(-spread, spread, size=2)
    return [float(center[0]) + float(dx), float(center[1]) + float(dy)]


def layout(name: str = "original", rng: np.random.Generator | None = None, task: str = PRACTICE_TASK) -> dict:
    """The scene of `task`'s variant `name` ("original", "swap", "pose"): the basket and the five other objects,
    each drawn by `rng` as LIBERO draws it (at its region's centre without one). The object to pick is the can,
    which the episode stands where it is told, so it is not in the layout."""
    t = tasks()[task]
    v = t["variants"][name]
    return {
        "model_id": MODEL_ID,
        "task": t["name"],
        "variant": name,
        # What is picked: the task's own object, standing where the episode puts it (its `can_xy`).
        "target": _standing(t["target"], t["target"], v["target"], float(v.get("target_yaw") or 0.0)),
        "basket": _standing("basket", "basket", _draw(t["basket"], "basket", rng)),
        "objects": [_standing(o["kind"], o["kind"], _draw(o["xy"], o["kind"], rng)) for o in v["others"]],
    }


def practice_setup() -> dict:
    """The first task as LIBERO has it: the can where the alphabet soup stands, the basket as the place target,
    and every other object at the centre of its region."""
    t = tasks()[PRACTICE_TASK]
    return {
        "can_xy": [float(v) for v in t["variants"]["original"]["target"]],
        "place_xy": [float(v) for v in t["basket"]],
        "layout": layout("original"),
    }


def hidden_episodes(draws: int = DRAWS, seed: int = SEED) -> list[dict]:
    """The episodes a LIBERO-PRO batch is measured on: for every task and each of LIBERO-PRO's two position
    perturbations of it, `draws` episodes. Each is {"can_xy", "task", "variant", "source", "layout"}.

    The first draw of a (task, variant) has everything at its region's centre; the others draw the basket and every
    object as LIBERO does for each of a task's initial states. The can stands at the centre of the perturbed
    region: LIBERO leaves a can of its width no room to move in a region. The list goes round the (task, variant)
    pairs draw by draw, so its first n cover them evenly. A target beyond `MAX_REACH` from the base is left out.
    """
    rng = np.random.default_rng(seed)
    pairs = []
    for kind, t in tasks().items():
        for name in HIDDEN_VARIANTS:
            v = t["variants"].get(name)
            if not v:
                continue
            x, y = float(v["target"][0]), float(v["target"][1])
            if float(np.hypot(x, y)) > MAX_REACH:
                continue
            pairs.append((kind, name, v))
    out = []
    for i in range(draws):
        for kind, name, v in pairs:
            out.append({
                "can_xy": [round(float(v["target"][0]), 4), round(float(v["target"][1]), 4)],
                "task": kind,
                "variant": name,
                "source": v.get("source", name),
                "layout": layout(name, None if i == 0 else rng, kind),
            })
    return out


def left_out() -> list[dict]:
    """The perturbed positions that are not measured because this sim's arm cannot reach them."""
    out = []
    for kind, t in tasks().items():
        for name in HIDDEN_VARIANTS:
            v = t["variants"].get(name)
            if v and float(np.hypot(*[float(c) for c in v["target"]])) > MAX_REACH:
                out.append({"task": kind, "variant": name, "target": v["target"], "source": v.get("source", name)})
    return out
