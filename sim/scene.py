"""Build the pick-and-place scene: the Franka Panda (MuJoCo Menagerie) plus a can and a place zone.

The menagerie files under `assets/franka_emika_panda/` are used unchanged; the can and the place zone
are added here with `mujoco.MjSpec`, so every episode gets a fresh model with the can where it should be.

Layout of qpos (nq = 16):
    0..6   joint1..joint7       arm joints (radians)
    7, 8   finger_joint1, finger_joint2   finger slides (0 closed .. 0.04 open, meters)
    9..15  can_joint            can freejoint: position xyz (3) then quaternion wxyz (4)

Actuators (nu = 8): actuator1..actuator7 are position servos on the arm joints (ctrl = target angle),
actuator8 drives both fingers (ctrl 0 = closed, 255 = open).

A layout (optional)
-------------------
`build_spec(..., layout=...)` adds a container and other objects to the scene, each a free body made of the
collision boxes the layout gives it (LIBERO's own, see sim/libero_scene.py). They come after the can, so the
first 16 qpos are as above and each added body takes 7 more: the container first, then the objects in order.

    layout = {
      "model_id": "panda-libero-object-v1",
      "basket":  {"name": "basket", "xy": [x, y], "yaw": 0.0, "boxes": [...], "quat": [w, x, y, z], "z": 0.0,
                  "density": 100.0, "friction": [0.95, 0.3, 0.1], "contain": {"pos": [...], "size": [...]}},
      "objects": [{"name": "milk", "xy": [x, y], "yaw": 0.0, "boxes": [...], "quat": [...], "z": 0.0, ...}, ...],
    }

`boxes` are `{"pos", "quat" (wxyz), "size" (half extents)}` in the object's own frame; `quat` and `z` stand the
object on the floor (frame to world, and its origin's height). `contain` is the box, in the container's frame,
that an object is "in" the container when its centre is inside. With a container the place zone's disc is not
drawn: the container stands there, and the site "place_target" stays at its centre on the floor.

A layout may also say what the object to pick is: `"target": {"name": "milk", "boxes": [...], "quat": [...],
"z": 0.0, ...}`, an object like the others. The body "can" (and its freejoint "can_joint", in the same qpos slots)
is then made of that object's boxes, standing at `can_xy`, in place of the cylinder. Its geoms are named "can",
"can_1", ...: everything that asks for the body "can" keeps working, whatever is being picked.
"""

from __future__ import annotations

from pathlib import Path

import mujoco
import numpy as np

ASSETS_DIR: Path = Path(__file__).resolve().parent / "assets"
PANDA_SCENE: Path = ASSETS_DIR / "franka_emika_panda" / "scene.xml"

MODEL_ID = "panda-can-v1"

CAN_RADIUS = 0.025
CAN_HALF_HEIGHT = 0.05
CAN_MASS = 0.1
CAN_FRICTION = 1.5
CAN_RGBA = (0.85, 0.15, 0.1, 1.0)

PLACE_ZONE_RADIUS = 0.05
PLACE_ZONE_HALF_THICKNESS = 0.0005
PLACE_ZONE_RGBA = (0.1, 0.75, 0.25, 0.6)

# The model of a scene with a layout: the same arm and can, plus the layout's container and objects.
LAYOUT_MODEL_ID = "panda-libero-object-v1"
BASKET_NAME = "basket"
BASKET_RGBA = (0.62, 0.45, 0.28, 1.0)
# Other objects, in order: muted colors that read apart from the red can and from each other. An object that
# brings its own `rgba` (a kind's color, the same wherever it stands) is drawn in that.
OBJECT_RGBAS = (
    (0.93, 0.93, 0.90, 1.0), (0.95, 0.80, 0.25, 1.0), (0.30, 0.55, 0.85, 1.0),
    (0.75, 0.30, 0.25, 1.0), (0.45, 0.70, 0.40, 1.0), (0.60, 0.45, 0.75, 1.0),
)
CAN_BODY = "can"


def _yaw_quat(yaw: float) -> list[float]:
    """Quaternion (w, x, y, z) for a rotation of `yaw` radians about the world z axis."""
    return [float(np.cos(yaw / 2.0)), 0.0, 0.0, float(np.sin(yaw / 2.0))]


def _quat_mul(a, b) -> list[float]:
    """Hamilton product of two quaternions (w, x, y, z): rotate by `b`, then by `a`."""
    aw, ax, ay, az = (float(v) for v in a)
    bw, bx, by, bz = (float(v) for v in b)
    return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw]


def object_body_name(obj: dict) -> str:
    """The body of a layout's object: "obj_milk"."""
    return f"obj_{obj['name']}"


