"""Write sim/libero_scene.json: the real collision boxes and layouts of the LIBERO-Object tasks and their LIBERO-PRO
variants.

The tasks are LIBERO-Object's ten "pick the <grocery item> and place it in the basket". The file holds the
collision boxes LIBERO gives the suite's eleven objects (ten grocery items and the basket), the orientation
LIBERO stands each in, and where each task and LIBERO-PRO's two position perturbations of it (position swap,
initial pose shift) stand every object. `tasks` is keyed by the kind of the object to pick; `task` is the
alphabet soup's, the first of the suite.

Nothing of LIBERO or LIBERO-PRO runs here. The downloaded files are read as text only (xml.etree and regular
expressions): none is imported, executed or unpickled. Run it isolated, from the repo root:

    python3 -I scripts/make_libero_scene.py --list-sources          # what to download, and to which file name
    python3 -I scripts/make_libero_scene.py --assets DIR --bddl DIR  # write sim/libero_scene.json

`--assets DIR` holds the LIBERO text files under the names `--list-sources` prints. `--bddl DIR` holds
`orig/<task>.bddl`, `swap/<task>.bddl` and `pose/<task>.bddl` for each of the ten tasks.

How an object's standing orientation is found
---------------------------------------------
LIBERO has no yaw to draw for these objects: every class fixes `rotation` to one angle (min == max).

  1. `libero/envs/objects/hope_objects.py` and `google_scanned_objects.py` give each class a `rotation` and a
     `rotation_axis` (read here with regular expressions).
  2. A floor task places a movable object with `TableRegionSampler` (`libero/envs/regions/__init__.py`,
     `REGION_SAMPLERS["libero_floor_manipulation"]`), whose `_sample_quat` returns `[sin(a/2), 0, 0, cos(a/2)]`
     for axis "x", `[0, 0, sin(a/2), cos(a/2)]` for axis "z", and for a dict of axes the product of those with
     robosuite's `quat_multiply`: all in robosuite's (x, y, z, w) order.
  3. `BDDLBaseDomain._reset_internal` (`libero/envs/bddl_base_domain.py`) writes that array, unconverted, into
     the free joint's qpos, where MuJoCo reads it as (w, x, y, z). No class sets `init_quat`.

So the orientation LIBERO really gets is the sampler's four numbers read as (w, x, y, z). An "x" rotation of
pi/2 is in fact a quarter turn about the vertical (the basket stays upright), and a "z" rotation of pi/2 is a
half turn about (0, 1, 1), which stands the y axis of a can up. `standing_quat` below does exactly this, and
`check_code` fails if the lines it relies on are no longer in the downloaded code.

Where LIBERO really draws an object inside its region
-----------------------------------------------------
`TableRegionSampler` keeps `ensure_object_boundary_in_range=True`, so `MultiRegionRandomSampler._sample_x` and
`_sample_y` (`libero/envs/regions/base_region_sampler.py`) draw the object's centre between `min + r` and
`max - r`, with `r` the x of the object's `horizontal_radius_site`. In a 5 cm region that is the region's centre
give or take |0.025 - r|: exactly the centre for r = 0.025. When r is more than half the side the two bounds
cross, and numpy's `uniform` then still draws between them (numpy calls that case undefined, but it computes
low + (high - low) * u). `placement` holds that half-width for every kind (the basket's for its own 2 cm region).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BASKET = "basket"
# The order of `objects` in the file: the alphabet soup task's seven first, as the file first had them.
HOPE_KINDS = ["alphabet_soup", "salad_dressing", "cream_cheese", "milk", "tomato_sauce", "butter",
              "bbq_sauce", "chocolate_pudding", "ketchup", "orange_juice"]
KINDS = HOPE_KINDS[:6] + [BASKET] + HOPE_KINDS[6:]
# One task per grocery item, keyed in `tasks` by the kind of the object to pick.
TARGETS = sorted(HOPE_KINDS)
FIRST = "alphabet_soup"  # the task the top-level `task` key repeats
VARIANTS = (("original", "orig"), ("swap", "swap"), ("pose", "pose"))


def task_name(target: str) -> str:
    return f"pick_up_the_{target}_and_place_it_in_the_basket"
# The day the text files were downloaded. Pass --read-on when they are downloaded again.
READ_ON = "2026-11-14"

LIBERO_RAW = "https://raw.githubusercontent.com/Lifelong-Robot-Learning/LIBERO/master/"
ROBOSUITE_RAW = "https://raw.githubusercontent.com/ARISE-Initiative/robosuite/v1.4.0/"
LIBERO_PRO_RAW = "https://huggingface.co/datasets/zhouxueyang/LIBERO-Pro/resolve/main/"

# Local file name under --assets -> where it comes from.
ASSET_SOURCES = {
    **{f"{k}.xml": f"{LIBERO_RAW}libero/libero/assets/stable_hope_objects/{k}/{k}.xml" for k in HOPE_KINDS},
    "basket.xml": f"{LIBERO_RAW}libero/libero/assets/stable_scanned_objects/basket/basket.xml",
    "objects_hope_objects.py.txt": f"{LIBERO_RAW}libero/libero/envs/objects/hope_objects.py",
    "objects_google_scanned_objects.py.txt": f"{LIBERO_RAW}libero/libero/envs/objects/google_scanned_objects.py",
    "regions___init__.py.txt": f"{LIBERO_RAW}libero/libero/envs/regions/__init__.py",
    "regions_workspace_region_sampler.py.txt": f"{LIBERO_RAW}libero/libero/envs/regions/workspace_region_sampler.py",
    "regions_base_region_sampler.py.txt": f"{LIBERO_RAW}libero/libero/envs/regions/base_region_sampler.py",
    "bddl_base_domain.py.txt": f"{LIBERO_RAW}libero/libero/envs/bddl_base_domain.py",
    "problems_libero_floor_manipulation.py.txt": f"{LIBERO_RAW}libero/libero/envs/problems/libero_floor_manipulation.py",
    "robots_on_the_ground_panda.py.txt": f"{LIBERO_RAW}libero/libero/envs/robots/on_the_ground_panda.py",
    "robosuite_objects.py.txt": f"{ROBOSUITE_RAW}robosuite/models/objects/objects.py",
}
# Local file name under --bddl -> where it comes from.
BDDL_FOLDERS = {
    "orig": f"{LIBERO_RAW}libero/libero/bddl_files/libero_object/",
    "swap": f"{LIBERO_PRO_RAW}bddl_files/libero_object_swap/",
    "pose": f"{LIBERO_PRO_RAW}bddl_files/07_initial_pose_position_angle/bddl/libero_object/",
}
BDDL_SOURCES = {
    f"{folder}/{task_name(target)}.bddl": f"{url}{task_name(target)}.bddl"
    for target in TARGETS for folder, url in BDDL_FOLDERS.items()
}
VARIANT_SOURCE = {"orig": "LIBERO", "swap": "LIBERO-PRO position swap", "pose": "LIBERO-PRO initial pose shift"}


# ---------------------------------------------------------------------------------------------- quaternions
# Every quaternion here is (w, x, y, z), MuJoCo's order, unless a name says xyzw.

def normalized(q: list[float]) -> list[float]:
    n = math.sqrt(sum(v * v for v in q))
    if n < 1e-9:
        raise ValueError(f"zero quaternion {q}")
    return [v / n for v in q]


def rotate(q: list[float], v: list[float]) -> list[float]:
    """`v` turned by the unit quaternion `q`."""
    w, x, y, z = q
    rows = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]
    return [sum(r[i] * v[i] for i in range(3)) for r in rows]


def quat_multiply_xyzw(q1: list[float], q0: list[float]) -> list[float]:
    """robosuite's `transform_utils.quat_multiply` (q1 * q0), both and the result in (x, y, z, w)."""
    x0, y0, z0, w0 = q0
    x1, y1, z1, w1 = q1
    return [
        x1 * w0 + y1 * z0 - z1 * y0 + w1 * x0,
        -x1 * z0 + y1 * w0 + z1 * x0 + w1 * y0,
        x1 * y0 - y1 * x0 + z1 * w0 + w1 * z0,
        -x1 * x0 - y1 * y0 - z1 * z0 + w1 * w0,
    ]


