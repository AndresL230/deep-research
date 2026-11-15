"""Hand strike controller for the G1 bag scene.

The arm on the bag's side (right for y < 0, left for y >= 0) swings through the bag. Waypoints are placed relative
to the bag's centre: wind up behind and beside it, swing fast through it, follow through, retract to the standing
pose. The feet stay planted and the centre of mass is held over them with ComFeedback.
"""

import numpy as np

from sim.g1.control import STAND_QPOS, WholeBody, ComFeedback

T_WIND = 1.0  # time the wind-up is reached
T_STRIKE = 1.25  # time the strike ends (fist past the bag)
T_BACK = 2.8  # time back at rest
T_DONE = 4.5

FOOT_L = np.array([0.035, 0.119, 0.0])
FOOT_R = np.array([0.035, -0.119, 0.0])


def _smooth(a):
    a = float(np.clip(a, 0.0, 1.0))
    return a * a * (3 - 2 * a)


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()
        self.fb = ComFeedback()
        self.com0 = None
        self.bag = np.array(task["bag_pos"], dtype=float)
        # Work in a mirrored frame where the striking arm is the right arm: flip y for a left-side bag.
        self.sign = 1.0 if self.bag[1] < 0 else -1.0
        self.hand_key = "right_hand" if self.sign > 0 else "left_hand"
        self.rest = np.array([-0.008, -0.242, 0.623])
        bag = self._mirror(self.bag)
        self.wind = bag + np.array([-0.43, -0.07, 0.0])
        # Follow-through point, kept inside the arm's reach (about x = 0.50 at bag height).
        self.strike_end = bag + np.array([0.12, 0.0, 0.0])
        self.strike_end[0] = min(self.strike_end[0], 0.50)
        # Bags further out need the torso to lean forward to reach them: shift the balance target back to match.
        self.lean = float(np.clip((self.bag[0] - 0.3) / 0.15, 0.0, 1.0))
        self.com_shift = np.array([-0.04 * self.lean, 0.0])

    def _mirror(self, p):
        p = np.array(p, dtype=float)
        p[1] *= self.sign
        return p

    def _unmirror(self, p):
        p = np.array(p, dtype=float)
        p[1] *= self.sign
        return p

    def _hand(self, t):
        if t < T_WIND:
            a = _smooth(t / T_WIND)
            return self.rest + a * (self.wind - self.rest)
        if t < T_STRIKE:
            a = (t - T_WIND) / (T_STRIKE - T_WIND)
            return self.wind + a * (self.strike_end - self.wind)
        if t < T_BACK:
            a = _smooth((t - T_STRIKE) / (T_BACK - T_STRIKE))
            return self.strike_end + a * (self.rest - self.strike_end)
        return self.rest

    def act(self, obs):
        t = obs["time"]
        if t >= T_DONE:
            self.done = True
        if self.com0 is None:
            self.com0 = np.array(obs["com"][:2])
        com_target = self.fb.update(self.com0 + self.com_shift, obs["com"][:2])
        # The feet are symmetric and stay put; the striking hand's waypoints are mapped back to the world frame.
        hand = self._unmirror(self._hand(t))
        targets = {
            "left_foot": FOOT_L,
            "right_foot": FOOT_R,
            "com": com_target,
            self.hand_key: hand,
        }
        self.q = self.wb.solve(self.q, targets)
        return list(self.q[7:])
