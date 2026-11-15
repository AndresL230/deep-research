"""Pick a can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints for the grasp point. Each step the grasp-point target is
interpolated (minimum-jerk) between waypoints and converted to joint angles with ik(); the gripper
command is set per phase.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik

HOVER_Z = 0.20       # grasp-point height while travelling
GRASP_Z = 0.05       # grasp-point height for the can (can centre is at z=0.05)
PLACE_Z = 0.06       # grasp-point height when placing (can rests on floor)


def _min_jerk(s):
    s = min(max(s, 0.0), 1.0)
    return 10 * s**3 - 15 * s**4 + 6 * s**5


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.cx, self.cy = task["can_start"]
        self.px, self.py = task["place_target"]
        self.q = np.array(HOME_QPOS, dtype=float)
        self.start_xyz = None
        # phases: (name, end_xyz_fn, duration, gripper)
        self.phases = [
            ("approach", lambda: (self.cx, self.cy, HOVER_Z), 1.6, GRIPPER_OPEN),
            ("descend", lambda: (self.cx, self.cy, GRASP_Z), 1.0, GRIPPER_OPEN),
            ("close", lambda: (self.cx, self.cy, GRASP_Z), 0.8, GRIPPER_CLOSED),
            ("lift", lambda: (self.cx, self.cy, HOVER_Z), 1.0, GRIPPER_CLOSED),
            ("transport", lambda: (self.px, self.py, HOVER_Z), 2.0, GRIPPER_CLOSED),
            ("lower", lambda: (self.px, self.py, PLACE_Z), 1.0, GRIPPER_CLOSED),
            ("release", lambda: (self.px, self.py, PLACE_Z), 0.8, GRIPPER_OPEN),
            ("retreat", lambda: (self.px, self.py, HOVER_Z), 1.0, GRIPPER_OPEN),
        ]
        self.idx = 0
        self.phase_t0 = 0.0
        self.seg_start = None

    def act(self, obs):
        t = obs["time"]
        hand = np.array(obs["hand_pos"], dtype=float)
        if self.idx >= len(self.phases):
            self.done = True
            return None
        name, end_fn, dur, grip = self.phases[self.idx]
        if self.seg_start is None:
            self.seg_start = hand.copy()
            self.phase_t0 = t
        end = np.array(end_fn(), dtype=float)
        s = (t - self.phase_t0) / dur
        if s >= 1.0:
            self.idx += 1
            self.seg_start = None
            if self.idx >= len(self.phases):
                self.done = True
                return None
            return self.act(obs)
        target = self.seg_start + (end - self.seg_start) * _min_jerk(s)
        self.q = ik(target, q_init=self.q, down_weight=0.5)
        return list(self.q) + [grip]
