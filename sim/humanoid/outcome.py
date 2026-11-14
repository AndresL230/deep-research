"""The push recovery outcome rule, in one place, with no MuJoCo: what one episode's result means in one word.

    upright   still standing at the end, feet where they were and the torso never tilted far
    stumbled  still standing at the end, but a foot moved more than STUMBLE_FOOT_SHIFT_M or the torso tilted more than
              STUMBLE_TILT_DEG on the way
    fell      the pelvis went below FALL_HEIGHT_M, or a part of the robot other than the feet touched the floor
    error     the controller failed (it raised, returned a bad action, timed out) or the simulation blew up

`success` is "did not fall and no error": upright or stumbled. `sim.humanoid.episode` measures the facts, this module
names them, and `sim.humanoid.domain` and the screens read the word.
"""

from __future__ import annotations

FALL_HEIGHT_M = 0.45  # pelvis height (standing: 0.79 m); below it the robot is down
# A balance controller that keeps the robot up tilts the torso at most 5 degrees and lets the feet slide at most 4 cm
# under the hidden pushes; one that falls tilts it past 80. A stumble is a survivor that rocked hard: a foot slid or
# stepped 3 cm or more, or the torso went past 10 degrees (sim/humanoid/CALIBRATION.md).
STUMBLE_TILT_DEG = 10.0  # torso tilt from vertical, degrees, at any moment
STUMBLE_FOOT_SHIFT_M = 0.03  # horizontal distance a foot moved from where it stood when the push began

OUTCOMES = ("upright", "stumbled", "fell", "error")


def outcome(result: dict) -> str:
    """One episode's result dict (`sim.humanoid.episode.run_episode`) as one word of OUTCOMES, the first that applies:
    error (an exception), fell, stumbled, upright."""
    if result.get("exception"):
        return "error"
    if result.get("fell"):
        return "fell"
    if result.get("stumbled"):
        return "stumbled"
    return "upright"


def push_dict(push) -> dict:
    """A push as {"angle_deg", "force_n"}: from such a dict, or from a pair (angle_deg, force_n)."""
    if isinstance(push, dict):
        return {"angle_deg": float(push["angle_deg"]), "force_n": float(push["force_n"])}
    angle, force = push
    return {"angle_deg": float(angle), "force_n": float(force)}


def failure_result(kwargs: dict, exception: str, end_reason: str) -> dict:
    """A failed episode with the keys `run_episode` gives, for an episode that never finished (a timeout, a crash)."""
    push = push_dict(kwargs["push"])
    return {
        "success": False,
        "outcome": "error",
        "fell": False,
        "stumbled": False,
        "fall_time": None,
        "touched": None,
        "max_tilt_deg": None,
        "final_tilt_deg": None,
        "max_foot_shift_cm": None,
        "min_pelvis_height": None,
        "push": push,
        "push_time": None,
        "seed": kwargs.get("seed", 0),
        "time_taken": None,
        "exception": exception,
        "end_reason": end_reason,
    }
