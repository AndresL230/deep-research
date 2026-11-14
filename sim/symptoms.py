"""Turn one motion recording into a short list of timestamped symptoms a language model can read.

This is the "motion helper" of the debugging pipeline: given a `panda-motion/1` file (see
`sim/MOTION_FORMAT.md`) it answers "what went wrong, when, and by how much" in plain sentences such
as "The can slipped out of the grip at 1.57 s, 0.14 m into a 0.76 m carry, while the hand moved at
2.0 m/s", so the model can map a symptom to a line of controller code (a phase time, a height, ...).

Everything is derived from the recorded frames (`t`, `hand`, `can_pos`, `ctrl`, finger `qpos`) and
the episode `result` dict. Pure numpy: no MuJoCo, no scene, deterministic, and tolerant of files with
missing keys (fewer symptoms, never an exception).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

KINDS = ["missed_grasp", "never_lifted", "slipped", "dropped", "tipped", "placed_off", "timeout", "exception", "out_of_bounds", "ok"]

GRIPPER_OPEN_ABOVE = 127.0  # ctrl[7] above this is an open command (0 closed .. 255 open)
LIFT_MIN = 0.01  # m above its start height before the can counts as lifted
GRIP_H_TOL = 0.045  # m, horizontal grasp point -> can centre while travelling with the hand
GRIP_V_TOL = 0.045  # m, vertical: on a long carry the can creeps ~3.5 cm down the pads and is still
# held; past 4.5 cm the pads are at the can's top and it is falling
LOST_GRIP_FRAMES = 3  # consecutive out-of-tolerance frames before the grip counts as lost
MISS_DISTANCE = 0.03  # m, grasp point farther than this from the can when closing is a miss
MISS_WIDTH = 0.03  # m, fingers narrower than this hold nothing (the can is 0.05 wide)
MISS_CHECK_DELAY = 0.3  # s after the close command to read the finger width
NEVER_LIFTED_RISE = 0.05  # m the hand must rise after closing for "never lifted" to mean anything
SUCCESS_RADIUS_CM = 3.0  # same rule as sim.episode.SUCCESS_RADIUS
CAN_HALF_HEIGHT = 0.05  # m, same as sim.scene.CAN_HALF_HEIGHT


@dataclass
class Symptom:
    t: float | None  # sim seconds, None for end-of-episode facts
    kind: str  # one of KINDS
    text: str  # one plain sentence, numbers with units, no jargon
    data: dict  # the numbers behind it, json-serialisable


@dataclass
class Timeline:
    """What the recording shows, phase by phase, derived purely from frames."""

    closed_at: float | None  # first t where ctrl[7] goes from open (>127) to closed (<=127)
    lifted_at: float | None  # first t after closed_at where can_z - start_z > LIFT_MIN
    released_at: float | None  # first t after closed_at where ctrl[7] goes back to open
    lost_grip_at: float | None  # first t after lifted_at where the can stops travelling with the hand
    carry_distance_m: float | None  # horizontal distance can start -> place target
    carry_moved_m: float | None  # horizontal distance the can travelled before lost_grip_at (or in total)
    peak_hand_speed_mps: float | None  # max horizontal hand speed between lifted_at and lost_grip/release
    hand_to_can_at_close_m: float | None  # horizontal grasp point -> can centre at closed_at


def _r(x, nd: int = 4):
    return None if x is None or not math.isfinite(float(x)) else round(float(x), nd)


def _fmt(x, nd: int) -> str:
    return "?" if x is None or not math.isfinite(float(x)) else f"{float(x):.{nd}f}"


def _vec(frame: dict, key: str, n: int, start: int = 0) -> list[float]:
    v = frame.get(key)
    try:
        return [float(x) for x in v[start : start + n]] if isinstance(v, (list, tuple)) and len(v) >= start + n else [math.nan] * n
    except (TypeError, ValueError):
        return [math.nan] * n


def _arrays(motion: dict) -> dict | None:
    """Frame columns as numpy arrays (NaN where a value is missing), or None without usable frames."""
    frames = motion.get("frames") if isinstance(motion, dict) else None
    frames = [f for f in frames if isinstance(f, dict)] if isinstance(frames, list) else []
    if not frames:
        return None
    return {
        "t": np.array([float(f["t"]) if isinstance(f.get("t"), (int, float)) else math.nan for f in frames]),
        "hand": np.array([_vec(f, "hand", 3) for f in frames]),
        "can": np.array([_vec(f, "can_pos", 3) for f in frames]),
        "grip": np.array([_vec(f, "ctrl", 1, 7)[0] for f in frames]),
        "width": np.array([sum(_vec(f, "qpos", 2, 7)) for f in frames]),
    }


def _hypot(a: np.ndarray) -> np.ndarray:
    return np.sqrt(np.sum(np.square(a[..., :2]), axis=-1))


def _section(motion: dict, key: str) -> dict:
    v = motion.get(key) if isinstance(motion, dict) else None
    return v if isinstance(v, dict) else {}


def _first(mask: np.ndarray, start: int = 0) -> int | None:
    idx = np.flatnonzero(mask[start:])
    return int(idx[0]) + start if len(idx) else None


def timeline(motion: dict) -> Timeline:
    a = _arrays(motion)
    if a is None:
        return Timeline(*[None] * 8)
    t, hand, can, grip, width = a["t"], a["hand"], a["can"], a["grip"], a["width"]
    n = len(t)
    place = _section(motion, "header").get("place_target") or _section(motion, "result").get("place_target")
    carry_distance = None
    if isinstance(place, (list, tuple)) and len(place) >= 2:
        carry_distance = _r(_hypot(can[0] - np.array([place[0], place[1], 0.0], dtype=float)))
    closed = grip <= GRIPPER_OPEN_ABOVE  # NaN compares False: an unknown command counts as open
    ci = _first(closed & np.r_[True, ~closed[:-1]])
    if ci is None:
        return Timeline(None, None, None, None, carry_distance, None, None, None)
    lifted = can[:, 2] - can[0, 2] > LIFT_MIN
    li = _first(lifted, ci + 1) if ci + 1 < n else None
    ri = _first(~closed, ci + 1) if ci + 1 < n else None
    rel = hand - can
    gone = width < MISS_WIDTH  # nothing between the pads
    with_hand = closed & ~gone & (_hypot(rel) <= GRIP_H_TOL) & (np.abs(rel[:, 2]) <= GRIP_V_TOL)
    bad = closed & (lifted | gone) & ~with_hand
    gi = None
    if li is not None:
        run = 0
        for i in range(li, ri if ri is not None else n):
            run = run + 1 if bad[i] else 0
            if run >= LOST_GRIP_FRAMES:
                gi = i - LOST_GRIP_FRAMES + 1
                break
    end_i = gi if gi is not None else (ri if ri is not None else n - 1)
    peak = None
    if li is not None and end_i > li:
        dt = np.diff(t[li : end_i + 1])
        ok = np.isfinite(dt) & (dt > 0)
        if np.any(ok):
            peak = _r(np.max(_hypot(np.diff(hand[li : end_i + 1], axis=0))[ok] / dt[ok]))
    at = lambda i: None if i is None else _r(t[i])  # noqa: E731
    return Timeline(at(ci), at(li), at(ri), at(gi), carry_distance, _r(_hypot(can[end_i] - can[0])), peak, _r(_hypot(rel[ci])))


def _frame_symptoms(motion: dict, tl: Timeline) -> list[Symptom]:
    a = _arrays(motion)
    if a is None or tl.closed_at is None:
        return []
    t, hand, can, width = a["t"], a["hand"], a["can"], a["width"]
    ci = _first(t >= tl.closed_at) or 0
    wi = _first(t >= tl.closed_at + MISS_CHECK_DELAY)
    width_after = None if wi is None else _r(width[wi])
    dist = tl.hand_to_can_at_close_m
    far = dist is not None and dist > MISS_DISTANCE
    narrow = width_after is not None and width_after < MISS_WIDTH
    data = {"closed_at": tl.closed_at, "hand_to_can_m": dist, "finger_width_m": width_after}
    if tl.lifted_at is None and (far or narrow):
        text = (
            f"The gripper closed {_fmt(dist * 100, 1)} cm from the can at {_fmt(tl.closed_at, 2)} s and caught nothing."
            if far
            else f"The gripper closed over the can at {_fmt(tl.closed_at, 2)} s but the fingers shut to "
            f"{_fmt(width_after * 100, 1)} cm (the can is {CAN_HALF_HEIGHT * 100:.1f} cm wide), so they caught nothing."
        )
        return [Symptom(tl.closed_at, "missed_grasp", text, data)]
    out: list[Symptom] = []
    if tl.lifted_at is None:
        rise = _r(np.nanmax(hand[ci:, 2]) - hand[ci, 2]) if np.any(np.isfinite(hand[ci:, 2])) else None
        if rise is not None and rise > NEVER_LIFTED_RISE:
            text = f"The gripper closed on the can at {_fmt(tl.closed_at, 2)} s but the can stayed on the floor while the hand rose {_fmt(rise * 100, 1)} cm."
            out.append(Symptom(tl.closed_at, "never_lifted", text, dict(data, hand_rise_m=rise)))
    if tl.lost_grip_at is not None:
        gi = _first(t >= tl.lost_grip_at) or 0
        speed = _r(np.linalg.norm(hand[gi] - hand[gi - 1]) / (t[gi] - t[gi - 1])) if gi > 0 and t[gi] > t[gi - 1] else None
        bottom = _r(can[gi, 2] - CAN_HALF_HEIGHT)
        text = (
            f"The can slipped out of the grip at {_fmt(tl.lost_grip_at, 2)} s, {_fmt(tl.carry_moved_m, 2)} m into a "
            f"{_fmt(tl.carry_distance_m, 2)} m carry, while the hand moved at {_fmt(speed, 1)} m/s "
            f"(peak {_fmt(tl.peak_hand_speed_mps, 1)} m/s) with the can's bottom {_fmt(bottom * 100, 1)} cm above the floor."
        )
        data = {"lost_grip_at": tl.lost_grip_at, "lifted_at": tl.lifted_at, "carry_moved_m": tl.carry_moved_m, "carry_distance_m": tl.carry_distance_m}
        data.update(hand_speed_mps=speed, peak_hand_speed_mps=tl.peak_hand_speed_mps, can_z_m=_r(can[gi, 2]), can_bottom_m=bottom)
        out.append(Symptom(tl.lost_grip_at, "slipped", text, data))
    return out


def _result_symptoms(motion: dict, tl: Timeline, have_slip: bool) -> list[Symptom]:
    res = _section(motion, "result")
    out: list[Symptom] = []
    err, tilt, tt, reason = res.get("place_error_cm"), res.get("tilt_deg"), res.get("time_taken"), res.get("end_reason")
    if res.get("dropped") and not have_slip:
        a = _arrays(motion)
        ri = _first(a["t"] >= tl.released_at) if a is not None and tl.released_at is not None else None
        bottom = None if ri is None else _r(a["can"][ri, 2] - CAN_HALF_HEIGHT)
        text = (
            f"The can was dropped: it was lifted {_fmt(res.get('max_height_cm'), 1)} cm and ended "
            f"{'on its side ' if res.get('tipped') else ''}{_fmt(err, 1)} cm from the target."
        )
        if bottom is not None and bottom > 0.005:
            text += f" The gripper opened at {_fmt(tl.released_at, 2)} s with the can's bottom {_fmt(bottom * 100, 1)} cm above the floor."
        elif bottom is not None:
            text += f" The can was already falling over when the gripper opened at {_fmt(tl.released_at, 2)} s."
        data = {"released_at": tl.released_at, "can_bottom_at_release_m": bottom, "max_height_cm": _r(res.get("max_height_cm")), "place_error_cm": _r(err)}
        out.append(Symptom(tl.released_at, "dropped", text, data))
    if res.get("tipped") or res.get("upright") is False:
        text = f"The can ended on its side, tilted {_fmt(tilt, 1)} degrees, {_fmt(err, 1)} cm from the target."
        out.append(Symptom(None, "tipped", text, {"tilt_deg": _r(tilt), "place_error_cm": _r(err)}))
    elif res.get("resting") and isinstance(err, (int, float)) and err > SUCCESS_RADIUS_CM and (tl.lifted_at is not None or _arrays(motion) is None):
        # Only a can that was actually carried can be "placed off"; one never picked up is a grasp problem.
        text = f"The can was set down upright but {_fmt(err, 1)} cm from the target, outside the {SUCCESS_RADIUS_CM:.1f} cm success radius."
        out.append(Symptom(None, "placed_off", text, {"place_error_cm": _r(err), "limit_cm": SUCCESS_RADIUS_CM}))
    if reason == "max_time":
        out.append(Symptom(None, "timeout", f"The episode ran out of time at {_fmt(tt, 2)} s without finishing.", {"time_taken": _r(tt)}))
    if reason == "out_of_bounds":
        text = f"The can left the workspace at {_fmt(tt, 2)} s, {_fmt(err, 1)} cm from the target."
        out.append(Symptom(_r(tt), "out_of_bounds", text, {"time_taken": _r(tt), "place_error_cm": _r(err)}))
    exc = res.get("exception")
    if exc or reason in ("exception", "physics_error"):
        line = str(exc or reason).splitlines()[0]
        out.append(Symptom(_r(tt), "exception", f"The controller failed at {_fmt(tt, 2)} s: {line}", {"time_taken": _r(tt), "exception": line}))
    return out


def symptoms(motion: dict) -> list[Symptom]:
    """Ordered by t (None last); always at least one entry; [ok] when the episode succeeded."""
    if not isinstance(motion, dict):
        return [Symptom(None, "exception", "The motion file is not a JSON object.", {})]
    res = _section(motion, "result")
    err, tt = res.get("place_error_cm"), res.get("time_taken")
    if res.get("success") is True:
        text = f"Succeeded: placed {_fmt(err, 1)} cm from the target in {_fmt(tt, 2)} s."
        return [Symptom(None, "ok", text, {"place_error_cm": _r(err), "time_taken": _r(tt)})]
    tl = timeline(motion)
    out = _frame_symptoms(motion, tl)
    out += _result_symptoms(motion, tl, any(s.kind == "slipped" for s in out))
    if not out and tl.closed_at is None and res.get("success") is False:
        text = f"The gripper never closed, so the can was never picked up ({_fmt(tt, 2)} s)."
        out.append(Symptom(None, "missed_grasp", text, {"time_taken": _r(tt)}))
    if not out:
        out.append(Symptom(None, "ok", "Nothing wrong found in the recording, but the result does not confirm success.", {}))
    out.sort(key=lambda s: (s.t is None, s.t or 0.0))
    return out


def describe(motion: dict) -> str:
    """The symptoms as numbered lines, for a prompt."""
    return "\n".join(f"{i}. {s.text}" for i, s in enumerate(symptoms(motion), 1))


def summarize(motion_paths: list[str | Path]) -> list[dict]:
    """Per file: {"path", "can_start", "success", "end_reason", "symptoms": [asdict(Symptom), ...]}."""
    out = []
    for p in motion_paths:
        try:
            motion = json.loads(Path(p).read_text())
        except (OSError, ValueError) as exc:
            motion = {"result": {"success": False, "exception": f"{type(exc).__name__}: {exc}", "end_reason": "exception"}}
        header, res = _section(motion, "header"), _section(motion, "result")
        can_start = header.get("can_start", res.get("can_start"))
        out.append({"path": str(p), "can_start": can_start, "success": res.get("success"), "end_reason": res.get("end_reason"), "symptoms": [asdict(s) for s in symptoms(motion)]})
    return out
