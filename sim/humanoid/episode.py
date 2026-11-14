"""Run one push recovery episode with a controller file and score it.

Controller protocol
-------------------
A controller is a Python file defining a class `Controller` with:

    reset(self, task: dict) -> None
        Called once before the first step. task = {"control_hz": 50, "max_time": 5.0, "joints": [29 names]}.
        The push is not in it: the controller only sees the robot's own state, in obs.

    act(self, obs: dict) -> sequence of 29 floats, or None
        Called every control step (50 Hz). Returns one target angle (radians) per joint, in the order of
        `sim.humanoid.control.JOINTS`; each joint's position servo pulls toward it. Values are clipped to the joint
        limits. Return None to keep the previous targets.

obs keys (numpy arrays are copies, changing them has no effect):
    qpos          (36,) pelvis position xyz, pelvis orientation quaternion wxyz, then the 29 joint angles
    qvel          (35,) pelvis linear velocity xyz, pelvis angular velocity xyz, then the 29 joint velocities
    joint_pos     (29,) the joint angles (qpos[7:]), in JOINTS order
    joint_vel     (29,) the joint velocities (qvel[6:])
    com           (3,)  world xyz of the robot's center of mass (standing: about 0.69 m high, over the ankles)
    com_vel       (3,)  its velocity, m/s
    pelvis_pos    (3,)  world xyz of the pelvis
    pelvis_quat   (4,)  pelvis orientation, wxyz
    torso_quat    (4,)  torso orientation, wxyz
    torso_angvel  (3,)  torso angular velocity, rad/s, world axes
    left_foot     (3,)  world xyz of the left ankle (the foot's origin; the sole is 0.03 m below it)
    right_foot    (3,)  world xyz of the right ankle
    foot_contact  (2,)  bools: the left / right foot touches the floor
    time          float, sim seconds since the start
    task          dict, same as in reset

Physics runs at the model timestep (0.002 s), round(CONTROL_DT / timestep) = 10 physics steps per act.

The push
--------
A push is {"angle_deg", "force_n"}: a horizontal force of force_n newtons on the torso (at its center of mass),
pointing angle_deg degrees counterclockwise from +x seen from above (0 pushes the robot forward, 90 to its left, 180
backward, 270 to its right), for PUSH_DURATION s starting at about PUSH_TIME s.

Seed noise
----------
`seed` feeds np.random.default_rng(seed). It adds up to 0.01 rad (uniform) to each initial joint angle and moves the
push start by up to 0.1 s either way. The servo targets start at the standing pose without noise. Same seed, same
episode, bit for bit.

Stopping
--------
The episode runs until max_time (5 s), or FALL_GRACE s after the robot fell (so the recording shows it land), or the
controller raises or returns a bad action, or the simulation blows up.

Scoring (sim/humanoid/outcome.py has the rule in one place)
-----------------------------------------------------------
    fell               the pelvis went below 0.45 m, or a part of the robot other than the feet touched the floor
    stumbled           did not fall, but a foot moved more than 3 cm (horizontally, from its place when the push began)
                       or the torso tilted more than 10 degrees from vertical at some moment
    outcome            "upright", "stumbled", "fell" or "error" (an exception)
    success            not fell and no exception: the robot is still on its feet at the end (upright or stumbled)
plus fall_time, touched (the first body other than a foot that touched the floor), max_tilt_deg, final_tilt_deg,
max_foot_shift_cm, min_pelvis_height, push, push_time, seed, time_taken, exception and end_reason.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import traceback
import uuid
from pathlib import Path

import mujoco
import numpy as np

from sim.humanoid.control import CONTROL_DT, CONTROL_HZ, JOINTS, STAND_CTRL, tilt_deg
from sim.humanoid.motion import DECIMALS, FORMAT, MOTION_FPS, round_list
from sim.humanoid.outcome import FALL_HEIGHT_M, STUMBLE_FOOT_SHIFT_M, STUMBLE_TILT_DEG, outcome, push_dict
from sim.humanoid.scene import FLOOR_GEOM, FOOT_BODIES, MODEL_ID, PUSH_BODY, build_model

MAX_TIME = 5.0
PUSH_TIME = 1.5  # s, nominal start of the push
PUSH_TIME_JITTER = 0.1  # s, uniform either way, per seed
PUSH_DURATION = 0.2  # s
QPOS_JITTER = 0.01  # rad
FALL_GRACE = 1.0  # s of physics after a fall, so the recording shows the robot land


def _format_exception(exc: BaseException) -> str:
    """'TypeName: message' plus the last two traceback frames, at most ~800 characters."""
    head = f"{type(exc).__name__}: {exc}"
    tail = "".join(traceback.format_tb(exc.__traceback__)[-2:]).rstrip()
    text = head if not tail else f"{head}\n{tail}"
    return text[:800]


def load_controller(path) -> object:
    """Import the .py file at `path` and return an instance of its `Controller` class.

    The file's folder is put on sys.path so it can import sibling modules. Raises whatever the import raises
    (SyntaxError, ImportError, ...) or AttributeError if there is no Controller class.
    """
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"controller file not found: {path}")
    folder = str(path.parent)
    if folder not in sys.path:
        sys.path.append(folder)
    name = f"_controller_{path.stem}_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cls = getattr(module, "Controller", None)
    if cls is None or not isinstance(cls, type):
        raise AttributeError(f"{path.name} does not define a class named Controller")
    return cls()


class _Sim:
    """Model, data and the lookups the episode loop needs."""

    def __init__(self, rng: np.random.Generator):
        self.model = build_model()
        m = self.model
        self.data = mujoco.MjData(m)
        d = self.data
        mujoco.mj_resetDataKeyframe(m, d, m.key("stand").id)
        d.qpos[7:] += rng.uniform(-QPOS_JITTER, QPOS_JITTER, size=m.nq - 7)
        d.ctrl[:] = STAND_CTRL
        mujoco.mj_forward(m, d)
        self.pelvis = m.body("pelvis").id
        self.torso = m.body(PUSH_BODY).id
        self.floor = m.geom(FLOOR_GEOM).id
        feet = [m.body(b).id for b in FOOT_BODIES]
        self.foot_ids = feet
        self.foot_sites = [m.site("left_foot").id, m.site("right_foot").id]
        self.foot_geoms = [{g for g in range(m.ngeom) if m.geom_bodyid[g] == f} for f in feet]
        self.n_substeps = max(1, int(round(CONTROL_DT / m.opt.timestep)))
        self.ctrl_lo = m.actuator_ctrlrange[:, 0].copy()
        self.ctrl_hi = m.actuator_ctrlrange[:, 1].copy()

    def feet(self) -> np.ndarray:
        return np.array([self.data.site_xpos[s].copy() for s in self.foot_sites])

    def torso_tilt(self) -> float:
        return tilt_deg(self.data.xquat[self.torso])

    def floor_contacts(self) -> tuple[list[bool], str | None]:
        """(each foot touches the floor, the name of a body other than the feet that touches it, or None)."""
        m, d = self.model, self.data
        on = [False, False]
        other = None
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if g1 == self.floor:
                g = g2
            elif g2 == self.floor:
                g = g1
            else:
                continue
            if g in self.foot_geoms[0]:
                on[0] = True
            elif g in self.foot_geoms[1]:
                on[1] = True
            elif other is None:
                other = m.body(int(m.geom_bodyid[g])).name
        return on, other

    def obs(self, task: dict) -> dict:
        m, d = self.model, self.data
        mujoco.mj_forward(m, d)
        mujoco.mj_subtreeVel(m, d)
        contact, _ = self.floor_contacts()
        feet = self.feet()
        return {
            "qpos": d.qpos.copy(),
            "qvel": d.qvel.copy(),
            "joint_pos": d.qpos[7:].copy(),
            "joint_vel": d.qvel[6:].copy(),
            "com": d.subtree_com[self.pelvis].copy(),
            "com_vel": d.subtree_linvel[self.pelvis].copy(),
            "pelvis_pos": d.qpos[:3].copy(),
            "pelvis_quat": d.qpos[3:7].copy(),
            "torso_quat": d.xquat[self.torso].copy(),
            "torso_angvel": d.cvel[self.torso][:3].copy(),
            "left_foot": feet[0],
            "right_foot": feet[1],
            "foot_contact": np.array(contact, dtype=bool),
            "time": float(d.time),
            "task": dict(task),
        }


def run_episode(
    controller_path,
    push,
    seed: int = 0,
    max_time: float = MAX_TIME,
    record: bool = True,
    motion_fps: int = MOTION_FPS,
    motion_decimals: int = DECIMALS,
) -> tuple[dict, dict | None]:
    """Run one episode with `push` ({"angle_deg", "force_n"} or a pair) and return (result, motion).

    motion is None when record is False. `motion_fps` and `motion_decimals` set the recording's frame rate and
    rounding (sim/MOTION_FORMAT.md); they never change the episode itself.

    Never raises because of the controller: load errors, exceptions in reset/act, bad actions and physics blow-ups all
    end the episode as a failure with result["exception"] set. See the module docstring for the rest.
    """
    push = push_dict(push)
    max_time = float(max_time)
    rng = np.random.default_rng(seed)
    sim = _Sim(rng)
    m, d = sim.model, sim.data
    push_time = PUSH_TIME + float(rng.uniform(-PUSH_TIME_JITTER, PUSH_TIME_JITTER))
    angle = math.radians(push["angle_deg"])
    force = np.array([push["force_n"] * math.cos(angle), push["force_n"] * math.sin(angle), 0.0])
    task = {"control_hz": CONTROL_HZ, "max_time": max_time, "joints": list(JOINTS)}

    frames: list[dict] = []
    next_frame_t = 0.0

    def capture() -> None:
        mujoco.mj_kinematics(m, d)
        mujoco.mj_comPos(m, d)
        frames.append(
            {
                "t": round(float(d.time), 4),
                "qpos": round_list(d.qpos, motion_decimals),
                "ctrl": round_list(d.ctrl, motion_decimals),
                "com": round_list(d.subtree_com[sim.pelvis], motion_decimals),
                "feet": round_list(sim.feet().reshape(-1), motion_decimals),
            }
        )

    def maybe_capture() -> None:
        nonlocal next_frame_t
        if record and d.time + 1e-9 >= next_frame_t:
            capture()
            next_frame_t += 1.0 / motion_fps

    exception: str | None = None
    end_reason = "max_time"
    controller = None
    maybe_capture()
    try:
        controller = load_controller(controller_path)
        controller.reset(dict(task))
    except BaseException as exc:  # noqa: BLE001 - any controller failure is a scored failure
        if isinstance(exc, KeyboardInterrupt):
            raise
        exception = _format_exception(exc)
        end_reason = "exception"

    fall_time: float | None = None
    touched: str | None = None
    max_tilt = sim.torso_tilt()
    min_pelvis = float(d.qpos[2])
    feet_at_push: np.ndarray | None = None
    max_shift = 0.0
    n_steps = int(math.floor(max_time / CONTROL_DT + 1e-9))
    for _ in range(n_steps if exception is None else 0):
        obs = sim.obs(task)
        try:
            action = controller.act(obs)
            if action is not None:
                arr = np.asarray(action, dtype=float).reshape(-1)
                if arr.shape != (m.nu,):
                    raise ValueError(f"act() must return {m.nu} numbers, got shape {np.shape(action)}")
                if not np.all(np.isfinite(arr)):
                    raise ValueError(f"act() returned non-finite values: {arr.tolist()}")
                d.ctrl[:] = np.clip(arr, sim.ctrl_lo, sim.ctrl_hi)
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, KeyboardInterrupt):
                raise
            exception = _format_exception(exc)
            end_reason = "exception"
            break

        unstable = False
        for _ in range(sim.n_substeps):
            pushing = push_time <= d.time < push_time + PUSH_DURATION
            d.xfrc_applied[sim.torso, :3] = force if pushing else 0.0
            if pushing and feet_at_push is None:
                mujoco.mj_kinematics(m, d)
                feet_at_push = sim.feet()
            mujoco.mj_step(m, d)
            if not np.all(np.isfinite(d.qpos)) or d.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0:
                unstable = True
                break
            maybe_capture()
        if unstable:
            exception = "PhysicsError: simulation became unstable (non-finite state)"
            end_reason = "physics_error"
            break

        mujoco.mj_kinematics(m, d)
        max_tilt = max(max_tilt, sim.torso_tilt())
        min_pelvis = min(min_pelvis, float(d.qpos[2]))
        if feet_at_push is not None:
            shift = np.linalg.norm((sim.feet() - feet_at_push)[:, :2], axis=1)
            max_shift = max(max_shift, float(shift.max()))
        if fall_time is None:
            _, other = sim.floor_contacts()
            if other is not None or d.qpos[2] < FALL_HEIGHT_M:
                fall_time = float(d.time)
                touched = other
        if fall_time is not None and d.time - fall_time >= FALL_GRACE - 1e-9:
            end_reason = "fell"
            break

    if record and (not frames or frames[-1]["t"] < round(float(d.time), 4)):
        capture()

    mujoco.mj_kinematics(m, d)
    finite = bool(np.all(np.isfinite(d.qpos)))
    fell = fall_time is not None
    stumbled = bool(not fell and (max_tilt > STUMBLE_TILT_DEG or max_shift > STUMBLE_FOOT_SHIFT_M))
    result = {
        "success": bool(exception is None and not fell),
        "outcome": "",
        "fell": fell,
        "stumbled": stumbled,
        "fall_time": None if fall_time is None else round(fall_time, 3),
        "touched": touched,
        "max_tilt_deg": round(max_tilt, 1) if finite else None,
        "final_tilt_deg": round(sim.torso_tilt(), 1) if finite else None,
        "max_foot_shift_cm": round(max_shift * 100, 2),
        "min_pelvis_height": round(min_pelvis, 3) if finite else None,
        "push": dict(push, time_s=round(push_time, 4), duration_s=PUSH_DURATION),
        "push_time": round(push_time, 4),
        "seed": seed,
        "time_taken": round(float(d.time), 3),
        "exception": exception,
        "end_reason": end_reason,
    }
    result["outcome"] = outcome(result)

    motion = None
    if record:
        motion = {
            "format": FORMAT,
            "header": {
                "model_id": MODEL_ID,
                "joint_names": [m.joint(j).name for j in range(m.njnt)],
                "actuator_names": [m.actuator(a).name for a in range(m.nu)],
                "push": dict(result["push"]),
                "fps": int(motion_fps),
                "nq": int(m.nq),
                "nu": int(m.nu),
                "qpos_layout": "pelvis xyz + quat wxyz, then the 29 joints in actuator order",
                "seed": seed,
                "dt": round(1.0 / motion_fps, 6),
            },
            "frames": frames,
            "result": result,
        }
    return result, motion