# ------------------------------------------------------------------------------------- LIBERO's object code

def read(path: Path) -> str:
    if not path.is_file():
        sys.exit(f"missing {path}: see --list-sources")
    return path.read_text(encoding="utf-8")


def _number(expr: str) -> float:
    """One angle as LIBERO writes it: `0`, `0.0`, `np.pi`, `np.pi / 2`. Nothing is evaluated."""
    m = re.fullmatch(r"\s*(np\.pi|\d+(?:\.\d*)?)\s*(?:/\s*(\d+(?:\.\d*)?))?\s*", expr)
    if not m:
        raise ValueError(f"cannot read the angle {expr!r}")
    value = math.pi if m.group(1) == "np.pi" else float(m.group(1))
    return value / float(m.group(2)) if m.group(2) else value


def _fixed_angle(tuple_body: str) -> float:
    values = [_number(part) for part in tuple_body.split(",") if part.strip()]
    if not values or max(values) != min(values):
        raise ValueError(f"the rotation ({tuple_body}) is a range, not one angle: LIBERO would draw it")
    return values[0]


def _rotation_fields(body: str) -> dict:
    """The `self.rotation` and `self.rotation_axis` a class body sets, if it does."""
    out: dict = {}
    m = re.search(r"self\.rotation\s*=\s*(\{.*?\}|\([^)]*\))", body, re.S)
    if m:
        text = m.group(1)
        if text.startswith("{"):
            out["rotation"] = [(axis, _fixed_angle(angles)) for axis, angles in
                               re.findall(r'"([xyz])"\s*:\s*\(([^)]*)\)', text)]
        else:
            out["rotation"] = _fixed_angle(text[1:-1])
    m = re.search(r'self\.rotation_axis\s*=\s*(?:"([xyz])"|None)', body)
    if m:
        out["rotation_axis"] = m.group(1)
    return out


