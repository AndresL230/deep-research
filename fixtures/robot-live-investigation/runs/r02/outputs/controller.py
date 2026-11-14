"""Pick the can from the table and place it upright on the place zone.

Cartesian waypoint state machine. Each segment moves a setpoint for a fixed duration with a smooth
(cosine) profile; the setpoint is converted to joint angles with IK (gripper kept pointing down).
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

APPROACH_Z = 0.22  # grasp-point height while travelling
GRASP_Z = 0.075  # grasp-point height for grasping and placing (can centre is 5 cm up; grip above centre is stable)
CLEAR_Z = 0.20  # height used when retreating after release


def _smooth(s):
    s = min(max(s, 0.0), 1.0)
    return 0.5 - 0.5 * np.cos(np.pi * s)


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.can_xy = np.array(task["can_start"], dtype=float)
        self.place_xy = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.setpoint = np.array(hand_position(HOME_QPOS), dtype=float)
        self.gripper = GRIPPER_OPEN
        self.t_start = 0.0
        self.seg_idx = 0
        self.seg_t0 = None
        self.segments = None
        self.grasp_xy = None
        self.hold_t0 = None

    def _build(self, obs):
        # Use the true can position for the grasp (valid while it sits still on the table).
        cx, cy = obs["can_pos"][0], obs["can_pos"][1]
        self.grasp_xy = np.array([cx, cy])
        s = self.setpoint.copy()
        ax = np.array([cx, cy])
        px, py = self.place_xy
        # each segment: (kind, duration, target xyz or None, gripper)
        self.segments = [
            ("move", 1.6, np.array([cx, cy, APPROACH_Z]), GRIPPER_OPEN),
            ("move", 1.0, np.array([cx, cy, GRASP_Z]), GRIPPER_OPEN),
            ("hold", 0.6, None, GRIPPER_CLOSED),
            ("move", 1.0, np.array([cx, cy, APPROACH_Z]), GRIPPER_CLOSED),
            ("move", 2.2, np.array([px, py, APPROACH_Z]), GRIPPER_CLOSED),
            ("hold", 0.3, None, GRIPPER_CLOSED),
            ("move", 1.2, np.array([px, py, GRASP_Z]), GRIPPER_CLOSED),
            ("hold", 0.4, None, GRIPPER_OPEN),
            ("move", 0.6, np.array([px, py, CLEAR_Z]), GRIPPER_OPEN),
        ]
        self.seg_start_pos = s

    def act(self, obs):
        t = float(obs["time"])
        if self.segments is None:
            self._build(obs)
            self.seg_idx = 0
            self.seg_t0 = t
            self.seg_from = self.setpoint.copy()
        # advance segments
        while self.seg_idx < len(self.segments):
            kind, dur, target, grip = self.segments[self.seg_idx]
            if t - self.seg_t0 >= dur:
                self.setpoint = target.copy() if target is not None else self.setpoint
                self.seg_idx += 1
                self.seg_t0 = t
                self.seg_from = self.setpoint.copy()
                continue
            break

        if self.seg_idx >= len(self.segments):
            self.done = True
            kind, dur, target, grip = self.segments[-1]
            self.gripper = GRIPPER_OPEN
            return list(self.q) + [GRIPPER_OPEN]

        kind, dur, target, grip = self.segments[self.seg_idx]
        self.gripper = grip
        if kind == "move":
            a = _smooth((t - self.seg_t0) / dur)
            sp = (1 - a) * self.seg_from + a * target
            self.setpoint = sp
        self.q = ik(self.setpoint, q_init=self.q, down_weight=0.5)
        return list(self.q) + [self.gripper]
