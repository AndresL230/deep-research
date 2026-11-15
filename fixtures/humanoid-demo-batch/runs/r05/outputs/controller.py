"""The baseline controller: punch a bag that hangs high, kick one that hangs low, with either side.

One schedule for every bag position, nothing tuned to one spot:

  1. sink a little at the knees, so the legs can move the hips in every direction;
  2. high bag (centre at or above KICK_BELOW): keep both feet planted and the centre of mass between them, draw
     the hand on the bag's side back, then drive it through the bag;
  3. low bag: move the centre of mass over the foot away from the bag, lift the other foot, draw it back and
     swing its toe through the bag, then put the foot down again;
  4. return to the stance and stop.

The centre of mass target goes through `ComFeedback`, so the real robot ends where the plan wants it.
"""

import numpy as np

from sim.g1.control import CONTROL_DT, STAND_QPOS, ComFeedback, WholeBody

KICK_BELOW = 0.0  # the kick is switched off: every bag is punched
SINK = 0.04  # m the pelvis is lowered for the stance
SINK_TIME = 0.8

# Punch.
PUNCH_BACK = 0.22  # m the fist is drawn back from the bag before the strike
PUNCH_THROUGH = 0.14  # m past the bag's centre the fist is driven
PUNCH_WINDUP = 0.6
PUNCH_TIME = 0.16
PUNCH_HOLD = 0.3
PUNCH_RETURN = 0.6

# Kick.
SHIFT_TIME = 2.2  # s to move the centre of mass over the standing foot
SHIFT_HOLD = 0.6
LIFT_TIME = 0.7
KICK_BACK = 0.20  # m the toe is drawn back from the bag before the swing
KICK_THROUGH = 0.20
KICK_TIME = 0.30
KICK_HOLD = 0.15
KICK_RETURN = 0.9
KICK_SETTLE = 0.6
LAND_SPEED = 0.10  # m/s the foot is lowered at until it touches
SHIFT_BACK = 1.2  # s to bring the centre of mass back between the feet
UNLOAD = 0.02  # m the swinging foot is eased off the floor as the weight leaves it
UNLOAD_FROM = 0.3  # the part of the weight shift after which that starts
STAND_IN = 0.035  # m forward of the sole's middle the centre of mass is held over, on one foot


