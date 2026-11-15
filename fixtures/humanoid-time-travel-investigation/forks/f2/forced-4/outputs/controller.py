"""Strike a hanging bag: right/left-hand punch for high bags, one-legged kick for low bags."""
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
        self.fb = ComFeedback(kp=6.0, ki=4.0, kd=0.3, limit=0.15)
        p = self.wb.points(self.q)
        self.p0 = p
        self.lf = p["left_foot"].copy()
        self.rf = p["right_foot"].copy()
        self.lf[2] = self.rf[2] = 0.0
        self.com_xy = p["com"][:2].copy()
        bag = np.array(task["bag_pos"], dtype=float)
        r = task["bag_radius"]
        self.bag = bag
        # the hand (fist) end is 'hand' point; aim to push through the bag centre
        self.wind = np.array([bag[0] - 0.17, bag[1], bag[2]])
        self.hit = np.array([bag[0] + 0.08, bag[1], bag[2]])
        self.shift = 0.015 + 0.025 * float(np.clip((bag[0] - 0.38) / 0.07, 0, 1))
        self.t_kick = 0.3
        self.kick_below = 0.65
        self.pz = float(np.clip(0.79 - (0.75 - bag[2]) * 0.7, 0.55, 0.79)) if False else 0.79
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

    def _kick(self, obs):
        t = obs["time"]
        bag = self.bag
        kick = "right" if bag[1] <= 0 else "left"
        sup = "left" if kick == "right" else "right"
        sup_foot = self.lf if sup == "left" else self.rf
        k_foot = self.rf if kick == "right" else self.lf
        # timeline
        a0, a1 = 0.5, 1.8      # shift weight to the support foot
        b1 = a1 + 1.2          # lift & wind up
        c1 = b1 + self.t_kick  # strike
        d1 = c1 + 0.2          # hold
        e1 = d1 + 1.2          # retract foot
        f1 = e1 + 1.0          # weight back
        if t > f1 + 0.3:
            self.done = True
        sm = lambda x: (lambda y: y * y * (3 - 2 * y))(float(np.clip(x, 0, 1)))
        com_want = self.com_xy + sm((t - a0) / (a1 - a0)) * (sup_foot[:2] + np.array([0.0, 0.0]) - self.com_xy)
        com_want = com_want - sm((t - e1 - 0.3) / (f1 - e1 - 0.3)) * (com_want - self.com_xy)
        toe0 = self.p0["right_toe" if kick == "right" else "left_toe"].copy()
        if t > c1:
            # the support foot may have slipped: re-plan the landing relative to where it really is
            act_sup = obs[sup + "_foot"]
            sup_foot = np.array([act_sup[0], act_sup[1], 0.0])
            toe0 = toe0 + np.array([act_sup[0] - self.p0[sup + "_foot"][0], act_sup[1] - self.p0[sup + "_foot"][1], 0.0])
        wind = np.array([bag[0] - 0.28, bag[1], max(bag[2] - 0.2, 0.12)])
        hit = np.array([bag[0] + 0.08, bag[1], bag[2]])
        if t < a1:
            toe = toe0
        elif t < b1:
            toe = toe0 + sm((t - a1) / (b1 - a1)) * (wind - toe0)
        elif t < c1:
            toe = wind + (t - b1) / self.t_kick * (hit - wind)
        elif t < d1:
            toe = hit
        else:
            toe = hit + sm((t - d1) / (e1 - d1)) * (toe0 - hit)
        com_t = self.fb.update(com_want, obs["com"][:2])
        targets = {sup + "_foot": sup_foot, kick + "_toe": toe, "com": com_t}
        weights = {kick + "_foot_level": 1.0, "torso_level": 5.0}
        self.q = self.wb.solve(self.q, targets, weights)
        return list(self.q[7:])

    def act(self, obs):
        if self.bag[2] < self.kick_below:
            return self._kick(obs)
        t = obs["time"]
        if t > T_END:
            self.done = True
        hand = self._hand_target(t)
        # lean the centre of mass slightly forward as the arm extends
        ext = np.clip((hand[0] - self.hand0[0]) / 0.5, 0, 1)
        want = self.com_xy + np.array([self.shift * ext, 0.0])
        com_t = self.fb.update(want, obs["com"][:2])
        targets = {"left_foot": self.lf, "right_foot": self.rf, "com": com_t, self.side + "_hand": hand}
        if self.pz < 0.79:
            sq = min(1.0, max(0.0, (t - 0.3) / 2.5))
            sq = sq * sq * (3 - 2 * sq)
            targets["pelvis"] = np.array([0.0, 0.0, 0.79 + sq * (self.pz - 0.79)])
        self.q = self.wb.solve(self.q, targets)
        return list(self.q[7:])
