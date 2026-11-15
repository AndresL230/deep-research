"""Pick-and-place controller: a timed sequence of Cartesian waypoints for the grasp point.

Each segment moves the grasp point linearly (smoothstep) from where the previous segment ended to
its target over `duration` seconds, with IK warm-started from the previous joint solution. The
gripper command is set per segment.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, JOINT_LOWER, JOINT_UPPER, CONTROL_DT, ik, hand_position

# Tunable parameters
APPROACH_Z = 0.22        # grasp-point height for travel
GRASP_Z = 0.05           # grasp-point height for grasping the can (can centre height)
PLACE_Z = 0.052          # grasp-point height when placing (can centre at floor + tiny)
GRASP_HOLD = 0.6         # s to hold gripper closed before lifting
RELEASE_HOLD = 0.6       # s to hold gripper open before retreating


class Controller:
    PLACE_SEGMENTS = (5, 6)  # segment indices that use closed-loop placement (lower, then release)

    def reset(self, task):
        self.task = task
        self.done = False
        self.hold_xy = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.gripper = GRIPPER_OPEN
        self.start_hand = None
        self.segments = None
        self.seg_idx = 0
        self.seg_t0 = 0.0
        self.seg_start_xyz = None
        self.plan_built = False
        self.cur_xyz = None

    # --- planning -------------------------------------------------------------------------------
    def _build_plan(self, obs):
        cx, cy = obs["can_pos"][0], obs["can_pos"][1]
        px, py = self.task["place_target"]
        self.can_xy = (float(cx), float(cy))
        segs = [
            # (target xyz, duration, gripper)
            ((cx, cy, APPROACH_Z), 1.5, GRIPPER_OPEN),
            ((cx, cy, GRASP_Z), 1.0, GRIPPER_OPEN),
            ((cx, cy, GRASP_Z), GRASP_HOLD, GRIPPER_CLOSED),
            ((cx, cy, APPROACH_Z), 1.0, GRIPPER_CLOSED),
            ((px, py, APPROACH_Z), 2.0, GRIPPER_CLOSED),
            ((px, py, PLACE_Z), 1.0, GRIPPER_CLOSED),
            ((px, py, PLACE_Z), RELEASE_HOLD, GRIPPER_OPEN),
            ((px, py, APPROACH_Z), 1.0, GRIPPER_OPEN),
        ]
        self.segments = segs
        self.plan_built = True

    def _ik(self, xyz):
        q = ik(xyz, q_init=self.q, down_weight=0.5)
        return np.clip(q, JOINT_LOWER, JOINT_UPPER)

    # --- control --------------------------------------------------------------------------------
    def act(self, obs):
        if not self.plan_built:
            self._build_plan(obs)
            self.cur_xyz = np.array(hand_position(HOME_QPOS), dtype=float)
            self.seg_start_xyz = self.cur_xyz.copy()
            self.seg_t0 = float(obs["time"])
            self.q = np.array(HOME_QPOS, dtype=float)

        t = float(obs["time"])
        if self.seg_idx >= len(self.segments):
            self.done = True
            return list(self.q) + [GRIPPER_OPEN]

        target, dur, grip = self.segments[self.seg_idx]
        target = np.array(target, dtype=float)
        s = min(1.0, max(0.0, (t - self.seg_t0) / dur)) if dur > 0 else 1.0
        s = s * s * (3 - 2 * s)  # smoothstep
        xyz = self.seg_start_xyz + s * (target - self.seg_start_xyz)

        # Closed-loop placement: while carrying the can over the place zone, aim the grasp point so the
        # can centre (not the hand) lands on the target. Corrects for the can slipping in the grasp.
        if self.seg_idx in self.PLACE_SEGMENTS:
            px, py = self.task["place_target"]
            can = obs["can_pos"]
            hand = obs["hand_pos"]
            off = hand[:2] - can[:2]
            xyz = np.array([px, py, xyz[2]]) + np.array([off[0], off[1], 0.0])
            if grip == GRIPPER_OPEN:
                xyz[0], xyz[1] = self.hold_xy
            else:
                self.hold_xy = xyz[:2].copy()

        self.q = self._ik(xyz)
        self.gripper = grip

        if t - self.seg_t0 >= dur - 1e-9:
            self.seg_idx += 1
            self.seg_t0 = t
            self.seg_start_xyz = target.copy()

        return list(self.q) + [float(self.gripper)]
