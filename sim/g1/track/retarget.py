"""Fit a human motion capture clip onto the Unitree G1: read CMU's ASF/AMC files, find a stretch where the person's
feet stay planted, and turn it into a reference motion the robot can stand through.

ExBody2 (Ji et al., arXiv:2412.13196) trains its tracking policy on CMU MoCap clips retargeted to the G1. Its
retargeted clips are not published, so this is our own retargeting, and a much simpler one: the feet are planted
where the robot stands, the pelvis follows the person's (height, sway and turn, scaled to the robot's legs), the
waist takes the lean and twist of the person's trunk, and the arms follow the person's elbows and wrists, scaled to
the robot's arms. The pelvis is then moved until the centre of mass is over the feet, so every frame of a reference
is a pose the robot can hold. Nothing here says the robot can follow it at the clip's speed: that is the task.

Used offline by `scripts/make_track_motions.py`, which writes the references under `sim/g1/track/motions/`. The sim
itself only reads those files.

CMU's data is from mocap.cs.cmu.edu (free for all uses; created with funding from NSF EIA-0196217).
"""

from __future__ import annotations

import math
from pathlib import Path

import mujoco
import numpy as np

# ASF lengths are in inches divided by this scale; this makes them meters.
ASF_TO_M = (1.0 / 0.45) * 0.0254
CMU_FPS = 120


# --- ASF / AMC -----------------------------------------------------------------------------------


def _rot(axis: str, deg: np.ndarray) -> np.ndarray:
    """Rotation matrices about one axis, for an array of angles in degrees: shape (..., 3, 3)."""
    a = np.radians(np.asarray(deg, dtype=float))
    c, s = np.cos(a), np.sin(a)
    out = np.zeros(a.shape + (3, 3))
    i = "xyz".index(axis)
    j, k = (i + 1) % 3, (i + 2) % 3
    out[..., i, i] = 1.0
    out[..., j, j] = c
    out[..., j, k] = -s
    out[..., k, j] = s
    out[..., k, k] = c
    return out


def _euler(rx, ry, rz) -> np.ndarray:
    """ASF's XYZ order: rotate about x, then y, then z."""
    return _rot("z", rz) @ _rot("y", ry) @ _rot("x", rx)


