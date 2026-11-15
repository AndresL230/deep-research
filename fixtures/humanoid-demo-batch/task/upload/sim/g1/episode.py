"""Run one strike episode with a controller file and score it.

Controller protocol
-------------------
A controller is a Python file defining a class `Controller` with:

    reset(self, task: dict) -> None
        Called once before the first step. task = {"bag_pos": [x, y, z], "bag_radius": 0.09, "rope_length": 0.8,
        "strike_distance": 0.2, "control_hz": 50, "max_time": 10.0}. bag_pos is where the bag's centre hangs at
        rest; the real one can differ by a few millimeters (see "Seed noise"), obs["bag_pos"] has the true value.

    act(self, obs: dict) -> sequence of 29 floats, or None
        Called every control step (50 Hz). Returns the 29 joint angle targets (radians), in the order of
        sim.g1.control.JOINT_NAMES. Values are clipped to the joint limits.
        Return None, or set `self.done = True`, to say the controller is finished (see "Stopping").

obs keys (numpy arrays are copies, changing them has no effect):
    qpos        (36,) the robot's pose: pelvis xyz, pelvis quaternion wxyz, 29 joint angles
    qvel        (35,) its velocities: pelvis linear xyz, angular xyz, 29 joint speeds
    com         (3,)  world xyz of the robot's centre of mass
    com_vel     (3,)  its velocity
    left_foot, right_foot, left_toe, right_toe, left_hand, right_hand, pelvis
                (3,)  world xyz of the named points of sim.g1.control.POINTS, as they really are
    left_foot_down, right_foot_down   bool, whether that foot touches the floor
    tilt_deg    float, how far the torso leans from upright
    bag_pos     (3,)  world xyz of the bag's centre now
    bag_moved   float, how far the bag's centre is from where it hung at the start, meters
    time        float, sim seconds since the start
    task        dict, same as in reset

Physics runs at the model timestep (0.002 s), 10 physics steps per act.

Seed noise
----------
`seed` feeds np.random.default_rng(seed). It moves the bag by up to 5 mm in x, y and z (uniform) and adds up to
0.005 rad (uniform) to each initial joint angle. Same seed, same episode, bit for bit.

Stopping
--------
The episode runs until the first of:
  * "controller_done": the controller signalled done; physics then continues with the last command for 1 s
    more (never past max_time), so a robot that is still falling is scored where it ends;
  * "fell": the robot fell (see below); physics stops 0.5 s later;
  * "max_time": max_time sim seconds have passed;
  * "exception" / "physics_error": the controller raised, returned a bad action, or the sim blew up.

Scoring
-------
    success       struck and not fell, no exception
    struck        the bag's centre swung at least 0.2 m (strike_distance) away from where it hung, at any time
    touched       some part of the robot touched the bag
    struck_with   the part that touched the bag first: "right hand", "left foot", "right leg", "torso", ... or None
    fell          at any time the pelvis was below 0.45 m, the torso leaned more than 50 degrees, or a part of
                  the robot other than its feet touched the floor
    bag_peak_cm   the furthest the bag's centre got from where it hung, cm
    standing      at the end: not fell and both feet on the floor
    time_taken    sim seconds when the episode stopped
    exception     None, or "TypeName: message" plus a short traceback tail
plus bag_pos, bag_start_actual, seed and a few diagnostics (end_reason, pelvis_min_z, max_tilt_deg).

A strike only counts when the robot is still on its feet afterwards: a hit that knocks the robot over is a failure.
"""

from __future__ import annotations

import importlib.util
import sys
import traceback
import uuid
from pathlib import Path

import mujoco
import numpy as np

from sim.g1.control import CONTROL_DT, CONTROL_HZ, POINTS
from sim.g1.motion import DECIMALS, FORMAT, MOTION_FPS, round_list
from sim.g1.scene import BAG_RADIUS, MODEL_ID, ROBOT_NQ, ROBOT_NV, ROPE_LENGTH, build_model

MAX_TIME = 10.0
STRIKE_DISTANCE = 0.20  # m the bag's centre must swing from rest
FALL_PELVIS_Z = 0.45  # m
FALL_TILT_DEG = 50.0
AFTER_DONE_TIME = 1.0  # s of extra physics after the controller signals done
AFTER_FALL_TIME = 0.5  # s of extra physics after a fall, so the recording shows it
BAG_JITTER = 0.005  # m
QPOS_JITTER = 0.005  # rad

# What touched the bag, in words, by the body's name.
_PART_WORDS = (("wrist", "hand"), ("elbow", "arm"), ("shoulder", "arm"), ("ankle", "foot"), ("knee", "leg"),
               ("hip", "leg"))


def part_name(body: str) -> str:
    """A robot body as a part in words: "right_wrist_yaw_link" is "right hand", "torso_link" is "torso"."""
    side = "left " if body.startswith("left_") else "right " if body.startswith("right_") else ""
    for key, word in _PART_WORDS:
        if key in body:
            return side + word
    return "pelvis" if "pelvis" in body else "torso"


