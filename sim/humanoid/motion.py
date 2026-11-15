"""Motion files of the push recovery sim: `g1-push-motion/1`, documented in `sim/MOTION_FORMAT.md` next to `panda-motion/1`.

    {"format": "g1-push-motion/1",
     "header": {"model_id", "joint_names", "actuator_names", "push", "fps", "nq"},
     "frames": [{"t", "qpos", "ctrl", "com", "feet"}, ...],
     "result": {...}}

Writing, reading, rounding and the size limit are `sim.motion`'s; only the format name and the keys differ.
"""

from __future__ import annotations

import math

from sim.motion import DECIMALS, LOW_DECIMALS, LOW_FPS, MAX_BYTES, MOTION_FPS, _is_num_list, dumps, read_motion, round_list, write_motion

FORMAT = "g1-push-motion/1"

HEADER_KEYS = ("model_id", "joint_names", "actuator_names", "push", "fps", "nq")
FRAME_KEYS = ("t", "qpos", "ctrl", "com", "feet")
PUSH_KEYS = ("angle_deg", "force_n", "time_s", "duration_s")

__all__ = [
    "DECIMALS", "FORMAT", "LOW_DECIMALS", "LOW_FPS", "MAX_BYTES", "MOTION_FPS",
    "dumps", "read_motion", "round_list", "validate_motion", "write_motion",
]


def validate_motion(motion) -> list[str]:
    """Return a list of problems with `motion` (empty if it matches `g1-push-motion/1`)."""
    problems: list[str] = []
    if not isinstance(motion, dict):
        return ["motion is not a dict"]
    if motion.get("format") != FORMAT:
        problems.append(f"format should be {FORMAT!r}, got {motion.get('format')!r}")
    for key in ("header", "frames", "result"):
        if key not in motion:
            problems.append(f"missing top-level key {key!r}")
    header = motion.get("header")
    nq = nu = None
    if not isinstance(header, dict):
        problems.append("header is not a dict")
    else:
        for key in HEADER_KEYS:
            if key not in header:
                problems.append(f"header missing {key!r}")
        nq = header.get("nq")
        if not isinstance(nq, int) or nq <= 0:
            problems.append(f"header.nq should be a positive int, got {nq!r}")
            nq = None
        names = header.get("joint_names")
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            problems.append("header.joint_names should be a list of strings")
        acts = header.get("actuator_names")
        if not isinstance(acts, list) or not all(isinstance(n, str) for n in acts):
            problems.append("header.actuator_names should be a list of strings")
        else:
            nu = len(acts)
        fps = header.get("fps")
        if not isinstance(fps, int) or isinstance(fps, bool) or not 1 <= fps <= MOTION_FPS:
            problems.append(f"header.fps should be a whole number from 1 to {MOTION_FPS}, got {fps!r}")
        push = header.get("push")
        if "push" in header and (not isinstance(push, dict) or not all(_is_num_list([push.get(k)]) for k in PUSH_KEYS)):
            problems.append(f"header.push should have the numbers {list(PUSH_KEYS)}")
    frames = motion.get("frames")
    if not isinstance(frames, list):
        problems.append("frames is not a list")
    elif not frames:
        problems.append("frames is empty")
    else:
        lengths = {"qpos": nq, "ctrl": nu, "com": 3, "feet": 6}
        last_t = -math.inf
        for i, frame in enumerate(frames):
            if not isinstance(frame, dict):
                problems.append(f"frame {i} is not a dict")
                continue
            missing = [k for k in FRAME_KEYS if k not in frame]
            if missing:
                problems.append(f"frame {i} missing {missing}")
                continue
            t = frame["t"]
            if not isinstance(t, (int, float)) or not math.isfinite(t) or t < last_t:
                problems.append(f"frame {i} has a bad or decreasing t {t!r}")
            else:
                last_t = t
            for key, n in lengths.items():
                if not _is_num_list(frame[key], n):
                    problems.append(f"frame {i}.{key} should be {n if n else 'a list of'} finite numbers")
            if len(problems) > 20:
                problems.append("too many problems, stopped checking frames")
                break
    if not isinstance(motion.get("result"), dict):
        problems.append("result is not a dict")
    try:
        size = len(dumps(motion).encode())
        if size > MAX_BYTES:
            problems.append(f"motion is {size} bytes, over the {MAX_BYTES} byte limit")
    except (TypeError, ValueError) as exc:
        problems.append(f"motion is not JSON serializable: {exc}")
    return problems
