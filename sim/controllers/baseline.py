"""Baseline scripted pick-and-place controller.

A fixed time schedule of grasp point waypoints: go above the can, go down, close the gripper, lift,
carry over the place target, go down, open, back off upward. Each phase lasts a fixed number of
seconds from PARAMS; inside a phase the grasp point target moves along a straight line from the
previous waypoint (smoothstep easing), and `ik` turns it into joint targets every step.

All tunables are in PARAMS. Nothing reacts to what the can actually does: if the arm lags, the can
slips or a phase is too short for a far away target, the schedule carries on regardless.
"""

import numpy as np

from sim.control import GRIPPER_CLOSED, GRIPPER_OPEN, HOME_QPOS, hand_position, ik

PARAMS = {
    # Heights of the grasp point (between the fingertips) above the floor, meters.
    "approach_height": 0.20,  # hover height above the can and above the place target
    "grasp_height": 0.065,  # where the fingers close; the can center is at 0.05. Much lower and the
    # palm (0.035 above the grasp point) presses on the can top (0.10)
    "lift_height": 0.20,  # carry height
    "release_height": 0.075,  # where the gripper opens; the can slips ~2 cm down in the grip while
    # carried, so this puts its bottom at about floor level
    # Phase durations, seconds.
    "t_approach": 1.2,  # home -> above the can
    "t_descend": 0.8,  # above the can -> grasp height
    "close_time": 0.5,  # gripper closing, arm still
    "t_lift": 0.8,  # up to lift height
    "t_move": 1.4,  # carry to above the place target
    "t_lower": 1.0,  # down to release height
    "settle_time": 0.3,  # pause before opening
    "open_time": 0.4,  # gripper opening, arm still
    "t_retreat": 0.8,  # back up to approach height
    # Motion shaping.
    "smooth": True,  # smoothstep easing inside each phase (False = constant speed)
    "down_weight": 0.5,  # ik orientation weight that keeps the gripper pointing down (0 = position only)
}


def _ease(s, smooth):
    s = min(max(s, 0.0), 1.0)
    return s * s * (3.0 - 2.0 * s) if smooth else s


class Controller:
    params = PARAMS

    def reset(self, task):
        p = self.params
        cx, cy = task["can_start"]
        px, py = task["place_target"]
        start = hand_position(HOME_QPOS)
        above_can = np.array([cx, cy, p["approach_height"]])
        at_can = np.array([cx, cy, p["grasp_height"]])
        lifted = np.array([cx, cy, p["lift_height"]])
        above_place = np.array([px, py, p["lift_height"]])
        at_place = np.array([px, py, p["release_height"]])
        retreat = np.array([px, py, p["approach_height"]])
        O, C = GRIPPER_OPEN, GRIPPER_CLOSED
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
        self.start = start
        self.q = np.array(HOME_QPOS, dtype=float)
        self.done = False

    def act(self, obs):
        p = self.params
        t = obs["time"]
        prev = self.start
        t0 = 0.0
        target, grip = self.phases[-1][1], self.phases[-1][2]
        for duration, end, g in self.phases:
            if t < t0 + duration:
                s = _ease((t - t0) / duration, p["smooth"]) if duration > 0 else 1.0
                target, grip = prev + s * (end - prev), g
                break
            prev, t0 = end, t0 + duration
        else:
            self.done = True
        self.q = ik(target, q_init=self.q, down_weight=p["down_weight"])
        return list(self.q) + [grip]
