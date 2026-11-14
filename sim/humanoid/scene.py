"""Build the push recovery scene: the Unitree G1 humanoid (MuJoCo Menagerie) standing on a floor.

The Menagerie files under `assets/unitree_g1/` are used unchanged (the 29 joint G1 without dexterous hands,
`scene.xml` with `g1.xml`). Nothing is added to the model: the push is a force applied to the torso during the
episode (`sim.humanoid.episode`), not a body.

Layout of qpos (nq = 36):
    0..2    floating_base_joint position of the pelvis, xyz (meters; standing, the pelvis is at about z = 0.79)
    3..6    floating_base_joint orientation of the pelvis, quaternion wxyz
    7..35   the 29 hinge joints, in actuator order (`sim.humanoid.control.JOINTS`), radians

Actuators (nu = 29): one position servo per hinge joint, in the same order as qpos[7:], ctrl = target angle.
They are Menagerie's: kp 500, critically damped, with each joint's torque limit (50 N m at the ankles).

World frame: z up, floor at z = 0. The robot starts at the origin facing +x, its left side toward +y.
"""

from __future__ import annotations

from pathlib import Path

import mujoco

ASSETS_DIR: Path = Path(__file__).resolve().parent.parent / "assets"
G1_SCENE: Path = ASSETS_DIR / "unitree_g1" / "scene.xml"

MODEL_ID = "g1-push-v1"

# The body the push is applied to (at its center of mass), and the bodies whose geoms may touch the floor.
PUSH_BODY = "torso_link"
FOOT_BODIES = ("left_ankle_roll_link", "right_ankle_roll_link")
FLOOR_GEOM = "floor"


def build_spec() -> mujoco.MjSpec:
    """An MjSpec of the G1 scene, unchanged: the robot on a floor plane named "floor", keyframe "stand"."""
    if not G1_SCENE.is_file():
        raise FileNotFoundError(
            f"{G1_SCENE} is missing: run `python -m sim.fetch_assets --model unitree_g1` to download the G1 model"
        )
    return mujoco.MjSpec.from_file(str(G1_SCENE))


def build_model() -> mujoco.MjModel:
    """Compile `build_spec()` into an MjModel (nq 36, nv 35, nu 29, timestep 0.002 s)."""
    return build_spec().compile()
