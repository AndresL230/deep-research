"""Strike a hanging bag: a right/left-hand punch for bags at chest height, a front kick for low bags.

Feet stay planted for the punch. For the kick the centre of mass is moved over the support foot first.
"""
import os

import numpy as np

from sim.g1.control import STAND_QPOS, WholeBody, ComFeedback

KICK_BELOW_Z = -1.0   # kick mode is EXPERIMENTAL and does not work reliably (falls); disabled, punch only

DEBUG = bool(os.environ.get("G1DBG"))

# punch timing
T_SETTLE = 0.5
T_WIND = 1.5
T_PUNCH = 0.15
T_HOLD = 0.3
T_END = 3.5

# kick timing
K_SHIFT = 1.2    # move COM over the support foot
K_LIFT = 0.8     # lift the kicking foot and bring toe behind the bag
K_KICK = 0.25    # swing
K_HOLD = 0.25
K_BACK = 0.8
K_LAND = 1.0


def smooth(s):
    s = min(1.0, max(0.0, s))
    return s * s * (3 - 2 * s)


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()
        self.fb = None
        p = self.wb.points(self.q)
        self.lf = p["left_foot"].copy()
        self.rf = p["right_foot"].copy()
        self.lf[2] = self.rf[2] = 0.0
        self.com_xy = p["com"][:2].copy()
        bag = np.array(task["bag_pos"], dtype=float)
        self.bag = bag
        self.kick = bag[2] < KICK_BELOW_Z
        self.side = "left" if bag[1] > 0 else "right"
        self.fb = ComFeedback(kp=6.0, ki=4.0, kd=0.3, limit=0.2) if self.kick else ComFeedback()
        if self.kick:
            self.toe0 = p[self.side + "_toe"].copy()
            self.k_wind = np.array([bag[0] - 0.22, bag[1], max(bag[2], 0.08)])
            self.k_hit = np.array([bag[0] + 0.08, bag[1], max(bag[2], 0.08)])
            self.k_wind[2] += 0.03
            self.T_END = K_SHIFT + K_LIFT + K_KICK + K_HOLD + K_BACK + K_LAND
        else:
            self.shift = 0.015 + 0.025 * float(np.clip((bag[0] - 0.38) / 0.07, 0, 1))
            self.wind = np.array([bag[0] - 0.17, bag[1], bag[2]])
            self.hit = np.array([bag[0] + 0.10, bag[1], bag[2]])
            self.hand0 = p[self.side + "_hand"].copy()
            self.T_END = T_END

    # ---------------- punch ----------------
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

    def _act_punch(self, obs):
        t = obs["time"]
        hand = self._hand_target(t)
        ext = np.clip((hand[0] - self.hand0[0]) / 0.5, 0, 1)
        want = self.com_xy + np.array([self.shift * ext, 0.0])
        com_t = self.fb.update(want, obs["com"][:2])
        targets = {"left_foot": self.lf, "right_foot": self.rf, "com": com_t, self.side + "_hand": hand}
        self.q = self.wb.solve(self.q, targets)

    # ---------------- kick ----------------
    def _act_kick(self, obs):
        t = obs["time"]
        side = self.side
        sup = "left" if side == "right" else "right"
        sup_foot = self.lf if sup == "left" else self.rf
        t1 = K_SHIFT
        t2 = t1 + K_LIFT
        t3 = t2 + K_KICK
        t4 = t3 + K_HOLD
        t5 = t4 + K_BACK
        s_shift = smooth(t / K_SHIFT)
        s_back = 1.0 - smooth((t - t4) / K_BACK)
        # COM over the support foot (a bit forward of its centre), returns at the end
        com_goal = sup_foot[:2] + np.array([0.0, 0.0])
        sw = s_shift if t < t4 else s_back
        want = self.com_xy + sw * (com_goal - self.com_xy)
        com_t = self.fb.update(want, obs["com"][:2])
        kf = self.rf if side == "right" else self.lf
        toe0 = self.toe0
        weights = {}
        if t < t1:
            toe = toe0.copy()
            lift = 0.0
        elif t < t2:
            s = smooth((t - t1) / K_LIFT)
            toe = toe0 + s * (self.k_wind - toe0)
            lift = s
        elif t < t3:
            s = (t - t2) / K_KICK
            toe = self.k_wind + s * (self.k_hit - self.k_wind)
            lift = 1.0
        elif t < t4:
            toe = self.k_hit
            lift = 1.0
        else:
            s = smooth((t - t4) / K_BACK)
            toe = self.k_hit + s * (toe0 - self.k_hit)
            lift = 1.0 - s
        targets = {sup + "_foot": sup_foot, "com": com_t}
        if t < t1 or t >= t5:
            targets[side + "_foot"] = kf
        else:
            targets[side + "_toe"] = toe
            weights[side + "_foot_level"] = 0.0
            if lift < 1e-6:
                targets[side + "_foot"] = kf
                del targets[side + "_toe"]
                weights = {}
        self.q = self.wb.solve(self.q, targets, weights)

    def act(self, obs):
        if DEBUG and int(round(obs["time"] * 50)) % 10 == 0:
            print(round(obs["time"], 2), "com", obs["com"][:2].round(3), "tilt", round(obs["tilt_deg"], 1),
                  "toe", obs["right_toe"].round(2), "lf", obs["left_foot"].round(3), "rf", obs["right_foot"].round(3),
                  "pz", round(obs["pelvis"][2], 2), "bag", round(obs["bag_moved"], 3))
        if obs["time"] > self.T_END:
            self.done = True
        if self.kick:
            self._act_kick(obs)
        else:
            self._act_punch(obs)
        return list(self.q[7:])
