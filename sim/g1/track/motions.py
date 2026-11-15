"""Reference motions for the tracking task: human motion capture clips fitted onto the Unitree G1.

A reference is a list of robot poses at 30 frames a second: LEAD_IN seconds from the ready pose (the same for every
motion) to the clip's first frame, then the clip. Every frame has both feet planted where the robot stands and the
centre of mass over them, so each pose can be held. Following them at the clip's speed is the task.

The clips are CMU motion capture recordings (mocap.cs.cmu.edu, free for all uses), fitted to the robot by
`sim/g1/track/retarget.py`. They are in three sets under `sim/g1/track/motions/`:

    public      what an agent is given: the practice motion and a few others
    hidden      what its controller is measured on. Never uploaded
    diagnostic  what a failing controller is traced on. Never uploaded, and none of them a hidden one

A motion's `kind` says what plain playback of its joint angles does in the sim: "calm" when the robot stays on its
feet, "demanding" when it falls (the weight shifts, twists and fast arms need balance).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

MOTIONS_DIR = Path(__file__).resolve().parent / "motions"
FORMAT = "g1-reference/1"
SETS = ("public", "hidden", "diagnostic")
KINDS = ("calm", "demanding")
FPS = 30
LEAD_IN = 1.5       # s, from the ready pose to the clip's first frame; not scored
N_JOINTS = 29
NQ = 7 + N_JOINTS
MAX_SECONDS = 30.0

# The joints by half of the body, as indices into the 29 joint angles (sim.g1.control.JOINT_NAMES): the legs, then
# the waist and the arms.
LOWER_JOINTS = tuple(range(0, 12))
UPPER_JOINTS = tuple(range(12, 29))
# The bodies whose positions are compared with the reference's.
UPPER_BODIES = ("torso_link", "left_elbow_link", "right_elbow_link", "left_wrist_yaw_link", "right_wrist_yaw_link")
LOWER_BODIES = ("left_knee_link", "right_knee_link", "left_ankle_roll_link", "right_ankle_roll_link")
KEY_BODIES = UPPER_BODIES + LOWER_BODIES


def names(set_name: str = "public") -> list[str]:
    """The names of a set's motions, sorted."""
    if set_name not in SETS:
        raise ValueError(f"unknown set {set_name!r}; there are {list(SETS)}")
    return sorted(p.stem for p in (MOTIONS_DIR / set_name).glob("*.json"))


def check_motion(data: dict) -> dict:
    """A motion as the sim uses it: {"name", "kind", "description", "source", "fps", "lead_in", "qpos": (n, 36)
    array}. Raises ValueError for anything that is not one."""
    if not isinstance(data, dict):
        raise ValueError("a motion is a dict")
    if isinstance(data.get("qpos"), np.ndarray):
        qpos = np.array(data["qpos"], dtype=float)
    else:
        try:
            root = np.array(data["root"], dtype=float)
            joints = np.array(data["joints"], dtype=float)
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"a motion needs 'root' and 'joints' lists of numbers: {e}") from None
        if root.ndim != 2 or root.shape[1] != 4 or joints.ndim != 2 or joints.shape != (len(root), N_JOINTS):
            raise ValueError(f"a motion's root must be (n, 4) and its joints (n, {N_JOINTS}), got {root.shape} and {joints.shape}")
        qpos = np.zeros((len(root), NQ))
        qpos[:, :3] = root[:, :3]
        qpos[:, 3] = np.cos(root[:, 3] / 2)
        qpos[:, 6] = np.sin(root[:, 3] / 2)
        qpos[:, 7:] = joints
    fps = float(data.get("fps", FPS))
    lead = float(data.get("lead_in", LEAD_IN))
    if qpos.ndim != 2 or qpos.shape[1] != NQ or not np.all(np.isfinite(qpos)):
        raise ValueError(f"a motion's poses must be (n, {NQ}) finite numbers")
    if not 1 <= fps <= 240 or lead < 0:
        raise ValueError("a motion's fps must be between 1 and 240 and its lead_in not negative")
    seconds = (len(qpos) - 1) / fps
    if seconds <= lead + 0.5 or seconds > MAX_SECONDS:
        raise ValueError(f"a motion must last longer than its lead-in and at most {MAX_SECONDS:g} s, got {seconds:.2f} s")
    kind = data.get("kind")
    return {
        "name": str(data.get("name") or "motion"),
        "kind": kind if kind in KINDS else None,
        "description": str(data.get("description") or ""),
        "source": dict(data.get("source") or {}),
        "fps": fps,
        "lead_in": lead,
        "qpos": qpos,
    }


def load(name: str, set_name: str = "public") -> dict:
    """One motion of a set by name. A name that is not there raises ValueError and lists the set's motions."""
    path = MOTIONS_DIR / set_name / f"{name}.json"
    if set_name not in SETS or not path.is_file() or path.parent != MOTIONS_DIR / set_name:
        raise ValueError(f"no {set_name} motion {name!r}; there are {names(set_name) if set_name in SETS else list(SETS)}")
    return check_motion({**json.loads(path.read_text()), "name": name})


def resolve(motion) -> dict:
    """What `run_episode` takes for a motion: a public motion's name, {"set": ..., "name": ...}, or a motion itself."""
    if isinstance(motion, str):
        return load(motion)
    if isinstance(motion, dict) and "qpos" not in motion and "root" not in motion and "name" in motion:
        return load(str(motion["name"]), str(motion.get("set", "public")))
    return check_motion(motion)


def spec(motion: dict, set_name: str) -> dict:
    """A motion as a small dict that names it, for a list of jobs or a results file."""
    return {"set": set_name, "name": motion["name"], "kind": motion["kind"]}


def duration(motion: dict) -> float:
    """Seconds from the start of the lead-in to the last frame."""
    return (len(motion["qpos"]) - 1) / motion["fps"]


def public_info(motion: dict) -> dict:
    """What can be said of a motion without its poses."""
    return {"name": motion["name"], "kind": motion["kind"], "description": motion["description"],
            "seconds": round(duration(motion) - motion["lead_in"], 2)}


def interpolate(frames: np.ndarray, fps: float, t: float) -> np.ndarray:
    """Row `t` seconds into `frames`, between the two nearest rows; the first row before 0, the last after the end."""
    f = min(max(t, 0.0) * fps, len(frames) - 1.0)
    i = int(math.floor(f))
    j = min(i + 1, len(frames) - 1)
    w = f - i
    return frames[i] * (1.0 - w) + frames[j] * w


def reference(motion: dict, t: float) -> np.ndarray:
    """The reference pose (36,) at `t` seconds: pelvis xyz, quaternion wxyz, 29 joint angles."""
    q = interpolate(motion["qpos"], motion["fps"], t)
    q[3:7] /= np.linalg.norm(q[3:7])
    return q


def to_file(motion: dict, decimals: int = 4) -> dict:
    """A motion as it is saved: the pelvis as x, y, z and its turn about the vertical, and the joint angles."""
    q = np.asarray(motion["qpos"], dtype=float)
    yaw = 2.0 * np.arctan2(q[:, 6], q[:, 3])
    root = np.column_stack([q[:, :3], yaw])
    return {
        "format": FORMAT,
        "name": motion["name"],
        "kind": motion.get("kind"),
        "description": motion.get("description", ""),
        "source": motion.get("source", {}),
        "fps": motion.get("fps", FPS),
        "lead_in": motion.get("lead_in", LEAD_IN),
        "root": np.round(root, decimals).tolist(),
        "joints": np.round(q[:, 7:], decimals).tolist(),
    }
