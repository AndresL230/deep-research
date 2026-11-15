"""Strike a hanging bag while balancing: a right/left-hand punch for bags at chest height, a one-legged kick for
low bags (the arm cannot reach below about z = 0.75)."""
import numpy as np

from sim.g1.control import STAND_QPOS, WholeBody, ComFeedback

KICK_BELOW_Z = 0.0   # kick mode disabled: the one-legged kick I wrote is not stable (it falls)

# punch timing
T_SETTLE = 0.5
T_WIND = 1.5
T_PUNCH = 0.15
T_HOLD = 0.3
T_END = 3.5

# kick timing
K_SHIFT = 1.4    # shift weight onto the stance foot
K_LIFT = 1.2     # lift and chamber the kicking foot
K_SWING = 0.2
K_HOLD = 0.2
K_BACK = 0.8
K_PLANT = 0.8


def smooth(s):
    s = float(np.clip(s, 0, 1))
    return s * s * (3 - 2 * s)


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
        self.kick = bag[2] < KICK_BELOW_Z
        if self.kick:
            self.side = "right" if bag[1] <= 0 else "left"   # kicking leg
            self.stance = "left" if self.side == "right" else "right"
            self.kick_foot0 = p[self.side + "_toe"].copy()
            self.kick_foot_flat = (self.rf if self.side == "right" else self.lf).copy()
            stance_foot = self.lf if self.stance == "left" else self.rf
            self.com_stance = stance_foot[:2] + np.array([-0.01, 0.0])
            toe0 = p[self.side + "_toe"].copy()
            # toe (front tip of the foot) goes through the bag centre
            self.chamber = np.array([bag[0] - 0.22, bag[1], min(bag[2] * 0.8 + 0.05, 0.4)])
            self.chamber[1] = 0.3 * toe0[1]
            self.hit = np.array([bag[0] + 0.06, bag[1], bag[2]])
            self.toe0 = toe0
        else:
            self.shift = 0.015 + 0.025 * float(np.clip((bag[0] - 0.38) / 0.07, 0, 1))
            self.side = "left" if bag[1] > 0 else "right"
            self.hand0 = p[self.side + "_hand"].copy()
            self.wind = np.array([bag[0] - 0.17, bag[1], bag[2]])
            self.hit = np.array([bag[0] + 0.10, bag[1], bag[2]])

    # ------------------------------------------------------------------ punch
    def _hand_target(self, t):
        t0 = T_SETTLE
        t1 = t0 + T_WIND
        t2 = t1 + T_PUNCH
        t3 = t2 + T_HOLD
        if t < t0:
            return self.hand0
        if t < t1:
            return self.hand0 + smooth((t - t0) / T_WIND) * (self.wind - self.hand0)
        if t < t2:
            s = (t - t1) / T_PUNCH
            return self.wind + s * (self.hit - self.wind)
        if t < t3:
            return self.hit
        return self.hit + smooth((t - t3) / 0.8) * (self.hand0 - self.hit)

    def _punch(self, obs):
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

    # ------------------------------------------------------------------- kick
    def _kick(self, obs):
        t = obs["time"] - T_SETTLE
        t1 = K_SHIFT
        t2 = t1 + K_LIFT
        t3 = t2 + K_SWING
        t4 = t3 + K_HOLD
        t5 = t4 + K_BACK
        t6 = t5 + K_PLANT
        if t > t6 + 0.3:
            self.done = True
        # centre of mass: over the stance foot while the kicking foot is up, back to the middle afterwards
        if t < t1:
            c = self.com_xy + smooth(t / K_SHIFT) * (self.com_stance - self.com_xy)
        elif t < t4:
            c = self.com_stance
        elif t < t5:
            c = self.com_stance
        else:
            c = self.com_stance + smooth((t - t5) / K_PLANT) * (self.com_xy - self.com_stance)
        com_t = self.fb.update(c, obs["com"][:2])
        stance_pt = self.lf if self.stance == "left" else self.rf
        kick_flat = self.kick_foot_flat
        weights = {}
        targets = {self.stance + "_foot": stance_pt, "com": com_t}
        if t < t1 - 0.2:
            targets[self.side + "_foot"] = kick_flat
        else:
            # toe target path: floor -> chamber -> hit -> chamber -> floor
            if t < t2:
                s = smooth((t - (t1 - 0.2)) / (K_LIFT + 0.2))
                tgt = self.toe0 + s * (self.chamber - self.toe0)
            elif t < t3:
                s = (t - t2) / K_SWING
                tgt = self.chamber + s * (self.hit - self.chamber)
            elif t < t4:
                tgt = self.hit
            elif t < t5:
                tgt = self.hit + smooth((t - t4) / K_BACK) * (self.chamber - self.hit)
            else:
                s = smooth((t - t5) / K_PLANT)
                tgt = self.chamber + s * (self.toe0 - self.chamber)
            targets[self.side + "_toe"] = tgt
            weights = {self.side + "_foot_level": 2.0, self.side + "_toe": 6.0, "com": 80.0}
        self.q = self.wb.solve(self.q, targets, weights)
        return list(self.q[7:])

    def act(self, obs):
        return self._kick(obs) if self.kick else self._punch(obs)
