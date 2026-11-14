"""Baseline push recovery controller: the standing pose plus an ankle and hip balance strategy.

Every step it estimates where the center of mass is heading (its capture point: position plus velocity over the
pendulum frequency sqrt(g / height)), measures how far that is from where it should be, a point `com_target_x` in
front of the midpoint of the ankles, and turns the error into joint offsets on top of the standing pose: the ankles
pitch and roll to push the feet against the floor toward the error, and the hips can do the same. It can also bend the
knees into a crouch (`crouch`, eased in over `crouch_time`), which lowers the center of mass.

All tunables are in PARAMS. As given, it holds the center of mass right over the ankles, a natural first choice, which
works for the practice push (a shove from behind) but leaves little room behind the ankles: each foot reaches 0.12 m in
front of its ankle and only 0.05 m behind it.

Used by sim/humanoid/evaluate.py --calibrate; see sim/humanoid/CALIBRATION.md.
"""

import math

import numpy as np

from sim.humanoid.control import STAND_CTRL, index

PARAMS = {
    # Where to hold the center of mass, meters in front of the midpoint of the ankles (x) and to the left (y).
    "com_target_x": 0.0,
    "com_target_y": 0.0,
    # How much of the center of mass velocity counts, as a multiple of velocity / sqrt(g / height) (1: the capture point).
    "velocity_weight": 1.0,
    # Joint offset (radians) per meter of capture point error, front-back (pitch) and sideways (roll).
    "k_ankle_pitch": 4.0,
    "k_hip_pitch": 0.0,
    "k_ankle_roll": 0.0,
    "k_hip_roll": 0.0,
    # Bend the knees: hip pitch -crouch, knee +2 crouch, ankle pitch -crouch (radians), keeping the torso upright.
    "crouch": 0.0,
    "crouch_time": 0.8,  # seconds to ease into the crouch from the start
}

LEFT_RIGHT = ("left", "right")


class Controller:
    params = PARAMS

    def __init__(self, params=None):
        self.params = dict(self.params, **(params or {}))
        self.i = {
            f"{s}_{j}": index(f"{s}_{j}")
            for s in LEFT_RIGHT
            for j in ("hip_pitch", "hip_roll", "knee", "ankle_pitch", "ankle_roll")
        }

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
        for s in LEFT_RIGHT:
            u[self.i[f"{s}_hip_pitch"]] += -c + p["k_hip_pitch"] * err[0]
            u[self.i[f"{s}_knee"]] += 2.0 * c
            u[self.i[f"{s}_ankle_pitch"]] += -c + p["k_ankle_pitch"] * err[0]
            u[self.i[f"{s}_ankle_roll"]] += p["k_ankle_roll"] * err[1]
            u[self.i[f"{s}_hip_roll"]] += p["k_hip_roll"] * err[1]
        return u
