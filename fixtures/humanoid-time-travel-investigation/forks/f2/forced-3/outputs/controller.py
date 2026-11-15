"""Strike a hanging bag with a straight punch (both feet planted).

The hand on the bag's side (left if bag y > 0, else right) is brought to a wind-up point in front of the bag,
then driven through the bag centre. The whole-body IK keeps both feet fixed and the centre of mass over them,
leaning slightly forward as the arm extends (more for bags further away).

Known limitation: this only works for bags roughly at chest height (z >= ~0.8 m) and x up to ~0.45 m.
Low bags (z < ~0.65 m) are NOT handled: the arm cannot reach them while standing, and the kick / squat
variants I tried made the robot fall, so they were removed.
"""
import numpy as np

from sim.g1.control import STAND_QPOS, WholeBody, ComFeedback

T_SETTLE = 0.5
T_WIND = 1.5     # time to bring hand to wind-up
T_PUNCH = 0.15   # duration of the punch
T_HOLD = 0.3
T_END = 3.5


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()
        self.fb = ComFeedback()
        p = self.wb.points(self.q)
        self.lf = p["left_foot"].copy()
        self.rf = p["right_foot"].copy()
        self.lf[2] = self.rf[2] = 0.0
        self.com_xy = p["com"][:2].copy()
        bag = np.array(task["bag_pos"], dtype=float)
        self.bag = bag
        self.wind = np.array([bag[0] - 0.17, bag[1], bag[2]])
        self.hit = np.array([bag[0] + 0.10, bag[1], bag[2]])
        self.shift = 0.015 + 0.025 * float(np.clip((bag[0] - 0.38) / 0.07, 0, 1))
        self.side = "left" if bag[1] > 0 else "right"
        self.hand0 = p[self.side + "_hand"].copy()

    def _hand_target(self, t):
        t0 = T_SETTLE
        t1 = t0 + T_WIND
        t2 = t1 + T_PUNCH
        t3 = t2 + T_HOLD
        if t < t0:
            return self.hand0
        if t < t1:
            s = (t - t0) / T_WIND
            s = s * s * (3 - 2 * s)
            return self.hand0 + s * (self.wind - self.hand0)
        if t < t2:
            s = (t - t1) / T_PUNCH
            return self.wind + s * (self.hit - self.wind)
        if t < t3:
            return self.hit
        s = min(1.0, (t - t3) / 0.8)
        s = s * s * (3 - 2 * s)
        return self.hit + s * (self.hand0 - self.hit)

    def act(self, obs):
        t = obs["time"]
        if t > T_END:
            self.done = True
        hand = self._hand_target(t)
        ext = np.clip((hand[0] - self.hand0[0]) / 0.5, 0, 1)
        want = self.com_xy + np.array([self.shift * ext, 0.0])
        com_t = self.fb.update(want, obs["com"][:2])
        targets = {"left_foot": self.lf, "right_foot": self.rf, "com": com_t, self.side + "_hand": hand}
        self.q = self.wb.solve(self.q, targets)
        return list(self.q[7:])
