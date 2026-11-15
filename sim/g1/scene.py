"""Build the strike scene: the Unitree G1 (MuJoCo Menagerie) and a bag hanging in front of it.

The menagerie files under `assets/unitree_g1/` are used unchanged; the bag is added here with `mujoco.MjSpec`, so
every episode gets a fresh model with the bag where it should hang.

World frame: z up, the floor is z = 0, the robot stands at the origin facing +x, its left side is +y. Units are
meters and radians.

Layout of qpos (nq = 40):
    0..6    the floating base (pelvis): position xyz (3) then quaternion wxyz (4)
    7..35   the 29 joints, in the order of `sim.g1.control.JOINT_NAMES`: left leg (6), right leg (6), waist (3),
            left arm (7), right arm (7)
    36..39  bag_joint: the quaternion wxyz of the ball joint the bag swings on

Actuators (nu = 29): one position servo per joint, in the same order (ctrl = target angle in radians).

The bag is a ball (radius 0.09 m, 1.5 kg) on a rope 0.8 m long. The rope's top end is fixed in the air straight
above where the bag hangs, so `bag_pos` is the bag's centre at rest and the bag swings like a pendulum when it is
hit. Only the ball collides; the rope is drawn and nothing can touch it.
"""

from __future__ import annotations

from pathlib import Path

import mujoco

ASSETS_DIR: Path = Path(__file__).resolve().parent.parent / "assets"
G1_SCENE: Path = ASSETS_DIR / "unitree_g1" / "scene.xml"

MODEL_ID = "g1-bag-v1"

BAG_BODY = "bag"
BAG_RADIUS = 0.09
BAG_MASS = 1.5
ROPE_LENGTH = 0.8
# A little damping on the swing, so a bag that was hit comes to rest again within some seconds.
BAG_DAMPING = 0.02
BAG_RGBA = (0.85, 0.15, 0.1, 1.0)
ROPE_RGBA = (0.25, 0.25, 0.25, 1.0)

ROBOT_NQ = 36
ROBOT_NV = 35


def build_spec(bag_pos) -> mujoco.MjSpec:
    """An MjSpec of the G1 scene with the bag hanging at rest with its centre at `bag_pos` (x, y, z).

    The bag is a body named "bag" whose origin is the rope's fixed top end, with a ball joint "bag_joint" there, a
    sphere geom "bag" at the rope's lower end and a site "bag_center" in its middle.
    """
    if not G1_SCENE.is_file():
        raise FileNotFoundError(f"{G1_SCENE} is missing: run `python -m sim.g1.fetch_assets` to download the G1 model")
    spec = mujoco.MjSpec.from_file(str(G1_SCENE))
    x, y, z = (float(v) for v in bag_pos[:3])
    bag = spec.worldbody.add_body(name=BAG_BODY, pos=[x, y, z + ROPE_LENGTH])
    bag.add_joint(name="bag_joint", type=mujoco.mjtJoint.mjJNT_BALL, damping=BAG_DAMPING)
    bag.add_geom(name="bag", type=mujoco.mjtGeom.mjGEOM_SPHERE, size=[BAG_RADIUS, 0, 0], pos=[0, 0, -ROPE_LENGTH],
                 mass=BAG_MASS, rgba=list(BAG_RGBA))
    bag.add_geom(name="bag_rope", type=mujoco.mjtGeom.mjGEOM_CAPSULE, size=[0.004, 0, 0],
                 fromto=[0, 0, 0, 0, 0, -ROPE_LENGTH + BAG_RADIUS], mass=0.0, density=0.0, contype=0, conaffinity=0,
                 rgba=list(ROPE_RGBA))
    bag.add_site(name="bag_center", pos=[0, 0, -ROPE_LENGTH], size=[0.005, 0, 0], rgba=[0, 0, 0, 0])
    return spec


def build_model(bag_pos) -> mujoco.MjModel:
    """Compile `build_spec(bag_pos)` into an MjModel (nq 40, nu 29, timestep 0.002 s)."""
    return build_spec(bag_pos).compile()