def class_rotations(code: str, base: str) -> dict[str, dict]:
    """kind -> {"rotation", "rotation_axis"} for every class of `code` that derives from `base`.

    The kind is the name LIBERO registers the class under (`register_object` in libero/envs/base_object.py).
    """
    code = "\n".join(line for line in code.splitlines() if not line.lstrip().startswith("#"))
    blocks = re.split(r"^class\s+", code, flags=re.M)[1:]
    bodies = {}
    for block in blocks:
        head = re.match(r"(\w+)\((\w+)\):", block)
        if head:
            bodies[head.group(1)] = (head.group(2), block)
    if base not in bodies:
        raise ValueError(f"no class {base}")
    defaults = _rotation_fields(bodies[base][1])
    if set(defaults) != {"rotation", "rotation_axis"}:
        raise ValueError(f"{base} does not set a rotation and a rotation_axis")
    out = {}
    for name, (parent, body) in bodies.items():
        if parent != base:
            continue
        kind = "_".join(re.sub(r"([A-Z0-9])", r" \1", name).split()).lower()
        out[kind] = {**defaults, **_rotation_fields(body)}
    return out


def standing_quat(rotation, rotation_axis) -> list[float]:
    """The quaternion (w, x, y, z) MuJoCo gets for a class's `rotation` and `rotation_axis`.

    `TableRegionSampler._sample_quat` builds an (x, y, z, w) array and `BDDLBaseDomain._reset_internal` writes it
    to the free joint as it is, so its four numbers are returned here as MuJoCo's (w, x, y, z).
    """
    def about(axis: str, angle: float) -> list[float]:
        s, c = math.sin(angle / 2), math.cos(angle / 2)
        return {"x": [s, 0.0, 0.0, c], "y": [0.0, s, 0.0, c], "z": [0.0, 0.0, s, c]}[axis]

    if isinstance(rotation, list):  # a dict of axes in the class: rotation_axis is not read
        q = [0.0, 0.0, 0.0, 1.0]
        for axis, angle in rotation:
            q = quat_multiply_xyzw(about(axis, angle), q)
    else:
        if rotation_axis is None:
            raise ValueError("a single rotation needs a rotation_axis")
        q = about(rotation_axis, rotation)
    return normalized(q)


