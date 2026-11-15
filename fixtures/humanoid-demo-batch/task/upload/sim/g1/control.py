"""Helpers for writing a whole-body controller for the Unitree G1.

Import these inside your controller file:

    from sim.g1.control import WholeBody, ComFeedback, STAND_QPOS, CONTROL_DT

Conventions
-----------
* World frame: z up, the floor is z = 0, the robot starts at the origin facing +x, its left side is +y. Units
  are meters and radians.
* A robot pose `q` is 36 numbers: the pelvis position xyz, its quaternion wxyz, then the 29 joint angles in the
  order of JOINT_NAMES. `STAND_QPOS` is the pose every episode starts in: standing upright, arms bent at the sides.
* A control action is the 29 joint angle targets, `q[7:]`. Every joint is a position servo that moves toward its
  target; the servos are strong but not rigid, so under load a joint lags its target a little.
* The robot is not held up by anything. It stands because its centre of mass is above its feet, and it falls
  when it is not. Each foot touches the floor in a patch about 17 cm long and 6 cm wide.

Points
------
Positions are asked for and reported at named points of the body (POINTS):

    left_foot, right_foot   the middle of the sole (z = 0 when the foot stands on the floor)
    left_toe, right_toe     the front tip of the foot
    left_hand, right_hand   the fist: the end of the forearm, past the wrist
    pelvis                  the pelvis (the floating base)

and "com" is the centre of mass of the whole robot.

`WholeBody.solve` is inverse kinematics for the whole body at once: you say where some points and the centre of
mass should be, and it returns the pose `q` that comes closest, moving every joint and the pelvis together. It
plans on a private copy of the robot (no bag, no physics), so calling it never touches the simulation of an
episode: what the real robot does with the joint targets, `obs` tells you. Everything here is deterministic.
"""

from __future__ import annotations

import mujoco
import numpy as np

from sim.g1.scene import G1_SCENE

CONTROL_HZ = 50
CONTROL_DT = 1.0 / CONTROL_HZ

JOINT_NAMES = (
    "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
    "left_ankle_pitch_joint", "left_ankle_roll_joint",
    "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint", "right_knee_joint",
    "right_ankle_pitch_joint", "right_ankle_roll_joint",
    "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint",
    "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint", "left_elbow_joint",
    "left_wrist_roll_joint", "left_wrist_pitch_joint", "left_wrist_yaw_joint",
    "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint", "right_elbow_joint",
    "right_wrist_roll_joint", "right_wrist_pitch_joint", "right_wrist_yaw_joint",
)
N_JOINTS = len(JOINT_NAMES)

# A named point: the body it is fixed to and its offset in that body's frame.
POINTS: dict[str, tuple[str, tuple[float, float, float]]] = {
    "left_foot": ("left_ankle_roll_link", (0.035, 0.0, -0.035)),
    "right_foot": ("right_ankle_roll_link", (0.035, 0.0, -0.035)),
    "left_toe": ("left_ankle_roll_link", (0.13, 0.0, -0.02)),
    "right_toe": ("right_ankle_roll_link", (0.13, 0.0, -0.02)),
    "left_hand": ("left_wrist_yaw_link", (0.10, 0.0, 0.0)),
    "right_hand": ("right_wrist_yaw_link", (0.10, 0.0, 0.0)),
    "pelvis": ("pelvis", (0.0, 0.0, 0.0)),
}
# Bodies `solve` can keep level: the weight "<name>_level" holds the body's orientation as in STAND_QPOS.
LEVEL = {"left_foot": "left_ankle_roll_link", "right_foot": "right_ankle_roll_link", "torso": "torso_link"}

# What `solve` uses for a target with no weight of its own. A larger weight wins where targets disagree.
DEFAULT_WEIGHTS: dict[str, float] = {
    "left_foot": 10.0, "right_foot": 10.0, "left_toe": 6.0, "right_toe": 6.0, "left_hand": 3.0, "right_hand": 3.0,
    "pelvis": 2.0, "com": 8.0,
    # A foot with a position target is also kept flat and pointing forward; 0 lets it turn freely.
    "left_foot_level": 10.0, "right_foot_level": 10.0,
    # Always on: the torso stays upright, and every joint is pulled gently toward `posture`.
    "torso_level": 1.0, "posture": 0.1,
}

_MODEL: mujoco.MjModel | None = None
_STAND: np.ndarray | None = None


