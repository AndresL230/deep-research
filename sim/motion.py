"""Motion files: a compact JSON recording of one episode, for the browser viewer and offline analysis.

The format is documented in `sim/MOTION_FORMAT.md`. In short:

    {"format": "panda-motion/1",
     "header": {"model_id", "joint_names", "actuator_names", "can_start", "place_target", "fps", "nq"},
     "frames": [{"t", "qpos", "ctrl", "hand", "can_pos", "can_quat"}, ...],
     "result": {...}}
"""

from __future__ import annotations

import json
import math
from pathlib import Path

FORMAT = "panda-motion/1"
MOTION_FPS = 30
MAX_BYTES = 200_000
DECIMALS = 4

HEADER_KEYS = ("model_id", "joint_names", "actuator_names", "can_start", "place_target", "fps", "nq")
FRAME_KEYS = ("t", "qpos", "ctrl", "hand", "can_pos", "can_quat")


def round_list(values, decimals: int = DECIMALS) -> list[float]:
    """Plain list of floats rounded to `decimals` places (non-finite values become None)."""
    out = []
    for v in values:
        f = float(v)
        out.append(round(f, decimals) if math.isfinite(f) else None)
    return out


def dumps(motion: dict) -> str:
    """Serialize a motion dict to compact JSON (no spaces)."""
    return json.dumps(motion, separators=(",", ":"), allow_nan=False)


def write_motion(motion: dict, path) -> int:
    """Write `motion` as compact JSON to `path` (parent folders are created). Returns the size in bytes."""
    text = dumps(motion)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return len(text.encode())


def read_motion(path) -> dict:
    """Load a motion file written by `write_motion`."""
    return json.loads(Path(path).read_text())


def _is_num_list(value, length: int | None = None) -> bool:
    if not isinstance(value, list):
        return False
    if length is not None and len(value) != length:
        return False
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)


def validate_motion(motion) -> list[str]:
    """Return a list of problems with `motion` (empty if it matches the format)."""
    problems: list[str] = []
    if not isinstance(motion, dict):
        return ["motion is not a dict"]
    if motion.get("format") != FORMAT:
        problems.append(f"format should be {FORMAT!r}, got {motion.get('format')!r}")
    for key in ("header", "frames", "result"):
        if key not in motion:
            problems.append(f"missing top-level key {key!r}")
    header = motion.get("header")
    nq = None
    nu = None
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
        if header.get("fps") != MOTION_FPS:
            problems.append(f"header.fps should be {MOTION_FPS}, got {header.get('fps')!r}")
        for key in ("can_start", "place_target"):
            if key in header and not _is_num_list(header[key], 2):
                problems.append(f"header.{key} should be 2 numbers")
    frames = motion.get("frames")
    if not isinstance(frames, list):
        problems.append("frames is not a list")
    elif not frames:
        problems.append("frames is empty")
    else:
        lengths = {"qpos": nq, "ctrl": nu, "hand": 3, "can_pos": 3, "can_quat": 4}
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