class Skeleton:
    """An ASF skeleton: bones with a direction, a length, an axis and degrees of freedom, in a tree under `root`."""

    def __init__(self, path: Path):
        self.bones: dict[str, dict] = {}
        self.children: dict[str, list[str]] = {}
        self.root_order = ["tx", "ty", "tz", "rx", "ry", "rz"]
        section, bone = "", None
        for raw in Path(path).read_text(errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith(":"):
                section = line.split()[0][1:]
                continue
            words = line.split()
            if section == "root" and words[0] == "order":
                self.root_order = [w.lower() for w in words[1:]]
            elif section == "bonedata":
                if words[0] == "begin":
                    bone = {"dof": [], "axis": [0.0, 0.0, 0.0]}
                elif words[0] == "end":
                    self.bones[bone["name"]] = bone
                elif words[0] == "name":
                    bone["name"] = words[1]
                elif words[0] == "direction":
                    bone["direction"] = np.array([float(w) for w in words[1:4]])
                elif words[0] == "length":
                    bone["length"] = float(words[1]) * ASF_TO_M
                elif words[0] == "axis":
                    bone["axis"] = [float(w) for w in words[1:4]]
                elif words[0] == "dof":
                    bone["dof"] = [w.lower() for w in words[1:]]
            elif section == "hierarchy" and words[0] not in ("begin", "end"):
                self.children[words[0]] = words[1:]
        for b in self.bones.values():
            c = _euler(*b["axis"])
            b["c"], b["cinv"] = c, c.T

    def read_amc(self, path: Path, every: int = 1) -> dict[str, np.ndarray]:
        """A clip's channels: {bone: (frames, values)}, every `every`-th frame."""
        frames: list[dict[str, list[float]]] = []
        for raw in Path(path).read_text(errors="replace").splitlines():
            line = raw.strip()
            if not line or line[0] in "#:":
                continue
            words = line.split()
            if len(words) == 1 and words[0].isdigit():
                frames.append({})
            elif frames:
                frames[-1][words[0]] = [float(w) for w in words[1:]]
        frames = frames[::every]
        return {name: np.array([f[name] for f in frames]) for name in frames[0]}

    def points(self, channels: dict[str, np.ndarray] | None = None) -> dict[str, np.ndarray]:
        """Where every bone ends, per frame, in our axes (x forward, y left, z up), meters: {bone: (frames, 3)}.
        "root" is the pelvis. With no channels, the skeleton's rest pose (one frame)."""
        n = len(channels["root"]) if channels else 1
        root = dict(zip(self.root_order, (channels["root"].T if channels else np.zeros((6, 1)))))
        pos = np.stack([root["tx"], root["ty"], root["tz"]], axis=-1) * ASF_TO_M
        rot = _euler(root["rx"], root["ry"], root["rz"])
        out = {"root": pos}

        def walk(parent: str, base: np.ndarray, r_parent: np.ndarray) -> None:
            for name in self.children.get(parent, []):
                b = self.bones[name]
                angles = {"rx": np.zeros(n), "ry": np.zeros(n), "rz": np.zeros(n)}
                if channels and b["dof"]:
                    for k, dof in enumerate(b["dof"]):
                        if dof in angles:
                            angles[dof] = channels[name][:, k]
                r = r_parent @ b["c"] @ _euler(angles["rx"], angles["ry"], angles["rz"]) @ b["cinv"]
                tip = base + np.einsum("nij,j->ni", r, b["direction"] * b["length"])
                out[name] = tip
                walk(name, tip, r)

        walk("root", pos, rot)
        # CMU has y up and the person facing z: ours is (z, x, y).
        return {k: v[:, [2, 0, 1]] for k, v in out.items()}


# The points of a person the fit reads, by the ASF bone that ends there.
HUMAN = {
    "pelvis": "root", "neck": "thorax", "head": "head",
    "left_hip": "lhipjoint", "left_knee": "lfemur", "left_ankle": "ltibia",
    "right_hip": "rhipjoint", "right_knee": "rfemur", "right_ankle": "rtibia",
    "left_shoulder": "lclavicle", "left_elbow": "lhumerus", "left_wrist": "lradius",
    "right_shoulder": "rclavicle", "right_elbow": "rhumerus", "right_wrist": "rradius",
}


def human_points(skeleton: Skeleton, channels: dict | None = None) -> dict[str, np.ndarray]:
    p = skeleton.points(channels)
    return {name: p[bone] for name, bone in HUMAN.items()}


# --- planted stretches ---------------------------------------------------------------------------

FOOT_SLIDE = 0.07   # m: a foot is planted while its ankle stays this close to where it was at the start
FOOT_LIFT = 0.04    # m: and this close to its lowest height


def planted_stretches(points: dict[str, np.ndarray], fps: float, min_seconds: float = 6.0) -> list[tuple[int, int]]:
    """Stretches of frames [a, b) where both ankles stay put, longest first, not overlapping."""
    ankles = [points["left_ankle"], points["right_ankle"]]
    n = len(ankles[0])
    floor = [float(np.percentile(a[:, 2], 2)) for a in ankles]
    low = np.all([a[:, 2] < f + FOOT_LIFT for a, f in zip(ankles, floor)], axis=0)
    found, a = [], 0
    step = max(1, int(fps / 4))
    while a < n - int(min_seconds * fps):
        b = a
        while b < n and low[b] and all(np.linalg.norm(k[b, :2] - k[a, :2]) < FOOT_SLIDE for k in ankles):
            b += 1
        if b - a >= min_seconds * fps:
            found.append((a, b))
            a = b
        else:
            a += step
    return sorted(found, key=lambda s: s[0] - s[1])


# --- the fit -------------------------------------------------------------------------------------

LEG = ("hip_pitch", "hip_roll", "hip_yaw", "knee", "ankle_pitch", "ankle_roll")
ARM = ("shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow", "wrist_roll", "wrist_pitch", "wrist_yaw")
PELVIS_Z = (0.62, 0.775)        # m: how low the pelvis may squat, and just short of straight legs
PELVIS_YAW = 0.25               # rad
WAIST = (1.0, 0.45, 0.45)       # rad: yaw, roll, pitch kept inside the joint limits
COM_BOX = ((-0.02, 0.02), (-0.035, 0.035))  # m: where the centre of mass may be, from the middle of the feet
SWAY_SMOOTH = 0.2               # s: the pelvis's sway and height are smoothed this much more than the rest
SWAY_MAX = 0.04                 # m: the pelvis sways at most this far from where it stands, to either side
LEAD_IN = 1.5                   # s: from the standing pose to the first frame, before the reference proper
ELBOW_WEIGHT = 0.6              # an elbow counts less than a wrist where both cannot be met


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def _frames_of(up: np.ndarray, left: np.ndarray) -> np.ndarray:
    """Orthonormal frames (..., 3, 3) with columns forward, left, up, from an up and a rough left direction."""
    z = _unit(up)
    y = _unit(left - np.sum(left * z, axis=-1, keepdims=True) * z)
    x = np.cross(y, z)
    return np.stack([x, y, z], axis=-1)


def _yaw(angle: np.ndarray) -> np.ndarray:
    return _rot("z", np.degrees(angle))


def _smooth(x: np.ndarray, fps: float, seconds: float = 0.07) -> np.ndarray:
    """A Gaussian low-pass along time, edges held."""
    sigma = seconds * fps
    half = max(1, int(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-half, half + 1) / sigma) ** 2)
    k /= k.sum()
    padded = np.concatenate([np.repeat(x[:1], half, axis=0), x, np.repeat(x[-1:], half, axis=0)])
    return np.stack([np.convolve(padded[:, j], k, mode="valid") for j in range(x.shape[1])], axis=1)