def _robot() -> mujoco.MjModel:
    """The private robot-only model used for kinematics, loaded once."""
    global _MODEL, _STAND
    if _MODEL is None:
        _MODEL = mujoco.MjModel.from_xml_path(str(G1_SCENE))
        _STAND = _MODEL.key_qpos[mujoco.mj_name2id(_MODEL, mujoco.mjtObj.mjOBJ_KEY, "stand")].copy()
        names = tuple(_MODEL.joint(j).name for j in range(1, _MODEL.njnt))
        if names != JOINT_NAMES:
            raise RuntimeError("the G1 model's joints are not in the order of JOINT_NAMES")
    return _MODEL


def stand_qpos() -> np.ndarray:
    """A fresh copy of the standing pose (36 numbers)."""
    _robot()
    return _STAND.copy()


def joint_limits() -> tuple[np.ndarray, np.ndarray]:
    """(lower, upper) angle limits of the 29 joints, radians."""
    m = _robot()
    return m.jnt_range[1:, 0].copy(), m.jnt_range[1:, 1].copy()


class _Lazy:
    """STAND_QPOS, JOINT_LOWER and JOINT_UPPER as arrays that load the model the first time they are read."""

    def __init__(self, make):
        self._make, self._value = make, None

    def _get(self) -> np.ndarray:
        if self._value is None:
            self._value = self._make()
            self._value.setflags(write=False)
        return self._value

    def __array__(self, dtype=None, copy=None):
        return np.array(self._get(), dtype=dtype)

    def __getitem__(self, key):
        return self._get()[key]

    def __len__(self) -> int:
        return len(self._get())

    def __iter__(self):
        return iter(self._get())

    def copy(self) -> np.ndarray:
        return np.array(self._get())

    def __repr__(self) -> str:
        return repr(self._get())


STAND_QPOS = _Lazy(stand_qpos)
JOINT_LOWER = _Lazy(lambda: joint_limits()[0])
JOINT_UPPER = _Lazy(lambda: joint_limits()[1])


