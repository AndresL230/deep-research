"""Pick-and-place controller.

Approach from above, grasp the can near mid-height, lift, carry, lower onto the zone, release, retreat.

Each phase moves the grasp point along a smooth (cosine) path from where the previous phase left off to
its end point, then holds. Arm joints come from IK warm-started on the previous solution. During carry and
lowering the end point is corrected with the measured can position, so the can (not the hand) is what
gets placed on the target.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, JOINT_LOWER, JOINT_UPPER, _set_arm, ik

HOVER_Z = 0.22   # grasp-point height while travelling
GRASP_Z = 0.066  # grasp point height for grasping (fingertips must stay above the table)
PLACE_Z = 0.054  # grasp point height for placing (can center ends on the floor)

# (name, duration in s, gripper command)
PHASES = [
    ("approach", 1.8, GRIPPER_OPEN),
    ("descend", 1.0, GRIPPER_OPEN),
    ("close", 0.7, GRIPPER_CLOSED),
    ("lift", 1.3, GRIPPER_CLOSED),
    ("carry", 2.0, GRIPPER_CLOSED),
    ("lower", 1.0, GRIPPER_CLOSED),
    ("release", 0.5, GRIPPER_OPEN),
    ("retreat", 0.8, GRIPPER_OPEN),
]
NAMES = [p[0] for p in PHASES]


YAW_DESIRED = 90.0  # deg: fingers close along world x, as at HOME_QPOS


def _hand_yaw(q):
    """World yaw (deg) of the hand's x axis, for arm angles q (hand pointing down)."""
    model, data = _set_arm(q)
    r = data.xmat[model.body("hand").id].reshape(3, 3)
    return float(np.degrees(np.arctan2(r[1, 0], r[0, 0])))


def _fix_yaw(q):
    """Rotate the wrist (joint 7) so the hand yaw matches YAW_DESIRED.

    Joint 7 turns the hand about its own axis, which passes through the grasp point, so this changes
    the gripper heading without moving the grasp point. Yaw drops about 1 deg per 1 deg of joint 7.
    """
    q = np.array(q, dtype=float)
    for _ in range(2):
        err = (_hand_yaw(q) - YAW_DESIRED + 180.0) % 360.0 - 180.0
        if abs(err) < 0.05:
            break
        q[6] = np.clip(q[6] + np.radians(err), JOINT_LOWER[6], JOINT_UPPER[6])
    return q


def _smooth(a, b, s):
    s = min(max(s, 0.0), 1.0)
    w = 0.5 - 0.5 * np.cos(np.pi * s)
    return a + (b - a) * w


class Controller:
    def reset(self, task):
        self.task = task
        self.can0 = np.array(task["can_start"], dtype=float)
        self.place = np.array(task["place_target"], dtype=float)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.cmd = None  # last commanded grasp-point target (xyz)
        self.latched_offset = np.zeros(2)  # can_xy - hand_xy frozen at release
        self.phase = -1
        self.phase_t0 = 0.0
        self.start = None
        self.done = False

    def _offset(self, obs, hand):
        return np.array(obs["can_pos"], dtype=float)[:2] - hand[:2]

    def _end_point(self, name, obs, hand):
        cx, cy = np.array(obs["can_pos"], dtype=float)[:2]  # live can position (still on the table before lift)
        if name in ("carry", "lower"):
            # Aim the grasp point so that the can center lands on the place target.
            off = self._offset(obs, hand)
            px, py = self.place - off
        elif name in ("release", "retreat"):
            px, py = self.place - self.latched_offset
        else:
            px, py = cx, cy
        z = {
            "approach": HOVER_Z,
            "descend": GRASP_Z,
            "close": GRASP_Z,
            "lift": HOVER_Z,
            "carry": HOVER_Z,
            "lower": PLACE_Z,
            "release": PLACE_Z,
            "retreat": HOVER_Z,
        }[name]
        return np.array([px, py, z])

    def _enter(self, idx, obs, hand):
        self.phase = idx
        name = NAMES[idx]
        if name == "release":
            self.latched_offset = self._offset(obs, hand)
        self.start = self.cmd.copy()

    def act(self, obs):
        t = float(obs["time"])
        hand = np.array(obs["hand_pos"], dtype=float)
        if self.cmd is None:
            self.cmd = hand.copy()

        # Advance to the phase containing time t (boundaries are cumulative durations).
        if self.phase < 0:
            self.phase_t0 = t
            self._enter(0, obs, hand)
        while self.phase < len(PHASES) - 1 and t - self.phase_t0 >= PHASES[self.phase][1]:
            self.phase_t0 += PHASES[self.phase][1]
            self._enter(self.phase + 1, obs, hand)

        name, dur, grip = PHASES[self.phase]
        if self.phase == len(PHASES) - 1 and t - self.phase_t0 >= dur:
            self.done = True
        frac = (t - self.phase_t0) / dur

        end = self._end_point(name, obs, hand)
        target = _smooth(self.start, end, frac)
        self.cmd = target

        self.q = ik(target, q_init=self.q, down_weight=0.5)
        self.q = _fix_yaw(self.q)
        return list(self.q) + [grip]
