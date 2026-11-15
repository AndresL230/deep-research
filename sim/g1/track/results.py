"""Tracking episode results in words, and the result of an episode that never ran. Imports nothing heavy:
`sim.evaluate` reads `failure_result` in the parent process, which must not load numpy before its workers start."""

from __future__ import annotations

# What happened at one episode, for the screens. The one place the rule lives.
OUTCOMES = ("tracked", "fell", "off_track", "error")


def outcome(result: dict) -> str:
    """One episode's result dict (sim.g1.track.episode.run_episode) as one word, the first that applies:

    tracked    `success`: the robot followed the reference closely enough and never fell.
    error      the controller raised, returned a bad action or ran out of time.
    fell       `fell`: the robot fell, however well it had tracked until then.
    off_track  it stayed on its feet but too far from the reference.
    """
    if result.get("success"):
        return "tracked"
    if result.get("exception"):
        return "error"
    if result.get("fell"):
        return "fell"
    return "off_track"


ERRORS = ("e_vel", "e_mpkpe", "e_mpkpe_upper", "e_mpkpe_lower", "e_mpjpe", "e_mpjpe_upper", "e_mpjpe_lower")


def failure_result(kwargs: dict, exception: str, end_reason: str) -> dict:
    """A failed episode result with the same keys `run_episode` gives, for an episode that never finished."""
    motion = kwargs.get("motion")
    name = motion if isinstance(motion, str) else (motion or {}).get("name")
    return {
        "success": False,
        "fell": False,
        **{k: None for k in ERRORS},
        "tracked_s": 0.0,
        "fell_at": None,
        "time_taken": None,
        "exception": exception,
        "motion": name,
        "kind": None if isinstance(motion, str) else (motion or {}).get("kind"),
        "seed": kwargs["seed"],
        "end_reason": end_reason,
        "pelvis_min_z": None,
        "max_tilt_deg": None,
    }
