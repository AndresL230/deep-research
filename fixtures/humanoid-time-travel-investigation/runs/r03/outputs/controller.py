"""Right-hand strike on the hanging bag, with whole-body balance.

The right fist swings level with the bag's centre: cock it beside the body, swing it through the bag, follow
through, then pull it back to a safe spot. The poses are offsets from the bag's centre (from reset's task).
Balance: both feet are held where they stand and ComFeedback keeps the centre of mass over them.

Phases (time since start, seconds):
  0 .. T_COCK     raise the right hand from its rest pose to the cocked pose
  T_COCK .. T_HIT swing the fist forward through the bag
  T_HIT .. T_FOLLOW follow through
  T_FOLLOW .. T_RETRACT pull the arm back to a safe pose, then hold it
"""

import numpy as np

from sim.g1.control import WholeBody, ComFeedback, STAND_QPOS

# Right fist offsets from the bag's centre (x forward, y left, z up).
COCK_OFF = np.array([-0.48, -0.07, 0.02])
STRIKE_OFF = np.array([0.17, 0.0, 0.0])
FOLLOW_OFF = np.array([0.04, 0.03, 0.02])
RETRACT_OFF = np.array([-0.28, -0.07, -0.05])

T_COCK = 1.0   # reach the cocked pose
T_HIT = 1.3    # reach the strike point (fast swing from the cocked pose)
T_FOLLOW = 1.5
T_RETRACT = 2.2


def smooth(a, b, u):
    u = min(max(u, 0.0), 1.0)
    s = u * u * (3 - 2 * u)
    return a + (b - a) * s


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.bag = np.asarray(task["bag_pos"], dtype=float)
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()
        pts = self.wb.points(self.q)
        self.lfoot = pts["left_foot"].copy()
        self.rfoot = pts["right_foot"].copy()
        self.rest_hand = pts["right_hand"].copy()
        self.cock = self.bag + COCK_OFF
        self.strike = self.bag + STRIKE_OFF
        self.follow = self.bag + FOLLOW_OFF
        self.retract = self.bag + RETRACT_OFF
        self.fb = ComFeedback()
        self.t = 0.0

    def hand_target(self, t):
        if t < T_COCK:
            return smooth(self.rest_hand, self.cock, t / T_COCK)
        if t < T_HIT:
            return smooth(self.cock, self.strike, (t - T_COCK) / (T_HIT - T_COCK))
        if t < T_FOLLOW:
            return smooth(self.strike, self.follow, (t - T_HIT) / (T_FOLLOW - T_HIT))
        if t < T_RETRACT:
            return smooth(self.follow, self.retract, (t - T_FOLLOW) / (T_RETRACT - T_FOLLOW))
        return self.retract

    def act(self, obs):
        self.t = float(obs["time"])
        com_xy = self.fb.update([0.0, 0.0], obs["com"][:2])
        targets = {
            "left_foot": self.lfoot,
            "right_foot": self.rfoot,
            "com": com_xy,
            "right_hand": self.hand_target(self.t),
        }
        self.q = self.wb.solve(self.q, targets, iters=6)
        return list(self.q[7:])