def check_code(files: dict[str, str]) -> None:
    """Fail if the downloaded code no longer has the lines `standing_quat` and `placement` copy."""
    sampler = re.search(r"^class TableRegionSampler\(MultiRegionRandomSampler\):.*?(?=^class |\Z)",
                        files["regions_workspace_region_sampler.py.txt"], re.S | re.M)
    if not sampler:
        sys.exit("regions_workspace_region_sampler.py.txt no longer has TableRegionSampler")
    files = {**files, "TableRegionSampler": sampler.group(0)}
    need = {
        "regions___init__.py.txt": ['"libero_floor_manipulation": {"floor": TableRegionSampler}'],
        "TableRegionSampler": [
            "return np.array([np.sin(rot_angle / 2), 0, 0, np.cos(rot_angle / 2)])",
            "return np.array([0, 0, np.sin(rot_angle / 2), np.cos(rot_angle / 2)])",
            "quat = quat_multiply(current_quat, quat)",
            "z_offset=0.01,",
            "ensure_object_boundary_in_range=True,",
        ],
        "bddl_base_domain.py.txt": [
            "np.concatenate([np.array(obj_pos), np.array(obj_quat)])",
            "rotation=self.objects_dict[object_name].rotation,",
            "rotation_axis=self.objects_dict[object_name].rotation_axis,",
            "reference_pos=self.workspace_offset,",
        ],
        "regions_base_region_sampler.py.txt": [
            "object_z -= bottom_offset[-1]",
            "minimum += object_horizontal_radius",
            "maximum -= object_horizontal_radius",
            "object_x = self._sample_x(horizontal_radius) + base_offset[0]",
            "object_y = self._sample_y(horizontal_radius) + base_offset[1]",
        ],
        "problems_libero_floor_manipulation.py.txt": ["self.floor_offset = (0, 0, -0.035)"],
        "robots_on_the_ground_panda.py.txt": ['"empty": (-0.6, 0, 0),'],
        "robosuite_objects.py.txt": [
            'return string_to_array(bottom_site.get("pos"))',
            'return string_to_array(horizontal_radius_site.get("pos"))[0]',
        ],
    }
    for name, lines in need.items():
        for line in lines:
            if line not in files[name]:
                sys.exit(f"{name} no longer has `{line}`: read the code again before trusting the orientations")
    for name in ("objects_hope_objects.py.txt", "objects_google_scanned_objects.py.txt", "robosuite_objects.py.txt"):
        if "init_quat" in files[name]:
            sys.exit(f"{name} now sets init_quat, which the sampler multiplies in: not handled here")


# ---------------------------------------------------------------------------------------------- object XML

def _floats(text: str, n: int) -> list[float]:
    values = [float(v) + 0.0 for v in text.split()]  # + 0.0 turns the XML's "-0.00000" into 0.0
    if len(values) != n:
        raise ValueError(f"expected {n} numbers, got {text!r}")
    return values


def read_object_xml(text: str) -> dict:
    """The collision boxes, contact numbers and sites of one LIBERO object XML.

    xml.etree drops comments, which matters: cream_cheese.xml keeps an older, larger box in a comment and
    bbq_sauce.xml an older mesh line.
    """
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise ValueError("the XML declares a DOCTYPE or an entity: not read")
    root = ET.fromstring(text)
    body = root.find("./worldbody/body/body[@name='object']")
    if body is None:
        raise ValueError("no <body name='object'>")
    boxes, densities, frictions, meshes = [], set(), set(), 0
    for geom in body.iter("geom"):
        if geom.get("type") == "mesh":
            if geom.get("contype") != "0" or geom.get("conaffinity") != "0":
                raise ValueError("a mesh geom collides: not handled here")
            meshes += 1
            continue
        if geom.get("type") != "box":
            raise ValueError(f"a {geom.get('type')} collision geom: not handled here")
        boxes.append({
            "pos": _floats(geom.get("pos", "0 0 0"), 3),
            # MuJoCo normalizes a quaternion when it compiles a model; butter, cream cheese and bbq sauce need
            # it (butter's is written as 0.0053 0 0.0053 0, cream cheese's as 0.00707 0 0.00707 0).
            "quat": [round(v, 10) for v in normalized(_floats(geom.get("quat", "1 0 0 0"), 4))],
            "size": _floats(geom.get("size"), 3),
        })
        densities.add(float(geom.get("density")))
        frictions.add(tuple(_floats(geom.get("friction"), 3)))
    if not boxes or meshes != 1 or len(densities) != 1 or len(frictions) != 1:
        raise ValueError("expected one visual mesh and boxes that share one density and one friction")
    out = {"boxes": boxes, "density": densities.pop(), "friction": list(frictions.pop()), "sites": {}}
    for site in root.iter("site"):
        name = site.get("name")
        if name in ("bottom_site", "top_site", "horizontal_radius_site"):
            out["sites"][name] = _floats(site.get("pos"), 3)
        elif name == "contain_region":
            if site.get("type") != "box":
                raise ValueError("contain_region is not a box")
            # Its quaternion is a half turn about z, which leaves a box centred on the z axis as it is.
            turn = normalized(_floats(site.get("quat", "1 0 0 0"), 4))
            if abs(abs(turn[0]) - 1) > 1e-6 and abs(abs(turn[3]) - 1) > 1e-6:
                raise ValueError("contain_region is turned by more than a half turn about z: not handled here")
            out["contain"] = {"pos": _floats(site.get("pos"), 3), "size": _floats(site.get("size"), 3)}
    return out


