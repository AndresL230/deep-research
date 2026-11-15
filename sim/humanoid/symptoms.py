"""Turn one `g1-push-motion/1` recording into a short list of timestamped symptoms a language model can read.

The humanoid twin of `sim/symptoms.py`: "A push of 40 N from the front hit the torso at 1.53 s", "When the push came,
the center of mass was 3.0 cm behind the ankles", "The robot fell backward at 2.81 s, 1.28 s after the push". Derived
from the frames (`t`, `qpos`, `com`, `feet`), the header's `push` and the episode `result`. Pure numpy, no MuJoCo;
a file with missing keys gives fewer symptoms, never an exception.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

KINDS = ["push", "lean", "fell", "stumbled", "ok", "exception"]


@dataclass
class Symptom:
    t: float | None
    kind: str
    text: str
    data: dict


def direction_words(angle_deg: float) -> str:
    """Where a push comes from, in words: angle 0 pushes forward, so it comes "from behind"."""
    a = float(angle_deg) % 360.0
    names = ["from behind", "from behind and the right", "from the right", "from the front and the right",
             "from the front", "from the front and the left", "from the left", "from behind and the left"]
    return names[int(((a + 22.5) % 360.0) // 45.0)]


def heading_words(dx: float, dy: float) -> str:
    """The direction of a horizontal movement in the robot's frame: "forward", "backward and to its left", ..."""
    a = math.degrees(math.atan2(dy, dx)) % 360.0
    names = ["forward", "forward and to its left", "to its left", "backward and to its left",
             "backward", "backward and to its right", "to its right", "forward and to its right"]
    return names[int(((a + 22.5) % 360.0) // 45.0)]


def _frames(motion: dict):
    fr = [f for f in motion.get("frames") or [] if isinstance(f, dict)]
    t = np.array([float(f.get("t", 0.0)) for f in fr]) if fr else np.zeros(0)
    com = np.array([f["com"] for f in fr if isinstance(f.get("com"), list) and len(f["com"]) == 3])
    feet = np.array([f["feet"] for f in fr if isinstance(f.get("feet"), list) and len(f["feet"]) == 6])
    return fr, t, com if len(com) == len(fr) else None, feet if len(feet) == len(fr) else None


def symptoms(motion: dict) -> list[Symptom]:
    """What happened in the recorded episode, in order, each a plain sentence with numbers."""
    out: list[Symptom] = []
    header = motion.get("header") if isinstance(motion.get("header"), dict) else {}
    result = motion.get("result") if isinstance(motion.get("result"), dict) else {}
    push = header.get("push") or result.get("push") or {}
    fr, t, com, feet = _frames(motion)
    t_push = push.get("time_s") if isinstance(push.get("time_s"), (int, float)) else result.get("push_time")
    if isinstance(push.get("angle_deg"), (int, float)) and isinstance(push.get("force_n"), (int, float)):
        out.append(Symptom(
            t_push, "push",
            f"A push of {push['force_n']:.0f} N {direction_words(push['angle_deg'])} (pointing {push['angle_deg']:.0f} degrees) "
            f"hit the torso at {t_push:.2f} s for {push.get('duration_s', 0.2):.1f} s." if t_push is not None else
            f"A push of {push['force_n']:.0f} N {direction_words(push['angle_deg'])} hit the torso.",
            {"angle_deg": push["angle_deg"], "force_n": push["force_n"], "time_s": t_push},
        ))
    if com is not None and feet is not None and len(t) and t_push is not None:
        k = int(min(len(t) - 1, np.searchsorted(t, float(t_push))))
        mid = 0.5 * (feet[k, :3] + feet[k, 3:])
        dx, dy = float(com[k, 0] - mid[0]), float(com[k, 1] - mid[1])
        where = "in front of" if dx >= 0 else "behind"
        out.append(Symptom(
            round(float(t[k]), 3), "lean",
            f"When the push came, the center of mass was {abs(dx) * 100:.1f} cm {where} the ankles and "
            f"{abs(dy) * 100:.1f} cm to the {'left' if dy >= 0 else 'right'} (each foot reaches 12 cm in front of its "
            "ankle and 5 cm behind it).",
            {"com_ahead_of_ankles_m": round(dx, 4), "com_left_of_ankles_m": round(dy, 4)},
        ))
    if result.get("exception"):
        out.append(Symptom(None, "exception", f"The controller failed: {str(result['exception']).splitlines()[0][:200]}",
                           {"exception": str(result["exception"])[:400]}))
        return out
    fall = result.get("fall_time")
    if result.get("fell") and isinstance(fall, (int, float)):
        way = ""
        if com is not None and len(t) and t_push is not None:
            k0 = int(min(len(t) - 1, np.searchsorted(t, float(t_push))))
            k1 = int(min(len(t) - 1, np.searchsorted(t, float(fall))))
            d = com[k1, :2] - com[k0, :2]
            if float(np.hypot(*d)) > 0.02:
                way = f" {heading_words(float(d[0]), float(d[1]))}"
        how = f"its {result['touched'].replace('_', ' ')} touched the floor" if result.get("touched") else "its pelvis dropped below 0.45 m"
        after = f", {fall - t_push:.2f} s after the push" if t_push is not None else ""
        out.append(Symptom(fall, "fell", f"The robot fell{way} at {fall:.2f} s{after}: {how}.",
                           {"fall_time": fall, "touched": result.get("touched"), "max_tilt_deg": result.get("max_tilt_deg")}))
    elif result.get("stumbled"):
        out.append(Symptom(None, "stumbled",
                           f"The robot stayed up but stumbled: the torso tilted up to {result.get('max_tilt_deg')} degrees and a "
                           f"foot moved {result.get('max_foot_shift_cm')} cm.",
                           {"max_tilt_deg": result.get("max_tilt_deg"), "max_foot_shift_cm": result.get("max_foot_shift_cm")}))
    else:
        out.append(Symptom(None, "ok",
                           f"The robot stayed upright: the torso tilted at most {result.get('max_tilt_deg')} degrees and the feet "
                           f"moved at most {result.get('max_foot_shift_cm')} cm.",
                           {"max_tilt_deg": result.get("max_tilt_deg"), "max_foot_shift_cm": result.get("max_foot_shift_cm")}))
    return out


def symptoms_dicts(motion: dict) -> list[dict]:
    return [asdict(s) for s in symptoms(motion)]