def _format_exception(exc: BaseException) -> str:
    """'TypeName: message' plus the last two traceback frames, at most ~800 characters."""
    head = f"{type(exc).__name__}: {exc}"
    tail = "".join(traceback.format_tb(exc.__traceback__)[-2:]).rstrip()
    text = head if not tail else f"{head}\n{tail}"
    return text[:800]


def load_controller(path) -> object:
    """Import the .py file at `path` and return an instance of its `Controller` class.

    The file's folder is put on sys.path so it can import sibling modules. Raises whatever the import
    raises (SyntaxError, ImportError, ...) or AttributeError if there is no Controller class.
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
    """The model and state of one episode, with the readings the episode loop needs."""

    def __init__(self, bag_pos, rng: np.random.Generator):
        self.bag_start = np.array(bag_pos, dtype=float) + rng.uniform(-BAG_JITTER, BAG_JITTER, size=3)
        self.model = m = build_model(self.bag_start)
        self.data = d = mujoco.MjData(m)
        stand = m.key_qpos[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "stand")] if m.nkey else None
        if stand is None or len(stand) != m.nq:
            # The keyframe was written for the robot alone: fill the robot's part and leave the bag at rest.
            from sim.g1.control import stand_qpos

            d.qpos[:ROBOT_NQ] = stand_qpos()
            d.qpos[ROBOT_NQ:] = [1.0, 0.0, 0.0, 0.0]
        else:
            d.qpos[:] = stand
        d.ctrl[:] = d.qpos[7:ROBOT_NQ]
        d.qpos[7:ROBOT_NQ] += rng.uniform(-QPOS_JITTER, QPOS_JITTER, size=m.nu)
        self.ctrl_lo, self.ctrl_hi = m.actuator_ctrlrange[:, 0].copy(), m.actuator_ctrlrange[:, 1].copy()
        self.n_substeps = int(round(CONTROL_DT / m.opt.timestep))
        self.floor = m.geom("floor").id
        self.bag_geom = m.geom("bag").id
        self.bag_site = m.site("bag_center").id
        self.torso = m.body("torso_link").id
        self.point_body = {name: m.body(body).id for name, (body, _) in POINTS.items()}
        self.point_offset = {name: np.array(off) for name, (_, off) in POINTS.items()}
        feet = {m.body("left_ankle_roll_link").id: "left", m.body("right_ankle_roll_link").id: "right"}
        self.foot_of_geom = {g: feet[int(m.geom_bodyid[g])] for g in range(m.ngeom) if int(m.geom_bodyid[g]) in feet}
        bag_body = m.body("bag").id
        self.robot_geom = {g for g in range(m.ngeom) if int(m.geom_bodyid[g]) not in (0, bag_body)}
        mujoco.mj_forward(m, d)

    def point(self, name: str) -> np.ndarray:
        b = self.point_body[name]
        return self.data.xpos[b] + self.data.xmat[b].reshape(3, 3) @ self.point_offset[name]

    def bag_pos(self) -> np.ndarray:
        return self.data.site_xpos[self.bag_site].copy()

    def tilt_deg(self) -> float:
        """Angle between the torso's up axis and the world's, degrees."""
        up_z = float(self.data.xmat[self.torso].reshape(3, 3)[2, 2])
        return float(np.degrees(np.arccos(np.clip(up_z, -1.0, 1.0))))

    def contacts(self) -> tuple[set[str], bool, str | None]:
        """(feet on the floor, whether another robot part touches the floor, the robot body touching the bag)."""
        m, d = self.model, self.data
        feet: set[str] = set()
        other_on_floor = False
        on_bag = None
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            for a, b in ((g1, g2), (g2, g1)):
                if a == self.floor and b in self.robot_geom:
                    if b in self.foot_of_geom:
                        feet.add(self.foot_of_geom[b])
                    else:
                        other_on_floor = True
                if a == self.bag_geom and b in self.robot_geom and on_bag is None:
                    on_bag = m.body(int(m.geom_bodyid[b])).name
        return feet, other_on_floor, on_bag


def task_dict(bag_pos, max_time: float = MAX_TIME) -> dict:
    return {
        "bag_pos": [float(v) for v in bag_pos[:3]],
        "bag_radius": BAG_RADIUS,
        "rope_length": ROPE_LENGTH,
        "strike_distance": STRIKE_DISTANCE,
        "control_hz": CONTROL_HZ,
        "max_time": float(max_time),
    }


def run_episode(
    controller_path,
    bag_pos,
    seed: int = 0,
    max_time: float = MAX_TIME,
    record: bool = True,
    motion_fps: int = MOTION_FPS,
    motion_decimals: int = DECIMALS,
) -> tuple[dict, dict | None]:
    """Run one episode and return (result, motion). motion is None when record is False.

    `motion_fps` and `motion_decimals` set the recording's frame rate and rounding; they never change the episode.

    Never raises because of the controller: load errors, exceptions in reset/act, bad actions and physics
    blow-ups all end the episode as a failure with result["exception"] set.
    See the module docstring for the protocol, stopping rule and scoring.
    """
    bag_pos = [float(v) for v in bag_pos[:3]]
    max_time = float(max_time)
    rng = np.random.default_rng(seed)
    sim = _Sim(bag_pos, rng)
    m, d = sim.model, sim.data
    task = task_dict(bag_pos, max_time)

    frames: list[dict] = []
    frame_every = max(1, int(round(1.0 / (motion_fps * m.opt.timestep))))
    step_count = 0

    def capture() -> None:
        frames.append({
            "t": round(float(d.time), 4),
            "qpos": round_list(d.qpos, motion_decimals),
            "bag": round_list(sim.bag_pos(), motion_decimals),
        })

    if record:
        capture()

    exception = None
    end_reason = "max_time"
    controller = None
    try:
        controller = load_controller(controller_path)
        controller.reset(dict(task))
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, KeyboardInterrupt):
            raise
        exception = _format_exception(exc)
        end_reason = "exception"

    done_at: float | None = None
    fell_at: float | None = None
    peak = 0.0
    touched = False
    struck_with: str | None = None
    pelvis_min = float(d.qpos[2])
    max_tilt = 0.0
    feet_down: set[str] = {"left", "right"}
    n_steps = int(round(max_time / CONTROL_DT))
    com_jac = np.zeros((3, m.nv))

    for _ in range(n_steps if exception is None else 0):
        if done_at is None and fell_at is None:
            mujoco.mj_jacSubtreeCom(m, d, com_jac, 1)
            obs = {
                "qpos": d.qpos[:ROBOT_NQ].copy(),
                "qvel": d.qvel[:ROBOT_NV].copy(),
                "com": d.subtree_com[1].copy(),
                "com_vel": com_jac @ d.qvel,
                **{name: sim.point(name).copy() for name in POINTS},
                "left_foot_down": "left" in feet_down,
                "right_foot_down": "right" in feet_down,
                "tilt_deg": sim.tilt_deg(),
                "bag_pos": sim.bag_pos(),
                "bag_moved": float(np.linalg.norm(sim.bag_pos() - sim.bag_start)),
                "time": float(d.time),
                "task": dict(task),
            }
            try:
                action = controller.act(obs)
                if action is None or getattr(controller, "done", False):
                    done_at = float(d.time)
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
            mujoco.mj_step(m, d)
            step_count += 1
            unstable = not np.all(np.isfinite(d.qpos)) or d.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0
            if unstable:
                break
            if record and step_count % frame_every == 0:
                capture()
        if unstable:
            exception = "PhysicsError: simulation became unstable (non-finite state)"
            end_reason = "physics_error"
            break

        feet_down, other_on_floor, on_bag = sim.contacts()
        if on_bag is not None:
            touched = True
            if struck_with is None:
                struck_with = part_name(on_bag)
        peak = max(peak, float(np.linalg.norm(sim.bag_pos() - sim.bag_start)))
        pelvis_min = min(pelvis_min, float(d.qpos[2]))
        tilt = sim.tilt_deg()
        max_tilt = max(max_tilt, tilt)
        if fell_at is None and (other_on_floor or d.qpos[2] < FALL_PELVIS_Z or tilt > FALL_TILT_DEG):
            fell_at = float(d.time)
        if fell_at is not None and d.time - fell_at >= AFTER_FALL_TIME:
            end_reason = "fell"
            break
        if done_at is not None and d.time - done_at >= AFTER_DONE_TIME:
            end_reason = "controller_done"
            break

    if record and (not frames or frames[-1]["t"] < round(float(d.time), 4)):
        capture()

    fell = fell_at is not None
    struck = peak >= STRIKE_DISTANCE
    result = {
        "success": bool(exception is None and struck and not fell),
        "struck": bool(struck),
        "touched": bool(touched),
        "struck_with": struck_with,
        "fell": bool(fell),
        "bag_peak_cm": round(peak * 100, 1),
        "standing": bool(not fell and feet_down == {"left", "right"}),
        "time_taken": round(float(d.time), 3),
        "exception": exception,
        "bag_pos": list(bag_pos),
        "seed": seed,
        "end_reason": end_reason,
        "fell_at": None if fell_at is None else round(fell_at, 3),
        "pelvis_min_z": round(pelvis_min, 3),
        "max_tilt_deg": round(max_tilt, 1),
        "bag_start_actual": round_list(sim.bag_start),
    }

    motion = None
    if record:
        motion = {
            "format": FORMAT,
            "header": {
                "model_id": MODEL_ID,
                "joint_names": [m.joint(j).name for j in range(m.njnt)],
                "actuator_names": [m.actuator(a).name for a in range(m.nu)],
                "bag_pos": list(bag_pos),
                "fps": int(motion_fps),
                "nq": int(m.nq),
                "nu": int(m.nu),
                "qpos_layout": "pelvis xyz + quat wxyz, 29 joint angles, the bag's ball joint quat wxyz",
                "seed": seed,
                "dt": round(1.0 / motion_fps, 6),
            },
            "frames": frames,
            "result": result,
        }
    return result, motion
