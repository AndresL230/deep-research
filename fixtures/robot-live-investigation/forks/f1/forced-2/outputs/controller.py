"""Pick the can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints of the grasp point. Each move is a minimum-jerk interpolation
between two points. Joint targets come from a small damped least-squares IK (grasp point position,
gripper pointing down, and gripper yaw held at a fixed heading) warm-started from the previous solution.
The yaw is chosen so the hand housing lies radially-outward and the fingers close tangentially to the
base-to-can direction; this keeps the housing from hitting the can side at far reach.
Gripper: open during approach, close on the can, open to release.
"""

import mujoco
import numpy as np

from sim.control import GRASP_OFFSET, GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, JOINT_LOWER, JOINT_UPPER, _robot, _set_arm

CAN_HALF_HEIGHT = 0.05
Z_GRASP = CAN_HALF_HEIGHT          # grasp at the can's mid-height
Z_CARRY = 0.22                     # grasp-point height while carrying (clears the can)
Z_PREGRASP = 0.16
Z_RELEASE = CAN_HALF_HEIGHT + 0.005
DOWN = np.array([0.0, 0.0, -1.0])


def min_jerk(s):
    s = min(max(s, 0.0), 1.0)
    return 10 * s**3 - 15 * s**4 + 6 * s**5


def solve_pose(target, q_init, psi, iters=200, damping=0.05, w_orient=0.5, w_yaw=0.5, tol=1e-4):
    """IK for the grasp point at `target`, gripper pointing down, hand x-axis heading `psi` (radians, world)."""
    model, _ = _robot()
    hand = model.body("hand").id
    jacp = np.zeros((3, model.nv))
    jacr = np.zeros((3, model.nv))
    dx = np.array([np.cos(psi), np.sin(psi), 0.0])
    q = np.clip(np.asarray(q_init, dtype=float)[:7], JOINT_LOWER, JOINT_UPPER).copy()
    for _ in range(iters):
        model, data = _set_arm(q)
        rot = data.xmat[hand].reshape(3, 3)
        point = data.xpos[hand] + rot @ GRASP_OFFSET
        err_p = np.asarray(target, dtype=float) - point
        r_down = np.cross(rot[:, 2], DOWN)
        r_yaw = np.cross(rot[:, 0], dx)
        if np.linalg.norm(err_p) < tol and np.linalg.norm(r_down) < 1e-3 and np.linalg.norm(r_yaw) < 1e-3:
            break
        mujoco.mj_jac(model, data, jacp, jacr, point, hand)
        # Two orientation terms: tilt (hand z axis vs down) and yaw (hand x axis vs heading).
        jac = np.vstack([jacp[:, :7], w_orient * jacr[:, :7], w_yaw * jacr[:, :7]])
        err = np.concatenate([err_p, w_orient * r_down, w_yaw * r_yaw])
        dq = jac.T @ np.linalg.solve(jac @ jac.T + damping**2 * np.eye(len(err)), err)
        step = np.linalg.norm(dq)
        if step > 0.2:
            dq *= 0.2 / step
        q = np.clip(q + dq, JOINT_LOWER, JOINT_UPPER)
    return q


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.can0 = np.array(task["can_start"], dtype=float)
        self.place = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        # Grasp heading: hand x-axis tangential to the base-to-can direction (i.e. fingers tangential).
        self.psi = float(np.arctan2(self.can0[1], self.can0[0]) + np.pi / 2)
        self.grip = GRIPPER_OPEN
        cx, cy = self.can0
        px, py = self.place
        # Each stage: (name, target xyz or None for a timed hold, duration s, gripper command)
        self.stages = [
            ("approach", (cx, cy, Z_PREGRASP), 1.2, GRIPPER_OPEN),
            ("descend", (cx, cy, Z_GRASP), 1.3, GRIPPER_OPEN),
            ("settle", None, 0.4, GRIPPER_OPEN),
            ("close", None, 0.8, GRIPPER_CLOSED),
            ("lift", (cx, cy, Z_CARRY), 1.0, GRIPPER_CLOSED),
            ("carry", (px, py, Z_CARRY), 1.8, GRIPPER_CLOSED),
            ("lower", (px, py, Z_RELEASE), 1.0, GRIPPER_CLOSED),
            ("release", None, 0.6, GRIPPER_OPEN),
            ("retreat", (px, py, Z_CARRY), 1.0, GRIPPER_OPEN),
        ]
        self.idx = 0
        self.stage_t0 = None
        self.finished = False
        self.cur_xyz = None

    def _start_xyz(self):
        from sim.control import hand_position
        return np.asarray(hand_position(HOME_QPOS), dtype=float)

    def _advance(self, t):
        """Return (target xyz, gripper cmd) for sim time t."""
        if self.stage_t0 is None:
            self.stage_t0 = t
            self.seg_from = self.cur_xyz.copy()
        name, target, dur, grip = self.stages[self.idx]
        if target is None:
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
        if self.cur_xyz is None:
            self.cur_xyz = self._start_xyz()
        t = obs["time"]
        if self.finished:
            self.done = True
        xyz, grip = self._advance(t)
        self.cur_xyz = np.asarray(xyz, dtype=float)
        self.q = solve_pose(xyz, self.q, self.psi)
        return list(self.q) + [grip]
