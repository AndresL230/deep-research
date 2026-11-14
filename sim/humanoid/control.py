"""Helpers for writing a G1 balance controller.

Import these inside your controller file:

    from sim.humanoid.control import JOINTS, JOINT_INDEX, STAND_CTRL, JOINT_LOWER, JOINT_UPPER, CONTROL_DT

Conventions
-----------
* World frame: z up, the floor is z = 0, units are meters, radians, newtons and seconds. The robot starts at the
  origin facing +x, its left side toward +y.
* A control action is 29 numbers, one target angle (radians) per joint in the order of `JOINTS`. Every joint has a
  position servo (stiffness 500 N m/rad, critically damped) that pulls it toward its target, up to the joint's torque
  limit (88 to 139 N m at the hips and knees, 50 N m at the ankles, 25 N m or less in the arms). Targets outside the
  joint limits are clipped.
* `STAND_CTRL` is the standing pose the episode starts in: legs straight, arms bent a little. Holding it is a
  controller that does nothing.
* Each foot touches the floor at four points, at its corners: from 0.05 m behind the ankle to 0.12 m in front of
  it, and 0.025 to 0.03 m to either side of the ankle (`FOOT_CORNERS`, in the foot's frame, which is the world frame
  while the robot stands straight). The ankles are 0.237 m apart.

Everything here reads a private copy of the model, so importing it never touches an episode's simulation.
"""

from __future__ import annotations

import mujoco
import numpy as np

from sim.humanoid.scene import G1_SCENE

CONTROL_HZ = 50
CONTROL_DT = 1.0 / CONTROL_HZ

# The four floor contact points of each foot, relative to the ankle (the foot site), meters: x forward, y left, z up.
FOOT_CORNERS = np.array([[-0.05, 0.025, -0.03], [-0.05, -0.025, -0.03], [0.12, 0.03, -0.03], [0.12, -0.03, -0.03]])

_MODEL: mujoco.MjModel | None = None


def _model() -> mujoco.MjModel:
    global _MODEL
    if _MODEL is None:
        _MODEL = mujoco.MjModel.from_xml_path(str(G1_SCENE))
    return _MODEL


JOINTS: tuple[str, ...] = tuple(_model().actuator(i).name for i in range(_model().nu))
"""The 29 joint names in action order (also the order of qpos[7:] and qvel[6:]): left leg (hip pitch, hip roll, hip yaw,
knee, ankle pitch, ankle roll), right leg (the same), waist (yaw, roll, pitch), left arm (shoulder pitch, roll, yaw,
elbow, wrist roll, pitch, yaw), right arm (the same)."""

JOINT_INDEX: dict[str, int] = {name: i for i, name in enumerate(JOINTS)}
"""Joint name -> its index in an action, e.g. JOINT_INDEX["left_ankle_pitch_joint"] == 4."""

JOINT_LOWER: np.ndarray = _model().actuator_ctrlrange[:, 0].copy()
JOINT_UPPER: np.ndarray = _model().actuator_ctrlrange[:, 1].copy()
"""Joint limits (radians), arrays of 29 in `JOINTS` order."""

STAND_CTRL: np.ndarray = _model().key("stand").ctrl.copy()
"""The standing pose (29 target angles) the episode starts in."""

MASS: float = float(_model().body_subtreemass[_model().body("pelvis").id])
"""The robot's total mass, kg (about 33.3)."""


def index(name: str) -> int:
    """The action index of joint `name`; "left_knee" and "left_knee_joint" both work."""
    return JOINT_INDEX[name if name.endswith("_joint") else f"{name}_joint"]


def tilt_deg(quat) -> float:
    """Angle in degrees between the z axis of a body with orientation `quat` (w, x, y, z) and straight up."""
    w, x, y, z = (float(v) for v in quat)
    n = w * w + x * x + y * y + z * z
    if n <= 0:
        return 180.0
    return float(np.degrees(np.arccos(np.clip(1.0 - 2.0 * (x * x + y * y) / n, -1.0, 1.0))))
