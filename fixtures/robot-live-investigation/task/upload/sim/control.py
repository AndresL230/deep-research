"""Helpers for writing a Panda pick-and-place controller.

Import these inside your controller file:

    from sim.control import ik, hand_position, GRIPPER_OPEN, GRIPPER_CLOSED, HOME_QPOS

Conventions
-----------
* World frame: z up, the robot base is at the origin, the floor is z = 0. Units are meters and radians.
* The "grasp point" is the point 0.105 m below the hand body along the hand's z axis, i.e. between the
  fingertip pads. `ik` and `hand_position` both work with this point, and `obs["hand_pos"]` in an
  episode is the same point.
* A control action is 8 numbers: 7 arm joint position targets (radians, the arm actuators are position
  servos, so the arm moves toward these angles) followed by the gripper command (0 = fully closed,
  255 = fully open). Targets outside the joint limits are clipped by MuJoCo.
* At the HOME pose the gripper points straight down and its fingers open and close along the world x axis.

Everything here uses a private copy of the robot model (no can), so calling these functions never
touches the simulation of an episode. All functions are deterministic.
"""

from __future__ import annotations

import mujoco
import numpy as np

from sim.scene import PANDA_SCENE

CONTROL_HZ = 50
CONTROL_DT = 1.0 / CONTROL_HZ

ARM_JOINTS = ("joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "joint7")
GRIPPER_OPEN = 255.0
GRIPPER_CLOSED = 0.0

# Offset of the grasp point from the hand body origin, in the hand frame (hand z points out of the palm).
GRASP_OFFSET = np.array([0.0, 0.0, 0.105])

_MODEL: mujoco.MjModel | None = None
_DATA: mujoco.MjData | None = None


def _robot() -> tuple[mujoco.MjModel, mujoco.MjData]:
    """Lazily load the private robot-only model used for kinematics."""
    global _MODEL, _DATA
    if _MODEL is None:
        _MODEL = mujoco.MjModel.from_xml_path(str(PANDA_SCENE))
        _DATA = mujoco.MjData(_MODEL)
    return _MODEL, _DATA


def _arm_limits() -> tuple[np.ndarray, np.ndarray]:
    model, _ = _robot()
    ids = [model.joint(n).id for n in ARM_JOINTS]
    rng = model.jnt_range[ids]
    return rng[:, 0].copy(), rng[:, 1].copy()


JOINT_LOWER, JOINT_UPPER = _arm_limits()
"""Arm joint limits (radians), arrays of 7, read from the model."""

HOME_QPOS = _robot()[0].key("home").qpos[:7].copy()
"""Arm part of the panda "home" keyframe: gripper above the base pointing down, about 0.52 m high."""


def _set_arm(q: np.ndarray) -> tuple[mujoco.MjModel, mujoco.MjData]:
    model, data = _robot()
    data.qpos[:] = model.key("home").qpos
    data.qpos[:7] = q
    mujoco.mj_kinematics(model, data)
    mujoco.mj_comPos(model, data)
    return model, data


def hand_position(q=None) -> np.ndarray:
    """World xyz of the grasp point for the 7 arm joint angles `q` (default HOME_QPOS)."""
    q = HOME_QPOS if q is None else np.asarray(q, dtype=float)[:7]
    model, data = _set_arm(q)
    hand = model.body("hand").id
    return data.xpos[hand] + data.xmat[hand].reshape(3, 3) @ GRASP_OFFSET


def hand_down_error(q=None) -> float:
    """Angle in degrees between the gripper's pointing direction and straight down, for arm angles `q`."""
    q = HOME_QPOS if q is None else np.asarray(q, dtype=float)[:7]
    model, data = _set_arm(q)
    z = data.xmat[model.body("hand").id].reshape(3, 3)[:, 2]
    return float(np.degrees(np.arccos(np.clip(-z[2], -1.0, 1.0))))


def ik(
    target_xyz,
    q_init=None,
    iters: int = 200,
    damping: float = 0.05,
    tol: float = 1e-4,
    down_weight: float = 0.0,
) -> np.ndarray:
    """Return 7 arm joint angles that put the grasp point at `target_xyz`.

    Default (down_weight=0): position-only damped least squares on the grasp point, starting from
    `q_init` (default HOME_QPOS) and clipping to the joint limits after every step. Orientation is not
    controlled: the solution is the one closest to `q_init`, and the gripper can end up tilted by tens of
    degrees (check with `hand_down_error`). Joint 7 (wrist roll) never changes in this mode because it
    does not move the grasp point.

    down_weight > 0 adds a soft orientation goal: turn the gripper to point straight down without
    spinning it about the vertical, so the fingers keep closing along the same world direction as in
    `q_init` (world x for HOME_QPOS). With a weight around 0.3 to 1 the gripper ends up within a
    fraction of a degree of vertical for reachable targets, and the position error stays below 0.1 mm.

    Stops early once the error is below `tol`. If the target is out of reach it returns the closest pose
    it found. Deterministic: same inputs give the same output.
    """
    target = np.asarray(target_xyz, dtype=float).reshape(3)
    q = (HOME_QPOS if q_init is None else np.asarray(q_init, dtype=float)[:7]).copy()
    q = np.clip(q, JOINT_LOWER, JOINT_UPPER)
    model, _ = _robot()
    hand = model.body("hand").id
    jacp = np.zeros((3, model.nv))
    jacr = np.zeros((3, model.nv))
    down = np.array([0.0, 0.0, -1.0])
    lam2 = damping**2
    for _ in range(iters):
        model, data = _set_arm(q)
        rot = data.xmat[hand].reshape(3, 3)
        point = data.xpos[hand] + rot @ GRASP_OFFSET
        err = target - point
        mujoco.mj_jac(model, data, jacp, jacr, point, hand)
        jac = jacp[:, :7]
        if down_weight > 0:
            # Rotation (axis * angle, small-angle) that turns the gripper axis toward straight down.
            rot_err = np.cross(rot[:, 2], down)
            if np.linalg.norm(err) < tol and np.linalg.norm(rot_err) < 1e-3:
                break
            jac = np.vstack([jac, down_weight * jacr[:, :7]])
            err = np.concatenate([err, down_weight * rot_err])
        elif np.linalg.norm(err) < tol:
            break
        dq = jac.T @ np.linalg.solve(jac @ jac.T + lam2 * np.eye(len(err)), err)
        step = np.linalg.norm(dq)
        if step > 0.2:
            dq *= 0.2 / step
        q = np.clip(q + dq, JOINT_LOWER, JOINT_UPPER)
    return q
