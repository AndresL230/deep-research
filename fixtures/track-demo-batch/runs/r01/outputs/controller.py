"""The reference tracker: the reference's joint angles, a little ahead of time, with balance feedback.

Two things on top of plain playback (`playback.py`):

1. It asks for the pose LEAD seconds ahead, because a position servo trails its target.
2. It watches the centre of mass. The reference says where the centre of mass should be at each moment; the robot's
   is somewhere else, because the servos give under load and a moving body carries on. `ComFeedback` turns that
   error into a corrected target, and `WholeBody.solve` moves the legs to put the centre of mass there while every
   joint stays as close to the reference as that allows. The feet are held where they stand.

The numbers here are fixed: this file is what the hidden motions were chosen with.
"""

import numpy as np

from sim.g1.control import ComFeedback, WholeBody

LEAD = 0.04          # s
POSTURE = 3.0        # how hard every joint is held to the reference against the balance correction


class Controller:
    def reset(self, task):
        ref = task["reference"]
        self.fps = float(ref["fps"])
        self.poses = np.asarray(ref["qpos"], dtype=float)
        self.wb = WholeBody()
        self.fb = ComFeedback(kp=1.0, ki=1.0, kd=0.3)
        ready = self.wb.points(self.poses[0])
        self.feet = {"left_foot": ready["left_foot"], "right_foot": ready["right_foot"]}

    def _pose(self, t):
        f = min(max(t, 0.0) * self.fps, len(self.poses) - 1.0)
        i = int(f)
        j = min(i + 1, len(self.poses) - 1)
        q = self.poses[i] * (1.0 - (f - i)) + self.poses[j] * (f - i)
        q[3:7] /= np.linalg.norm(q[3:7])
        return q

    def act(self, obs):
        t = obs["time"]
        ahead = self._pose(t + LEAD)
        wanted_com = self.wb.points(self._pose(t))["com"][:2]
        com = self.fb.update(wanted_com, obs["com"][:2])
        q = self.wb.solve(ahead, {"com": com, **self.feet}, weights={"posture": POSTURE, "torso_level": 0.0},
                          posture=ahead[7:], iters=2)
        return q[7:]