def corners(boxes: list[dict], quat: list[float]) -> list[list[float]]:
    """Every corner of every box, in the frame the object frame is turned into by `quat`."""
    out = []
    for box in boxes:
        hx, hy, hz = box["size"]
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    local = rotate(box["quat"], [sx * hx, sy * hy, sz * hz])
                    out.append(rotate(quat, [local[i] + box["pos"][i] for i in range(3)]))
    return out


def standing(boxes: list[dict], quat: list[float]) -> dict:
    """How the boxes stand on a floor at z = 0 once turned by `quat`: origin height, height and footprint."""
    pts = corners(boxes, quat)
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return {
        "z": round(-lo[2], 6),
        "height": round(hi[2] - lo[2], 6),
        "footprint": [round(hi[0] - lo[0], 6), round(hi[1] - lo[1], 6)],
    }


# --------------------------------------------------------------------------------------------------- BDDL

def _block(text: str, head: str) -> str:
    """The parenthesized block of `text` that starts with `head`, e.g. "(:init"."""
    start = text.find(head)
    if start < 0:
        raise ValueError(f"no {head} block")
    depth = 0
    for i in range(start, len(text)):
        depth += {"(": 1, ")": -1}.get(text[i], 0)
        if depth == 0:
            return text[start:i + 1]
    raise ValueError(f"{head} is not closed")


def read_bddl(text: str) -> dict:
    regions = {}
    for name, numbers in re.findall(
        r"\((\w+)\s*\(:target floor\)\s*\(:ranges \(\s*\(([^()]*)\)\s*\)\s*\)\s*\)", _block(text, "(:regions")
    ):
        x0, y0, x1, y1 = _floats(numbers, 4)
        regions[name] = {"centre": [(x0 + x1) / 2, (y0 + y1) / 2], "side": [x1 - x0, y1 - y0]}
    objects = re.findall(r"(\w+)\s+-\s+(\w+)", _block(text, "(:objects"))
    on = dict(re.findall(r"\(On (\w+) floor_(\w+)\)", _block(text, "(:init")))
    out = {
        "language": re.search(r"\(:language ([^()]*)\)", text).group(1).strip(),
        "regions": regions,
        "objects": objects,  # [(instance, kind)], in the file's order
        "on": on,            # instance -> region
    }
    if "(:initial_pose" in text:
        block = _block(text, "(:initial_pose")
        if "(:enabled true)" in block:
            out["initial_pose"] = {
                "target": re.search(r"\(:target (\w+)\)", block).group(1),
                "delta_xy": _floats(re.search(r"\(:delta_xy ([^()]*)\)", block).group(1), 2),
                "yaw": float(re.search(r"\(:yaw ([^()]*)\)", block).group(1)),
            }
    return out


def ours(xy: list[float], base_x: float) -> list[float]:
    """A LIBERO floor point in this sim's frame: LIBERO's Panda base is at x = -base_x, ours at the origin."""
    return [round(xy[0] + base_x, 6), round(xy[1], 6)]


def variant(bddl: dict, target_kind: str, base_x: float) -> dict:
    """One BDDL file as a variant: where its (On ...) lines stand the object to pick, the others and the basket."""
    kinds = dict(bddl["objects"])
    centre = {inst: ours(bddl["regions"][region]["centre"], base_x) for inst, region in bddl["on"].items()}
    target = [inst for inst, kind in bddl["objects"] if kind == target_kind]
    basket = [inst for inst, kind in bddl["objects"] if kind == BASKET]
    if len(target) != 1 or len(basket) != 1 or set(kinds) != set(centre):
        raise ValueError(f"expected one {target_kind}, one basket and a region for every object")
    if len(set(bddl["on"].values())) != len(bddl["on"]):
        raise ValueError("two objects stand in one region")
    out = {"target": centre[target[0]]}
    pose = bddl.get("initial_pose")
    if pose:
        if pose["target"] != target[0]:
            raise ValueError("the initial pose shift is not applied to the object to pick")
        out["target"] = [round(out["target"][0] + pose["delta_xy"][0], 6),
                         round(out["target"][1] + pose["delta_xy"][1], 6)]
        out["target_yaw"] = pose["yaw"]
    out["reach"] = round(math.hypot(*out["target"]), 3)  # from this sim's robot base, the origin
    out["others"] = [{"kind": kind, "xy": centre[inst]} for inst, kind in bddl["objects"]
                     if inst not in (target[0], basket[0])]
    out["_basket"] = centre[basket[0]]
    return out


