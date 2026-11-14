"""Pick the can up from the table and place it upright on the place zone.

Cartesian waypoint state machine. The grasp point follows smooth (smoothstep) segments between waypoints;
each waypoint is turned into joint targets with IK, warm-started from the previous solution, with the
gripper kept pointing straight down.

Phases: hover above can -> descend -> close (wait until the fingers settle) -> lift -> carry above zone
-> lower -> open (wait until open) -> retreat.

While the gripper is still open, the grasp xy follows the can's live position from obs (so a can that
is a few mm off nominal is still centred). Once the fingers start closing, that xy is frozen.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

HOVER = 0.22          # safe transit height for the grasp point
GRASP_Z = 0.060       # grasp point height for grasping the can (upper-middle of the can, clear of the floor)
PLACE_Z = 0.058       # grasp point height when placing (can centre just above floor contact)
RETREAT_Z = 0.22

# Segment kinds
MOVE = "move"
HOLD = "hold"         # hold position, change gripper, wait until fingers settle


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.can_xy = np.array(task["can_start"], dtype=float)
        self.place = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.p = hand_position(HOME_QPOS)  # current commanded grasp point
        self.seg_idx = 0
        self.seg_t0 = 0.0
        self.seg_start = self.p.copy()
        self.last_fw = 0.08
        # (kind, duration or None, target as ("can", z) / ("place", z) / ("fixed", xyz), gripper command)
        self.segments = [
            (MOVE, 1.5, ("can", HOVER), GRIPPER_OPEN),       # transit above can
            (MOVE, 1.2, ("can", GRASP_Z), GRIPPER_OPEN),     # descend onto can
            (HOLD, None, None, GRIPPER_CLOSED),              # close fingers
            (MOVE, 1.6, ("can", HOVER), GRIPPER_CLOSED),     # lift
            (MOVE, 1.5, ("place", HOVER), GRIPPER_CLOSED),   # carry above zone
            (MOVE, 1.0, ("place", PLACE_Z), GRIPPER_CLOSED), # lower onto zone
            (HOLD, None, None, GRIPPER_OPEN),                # release
            (MOVE, 0.8, ("place", RETREAT_Z), GRIPPER_OPEN), # retreat upward
        ]
        self.frozen = False

    def _xy(self, ref):
        return self.can_xy if ref == "can" else self.place

    def _target(self, spec):
        ref, z = spec
        xy = self._xy(ref)
        return np.array([xy[0], xy[1], z])

    def act(self, obs):
        t = float(obs["time"])
        fw = float(obs["finger_width"])
        if not self.frozen:
            # track the live can position until the fingers begin to close
            self.can_xy = np.array(obs["can_pos"][:2], dtype=float)

        # advance segments
        while self.seg_idx < len(self.segments):
            kind, dur, _, _ = self.segments[self.seg_idx]
            el = t - self.seg_t0
            if kind == HOLD:
                # wait until the fingers have stopped moving (min time, then settle / max time)
                if (el >= 0.4 and abs(fw - self.last_fw) < 2e-4) or el >= 1.5:
                    self.last_fw = fw
                    self._advance(t)
                    continue
                self.last_fw = fw
                break
            if el >= dur:
                self._advance(t)
            else:
                break

        if self.seg_idx >= len(self.segments):
            self.done = True
            return list(self.q) + [GRIPPER_OPEN]

        kind, dur, spec, grip = self.segments[self.seg_idx]
        if spec is None:
            self.p = self.seg_start.copy()
        else:
            s = np.clip((t - self.seg_t0) / dur, 0.0, 1.0)
            s = s * s * (3 - 2 * s)  # smoothstep
            self.p = self.seg_start + s * (self._target(spec) - self.seg_start)
        if self.seg_idx >= 2:
            self.frozen = True
        self.q = ik(self.p, q_init=self.q, down_weight=0.5)
        return list(self.q) + [grip]

    def _advance(self, t):
        self.seg_t0 = t if self.segments[self.seg_idx][0] == HOLD else self.seg_t0 + self.segments[self.seg_idx][1]
        self.seg_start = self.p.copy()
        self.seg_idx += 1
