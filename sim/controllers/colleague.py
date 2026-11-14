"""Pick and place controller. Works on the practice setup.

The grasp point follows a fixed schedule of waypoints: above the can, down to the can, close the gripper,
lift, carry to above the zone, lower, open the gripper, back up. Each phase lasts the time set in PARAMS.
Inside a phase the target slides from the previous waypoint to the next one with smooth easing, and `ik`
turns it into joint targets on every step.

Run it with:
    python3 -m sim.run --controller controller.py --out live/practice.motion.json
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

PARAMS = {
    # Heights of the grasp point above the floor, meters. The can is 0.10 tall, its center at 0.05.
    "approach_height": 0.20,  # hover height above the can and above the zone
    "grasp_height": 0.065,  # where the fingers close on the can
    "lift_height": 0.20,  # carry height
    "release_height": 0.075,  # where the gripper opens over the zone
    # Phase durations, seconds.
    "t_approach": 0.5,  # start pose -> above the can
    "t_descend": 0.3,  # down to grasp height
    "t_close": 0.25,  # gripper closing, arm still
    "t_lift": 0.3,  # up to carry height
    "t_carry": 0.4,  # over to above the zone
    "t_lower": 0.35,  # down to release height
    "t_settle": 0.1,  # pause before opening
    "t_open": 0.15,  # gripper opening, arm still
    "t_retreat": 0.3,  # back up
    # Motion shaping.
    "smooth": True,  # ease in and out of each phase (False: constant speed)
    "down_weight": 0.5,  # how hard ik keeps the gripper pointing down (0: not at all)
}


def ease(s, smooth=True):
    """Progress through a phase, 0 to 1, with smoothstep easing."""
    s = min(max(s, 0.0), 1.0)
    return s * s * (3.0 - 2.0 * s) if smooth else s


class Controller:
    def __init__(self, params=None):
        self.params = dict(PARAMS, **(params or {}))

    def reset(self, task):
        p = self.params
        cx, cy = task["can_start"]
        px, py = task["place_target"]
        above_can = np.array([cx, cy, p["approach_height"]])
        at_can = np.array([cx, cy, p["grasp_height"]])
        lifted = np.array([cx, cy, p["lift_height"]])
        above_zone = np.array([px, py, p["lift_height"]])
        at_zone = np.array([px, py, p["release_height"]])
        backed_off = np.array([px, py, p["approach_height"]])
        OPEN, CLOSED = GRIPPER_OPEN, GRIPPER_CLOSED
        # (duration, waypoint at the end of the phase, gripper command during the phase)
        self.phases = [
            (p["t_approach"], above_can, OPEN),
            (p["t_descend"], at_can, OPEN),
            (p["t_close"], at_can, CLOSED),
            (p["t_lift"], lifted, CLOSED),
            (p["t_carry"], above_zone, CLOSED),
            (p["t_lower"], at_zone, CLOSED),
            (p["t_settle"], at_zone, CLOSED),
            (p["t_open"], at_zone, OPEN),
            (p["t_retreat"], backed_off, OPEN),
        ]
        self.start = hand_position(HOME_QPOS)
        self.q = np.array(HOME_QPOS, dtype=float)
        self.done = False

    def act(self, obs):
        p = self.params
        t = obs["time"]
        prev, t0 = self.start, 0.0
        target, grip = self.phases[-1][1], self.phases[-1][2]
        for duration, end, g in self.phases:
            if t < t0 + duration:
                s = ease((t - t0) / duration, p["smooth"]) if duration > 0 else 1.0
                target, grip = prev + s * (end - prev), g
                break
            prev, t0 = end, t0 + duration
        else:
            self.done = True
        self.q = ik(target, q_init=self.q, down_weight=p["down_weight"])
        return list(self.q) + [grip]
