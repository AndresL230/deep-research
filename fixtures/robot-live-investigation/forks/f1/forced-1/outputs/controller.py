"""Pick the can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints of the grasp point. Each move is a minimum-jerk interpolation
between two points. Joint targets come from a damped-least-squares IK that keeps the gripper pointing
straight down and holds the wrist roll (joint 7) fixed, so the hand does not spin while it carries the
can. Gripper: open during approach, close on the can, open to release.
"""

import mujoco
import numpy as np

from sim.control import GRASP_OFFSET, GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, JOINT_LOWER, JOINT_UPPER, _robot

CAN_HALF_HEIGHT = 0.05
Z_GRASP = CAN_HALF_HEIGHT  # grasp at the can's mid-height
Z_CARRY = 0.22  # grasp-point height while carrying (clears the can)
Z_PREGRASP = 0.16
Z_RELEASE = CAN_HALF_HEIGHT + 0.005
TIME_SCALE = 1.6  # multiplies the transport durations (slower = gentler accelerations)

# Robot-only model (cached by sim.control, so it is not reloaded for every episode); own data buffer.
_M, _ = _robot()
_D = mujoco.MjData(_M)
_HAND = _M.body("hand").id
_DOWN = np.array([0.0, 0.0, -1.0])


def _fk(q):
    _D.qpos[:7] = q
    mujoco.mj_kinematics(_M, _D)
    R = _D.xmat[_HAND].reshape(3, 3)
    return _D.xpos[_HAND] + R @ GRASP_OFFSET, R


def _residual(q, target):
    p, R = _fk(q)
    return np.concatenate([target - p, 0.5 * np.cross(R[:, 2], _DOWN)])


def ik_fixed_yaw(target_xyz, q_init, iters=300, damping=0.02, tol=1e-5):
    """Arm joints (joint 7 kept at q_init[6]) putting the grasp point at target_xyz with the gripper down."""
    target = np.asarray(target_xyz, dtype=float).reshape(3)
    q = np.clip(np.asarray(q_init, dtype=float)[:7].copy(), JOINT_LOWER, JOINT_UPPER)
    lam2 = damping**2
    eps = 1e-6
    for _ in range(iters):
        r = _residual(q, target)
        if np.linalg.norm(r) < tol:
            break
        J = np.zeros((6, 6))
        for j in range(6):
            dq = np.zeros(7)
            dq[j] = eps
            J[:, j] = (_residual(q + dq, target) - r) / eps
        step = -J.T @ np.linalg.solve(J @ J.T + lam2 * np.eye(6), r)
        n = np.linalg.norm(step)
        if n > 0.2:
            step *= 0.2 / n
        q[:6] = np.clip(q[:6] + step, JOINT_LOWER[:6], JOINT_UPPER[:6])
    return q


def min_jerk(s):
    s = min(max(s, 0.0), 1.0)
    return 10 * s**3 - 15 * s**4 + 6 * s**5


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.can0 = np.array(task["can_start"], dtype=float)
        self.place = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.started = False
        cx, cy = self.can0
        px, py = self.place
        T = TIME_SCALE
        # Each stage: (name, target xyz or None for a timed hold, duration s, gripper command)
        self.stages = [
            ("approach", (cx, cy, Z_PREGRASP), 1.0, GRIPPER_OPEN),
            ("descend", (cx, cy, Z_GRASP), 0.6, GRIPPER_OPEN),
            ("close", None, 0.5, GRIPPER_CLOSED),
            ("lift", (cx, cy, Z_CARRY), 0.8 * T, GRIPPER_CLOSED),
            ("carry", (px, py, Z_CARRY), 2.0 * T, GRIPPER_CLOSED),
            ("lower", (px, py, Z_RELEASE), 0.9 * T, GRIPPER_CLOSED),
            ("release", None, 0.4, GRIPPER_OPEN),
            ("retreat", (px, py, Z_CARRY), 0.4, GRIPPER_OPEN),
        ]
        self.idx = 0
        self.stage_t0 = None
        self.finished = False
        self.cur_xyz = _fk(HOME_QPOS)[0].copy()

    def _advance(self, t):
        """Return (commanded grasp-point xyz, gripper command) for sim time t."""
        if self.stage_t0 is None:
            self.stage_t0 = t
            self.seg_from = self.cur_xyz.copy()
        name, target, dur, grip = self.stages[self.idx]
        if target is None:  # timed hold in place
            if t - self.stage_t0 >= dur:
                self._next()
                return self._advance(t)
            return self.cur_xyz.copy(), grip
        s = (t - self.stage_t0) / dur
        if s >= 1.0:
            self._next()
            return np.array(target, dtype=float), grip
        p = self.seg_from + (np.array(target, dtype=float) - self.seg_from) * min_jerk(s)
        return p, grip

    def _next(self):
        self.idx += 1
        self.stage_t0 = None
        if self.idx >= len(self.stages):
            self.idx = len(self.stages) - 1
            self.finished = True

    def act(self, obs):
        if self.finished:
            self.done = True
        xyz, grip = self._advance(obs["time"])
        self.cur_xyz = np.asarray(xyz, dtype=float)
        self.q = ik_fixed_yaw(xyz, self.q)
        return list(self.q) + [grip]