def read_task(bddl_dir: Path, target: str, base_x: float) -> tuple[dict, dict]:
    """The task that picks `target`, from its three BDDL files, and the sides of its regions.

    Every (On ...) line of every file is read; what the three files must share is checked, not assumed.
    """
    name = task_name(target)
    bddl = {v: read_bddl(read(bddl_dir / v / f"{name}.bddl")) for _, v in VARIANTS}
    orig = bddl["orig"]
    for v in ("swap", "pose"):
        if any(bddl[v][key] != orig[key] for key in ("regions", "objects", "language")):
            raise ValueError(f"{name}: the {v} file changes the regions, the objects or the language")
    kinds = [kind for _, kind in orig["objects"]]
    others = [k for k in kinds if k not in (target, BASKET)]
    if len(kinds) != 7 or len(set(kinds)) != 7 or len(others) != 5 or not set(others) <= set(HOPE_KINDS):
        raise ValueError(f"{name}: unexpected objects {orig['objects']}")
    if "initial_pose" in orig or "initial_pose" in bddl["swap"] or "initial_pose" not in bddl["pose"]:
        raise ValueError(f"{name}: only the pose file should shift the initial pose")
    if bddl["pose"]["on"] != orig["on"]:
        raise ValueError(f"{name}: the pose file also moves objects between regions")
    moved = {inst for inst in orig["on"] if bddl["swap"]["on"][inst] != orig["on"][inst]}
    target_inst = next(inst for inst, kind in orig["objects"] if kind == target)
    if len(moved) != 2 or target_inst not in moved or (
            {bddl["swap"]["on"][i] for i in moved} != {orig["on"][i] for i in moved}):
        raise ValueError(f"{name}: the swap file is not the target changing places with one other object")
    object_sides = {round(s, 9) for region, r in orig["regions"].items() if region != "bin_region" for s in r["side"]}
    bin_sides = {round(s, 9) for s in orig["regions"]["bin_region"]["side"]}
    if len(object_sides) != 1 or len(bin_sides) != 1:
        raise ValueError(f"{name}: the regions are not squares of one size: {object_sides}, {bin_sides}")
    variants = {key: variant(bddl[v], target, base_x) for key, v in VARIANTS}
    baskets = {tuple(v.pop("_basket")) for v in variants.values()}
    if len(baskets) != 1:
        raise ValueError(f"{name}: the basket moves between the variants")
    task = {
        "name": name,
        "language": orig["language"],
        "target": target,
        "region_side": object_sides.pop(),
        "basket": list(baskets.pop()),
        "variants": {key: {"source": VARIANT_SOURCE[v], **variants[key]} for key, v in VARIANTS},
    }
    return task, {"region_side": task["region_side"], "bin_side": bin_sides.pop()}


# --------------------------------------------------------------------------------------------------- main