def _add_boxes(spec: mujoco.MjSpec, name: str, obj: dict, rgba, xy=None, yaw: float | None = None) -> None:
    """A free body named `name` standing at `obj["xy"]` (or `xy`), made of the object's collision boxes. The body
    "can" gets geoms named "can", "can_1", ...; any other body `<name>_0`, `<name>_1`, ..."""
    x, y = (float(v) for v in (obj["xy"] if xy is None else xy)[:2])
    turn = float(obj.get("yaw") or 0.0) if yaw is None else float(yaw)
    quat = _quat_mul(_yaw_quat(turn), obj.get("quat") or [1.0, 0.0, 0.0, 0.0])
    body = spec.worldbody.add_body(name=name, pos=[x, y, float(obj.get("z") or 0.0)], quat=quat)
    body.add_freejoint(name=f"{name}_joint")
    friction = [float(v) for v in (obj.get("friction") or [0.95, 0.3, 0.1])]
    rgba = obj.get("rgba") or rgba
    for i, box in enumerate(obj["boxes"]):
        body.add_geom(
            name=(name if i == 0 else f"{name}_{i}") if name == CAN_BODY else f"{name}_{i}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            size=[float(v) for v in box["size"]],
            pos=[float(v) for v in box["pos"]],
            quat=[float(v) for v in box.get("quat") or [1.0, 0.0, 0.0, 0.0]],
            density=float(obj.get("density") or 100.0),
            friction=friction,
            rgba=list(rgba),
        )
    contain = obj.get("contain")
    if contain:
        body.add_site(name=f"{name}_contain", type=mujoco.mjtGeom.mjGEOM_BOX, pos=[float(v) for v in contain["pos"]],
                      size=[float(v) for v in contain["size"]], rgba=[0, 0, 0, 0])


def retarget(layout: dict, name: str, can_xy) -> tuple[dict, list[float]]:
    """The same scene with another of its objects as the one to pick: (the new layout, where that object stands).

    The object named `name` leaves the layout's `objects` and becomes its `target`; what was the target joins the
    objects, standing at `can_xy`, where it was. Raises KeyError with the names there are when `name` is not one.
    """
    objects = list(layout.get("objects") or [])
    pick = next((o for o in objects if o.get("name") == name), None)
    if pick is None:
        raise KeyError(f"no object named {name!r} in the scene: there are {[o.get('name') for o in objects]}")
    rest = [o for o in objects if o is not pick]
    if layout.get("target"):
        rest.append({**layout["target"], "xy": [float(can_xy[0]), float(can_xy[1])]})
    return {**layout, "target": pick, "objects": rest}, [float(pick["xy"][0]), float(pick["xy"][1])]


def add_layout(spec: mujoco.MjSpec, layout: dict) -> None:
    """Add a layout's container and objects to `spec`, after the can (see the module docstring)."""
    if layout.get("basket"):
        _add_boxes(spec, BASKET_NAME, layout["basket"], BASKET_RGBA)
    for i, obj in enumerate(layout.get("objects") or []):
        _add_boxes(spec, object_body_name(obj), obj, OBJECT_RGBAS[i % len(OBJECT_RGBAS)])


def build_spec(can_xy, place_xy, can_yaw: float = 0.0, layout: dict | None = None) -> mujoco.MjSpec:
    """Return an MjSpec of the panda scene with a can standing at `can_xy` and a place zone at `place_xy`.

    The can is a body named "can" with a freejoint named "can_joint" and one cylinder geom named "can"
    (radius 0.025 m, half height 0.05 m, mass 0.1 kg, friction 1.5), standing upright on the floor.
    The place zone is a static body named "place_zone" holding a thin green disc geom also named
    "place_zone" (radius 0.05 m) that is purely visual: contype=0 and conaffinity=0, so nothing ever
    touches it. A site "place_target" marks its center on the floor.
    """
    if not PANDA_SCENE.is_file():
        raise FileNotFoundError(f"{PANDA_SCENE} is missing: run `python -m sim.fetch_assets` to download the panda model")
    spec = mujoco.MjSpec.from_file(str(PANDA_SCENE))
    cx, cy = float(can_xy[0]), float(can_xy[1])
    px, py = float(place_xy[0]), float(place_xy[1])

    zone = spec.worldbody.add_body(name="place_zone", pos=[px, py, 0.0])
    if not (layout and layout.get("basket")):
        zone.add_geom(
            name="place_zone",
            type=mujoco.mjtGeom.mjGEOM_CYLINDER,
            size=[PLACE_ZONE_RADIUS, PLACE_ZONE_HALF_THICKNESS, 0.0],
            pos=[0.0, 0.0, PLACE_ZONE_HALF_THICKNESS],
            rgba=list(PLACE_ZONE_RGBA),
            contype=0,
            conaffinity=0,
            mass=0.0,
            density=0.0,
        )
    zone.add_site(name="place_target", pos=[0.0, 0.0, 0.0], size=[0.005, 0.0, 0.0], rgba=[0, 0, 0, 0])

    target = (layout or {}).get("target")
    if target:
        # The object to pick is one of the layout's own: the body "can", made of that object's boxes.
        _add_boxes(spec, CAN_BODY, target, CAN_RGBA, xy=[cx, cy], yaw=float(can_yaw) + float(target.get("yaw") or 0.0))
    else:
        can = spec.worldbody.add_body(name=CAN_BODY, pos=[cx, cy, CAN_HALF_HEIGHT], quat=_yaw_quat(float(can_yaw)))
        can.add_freejoint(name="can_joint")
        can.add_geom(
            name="can",
            type=mujoco.mjtGeom.mjGEOM_CYLINDER,
            size=[CAN_RADIUS, CAN_HALF_HEIGHT, 0.0],
            mass=CAN_MASS,
            friction=[CAN_FRICTION, 0.005, 0.0001],
            rgba=list(CAN_RGBA),
        )
    if layout:
        add_layout(spec, layout)
    return spec


def build_model(can_xy, place_xy, can_yaw: float = 0.0, layout: dict | None = None) -> mujoco.MjModel:
    """Compile `build_spec(...)` into an MjModel (nq 16 plus 7 per body of the layout, nu 8, timestep 0.002 s)."""
    return build_spec(can_xy, place_xy, can_yaw, layout).compile()