class Fitter:
    """Fits human points onto the G1, a frame at a time, each frame starting from the one before."""

    def __init__(self, model: mujoco.MjModel, stand_qpos: np.ndarray, joint_names: tuple[str, ...]):
        self.m, self.d = model, mujoco.MjData(model)
        self.stand = np.array(stand_qpos, dtype=float)
        self.names = joint_names
        self.adr = {n: 7 + i for i, n in enumerate(joint_names)}        # qpos address
        self.dof = {n: 6 + i for i, n in enumerate(joint_names)}        # velocity address
        lim = np.array([model.joint(n).range for n in joint_names])
        self.lower, self.upper = lim[:, 0] + 0.02, lim[:, 1] - 0.02
        body = lambda n: mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, n)  # noqa: E731
        self.body = {n: body(n) for n in ("pelvis", "torso_link", "left_ankle_roll_link", "right_ankle_roll_link",
                                          "left_shoulder_pitch_link", "right_shoulder_pitch_link", "left_elbow_link",
                                          "right_elbow_link", "left_wrist_yaw_link", "right_wrist_yaw_link",
                                          "left_knee_link", "right_knee_link")}
        d = self._set(self.stand)
        self.feet = {s: d.xpos[self.body[f"{s}_ankle_roll_link"]].copy() for s in ("left", "right")}
        self.support = np.mean([self.feet["left"][:2], self.feet["right"][:2]], axis=0) + np.array([0.03, 0.0])
        length = lambda a, b: float(np.linalg.norm(d.xpos[self.body[a]] - d.xpos[self.body[b]]))  # noqa: E731
        self.upper_arm = length("left_shoulder_pitch_link", "left_elbow_link")
        self.forearm = length("left_elbow_link", "left_wrist_yaw_link")
        self.pelvis_stand = float(self.stand[2] - self.feet["left"][2])

    def _set(self, q: np.ndarray) -> mujoco.MjData:
        self.d.qpos[:] = q
        mujoco.mj_kinematics(self.m, self.d)
        mujoco.mj_comPos(self.m, self.d)
        return self.d

    def _cols(self, side: str, part: tuple[str, ...]) -> list[int]:
        return [self.dof[f"{side}_{j}_joint"] for j in part]

    def _step(self, q: np.ndarray, cols: list[int], jac: np.ndarray, err: np.ndarray, damping: float, rest: np.ndarray | None = None,
              pull: float = 0.0) -> None:
        j = jac[:, cols]
        h = j.T @ j + damping * np.eye(len(cols))
        g = j.T @ err
        adr = [c + 1 for c in cols]
        if rest is not None:
            h += pull * np.eye(len(cols))
            g += pull * (rest - q[adr])
        q[adr] = np.clip(q[adr] + np.linalg.solve(h, g), self.lower[[c - 6 for c in cols]], self.upper[[c - 6 for c in cols]])

    def _legs(self, q: np.ndarray, iters: int) -> None:
        jp, jr = np.zeros((3, self.m.nv)), np.zeros((3, self.m.nv))
        for _ in range(iters):
            d = self._set(q)
            for side in ("left", "right"):
                b = self.body[f"{side}_ankle_roll_link"]
                mujoco.mj_jacBody(self.m, d, jp, jr, b)
                r = d.xmat[b].reshape(3, 3)
                turn = 0.5 * sum(np.cross(r[:, i], np.eye(3)[:, i]) for i in range(3))
                self._step(q, self._cols(side, LEG), np.vstack([jp, jr]), np.concatenate([self.feet[side] - d.xpos[b], turn]), 1e-4)

    def _arms(self, q: np.ndarray, targets: dict[str, np.ndarray], rest: np.ndarray, iters: int) -> None:
        jp = np.zeros((3, self.m.nv))
        for _ in range(iters):
            d = self._set(q)
            for side in ("left", "right"):
                rows, errs = [], []
                for part, w in (("elbow_link", ELBOW_WEIGHT), ("wrist_yaw_link", 1.0)):
                    b = self.body[f"{side}_{part}"]
                    mujoco.mj_jacBody(self.m, d, jp, None, b)
                    rows.append(w * jp.copy())
                    errs.append(w * (targets[f"{side}_{part}"] - d.xpos[b]))
                cols = self._cols(side, ARM)
                self._step(q, cols, np.vstack(rows), np.concatenate(errs), 1e-4, rest[[c + 1 for c in cols]], 2e-4)

    def fit(self, human: dict[str, np.ndarray], rest_pose: dict[str, np.ndarray], fps: float) -> np.ndarray:
        """Reference qpos (frames, 36) for a planted stretch of human points: LEAD_IN seconds from the standing pose
        to the stretch's first frame, then the stretch. `rest_pose` is the same skeleton's points with every channel
        at zero, which says how its trunk stands when nothing leans."""
        h = {k: np.array(v, dtype=float) for k, v in human.items()}
        n = len(h["pelvis"])
        # Face the person along x, with the middle of the ankles at the origin, as the stretch starts.
        left0 = (h["left_hip"] - h["right_hip"])[: max(1, int(fps / 2))].mean(axis=0)
        heading = math.atan2(left0[1], left0[0]) - math.pi / 2
        turn = _yaw(np.array(-heading))
        mid0 = 0.5 * (h["left_ankle"][0] + h["right_ankle"][0])
        floor = 0.5 * (np.percentile(h["left_ankle"][:, 2], 2) + np.percentile(h["right_ankle"][:, 2], 2))
        origin = np.array([mid0[0], mid0[1], floor])
        h = {k: (v - origin) @ turn.T for k, v in h.items()}

        # The pelvis: height as a share of standing height, sway from the middle of the ankles, and its turn.
        stand_h = float(np.percentile(h["pelvis"][:, 2], 95))
        scale = self.pelvis_stand / stand_h
        z = np.clip(self.feet["left"][2] + self.pelvis_stand * h["pelvis"][:, 2] / stand_h, *PELVIS_Z)
        z = _smooth(z[:, None], fps, SWAY_SMOOTH)[:, 0]
        mid = 0.5 * (h["left_ankle"][:, :2] + h["right_ankle"][:, :2])
        sway = _smooth((h["pelvis"][:, :2] - mid - np.median(h["pelvis"][:, :2] - mid, axis=0)) * scale, fps, SWAY_SMOOTH)
        sway = SWAY_MAX * np.tanh(sway / SWAY_MAX)
        hips = h["left_hip"] - h["right_hip"]
        pelvis_yaw = np.unwrap(np.arctan2(hips[:, 1], hips[:, 0]) - math.pi / 2)
        pelvis_yaw_robot = np.clip(_smooth(pelvis_yaw[:, None], fps, SWAY_SMOOTH)[:, 0], -PELVIS_YAW, PELVIS_YAW)

        # The trunk: its frame against the rest pose's, in the robot pelvis's frame, as waist yaw, roll and pitch.
        frames = lambda p: _frames_of(p["neck"] - p["pelvis"], p["left_shoulder"] - p["right_shoulder"])  # noqa: E731
        trunk = frames(h) @ frames(rest_pose)[0].T
        rel = np.swapaxes(_yaw(pelvis_yaw_robot), -1, -2) @ trunk
        waist = np.stack([np.arctan2(-rel[:, 0, 1], rel[:, 1, 1]), np.arcsin(np.clip(rel[:, 2, 1], -1, 1)),
                          np.arctan2(-rel[:, 2, 0], rel[:, 2, 2])], axis=1)
        waist = np.clip(_smooth(waist, fps), [-w for w in WAIST], WAIST)

        arm_scale = {s: (self.upper_arm / np.linalg.norm(h[f"{s}_elbow"] - h[f"{s}_shoulder"], axis=1).mean(),
                         self.forearm / np.linalg.norm(h[f"{s}_wrist"] - h[f"{s}_elbow"], axis=1).mean()) for s in ("left", "right")}
        lead = int(round(LEAD_IN * fps))
        ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, lead + 1))[:-1]
        out = np.zeros((lead + n, len(self.stand)))
        q = self.stand.copy()
        q[[self.adr["left_knee_joint"], self.adr["right_knee_joint"]]] = 0.3
        q[[self.adr["left_hip_pitch_joint"], self.adr["right_hip_pitch_joint"]]] = -0.15
        q[[self.adr["left_ankle_pitch_joint"], self.adr["right_ankle_pitch_joint"]]] = -0.15
        shift = np.zeros(2)
        waist_adr = [self.adr[f"waist_{a}_joint"] for a in ("yaw", "roll", "pitch")]
        arm_adr = [self.adr[f"{s}_{j}_joint"] for s in ("left", "right") for j in ARM]

        def pose(i: int, part: float, start: bool, arms: np.ndarray | None) -> None:
            """Frame `i` of the stretch, `part` of the way from the standing pose to it, into `q`. With `arms`, the
            arm joints are those angles; without, they follow the person's elbows and wrists."""
            nonlocal shift
            yaw = part * pelvis_yaw_robot[i]
            q[3:7] = [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]
            q[waist_adr] = part * waist[i]
            # Never quite the standing pose's straight legs: there the leg fit has no single answer.
            q[2] = PELVIS_Z[1] + part * (z[i] - PELVIS_Z[1])
            if arms is not None:
                q[arm_adr] = arms
            for _ in range(6 if start else 2):
                q[:2] = self.support - [0.03, 0.0] + part * sway[i] + shift
                self._legs(q, 12 if start else 4)
                if arms is None:
                    d = self._set(q)
                    targets = {}
                    for s in ("left", "right"):
                        shoulder = d.xpos[self.body[f"{s}_shoulder_pitch_link"]]
                        targets[f"{s}_elbow_link"] = shoulder + arm_scale[s][0] * (h[f"{s}_elbow"][i] - h[f"{s}_shoulder"][i])
                        targets[f"{s}_wrist_yaw_link"] = targets[f"{s}_elbow_link"] + arm_scale[s][1] * (h[f"{s}_wrist"][i] - h[f"{s}_elbow"][i])
                    self._arms(q, targets, self.stand if start else last, 30 if start else 6)
                # Move the pelvis until the centre of mass is over the feet.
                com = self._set(q).subtree_com[0][:2] - self.support
                over = com - np.clip(com, [COM_BOX[0][0], COM_BOX[1][0]], [COM_BOX[0][1], COM_BOX[1][1]])
                shift -= over
                if np.linalg.norm(over) < 0.002:
                    break
            self._legs(q, 4)

        # The first frame, to know the arms the lead-in ends at; then the lead-in; then the stretch.
        last = self.stand.copy()
        pose(0, 1.0, True, None)
        first_arms, first_shift = q[arm_adr].copy(), shift.copy()
        shift = np.zeros(2)
        for k in range(lead):
            pose(0, float(ramp[k]), k == 0, self.stand[arm_adr] + ramp[k] * (first_arms - self.stand[arm_adr]))
            out[k] = q
        shift = first_shift
        for i in range(n):
            pose(i, 1.0, False, None)
            out[lead + i] = last = q.copy()
        out[:, 7:] = _smooth(out[:, 7:], fps)
        out[:, :3] = _smooth(out[:, :3], fps)
        return out


# --- a clip to a reference -----------------------------------------------------------------------

FIT_FPS = 30


def make_fitter() -> Fitter:
    from sim.g1.control import JOINT_NAMES, STAND_QPOS
    from sim.g1.scene import build_track_model

    return Fitter(build_track_model(), np.array(STAND_QPOS, dtype=float), tuple(JOINT_NAMES))


def read_clip(asf: Path, amc: Path, fps: int = FIT_FPS) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    """(a clip's points per frame at `fps`, the skeleton's rest pose points)."""
    skeleton = Skeleton(asf)
    return human_points(skeleton, skeleton.read_amc(amc, every=CMU_FPS // fps)), human_points(skeleton)


def fit_clip(asf: Path, amc: Path, start: float, seconds: float, fitter: Fitter | None = None, fps: int = FIT_FPS) -> np.ndarray:
    """The reference poses (frames, 36) for `seconds` of a clip from `start`: the lead-in, then the stretch."""
    points, rest = read_clip(asf, amc, fps)
    a = int(round(start * fps))
    b = min(a + int(round(seconds * fps)) + 1, len(points["pelvis"]))
    return (fitter or make_fitter()).fit({k: v[a:b] for k, v in points.items()}, rest, fps)