def smooth(a, b, s):
    s = float(np.clip(s, 0.0, 1.0))
    s = s * s * (3.0 - 2.0 * s)
    return np.asarray(a, dtype=float) + (np.asarray(b, dtype=float) - np.asarray(a, dtype=float)) * s


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.fb = ComFeedback()
        self.q = STAND_QPOS.copy()
        p = self.wb.points(self.q)
        self.left, self.right = p["left_foot"].copy(), p["right_foot"].copy()
        self.com0 = p["com"][:2].copy()
        self.pelvis0 = p["pelvis"].copy()
        self.hand0 = {"left": p["left_hand"].copy(), "right": p["right_hand"].copy()}
        self.toe_from_foot = p["right_toe"] - p["right_foot"]
        bag = np.array(task["bag_pos"], dtype=float)
        self.bag = bag
        self.side = "right" if bag[1] <= 0.0 else "left"
        self.kick = bag[2] < KICK_BELOW
        self.land_z = 0.08
        self.landed_at = None

    def _pelvis(self, t):
        return self.pelvis0 - np.array([0.0, 0.0, SINK]) * float(np.clip(t / SINK_TIME, 0.0, 1.0))

    def act(self, obs):
        t = obs["time"]
        q = self._kick(t, obs) if self.kick else self._punch(t, obs)
        self.q = q
        return list(q[7:])

    def _punch(self, t, obs):
        side = self.side
        bag = np.asarray(obs["bag_pos"], dtype=float) if t < SINK_TIME else self._bag_seen
        self._bag_seen = bag
        hand0 = self.hand0[side]
        shoulder = np.array([0.0, -0.14 if side == "right" else 0.14, bag[2]])
        aim = bag - shoulder
        aim[2] = 0.0
        aim /= np.linalg.norm(aim)
        back, through = bag - PUNCH_BACK * aim, bag + PUNCH_THROUGH * aim
        t1 = SINK_TIME
        t2 = t1 + PUNCH_WINDUP
        t3 = t2 + PUNCH_TIME
        t4 = t3 + PUNCH_HOLD
        t5 = t4 + PUNCH_RETURN
        if t < t1:
            hand = hand0
        elif t < t2:
            hand = smooth(hand0, back, (t - t1) / PUNCH_WINDUP)
        elif t < t3:
            hand = smooth(back, through, (t - t2) / PUNCH_TIME)
        elif t < t4:
            hand = through
        else:
            hand = smooth(through, hand0, (t - t4) / PUNCH_RETURN)
        if t >= t5 + 0.3:
            self.done = True
        com = self.fb.update(self.com0, obs["com"][:2])
        targets = {"left_foot": self.left, "right_foot": self.right, "com": com, "pelvis": self._pelvis(t),
                   f"{side}_hand": hand}
        return self.wb.solve(self.q, targets, weights={"pelvis": 1.0})

    def _kick(self, t, obs):
        swing = self.side
        stand = "left" if swing == "right" else "right"
        stand_foot = self.left if stand == "left" else self.right
        swing_foot = self.right if swing == "right" else self.left
        bag = np.asarray(obs["bag_pos"], dtype=float) if t < SINK_TIME else self._bag_seen
        self._bag_seen = bag
        over = stand_foot[:2] + np.array([STAND_IN, 0.0])
        hip = np.array([0.0, swing_foot[1], bag[2]])
        aim = bag - hip
        aim[2] = 0.0
        aim /= np.linalg.norm(aim)
        # Toe targets, turned into targets for the middle of the sole.
        back = bag - KICK_BACK * aim - self.toe_from_foot
        through = bag + KICK_THROUGH * aim - self.toe_from_foot
        back[2] = max(back[2], 0.10)
        through[2] = max(through[2], 0.10)
        up = swing_foot + np.array([0.0, 0.0, 0.08])
        unload = swing_foot + np.array([0.0, 0.0, UNLOAD])
        t1 = SINK_TIME
        t2 = t1 + SHIFT_TIME
        t3 = t2 + SHIFT_HOLD
        t4 = t3 + LIFT_TIME
        t5 = t4 + KICK_TIME
        t6 = t5 + KICK_HOLD
        t7 = t6 + KICK_RETURN
        level = 10.0
        if t < t1:
            com, foot = self.com0, swing_foot
        elif t < t2:
            # The foot that will swing is eased off the floor while the weight moves away from it: a leg that
            # carries nothing is longer than the loaded one, and left planted it pushes the robot over.
            s = (t - t1) / SHIFT_TIME
            com, foot = smooth(self.com0, over, s), smooth(swing_foot, unload, (s - UNLOAD_FROM) / (1.0 - UNLOAD_FROM))
        elif t < t3:
            com, foot = over, unload
        elif t < t4:
            com, foot, level = over, smooth(unload, back, (t - t3) / LIFT_TIME), 1.0
        elif t < t5:
            com, foot, level = over, smooth(back, through, (t - t4) / KICK_TIME), 0.3
        elif t < t6:
            com, foot, level = over, through, 0.3
        elif t < t7:
            com, foot, level = over, smooth(through, up, (t - t6) / KICK_RETURN), 1.0
        else:
            # Put the foot down by feel: the real leg hangs lower than the planned one (the hip gives under its
            # weight), so lower the planned foot until the real one touches, and only then bring the weight back.
            if self.landed_at is None:
                com = over
                self.land_z = max(self.land_z - LAND_SPEED * CONTROL_DT, -0.03)
                if obs[f"{swing}_foot_down"] or obs[f"{swing}_foot"][2] < 0.003 or self.land_z <= -0.03:
                    self.landed_at = t
            else:
                s = (t - self.landed_at) / SHIFT_BACK
                com = smooth(over, self.com0, s)
                if s >= 1.0:
                    self.land_z = self.land_z + (0.0 - self.land_z) * 0.05
                if s >= 1.0 + KICK_SETTLE / SHIFT_BACK:
                    self.done = True
            foot = swing_foot + np.array([0.0, 0.0, self.land_z])
        targets = {f"{stand}_foot": stand_foot, f"{swing}_foot": foot, "com": self.fb.update(com, obs["com"][:2]),
                   "pelvis": self._pelvis(t)}
        return self.wb.solve(self.q, targets, weights={"pelvis": 1.0, f"{swing}_foot": 6.0, f"{swing}_foot_level": level})
