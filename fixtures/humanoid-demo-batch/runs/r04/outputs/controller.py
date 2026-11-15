"""A controller made on the practice bag alone: a right-hand punch at wherever the bag hangs.

What an engineer writes who only ever tries the practice position (a bag at chest height in front of the right
shoulder): both feet stay planted, the right fist is drawn back and driven through the bag. It never uses the left
hand and never kicks, so it reaches a bag on its left badly and a low bag not at all. Self-contained.
"""

import numpy as np

from sim.g1.control import STAND_QPOS, ComFeedback, WholeBody

PUNCH_BACK = 0.22
PUNCH_THROUGH = 0.14
START = 0.5
WINDUP = 0.6
PUNCH_TIME = 0.16
HOLD = 0.3
RETURN = 0.6


def smooth(a, b, s):
    s = float(np.clip(s, 0.0, 1.0))
    s = s * s * (3.0 - 2.0 * s)
    return np.asarray(a, dtype=float) + (np.asarray(b, dtype=float) - np.asarray(a, dtype=float)) * s


class Controller:
    def reset(self, task):
        self.done = False
        self.wb = WholeBody()
        self.fb = ComFeedback()
        self.q = STAND_QPOS.copy()
        p = self.wb.points(self.q)
        self.left, self.right, self.com0, self.hand0 = p["left_foot"], p["right_foot"], p["com"][:2], p["right_hand"]
        bag = np.array(task["bag_pos"], dtype=float)
        aim = bag - np.array([0.0, -0.14, bag[2]])
        aim /= np.linalg.norm(aim)
        self.back, self.through = bag - PUNCH_BACK * aim, bag + PUNCH_THROUGH * aim

    def act(self, obs):
        t = obs["time"]
        t1 = START + WINDUP
        t2 = t1 + PUNCH_TIME
        t3 = t2 + HOLD
        if t < START:
            hand = self.hand0
        elif t < t1:
            hand = smooth(self.hand0, self.back, (t - START) / WINDUP)
        elif t < t2:
            hand = smooth(self.back, self.through, (t - t1) / PUNCH_TIME)
        elif t < t3:
            hand = self.through
        else:
            hand = smooth(self.through, self.hand0, (t - t3) / RETURN)
            if t >= t3 + RETURN + 0.3:
                self.done = True
        self.q = self.wb.solve(self.q, {"left_foot": self.left, "right_foot": self.right, "right_hand": hand,
                                        "com": self.fb.update(self.com0, obs["com"][:2])})
        return list(self.q[7:])
