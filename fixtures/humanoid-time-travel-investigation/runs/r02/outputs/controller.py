"""Straight punch with the hand on the bag's side, feet planted, COM held over the feet by feedback."""

import numpy as np

from sim.g1.control import STAND_QPOS, ComFeedback, WholeBody


def smooth(a):
    a = float(np.clip(a, 0.0, 1.0))
    return a * a * (3 - 2 * a)


class Controller:
    T_WIND = 1.2      # end of wind-up
    T_PUNCH = 0.30    # duration of punch
    T_HOLD = 0.1
    T_BACK = 0.8
    OVERSHOOT = 0.10  # how far past the bag centre the fist goes

    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()
        self.fb = ComFeedback()
        p = self.wb.points(self.q)
        self.feet = {"left_foot": p["left_foot"].copy(), "right_foot": p["right_foot"].copy()}
        self.com0 = p["com"][:2].copy()
        b = np.array(task["bag_pos"], dtype=float)
        self.bag = b
        self.side = "left_hand" if b[1] >= 0 else "right_hand"
        self.h0 = p[self.side].copy()
        self.wind = np.array([max(b[0] - 0.22, 0.12), b[1], b[2]])
        self.end = np.array([b[0] + self.OVERSHOOT, b[1], b[2]])
        self.t1 = self.T_WIND
        self.t2 = self.t1 + self.T_PUNCH
        self.t3 = self.t2 + self.T_HOLD
        self.t4 = self.t3 + self.T_BACK

    def hand_target(self, t):
        if t < self.t1:
            # go up/back to wind-up pose
            return self.h0 + (self.wind - self.h0) * smooth(t / self.t1)
        if t < self.t2:
            return self.wind + (self.end - self.wind) * smooth((t - self.t1) / self.T_PUNCH)
        if t < self.t3:
            return self.end
        if t < self.t4:
            return self.end + (self.h0 - self.end) * smooth((t - self.t3) / self.T_BACK)
        return self.h0

    def act(self, obs):
        t = obs["time"]
        h = self.hand_target(t)
        lean = np.clip((self.bag[0] - 0.33) * 1.0, 0.0, 0.07) * smooth(t / self.t1) * (1 - smooth((t - self.t3) / self.T_BACK))
        want = self.com0 + np.array([lean, 0.0])
        com_t = self.fb.update(want, obs["com"][:2])
        targets = dict(self.feet)
        targets["com"] = com_t
        targets[self.side] = h
        w = {self.side: 6.0}
        self.q = self.wb.solve(self.q, targets, weights=w, iters=4)
        if t > self.t4 + 1.0:
            self.done = True
        return list(self.q[7:])
