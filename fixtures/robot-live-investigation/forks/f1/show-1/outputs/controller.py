"""Pick the can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints of the grasp point. Each move is a minimum-jerk interpolation
between two points; the joint targets come from `ik` (warm-started from the previous solution, with
the gripper kept pointing down). Gripper: open during approach, close on the can, open to release.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik

CAN_HALF_HEIGHT = 0.05
Z_GRASP = CAN_HALF_HEIGHT          # grasp at the can's mid-height
Z_CARRY = 0.22                     # grasp-point height while carrying (clears the can)
Z_PREGRASP = 0.16
Z_RELEASE = CAN_HALF_HEIGHT + 0.005


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
        self.grip = GRIPPER_OPEN
        # Each stage: (name, target xyz or None for a timed hold, duration s, gripper command)
        cx, cy = self.can0
        px, py = self.place
        self.stages = [
            ("approach", (cx, cy, Z_PREGRASP), 1.5, GRIPPER_OPEN),
            ("descend", (cx, cy, Z_GRASP), 1.0, GRIPPER_OPEN),
            ("close", None, 0.8, GRIPPER_CLOSED),
            ("lift", (cx, cy, Z_CARRY), 1.0, GRIPPER_CLOSED),
            ("carry", (px, py, Z_CARRY), 2.0, GRIPPER_CLOSED),
            ("lower", (px, py, Z_RELEASE), 1.0, GRIPPER_CLOSED),
            ("release", None, 0.6, GRIPPER_OPEN),
            ("retreat", (px, py, Z_CARRY), 1.0, GRIPPER_OPEN),
        ]
        self.idx = 0
        self.stage_t0 = None
        self.start_xyz = self._hand_guess()
        self.now = 0.0

    def _hand_guess(self):
        from sim.control import hand_position
        return hand_position(HOME_QPOS)

    def _advance(self, t):
        """Return (current target xyz or None, gripper cmd) for time t."""
        if self.stage_t0 is None:
            self.stage_t0 = t
            self.seg_from = self.cur_xyz
        name, target, dur, grip = self.stages[self.idx]
        if target is None:
            # timed hold in place
            if t - self.stage_t0 >= dur:
                self._next(t)
                return self._advance(t)
            return self.cur_xyz, grip
        s = (t - self.stage_t0) / dur
        if s >= 1.0:
            self.cur_xyz = np.array(target, dtype=float)
            self._next(t)
            return self.cur_xyz, grip
        p = self.seg_from + (np.array(target) - self.seg_from) * min_jerk(s)
        return p, grip

    def _next(self, t):
        self.idx += 1
        self.stage_t0 = None
        if self.idx >= len(self.stages):
            self.idx = len(self.stages) - 1
            self.finished = True

    def act(self, obs):
        if not hasattr(self, "cur_xyz"):
            self.cur_xyz = self.start_xyz.copy()
            self.finished = False
        t = obs["time"]
        if self.finished:
            self.done = True
        xyz, grip = self._advance(t)
        self.cur_xyz = np.array(xyz, dtype=float)
        self.q = ik(xyz, q_init=self.q, down_weight=0.5)
        self.grip = grip
        return list(self.q) + [grip]