class WholeBody:
    """Whole-body inverse kinematics and forward kinematics for the G1.

        wb = WholeBody()
        q = STAND_QPOS.copy()
        feet = wb.points(q)                      # {"left_foot": xyz, ..., "com": xyz}
        q = wb.solve(q, {"left_foot": feet["left_foot"], "right_foot": feet["right_foot"],
                         "com": feet["com"][:2], "right_hand": [0.35, -0.15, 1.0]})
        action = q[7:]

    Call `solve` every control step with the `q` it returned the step before and targets that move a little each
    step: it takes a few small steps toward the targets, so a target far from the current pose is reached over
    several calls, and a target that cannot be reached is approached as far as the others allow.
    """

    def __init__(self) -> None:
        self.model = _robot()
        self.data = mujoco.MjData(self.model)
        m = self.model
        self._body = {name: m.body(body).id for name, (body, _) in POINTS.items()}
        self._offset = {name: np.array(off, dtype=float) for name, (_, off) in POINTS.items()}
        self._level = {name: m.body(body).id for name, body in LEVEL.items()}
        self._lo, self._hi = joint_limits()
        # The orientation each `_level` body has in the standing pose.
        self._set(stand_qpos())
        self._level_quat = {name: self.data.xquat[b].copy() for name, b in self._level.items()}

    def _set(self, q) -> None:
        self.data.qpos[:] = np.asarray(q, dtype=float)
        mujoco.mj_kinematics(self.model, self.data)
        mujoco.mj_comPos(self.model, self.data)

    def _point(self, name: str) -> np.ndarray:
        b = self._body[name]
        return self.data.xpos[b] + self.data.xmat[b].reshape(3, 3) @ self._offset[name]

    def points(self, q) -> dict[str, np.ndarray]:
        """World xyz of every named point and of "com" for the pose `q`."""
        self._set(q)
        out = {name: self._point(name).copy() for name in POINTS}
        out["com"] = self.data.subtree_com[1].copy()
        return out

    def solve(self, q, targets: dict, weights: dict | None = None, posture=None, iters: int = 3,
              damping: float = 1e-2) -> np.ndarray:
        """The pose near `q` that best meets `targets`. Returns a new `q`; `q[7:]` are the joint targets to send.

        targets: {point name: [x, y, z]} for any of POINTS, and "com": [x, y] for the centre of mass over the floor.
        weights: {name: weight} to change DEFAULT_WEIGHTS for this call. Besides the target names there are
            "left_foot_level" and "right_foot_level" (used for a foot that has a "…_foot" or "…_toe" target),
            "torso_level" and "posture". A weight of 0 switches that part off.
        posture: the 29 joint angles every joint is pulled gently toward (default: the standing pose's).
        iters, damping: how many damped least squares steps are taken, and how cautious each is.

        Joint angles are kept inside their limits. Unknown names raise KeyError.
        """
        m, d = self.model, self.data
        w = dict(DEFAULT_WEIGHTS)
        if weights:
            unknown = set(weights) - set(DEFAULT_WEIGHTS)
            if unknown:
                raise KeyError(f"unknown weights {sorted(unknown)}; there are {sorted(DEFAULT_WEIGHTS)}")
            w.update({k: float(v) for k, v in weights.items()})
        unknown = set(targets) - set(POINTS) - {"com"}
        if unknown:
            raise KeyError(f"unknown targets {sorted(unknown)}; there are {sorted(POINTS) + ['com']}")
        rest = stand_qpos()[7:] if posture is None else np.asarray(posture, dtype=float).reshape(N_JOINTS)
        level = {"torso"} | {side for side in ("left_foot", "right_foot")
                             if side in targets or side.replace("foot", "toe") in targets}
        q = np.array(q, dtype=float).reshape(m.nq)
        nv = m.nv
        jp, jr = np.zeros((3, nv)), np.zeros((3, nv))
        neg, diff, rot = np.zeros(4), np.zeros(4), np.zeros(3)
        for _ in range(max(1, int(iters))):
            self._set(q)
            rows, errs = [], []
            for name, target in targets.items():
                wt = w[name]
                if wt <= 0:
                    continue
                if name == "com":
                    mujoco.mj_jacSubtreeCom(m, d, jp, 1)
                    rows.append(wt * jp[:2])
                    errs.append(wt * (np.asarray(target, dtype=float)[:2] - d.subtree_com[1][:2]))
                    continue
                p = self._point(name)
                mujoco.mj_jac(m, d, jp, None, p, self._body[name])
                rows.append(wt * jp)
                errs.append(wt * (np.asarray(target, dtype=float).reshape(3) - p))
            for name in level:
                wt = w[f"{name}_level"]
                if wt <= 0:
                    continue
                b = self._level[name]
                mujoco.mj_jacBody(m, d, None, jr, b)
                mujoco.mju_negQuat(neg, d.xquat[b])
                mujoco.mju_mulQuat(diff, self._level_quat[name], neg)
                mujoco.mju_quat2Vel(rot, diff, 1.0)
                rows.append(wt * jr)
                errs.append(wt * rot)
            if w["posture"] > 0:
                jq = np.zeros((N_JOINTS, nv))
                jq[:, 6:] = np.eye(N_JOINTS)
                rows.append(w["posture"] * jq)
                errs.append(w["posture"] * (rest - q[7:]))
            jac = np.vstack(rows)
            err = np.concatenate(errs)
            dq = np.linalg.solve(jac.T @ jac + float(damping) * np.eye(nv), jac.T @ err)
            mujoco.mj_integratePos(m, q, dq, 1.0)
            q[7:] = np.clip(q[7:], self._lo, self._hi)
        return q


class ComFeedback:
    """Balance feedback: where to ask `solve` to put the centre of mass so the real one ends where you want it.

    The real robot leans a little differently from the plan (the servos give under load), and on one foot there
    are only a few centimetres to spare. Each control step:

        com_target = fb.update(wanted_xy, obs["com"][:2])
        q = wb.solve(q, {..., "com": com_target})

    The target is the wanted position plus kp times the error, plus ki times the error summed over time, minus kd
    times the measured speed of the centre of mass; each part of the correction is limited to `limit` meters.
    """

    def __init__(self, kp: float = 4.0, ki: float = 3.0, kd: float = 0.3, limit: float = 0.08, dt: float = CONTROL_DT):
        self.kp, self.ki, self.kd, self.limit, self.dt = float(kp), float(ki), float(kd), float(limit), float(dt)
        self.reset()

    def reset(self) -> None:
        self._sum = np.zeros(2)
        self._last: np.ndarray | None = None

    def update(self, wanted_xy, measured_xy) -> np.ndarray:
        wanted = np.asarray(wanted_xy, dtype=float)[:2]
        measured = np.asarray(measured_xy, dtype=float)[:2]
        err = wanted - measured
        speed = np.zeros(2) if self._last is None else (measured - self._last) / self.dt
        self._last = measured.copy()
        self._sum = np.clip(self._sum + self.ki * err * self.dt, -self.limit, self.limit)
        return wanted + np.clip(self._sum + self.kp * err - self.kd * speed, -self.limit, self.limit)