def build(assets: Path, bddl_dir: Path, read_on: str) -> tuple[dict, list[str]]:
    files = {name: read(assets / name) for name in ASSET_SOURCES}
    check_code(files)
    base_x = 0.6      # check_code: OnTheGroundPanda.base_xpos_offset["empty"] is (-0.6, 0, 0)
    spawn_base = 0.01 + -0.035  # check_code: TableRegionSampler's z_offset plus the floor task's floor_offset z

    rotations = {
        **class_rotations(files["objects_hope_objects.py.txt"], "HopeBaseObject"),
        **class_rotations(files["objects_google_scanned_objects.py.txt"], "GoogleScannedObject"),
    }
    objects, sites, report = {}, {}, []
    report.append(f"{'kind':18} boxes  height  footprint x, y     z      bottom_site  LIBERO spawn z  rotation in the code")
    for kind in KINDS:
        xml = read_object_xml(files[f"{kind}.xml"])
        rot = rotations[kind]
        quat = standing_quat(rot["rotation"], rot["rotation_axis"])
        stand = standing(xml["boxes"], quat)
        entry = {
            "boxes": xml["boxes"], "density": xml["density"], "friction": xml["friction"],
            "quat": [round(v, 10) + 0.0 for v in quat], **stand,
        }
        if "contain" in xml:
            entry["contain"] = xml["contain"]
        objects[kind] = entry
        # LIBERO's own placement height: the sampler puts the object frame at z_offset + floor_offset z minus
        # the z of bottom_site, whatever the orientation. The floor plane is at z = 0.
        spawn_z = round(spawn_base - xml["sites"]["bottom_site"][2], 6) if "bottom_site" in xml["sites"] else None
        sites[kind] = {**xml["sites"], "spawn_z": spawn_z}
        bottom = xml["sites"].get("bottom_site", [None] * 3)[2]
        report.append(
            f"{kind:18} {len(xml['boxes']):5d}  {stand['height']:.4f}  {stand['footprint'][0]:.4f}, "
            f"{stand['footprint'][1]:.4f}  {stand['z']:.4f}  {bottom!s:>11}  {spawn_z!s:>14}  "
            f"{rot['rotation']} about {rot['rotation_axis']}"
        )

    tasks, sides = {}, {}
    for target in TARGETS:
        tasks[target], sides[target] = read_task(bddl_dir, target, base_x)
    if len({(t["region_side"], tuple(t["basket"])) for t in tasks.values()}) != 1 or (
            len({s["bin_side"] for s in sides.values()}) != 1):
        raise ValueError("the tasks do not share one region size and one basket region")
    region_side, bin_side = sides[FIRST]["region_side"], sides[FIRST]["bin_side"]
    # Where LIBERO really draws a centre: between min + r and max - r of the region (see the module docstring).
    placement = {
        kind: round(abs((bin_side if kind == BASKET else region_side) / 2 - sites[kind]["horizontal_radius_site"][0]), 6)
        for kind in KINDS
    }

    report.append("")
    report.append(f"{'task (target)':18} original           swap               pose               others, in the file's order")
    for target, task in tasks.items():
        cells = "  ".join(f"{str(v['target']):14} {v['reach']:.3f}" for v in task["variants"].values())
        report.append(f"{target:18} {cells}  " + ", ".join(o["kind"] for o in task["variants"]["original"]["others"]))
    report.append("placement half-widths: " + ", ".join(f"{k} {v}" for k, v in placement.items()))

    source = (
        f"Made by scripts/make_libero_scene.py from text files read on {read_on}; nothing of LIBERO runs to make "
        "it and no file was executed or unpickled. objects.*.boxes, density, friction and contain: the "
        "type=\"box\" collision geoms and the contain_region site of LIBERO's object XML files "
        "(libero/libero/assets/stable_hope_objects/<kind>/<kind>.xml and "
        "libero/libero/assets/stable_scanned_objects/basket/basket.xml, github.com/Lifelong-Robot-Learning/LIBERO, "
        "MIT licence), in metres in the object's own frame, numbers as written there except that every box "
        "quaternion is normalized as MuJoCo does when it compiles a model (butter's, cream cheese's and bbq "
        "sauce's are not unit in the XML); the mesh scale of an XML applies to its visual mesh only. "
        "objects.*.quat: the orientation LIBERO gives the object's free joint, from each class's rotation and "
        "rotation_axis (libero/libero/envs/objects/hope_objects.py, google_scanned_objects.py) passed through "
        "TableRegionSampler._sample_quat (libero/libero/envs/regions/workspace_region_sampler.py) and written "
        "unconverted to qpos by BDDLBaseDomain._reset_internal (libero/libero/envs/bddl_base_domain.py); LIBERO "
        "draws no yaw for these objects. objects.*.z, height and footprint: computed here from the corners of "
        "the boxes turned by quat, with the lowest corner on the floor; they are not LIBERO numbers. "
        "libero_sites: the bottom_site, top_site and horizontal_radius_site positions of each XML and the height "
        "LIBERO's sampler drops the object frame at (0.01 - 0.035 - bottom_site z, floor plane at z = 0); those "
        "sites are rough placeholders, not the objects' real extents. tasks: the ten LIBERO-Object tasks, keyed "
        "by the kind of the object to pick, each from its three BDDL files: "
        "libero/libero/bddl_files/libero_object/<name>.bddl in LIBERO (variant original) and, in LIBERO-PRO "
        "(Zhou et al., arXiv:2510.03827; code MIT, data CC BY 4.0; Hugging Face dataset zhouxueyang/LIBERO-Pro), "
        "bddl_files/libero_object_swap/<name>.bddl (variant swap) and "
        "bddl_files/07_initial_pose_position_angle/bddl/libero_object/<name>.bddl (variant pose: the target's "
        "region centre plus its delta_xy, and its yaw); task repeats tasks.alphabet_soup. Every xy is a region "
        "centre in this sim's frame, which is LIBERO's floor frame moved by +0.6 m in x because LIBERO stands "
        "its Panda base at (-0.6, 0, 0) (OnTheGroundPanda.base_xpos_offset[\"empty\"]) and this sim has it at "
        "the origin; reach is the distance from that origin to the variant's target, computed here. placement: "
        "for each kind, the half-width in metres of the square LIBERO really draws the object's centre in, "
        "around its region's centre: TableRegionSampler keeps ensure_object_boundary_in_range=True, so "
        "MultiRegionRandomSampler._sample_x and _sample_y (libero/libero/envs/regions/base_region_sampler.py) "
        "draw between min + r and max - r with r the x of the XML's horizontal_radius_site, which is "
        "|side / 2 - r| either side of the centre, computed here for the 5 cm object regions and, for the "
        "basket, its 2 cm bin_region; where r exceeds side / 2 the bounds cross and numpy's uniform still draws "
        "between them."
    )
    data = {
        "source": source,
        "objects": objects,
        "task": tasks[FIRST],
        "tasks": tasks,
        "placement": placement,
        "libero_sites": sites,
    }
    report += basket_report(objects[BASKET])
    return data, report


