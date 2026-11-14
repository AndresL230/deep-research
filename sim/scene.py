"""Build the pick-and-place scene: the Franka Panda (MuJoCo Menagerie) plus a can and a place zone.

The menagerie files under `assets/franka_emika_panda/` are used unchanged; the can and the place zone
are added here with `mujoco.MjSpec`, so every episode gets a fresh model with the can where it should be.

Layout of qpos (nq = 16):
    0..6   joint1..joint7       arm joints (radians)
    7, 8   finger_joint1, finger_joint2   finger slides (0 closed .. 0.04 open, meters)
    9..15  can_joint            can freejoint: position xyz (3) then quaternion wxyz (4)

Actuators (nu = 8): actuator1..actuator7 are position servos on the arm joints (ctrl = target angle),
actuator8 drives both fingers (ctrl 0 = closed, 255 = open).
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


def _yaw_quat(yaw: float) -> list[float]:
    """Quaternion (w, x, y, z) for a rotation of `yaw` radians about the world z axis."""
    return [float(np.cos(yaw / 2.0)), 0.0, 0.0, float(np.sin(yaw / 2.0))]


def build_spec(can_xy, place_xy, can_yaw: float = 0.0) -> mujoco.MjSpec:
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

    can = spec.worldbody.add_body(name="can", pos=[cx, cy, CAN_HALF_HEIGHT], quat=_yaw_quat(float(can_yaw)))
    can.add_freejoint(name="can_joint")
    can.add_geom(
        name="can",
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        size=[CAN_RADIUS, CAN_HALF_HEIGHT, 0.0],
        mass=CAN_MASS,
        friction=[CAN_FRICTION, 0.005, 0.0001],
        rgba=list(CAN_RGBA),
    )
    return spec


def build_model(can_xy, place_xy, can_yaw: float = 0.0) -> mujoco.MjModel:
    """Compile `build_spec(...)` into an MjModel (nq 16, nu 8, timestep 0.002 s)."""
    return build_spec(can_xy, place_xy, can_yaw).compile()
