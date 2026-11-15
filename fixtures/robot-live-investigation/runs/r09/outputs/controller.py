"""Pick a standing can from the table and place it upright on the place zone.

Timed state machine over Cartesian waypoints (grasp-point xyz). Each segment interpolates the
grasp-point target from the previous waypoint to the next one, converts it to joint angles with
`ik` (warm-started from the previous solution, gripper kept pointing down), and sends those as servo
targets. Until the gripper closes, the grasp xy follows the measured can position (obs["can_pos"]),
not the nominal start position. After the grasp, the place target is used.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik, hand_position

# Heights for the grasp point (world z). The can is 0.10 m tall standing on the floor.
GRASP_Z = 0.065     # grasp in the upper half of the can (can centre is at 0.05)
TRAVEL_Z = 0.22     # safe transport height
PLACE_Z = 0.064     # grasp-point height that puts a standing can's bottom on the floor (grasp point is ~1.3 cm above can centre when held)
PRE_Z = 0.14        # hover height above the can before descending

# (name, duration s, target key, gripper command). 'hold' keeps the current grasp point.
SEGMENTS = [
    ("approach", 1.3, "can_pre", GRIPPER_OPEN),
    ("descend", 0.8, "can_grasp", GRIPPER_OPEN),
    ("close", 0.5, "hold", GRIPPER_CLOSED),
    ("lift", 0.7, "can_lift", GRIPPER_CLOSED),
    ("transfer", 2.5, "place_travel", GRIPPER_CLOSED),
    ("lower", 1.8, "place_low", GRIPPER_CLOSED),
    ("release", 0.8, "hold", GRIPPER_OPEN),
    ("retreat", 0.8, "place_up", GRIPPER_OPEN),
]
TRACK_CAN_UNTIL = 3  # segments with index below this follow the measured can position


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.can_xy = np.array(task["can_start"], dtype=float)
        self.place_xy = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.seg = 0
        self.seg_start_t = None
        self.seg_start_xyz = None

    def _target_of(self, key):
        if key == "hold":
            return None
        cx, cy = self.can_xy
        px, py = self.place_xy
        return {
            "can_pre": np.array([cx, cy, PRE_Z]),
            "can_grasp": np.array([cx, cy, GRASP_Z]),
            "can_lift": np.array([cx, cy, TRAVEL_Z]),
            "place_travel": np.array([px, py, TRAVEL_Z]),
            "place_low": np.array([px, py, PLACE_Z]),
            "place_up": np.array([px, py, TRAVEL_Z]),
        }[key]

    def act(self, obs):
        t = float(obs["time"])
        if self.seg < TRACK_CAN_UNTIL:
            self.can_xy = np.array(obs["can_pos"][:2], dtype=float)
        if self.seg_start_t is None:
            self.seg_start_t = t
            self.seg_start_xyz = np.array(obs["hand_pos"], dtype=float)

        # advance through segments whose time has elapsed
        while self.seg < len(SEGMENTS):
            name, dur, key, grip = SEGMENTS[self.seg]
            if t - self.seg_start_t >= dur:
                tgt = self._target_of(key)
                if tgt is not None:
                    self.seg_start_xyz = tgt.copy()
                self.seg += 1
                self.seg_start_t = t
                continue
            break

        if self.seg >= len(SEGMENTS):
            self.done = True
            return list(self.q) + [GRIPPER_OPEN]

        name, dur, key, grip = SEGMENTS[self.seg]
        s = min(1.0, (t - self.seg_start_t) / dur)
        s = 0.5 - 0.5 * np.cos(np.pi * s)  # smooth ease in/out
        tgt = self._target_of(key)
        if tgt is None:
            xyz = self.seg_start_xyz
        else:
            xyz = (1.0 - s) * self.seg_start_xyz + s * tgt
        self.q = ik(xyz, q_init=self.q, down_weight=0.5)
        return list(self.q) + [grip]
