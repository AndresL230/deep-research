"""A controller for scripts/make_libero_preview.py: it grasps whatever `task["target"]` is, at a height set by
the object's own height, carries it over the basket's rim and lets it go inside."""
import numpy as np
from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik


def ease(s):
    s = min(max(s, 0.0), 1.0)
    return s * s * (3.0 - 2.0 * s)


class Controller:
    def reset(self, task):
        cx, cy = task["can_start"]
        px, py = task["place_target"]
        target = task.get("target") or {"height": 0.10}
        h = float(target["height"])
        rim = float((task.get("basket") or {}).get("height") or 0.0)
        grasp = max(0.012, min(h - 0.025, h * 0.6))       # where the fingers close, above the floor
        carry = rim + h + 0.10                              # the object's bottom clears the rim
        release = rim + (h - grasp) + 0.03 if rim else grasp
        P = lambda x, y, z: np.array([x, y, z])
        O, C = GRIPPER_OPEN, GRIPPER_CLOSED
        self.phases = [
            (0.9, P(cx, cy, grasp + 0.15), O), (0.7, P(cx, cy, grasp), O), (0.5, P(cx, cy, grasp), C),
            (1.0, P(cx, cy, carry), C), (1.8, P(px, py, carry), C), (0.6, P(px, py, release), C),
            (0.3, P(px, py, release), C), (0.3, P(px, py, release), O), (0.5, P(px, py, carry), O),
        ]
        self.start = hand_position(HOME_QPOS)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.done = False

    def act(self, obs):
        t = obs["time"]
        prev, t0 = self.start, 0.0
        target, grip = self.phases[-1][1], self.phases[-1][2]
        for dur, end, g in self.phases:
            if t < t0 + dur:
                target, grip = prev + (end - prev) * ease((t - t0) / dur), g
                break
            prev, t0 = end, t0 + dur
        else:
            self.done = True
        self.q = np.asarray(ik(target, q_init=self.q, down_weight=0.5), dtype=float)
        return list(self.q) + [grip]
