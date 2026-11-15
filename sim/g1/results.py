"""Episode results in words, and the result of an episode that never ran. Imports nothing heavy: `sim.evaluate`
reads `failure_result` in the parent process, which must not load numpy before its workers start."""

from __future__ import annotations

# What happened at one episode, for the screens. The one place the rule lives.
OUTCOMES = ("struck", "fell", "weak", "missed")


def outcome(result: dict) -> str:
    """One episode's result dict (sim.g1.episode.run_episode) as one word, the first that applies:

    struck   `success`: the bag swung at least 0.2 m and the robot never fell, no exception.
    fell     `fell`: the robot fell, whether or not it hit the bag first.
    weak     `touched` without `struck`: the robot reached the bag but it swung less than 0.2 m.
    missed   everything else: the robot never touched the bag, or the controller failed (an exception, a
             timeout) before anything else happened.
    """
    if result.get("success"):
        return "struck"
    if result.get("fell"):
        return "fell"
    if result.get("touched"):
        return "weak"
    return "missed"


def failure_result(kwargs: dict, exception: str, end_reason: str) -> dict:
    """A failed episode result with the same keys `run_episode` gives, for an episode that never finished."""
    return {
        "success": False,
        "struck": False,
        "touched": False,
        "struck_with": None,
        "fell": False,
        "bag_peak_cm": 0.0,
        "standing": False,
        "time_taken": None,
        "exception": exception,
        "bag_pos": [float(v) for v in kwargs["bag_pos"]],
        "seed": kwargs["seed"],
        "end_reason": end_reason,
        "fell_at": None,
        "pelvis_min_z": None,
        "max_tilt_deg": None,
        "bag_start_actual": None,
    }
