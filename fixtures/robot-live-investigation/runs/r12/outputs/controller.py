"""Pick the can from the table and place it upright on the place zone.

Phase machine over Cartesian waypoints for the grasp point. Each segment interpolates smoothly from the
previous commanded grasp point to its target, IK (with gripper-down orientation) is solved every step,
and the gripper command is set per segment.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, ik

APPROACH_Z = 0.20        # grasp-point height while travelling
GRASP_Z = 0.055          # grasp point height for grasping the can (can center is at 0.05)
PLACE_Z = 0.065          # grasp point height when releasing on the zone
CARRY_Z = 0.22


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.q = np.array(HOME_QPOS, dtype=float)
        self.segments = None
        self.seg_idx = 0
        self.seg_t = 0.0
        self.place_xy = np.array(task["place_target"], dtype=float)
        self.grip = GRIPPER_OPEN
        self.q7_lock = None
        self.q1_lock = None

    def _build_segments(self, can_xy):
        cx, cy = can_xy
        px, py = self.place_xy
        # (grasp-point target xyz, duration s, gripper command)
        return [
            ((cx, cy, APPROACH_Z), 1.2, GRIPPER_OPEN),
            ((cx, cy, GRASP_Z), 0.8, GRIPPER_OPEN),
            ((cx, cy, GRASP_Z), 0.8, GRIPPER_CLOSED),   # close fingers in place
            ((cx, cy, CARRY_Z), 1.2, GRIPPER_CLOSED),   # lift
            ((px, py, CARRY_Z), 2.4, GRIPPER_CLOSED),   # carry
            ((px, py, PLACE_Z), 1.0, GRIPPER_CLOSED),   # lower onto zone
            ((px, py, PLACE_Z), 0.5, GRIPPER_OPEN),     # release
            ((px, py, APPROACH_Z), 0.5, GRIPPER_OPEN),  # retreat
        ]

    def act(self, obs):
        if self.segments is None:
            # Lock the can position seen at the start of the episode (true value, not nominal).
            self.can_xy = np.array(obs["can_pos"][:2], dtype=float)
            self.segments = self._build_segments(self.can_xy)
            self.seg_start = np.array(obs["hand_pos"], dtype=float)
            self.seg_idx = 0
            self.seg_t = 0.0

        if self.seg_idx >= len(self.segments):
            self.done = True
            return list(self.q) + [GRIPPER_OPEN]

        target, dur, grip = self.segments[self.seg_idx]
        target = np.array(target, dtype=float)
        self.seg_t += 1.0 / 50.0
        s = min(self.seg_t / dur, 1.0)
        s = s * s * (3.0 - 2.0 * s)  # smoothstep
        xyz = self.seg_start + s * (target - self.seg_start)
        self.q = ik(xyz, q_init=self.q, down_weight=0.5)
        if self.q7_lock is None:
            # Before grasping, keep the hand yawed like the home pose relative to the arm (q1 - q7 = const),
            # so the fingers close the same way as in the home configuration. Joint 7 does not move the grasp point.
            self.q[6] = self.q[0] - (HOME_QPOS[0] - HOME_QPOS[6])
        if self.q7_lock is not None:
            # Once the can is gripped, keep the hand yaw fixed in the world: joint 7 follows joint 1
            # (yaw ~ q1 - q7). Spinning the hand would twist the can out of the grip.
            # Joint 7 does not move the grasp point, so this keeps the position exact.
            self.q[6] = self.q7_lock + (self.q[0] - self.q1_lock)
        self.grip = grip
        if self.seg_idx == 2 and self.q7_lock is None:
            self.q7_lock = float(self.q[6])
            self.q1_lock = float(self.q[0])
        if self.seg_t >= dur:
            self.seg_idx += 1
            self.seg_t = 0.0
            self.seg_start = target
        return list(self.q) + [self.grip]
