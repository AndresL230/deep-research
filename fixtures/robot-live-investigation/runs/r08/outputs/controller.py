"""Pick the can from the table and place it upright on the place zone.

State machine over grasp-point waypoints (IK with gripper pointing down), using live feedback
from obs["hand_pos"] and obs["can_pos"].
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik

APPROACH_Z = 0.20      # grasp-point height above the table for transit
GRASP_Z = 0.050        # grasp at can mid-height (can center is at 0.05)
LIFT_Z = 0.20          # carry height
PLACE_Z = 0.052        # release height (can center)
MAX_STEP = 0.004       # m per control step the commanded point may move (~0.2 m/s)
POS_TOL = 0.006        # m, waypoint reached tolerance
GRIP_TIME = 0.6        # s to wait for the gripper to close / open


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.place = np.array(task["place_target"], dtype=float)
        self.phase = "approach"
        self.phase_t0 = 0.0
        self.cmd = None          # commanded grasp point (xyz)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.grip = GRIPPER_OPEN
        self.can_grab_xy = None

    # -- helpers -------------------------------------------------------------
    def _move_toward(self, target):
        delta = target - self.cmd
        d = np.linalg.norm(delta)
        if d > MAX_STEP:
            delta *= MAX_STEP / d
        self.cmd = self.cmd + delta
        return float(d)

    def _set_phase(self, name, t):
        self.phase = name
        self.phase_t0 = t

    def act(self, obs):
        t = obs["time"]
        hand = np.array(obs["hand_pos"], dtype=float)
        can = np.array(obs["can_pos"], dtype=float)
        if self.cmd is None:
            self.cmd = hand.copy()

        ph = self.phase
        if ph == "approach":
            self.grip = GRIPPER_OPEN
            target = np.array([can[0], can[1], APPROACH_Z])
            self._move_toward(target)
            if np.linalg.norm(hand[:2] - can[:2]) < 0.01 and abs(hand[2] - APPROACH_Z) < POS_TOL:
                self._set_phase("descend", t)

        elif ph == "descend":
            self.grip = GRIPPER_OPEN
            # track the can's live xy while descending
            target = np.array([can[0], can[1], GRASP_Z])
            self._move_toward(target)
            if np.linalg.norm(hand[:2] - can[:2]) < 0.004 and abs(hand[2] - GRASP_Z) < 0.004:
                self._set_phase("close", t)

        elif ph == "close":
            self.grip = GRIPPER_CLOSED
            if t - self.phase_t0 >= GRIP_TIME:
                self._set_phase("lift", t)

        elif ph == "lift":
            self.grip = GRIPPER_CLOSED
            target = np.array([self.place[0], self.place[1], LIFT_Z])
            # lift straight up first, then travel
            if hand[2] < LIFT_Z - 0.03 and np.linalg.norm(hand[:2] - can[:2]) < 0.02:
                target = np.array([hand[0], hand[1], LIFT_Z])
            self._move_toward(target)
            if (np.linalg.norm(hand[:2] - self.place) < 0.01 and abs(hand[2] - LIFT_Z) < 0.012) or t - self.phase_t0 > 4.0:
                self._set_phase("lower", t)

        elif ph == "lower":
            self.grip = GRIPPER_CLOSED
            target = np.array([self.place[0], self.place[1], PLACE_Z])
            self._move_toward(target)
            if (abs(hand[2] - PLACE_Z) < 0.006 and np.linalg.norm(hand[:2] - self.place) < 0.01) or t - self.phase_t0 > 4.0:
                self._set_phase("release", t)

        elif ph == "release":
            self.grip = GRIPPER_OPEN
            if t - self.phase_t0 >= GRIP_TIME:
                self._set_phase("retreat", t)

        elif ph == "retreat":
            self.grip = GRIPPER_OPEN
            target = np.array([hand[0], hand[1], LIFT_Z])
            self._move_toward(target)
            if hand[2] > LIFT_Z - POS_TOL:
                self.done = True

        self.q = ik(self.cmd, q_init=self.q, down_weight=0.5)
        return list(self.q) + [float(self.grip)]
