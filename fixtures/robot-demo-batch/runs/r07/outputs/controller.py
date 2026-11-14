"""Pick and place controller.

A fixed schedule of grasp point waypoints: above the can, down to it, close, lift, carry over the
zone, down, open, back up. Inside each phase the target moves in a straight line with smoothstep
easing, and ik() turns it into joint targets every step.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

PARAMS = {
    "approach_height": 0.2,
    "grasp_height": 0.065,
    "lift_height": 0.13,
    "release_height": 0.075,
    "t_approach": 1.2,
    "t_descend": 0.8,
    "close_time": 0.5,
    "t_lift": 0.8,
    "t_move": 1.6,
    "t_lower": 1.0,
    "settle_time": 0.3,
    "open_time": 0.4,
    "t_retreat": 0.8,
    "down_weight": 1.0,
}


def _ease(s):
    s = min(max(s, 0.0), 1.0)
    return s * s * (3.0 - 2.0 * s)


class Controller:
    def reset(self, task):
        p = PARAMS
        cx, cy = task["can_start"]
        px, py = task["place_target"]
        O, C = GRIPPER_OPEN, GRIPPER_CLOSED
        above_can = np.array([cx, cy, p["approach_height"]])
        at_can = np.array([cx, cy, p["grasp_height"]])
        lifted = np.array([cx, cy, p["lift_height"]])
        above_place = np.array([px, py, p["lift_height"]])
        at_place = np.array([px, py, p["release_height"]])
        retreat = np.array([px, py, p["approach_height"]])
        # (duration, end waypoint, gripper command during the phase)
        self.phases = [
            (p["t_approach"], above_can, O),
            (p["t_descend"], at_can, O),
            (p["close_time"], at_can, C),
            (p["t_lift"], lifted, C),
            (p["t_move"], above_place, C),
            (p["t_lower"], at_place, C),
            (p["settle_time"], at_place, C),
            (p["open_time"], at_place, O),
            (p["t_retreat"], retreat, O),
        ]
        self.start = hand_position(HOME_QPOS)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.done = False

    def act(self, obs):
        t = obs["time"]
        prev, t0 = self.start, 0.0
        target, grip = self.phases[-1][1], self.phases[-1][2]
        for duration, end, g in self.phases:
            if t < t0 + duration:
                s = _ease((t - t0) / duration) if duration > 0 else 1.0
                target, grip = prev + s * (end - prev), g
                break
            prev, t0 = end, t0 + duration
        else:
            self.done = True
        self.q = ik(target, q_init=self.q, down_weight=PARAMS["down_weight"])
        return list(self.q) + [grip]
