"""Pick a can from the table and place it upright on the place zone.

Phase machine over a Cartesian setpoint for the grasp point. The setpoint moves toward the current
phase goal at a limited speed; IK turns it into arm joint targets (gripper kept pointing down).
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik

CAN_HALF_HEIGHT = 0.05
APPROACH_Z = 0.20       # grasp-point height for travelling
GRASP_Z = 0.05          # grasp at can mid-height (can is 0.10 m tall)
PLACE_Z = 0.055         # grasp-point height when releasing (can bottom ~0.5 cm above table)
SPEED = 0.35            # m/s max setpoint speed (free motion)
CARRY_SPEED = 0.2       # m/s while the can is held (lift, transfer, lower), limits slip
TOL = 0.006             # m, phase goal reached when setpoint within this of goal and hand close
CLOSE_TIME = 0.6        # s to wait for fingers to close
OPEN_TIME = 0.4         # s to wait for release


class Controller:
    def reset(self, task):
        self.task = task
        self.can = np.array(task["can_start"], dtype=float)
        self.place = np.array(task["place_target"], dtype=float)
        self.done = False
        self.q = np.array(HOME_QPOS, dtype=float)
        self.sp = None  # Cartesian setpoint, initialised from first observation
        self.phase = 0
        self.t_phase = 0.0
        self.last_t = 0.0
        self.gripper = GRIPPER_OPEN
        # phase goals: (xyz goal function, gripper command during phase)
        self.phases = [
            "approach", "descend", "close", "lift", "transfer", "lower", "open", "retreat", "finish",
        ]

    def _goal(self):
        name = self.phases[self.phase]
        if name == "approach":
            return np.array([self.can[0], self.can[1], APPROACH_Z])
        if name == "descend":
            return np.array([self.can[0], self.can[1], GRASP_Z])
        if name in ("close", "lift"):
            return np.array([self.can[0], self.can[1], APPROACH_Z if name == "lift" else GRASP_Z])
        if name == "transfer":
            return np.array([self.place[0], self.place[1], APPROACH_Z])
        if name in ("lower", "open"):
            return np.array([self.place[0], self.place[1], PLACE_Z])
        return np.array([self.place[0], self.place[1], APPROACH_Z])

    def _gripper(self):
        name = self.phases[self.phase]
        if name in ("approach", "descend", "open", "retreat", "finish"):
            return GRIPPER_OPEN
        return GRIPPER_CLOSED

    def act(self, obs):
        t = float(obs["time"])
        dt = t - self.last_t if self.sp is not None else 0.0
        self.last_t = t
        if self.sp is None:
            self.sp = np.array(obs["hand_pos"], dtype=float)

        name = self.phases[self.phase]
        # Track the real can position (seed noise moves it a few mm from the nominal task value)
        # until the fingers close; after that the can is held and its position is no longer used.
        if name in ("approach", "descend"):
            self.can = np.array(obs["can_pos"][:2], dtype=float)
        goal = self._goal()
        # move setpoint toward goal at limited speed
        delta = goal - self.sp
        dist = np.linalg.norm(delta)
        carrying = name in ("lift", "transfer", "lower")
        slow = name == "retreat"  # leave the can gently after release
        speed = CARRY_SPEED if carrying else (0.15 if slow else SPEED)
        step = speed * max(dt, 0.02)
        if dist > step:
            self.sp = self.sp + delta * (step / dist)
        else:
            self.sp = goal.copy()

        self.t_phase += dt
        advance = False
        if name in ("approach", "descend", "lift", "transfer", "lower", "retreat"):
            if dist < TOL and np.linalg.norm(np.array(obs["hand_pos"]) - goal) < 0.012:
                advance = True
        elif name == "close":
            advance = self.t_phase >= CLOSE_TIME
        elif name == "open":
            advance = self.t_phase >= OPEN_TIME

        if advance and self.phase < len(self.phases) - 1:
            self.phase += 1
            self.t_phase = 0.0
        if self.phases[self.phase] == "finish":
            self.done = True

        self.q = ik(self.sp, q_init=self.q, down_weight=0.5)
        return list(self.q) + [self._gripper()]
