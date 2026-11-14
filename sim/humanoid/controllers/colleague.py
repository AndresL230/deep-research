"""Balance controller for the G1. Works on the practice push.

It holds the standing pose and, every step, corrects it with the ankles and hips. It estimates where the center of
mass is heading (its position plus its velocity divided by sqrt(g / height)), compares that with where the center of
mass should be, and tilts the ankles to push the feet against the floor toward the error. All numbers are in PARAMS.

Run it with:
    python3 -m sim.humanoid.run --controller controller.py --out live/practice.motion.json
"""

import math

import numpy as np

from sim.humanoid.control import STAND_CTRL, index

PARAMS = {
    # Where to hold the center of mass, meters in front of the midpoint of the ankles (x) and to the left (y).
    "com_target_x": -0.03,
    "com_target_y": 0.0,
    # How much the center of mass velocity counts (1: position + velocity / sqrt(g / height)).
    "velocity_weight": 1.0,
    # Joint offset in radians per meter of error: ankles and hips, front-back (pitch) and sideways (roll).
    "k_ankle_pitch": 6.0,
    "k_hip_pitch": 0.0,
    "k_ankle_roll": 0.0,
    "k_hip_roll": 0.0,
    # Knee bend in radians (0: straight legs), eased in over crouch_time seconds.
    "crouch": 0.0,
    "crouch_time": 0.8,
}

SIDES = ("left", "right")


class Controller:
    def __init__(self, params=None):
        self.params = dict(PARAMS, **(params or {}))
        self.i = {f"{s}_{j}": index(f"{s}_{j}") for s in SIDES for j in ("hip_pitch", "hip_roll", "knee", "ankle_pitch", "ankle_roll")}

    def reset(self, task):
        self.task = task

    def act(self, obs):
        p = self.params
        com, vel = obs["com"], obs["com_vel"]
        mid = 0.5 * (obs["left_foot"] + obs["right_foot"])
        target = mid[:2] + np.array([p["com_target_x"], p["com_target_y"]])
        omega = math.sqrt(9.81 / max(0.3, float(com[2])))
        err = com[:2] + p["velocity_weight"] * vel[:2] / omega - target

        u = np.array(STAND_CTRL, dtype=float)
        c = p["crouch"] * min(1.0, obs["time"] / p["crouch_time"]) if p["crouch_time"] > 0 else p["crouch"]
        for s in SIDES:
            u[self.i[f"{s}_hip_pitch"]] += -c + p["k_hip_pitch"] * err[0]
            u[self.i[f"{s}_knee"]] += 2.0 * c
            u[self.i[f"{s}_ankle_pitch"]] += -c + p["k_ankle_pitch"] * err[0]
            u[self.i[f"{s}_ankle_roll"]] += p["k_ankle_roll"] * err[1]
            u[self.i[f"{s}_hip_roll"]] += p["k_hip_roll"] * err[1]
        return u
