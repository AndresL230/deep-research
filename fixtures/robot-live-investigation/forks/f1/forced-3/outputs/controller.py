"""Pick the can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints of the grasp point. Each move is a minimum-jerk interpolation
between two points; the joint targets come from `ik` (warm-started from the previous solution, with
the gripper kept pointing down). Gripper: open during approach, close on the can, open to release.

The can can slide a little in the grip while carried, so the final lowering is relative to the measured
hand-to-can offset: the can's bottom is kept just above the floor and the fingers never push into the table.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

CAN_HALF_HEIGHT = 0.05
Z_GRASP = 0.06                     # grasp slightly above the can's mid-height (fingertips clear the table)
Z_CARRY = 0.22                     # grasp-point height while carrying (clears the can)
Z_PREGRASP = 0.16
Z_RELEASE_CLEARANCE = 0.005        # can bottom this far above the floor when released

# (name, kind, duration s, gripper command). kind: "move" to a fixed xy/z point, or "hold" in place.
STAGES = [
    ("approach", "move", 1.0, GRIPPER_OPEN),
    ("descend", "move", 0.8, GRIPPER_OPEN),
    ("close", "hold", 0.6, GRIPPER_CLOSED),
    ("lift", "move", 1.8, GRIPPER_CLOSED),
    ("carry", "move", 2.6, GRIPPER_CLOSED),
    ("lower", "move", 1.5, GRIPPER_CLOSED),
    ("release", "hold", 0.5, GRIPPER_OPEN),
    ("retreat", "move", 0.6, GRIPPER_OPEN),
]


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
        self.cur = hand_position(HOME_QPOS)  # last commanded grasp-point position
        self.idx = 0
        self.stage_t0 = None
        self.seg_from = None
        self.seg_to = None
        self.grip_offset = 0.0  # hand z minus can z measured when lowering starts
        self.finished = False

    def _target(self, name, obs):
        cx, cy = self.can0
        px, py = self.place
        if name == "approach":
            return np.array([cx, cy, Z_PREGRASP])
        if name == "descend":
            return np.array([cx, cy, Z_GRASP])
        if name == "lift":
            return np.array([cx, cy, Z_CARRY])
        if name == "carry":
            return np.array([px, py, Z_CARRY])
        if name == "lower":
            # keep the can's bottom just above the floor, given the grip offset actually in use
            self.grip_offset = float(obs["hand_pos"][2] - obs["can_pos"][2])
            return np.array([px, py, CAN_HALF_HEIGHT + Z_RELEASE_CLEARANCE + self.grip_offset])
        if name == "retreat":
            return np.array([px, py, Z_CARRY])
        return None

    def act(self, obs):
        if self.finished:
            self.done = True
            return list(self.q) + [GRIPPER_OPEN]
        t = obs["time"]
        name, kind, dur, grip = STAGES[self.idx]
        if self.stage_t0 is None:
            self.stage_t0 = t
            self.seg_from = self.cur.copy()
            self.seg_to = None if kind == "hold" else self._target(name, obs)
        s = (t - self.stage_t0) / dur
        if name == "lower" and obs["can_pos"][2] < CAN_HALF_HEIGHT + 0.006:
            # the can has reached the floor: stop pushing down and release
            s = 1.0
            self.seg_to = self.cur.copy()
        if kind == "hold" or s >= 1.0:
            xyz = self.seg_from if kind == "hold" else self.seg_to
            if kind == "move":
                xyz = self.seg_to
            # hold: stay where we are (seg_from is the hand position at the start of the hold)
        else:
            xyz = self.seg_from + (self.seg_to - self.seg_from) * min_jerk(s)
        if s >= 1.0:
            self.idx += 1
            self.stage_t0 = None
            if self.idx >= len(STAGES):
                self.finished = True
        self.cur = np.array(xyz, dtype=float)
        self.q = ik(xyz, q_init=self.q, down_weight=0.5)
        return list(self.q) + [grip]