def basket_report(basket: dict) -> list[str]:
    """The basket's plate, walls and opening, in its own frame (z up), for a person to read.

    Each wall is taken as the box around its slightly leaning box, so the opening is the narrowest it gets.
    """
    identity = [1.0, 0.0, 0.0, 0.0]
    spans = []
    for box in basket["boxes"]:
        pts = corners([box], identity)
        spans.append([(min(p[i] for p in pts), max(p[i] for p in pts)) for i in range(3)])
    plate = min(spans, key=lambda s: s[2][1])
    walls = [s for s in spans if s is not plate]
    inner = []
    for axis in (0, 1):
        low = max(s[axis][1] for s in walls if s[axis][1] < 0)
        high = min(s[axis][0] for s in walls if s[axis][0] > 0)
        inner.append((low, high))
    c = basket["contain"]
    lines = [
        "basket, in its own frame:",
        f"  floor plate: x {plate[0][0]:.4f}..{plate[0][1]:.4f}, y {plate[1][0]:.4f}..{plate[1][1]:.4f}, "
        f"z {plate[2][0]:.4f}..{plate[2][1]:.4f}",
        f"  walls: {len(walls)}, tops at z " + ", ".join(f"{s[2][1]:.4f}" for s in walls)
        + f"; above the plate's top by " + ", ".join(f"{s[2][1] - plate[2][1]:.4f}" for s in walls),
        f"  inner opening at its narrowest (the walls lean outwards, so at their feet): "
        f"x {inner[0][0]:.4f}..{inner[0][1]:.4f} ({inner[0][1] - inner[0][0]:.4f}), "
        f"y {inner[1][0]:.4f}..{inner[1][1]:.4f} ({inner[1][1] - inner[1][0]:.4f})",
        "  contain: " + ", ".join(
            f"{'xyz'[i]} {c['pos'][i] - c['size'][i]:.4f}..{c['pos'][i] + c['size'][i]:.4f}" for i in range(3)),
    ]
    return lines


def dump(data: dict) -> str:
    """JSON with one list of numbers per line."""
    text = json.dumps(data, indent=2)
    number = r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"
    return re.sub(
        rf"\[\s*({number}(?:,\s*{number})*)\s*\]",
        lambda m: "[" + ", ".join(part.strip() for part in m.group(1).split(",")) + "]",
        text,
    ) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--assets", type=Path, help="folder with the LIBERO text files (see --list-sources)")
    parser.add_argument("--bddl", type=Path, help="folder with orig/, swap/ and pose/, each holding the task's .bddl")
    parser.add_argument("--out", type=Path, default=REPO / "sim" / "libero_scene.json")
    parser.add_argument("--read-on", default=READ_ON, help="the day the text files were downloaded")
    parser.add_argument("--list-sources", action="store_true", help="print each file to download and its URL")
    args = parser.parse_args()
    if args.list_sources:
        for folder, sources in (("--assets", ASSET_SOURCES), ("--bddl", BDDL_SOURCES)):
            for name, url in sources.items():
                print(f"{folder}/{name}\t{url}")
        return
    if not args.assets or not args.bddl:
        parser.error("--assets and --bddl are needed")
    data, report = build(args.assets, args.bddl, args.read_on)
    args.out.write_text(dump(data), encoding="utf-8")
    print("\n".join(report))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
