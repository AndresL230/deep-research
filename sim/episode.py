"""Run one pick-and-place episode with a controller file and score it.

Controller protocol
-------------------
A controller is a Python file defining a class `Controller` with:

    reset(self, task: dict) -> None
        Called once before the first step. task = {"can_start": [x, y], "place_target": [x, y],
        "control_hz": 50, "max_time": 10.0}. can_start is the nominal can position; the real one can
        differ by a few millimeters (see "Seed noise"), obs["can_pos"] has the true value.

    act(self, obs: dict) -> sequence of 8 floats, or None
        Called every control step (50 Hz). Returns 7 arm joint position targets (radians) followed by
        the gripper command (0 closed .. 255 open). Values are clipped to the actuator ranges.
        Return None, or set `self.done = True`, to say the controller is finished (see "Stopping").

obs keys (numpy arrays are copies, changing them has no effect):
    qpos      (16,) all joint positions: 7 arm, 2 fingers, can freejoint (xyz + quaternion wxyz)
    qvel      (15,) all joint velocities: 7 arm, 2 fingers, can freejoint (linear xyz + angular xyz)
    hand_pos  (3,)  world xyz of the grasp point (between the fingertips, see sim.control)
    can_pos   (3,)  world xyz of the can center (the can is 0.10 m tall, so standing it is at z = 0.05)
    can_quat  (4,)  can orientation, quaternion wxyz
    finger_width float, distance between the fingers in meters (0 closed .. 0.08 open)
    time      float, sim seconds since the start
    task      dict, same as in reset

Physics runs at the model timestep (0.002 s), round(CONTROL_DT / timestep) = 10 physics steps per act.

Seed noise
----------
`seed` feeds np.random.default_rng(seed). It moves the can start by up to 3 mm in x and y (uniform)
and adds up to 0.005 rad (uniform) to each initial arm joint angle. The arm servo targets start at the
home pose without noise. Same seed, same episode, bit for bit.

Stopping
--------
The episode runs until the first of:
  * "settled": the can has rested for 0.5 s within 3 cm of the place target, upright, standing on the
    floor, not touching the robot, with the grasp point at least 3 cm away from the can's top or side;
  * "controller_done": the controller signalled done; physics then continues with the last command for
    up to 1 s more (never past max_time) until the can stops moving, so a can that is still falling
    is scored where it lands;
  * "out_of_bounds": the can center is more than 1.2 m from the robot base horizontally or below z = -0.05;
  * "max_time": max_time sim seconds have passed;
  * "exception" / "physics_error": the controller raised, returned a bad action, or the sim blew up.

Scoring (computed on the final state)
-------------------------------------
    success        place_error_cm <= 3 and upright and resting, no exception
    place_error_cm horizontal distance from the can center to the place target, cm
    upright        can axis within 15 degrees of vertical
    resting        can speed below 2 cm/s and 0.5 rad/s, standing on the floor (center z within 1 cm of
                   0.05), and not touching any robot part
    dropped        the can lost contact with both fingers while its bottom was more than 3 cm above the
                   floor and more than 3 cm (horizontally) from the place target, or it was lifted by
                   more than 1 cm and ended not upright
    max_height_cm  highest can center height above its start height, cm
    time_taken     sim seconds when the episode stopped
    exception      None, or "TypeName: message" plus a short traceback tail
plus can_start, place_target, seed and a few diagnostics (end_reason, tilt_deg, final_can_pos,
can_start_actual, released, resting, tipped).
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

from sim.control import CONTROL_DT, CONTROL_HZ, GRASP_OFFSET
from sim.motion import FORMAT, MOTION_FPS, round_list
from sim.scene import CAN_HALF_HEIGHT, MODEL_ID, build_model

MAX_TIME = 10.0

SUCCESS_RADIUS = 0.03  # m, horizontal distance from the place target
UPRIGHT_DEG = 15.0
REST_LIN_SPEED = 0.02  # m/s
REST_ANG_SPEED = 0.5  # rad/s
REST_Z_TOL = 0.01  # m, can center within this of CAN_HALF_HEIGHT counts as standing on the floor
SETTLE_TIME = 0.5  # s of continuous "placed" state before stopping early
HAND_CLEAR = 0.03  # m, grasp point distance from the can surface for "hand away"
DROP_HEIGHT = 0.03  # m, can bottom above floor at release that counts as a drop
LIFT_FOR_DROP = 0.01  # m, lift above start needed for "ended on its side" to count as a drop
AFTER_DONE_TIME = 1.0  # s of extra physics after the controller signals done
OUT_OF_BOUNDS_R = 1.2  # m
CAN_JITTER = 0.003  # m
QPOS_JITTER = 0.005  # rad


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
    """Model, data and the lookups the episode loop needs."""

    def __init__(self, can_xy, place_xy, can_yaw: float, rng: np.random.Generator):
        self.model = build_model(can_xy, place_xy, can_yaw)
        m = self.model
        self.data = mujoco.MjData(m)
        d = self.data
        mujoco.mj_resetDataKeyframe(m, d, m.key("home").id)
        can_jnt = m.joint("can_joint")
        self.can_qadr = int(can_jnt.qposadr[0])
        self.can_vadr = int(can_jnt.dofadr[0])
        d.qpos[self.can_qadr : self.can_qadr + 2] += rng.uniform(-CAN_JITTER, CAN_JITTER, size=2)
        d.qpos[:7] += rng.uniform(-QPOS_JITTER, QPOS_JITTER, size=7)
        d.ctrl[:] = m.key("home").ctrl
        mujoco.mj_forward(m, d)
        self.hand_id = m.body("hand").id
        self.can_geom = m.geom("can").id
        robot_root = m.body("link0").id
        robot_bodies = {b for b in range(m.nbody) if self._is_descendant(b, robot_root)}
        self.robot_geoms = {g for g in range(m.ngeom) if m.geom_bodyid[g] in robot_bodies}
        fingers = {m.body("left_finger").id, m.body("right_finger").id}
        self.finger_geoms = {g for g in range(m.ngeom) if m.geom_bodyid[g] in fingers}
        self.n_substeps = max(1, int(round(CONTROL_DT / m.opt.timestep)))
        self.ctrl_lo = m.actuator_ctrlrange[:, 0].copy()
        self.ctrl_hi = m.actuator_ctrlrange[:, 1].copy()

    def _is_descendant(self, body: int, root: int) -> bool:
        while body != 0:
            if body == root:
                return True
            body = int(self.model.body_parentid[body])
        return root == 0

    def hand_pos(self) -> np.ndarray:
        d = self.data
        return d.xpos[self.hand_id] + d.xmat[self.hand_id].reshape(3, 3) @ GRASP_OFFSET

    def can_pos(self) -> np.ndarray:
        return self.data.qpos[self.can_qadr : self.can_qadr + 3].copy()

    def can_quat(self) -> np.ndarray:
        return self.data.qpos[self.can_qadr + 3 : self.can_qadr + 7].copy()

    def can_vel(self) -> tuple[float, float]:
        v = self.data.qvel[self.can_vadr : self.can_vadr + 6]
        return float(np.linalg.norm(v[:3])), float(np.linalg.norm(v[3:]))

    def can_tilt_deg(self) -> float:
        w, x, y, z = self.can_quat()
        n = w * w + x * x + y * y + z * z
        if n <= 0:
            return 180.0
        # z component of the can's local z axis expressed in the world frame.
        axis_z = 1.0 - 2.0 * (x * x + y * y) / n
        return float(np.degrees(np.arccos(np.clip(axis_z, -1.0, 1.0))))

    def contacts(self) -> tuple[bool, bool]:
        """(can touches any robot geom, can touches a finger geom)."""
        d = self.data
        robot = finger = False
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if g1 == self.can_geom:
                other = g2
            elif g2 == self.can_geom:
                other = g1
            else:
                continue
            if other in self.robot_geoms:
                robot = True
                if other in self.finger_geoms:
                    finger = True
        return robot, finger


def run_episode(
    controller_path,
    can_xy,
    place_xy,
    seed: int = 0,
    can_yaw: float = 0.0,
    max_time: float = MAX_TIME,
    record: bool = True,
) -> tuple[dict, dict | None]:
    """Run one episode and return (result, motion). motion is None when record is False.

    Never raises because of the controller: load errors, exceptions in reset/act, bad actions and
    physics blow-ups all end the episode as a failure with result["exception"] set.
    See the module docstring for the protocol, stopping rule and scoring.
    """
    can_xy = [float(can_xy[0]), float(can_xy[1])]
    place_xy = [float(place_xy[0]), float(place_xy[1])]
    max_time = float(max_time)
    rng = np.random.default_rng(seed)
    sim = _Sim(can_xy, place_xy, can_yaw, rng)
    m, d = sim.model, sim.data
    place = np.array(place_xy)
    task = {"can_start": list(can_xy), "place_target": list(place_xy), "control_hz": CONTROL_HZ, "max_time": max_time}
    start_pos = sim.can_pos()

    frames: list[dict] = []
    next_frame_t = 0.0

    def capture() -> None:
        mujoco.mj_kinematics(m, d)  # body poses for the current qpos (mj_step leaves them one substep behind)
        frames.append(
            {
                "t": round(float(d.time), 4),
                "qpos": round_list(d.qpos),
                "ctrl": round_list(d.ctrl),
                "hand": round_list(sim.hand_pos()),
                "can_pos": round_list(sim.can_pos()),
                "can_quat": round_list(sim.can_quat()),
            }
        )

    def maybe_capture() -> None:
        nonlocal next_frame_t
        if record and d.time + 1e-9 >= next_frame_t:
            capture()
            next_frame_t += 1.0 / MOTION_FPS

    exception: str | None = None
    end_reason = "max_time"
    max_z = float(start_pos[2])
    dropped_in_air = False
    had_finger_contact = False
    settled_for = 0.0
    controller = None

    maybe_capture()
    try:
        controller = load_controller(controller_path)
    except BaseException as exc:  # noqa: BLE001 - any controller failure is a scored failure
        if isinstance(exc, KeyboardInterrupt):
            raise
        exception = _format_exception(exc)
        end_reason = "exception"
    if controller is not None:
        try:
            controller.reset(dict(task, can_start=list(can_xy), place_target=list(place_xy)))
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, KeyboardInterrupt):
                raise
            exception = _format_exception(exc)
            end_reason = "exception"

    done_at: float | None = None
    n_steps = int(math.floor(max_time / CONTROL_DT + 1e-9))
    for _ in range(n_steps if exception is None else 0):
        if done_at is None:
            mujoco.mj_kinematics(m, d)
            obs = {
                "qpos": d.qpos.copy(),
                "qvel": d.qvel.copy(),
                "hand_pos": sim.hand_pos(),
                "can_pos": sim.can_pos(),
                "can_quat": sim.can_quat(),
                "finger_width": float(d.qpos[7] + d.qpos[8]),
                "time": float(d.time),
                "task": dict(task, can_start=list(can_xy), place_target=list(place_xy)),
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

        for _ in range(sim.n_substeps):
            mujoco.mj_step(m, d)
            unstable = (
                not np.all(np.isfinite(d.qpos)) or d.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0
            )
            if unstable:
                break
            maybe_capture()
        if unstable:
            exception = "PhysicsError: simulation became unstable (non-finite state)"
            end_reason = "physics_error"
            break

        pos = sim.can_pos()
        lin, ang = sim.can_vel()
        robot_touch, finger_touch = sim.contacts()
        max_z = max(max_z, float(pos[2]))
        horiz_err = float(np.linalg.norm(pos[:2] - place))
        if finger_touch:
            had_finger_contact = True
        elif had_finger_contact:
            # Contact with the fingers just ended (or stays ended): a release high up away from the target
            # is a drop. Only the moment of release counts, so a can that is merely falling is not re-counted.
            if pos[2] - CAN_HALF_HEIGHT > DROP_HEIGHT and horiz_err > SUCCESS_RADIUS:
                dropped_in_air = True
            had_finger_contact = False

        if np.linalg.norm(pos[:2]) > OUT_OF_BOUNDS_R or pos[2] < -0.05:
            end_reason = "out_of_bounds"
            break

        resting = lin < REST_LIN_SPEED and ang < REST_ANG_SPEED and abs(pos[2] - CAN_HALF_HEIGHT) < REST_Z_TOL
        upright = sim.can_tilt_deg() <= UPRIGHT_DEG
        if done_at is not None:
            if (resting and not robot_touch) or d.time - done_at >= AFTER_DONE_TIME:
                end_reason = "controller_done"
                break
            continue

        hand = sim.hand_pos()
        hand_rel = hand - pos
        hand_away = (
            hand_rel[2] > CAN_HALF_HEIGHT + HAND_CLEAR or np.linalg.norm(hand_rel[:2]) > 0.025 + HAND_CLEAR
        )
        if resting and upright and not robot_touch and hand_away and horiz_err <= SUCCESS_RADIUS:
            settled_for += CONTROL_DT
            if settled_for >= SETTLE_TIME - 1e-9:
                end_reason = "settled"
                break
        else:
            settled_for = 0.0

    if record and (not frames or frames[-1]["t"] < round(float(d.time), 4)):
        capture()

    pos = sim.can_pos()
    lin, ang = sim.can_vel()
    robot_touch, _ = sim.contacts()
    finite = bool(np.all(np.isfinite(pos)))
    tilt = sim.can_tilt_deg() if finite else 180.0
    upright = tilt <= UPRIGHT_DEG
    place_err = float(np.linalg.norm(pos[:2] - place)) if finite else float("inf")
    resting = bool(
        finite
        and lin < REST_LIN_SPEED
        and ang < REST_ANG_SPEED
        and abs(pos[2] - CAN_HALF_HEIGHT) < REST_Z_TOL
        and not robot_touch
    )
    lift = max_z - float(start_pos[2])
    dropped = bool(dropped_in_air or (lift > LIFT_FOR_DROP and not upright))
    success = bool(exception is None and place_err <= SUCCESS_RADIUS and upright and resting)

    result = {
        "success": success,
        "place_error_cm": round(place_err * 100, 2) if math.isfinite(place_err) else None,
        "upright": bool(upright),
        "dropped": dropped,
        "max_height_cm": round(lift * 100, 2),
        "time_taken": round(float(d.time), 3),
        "exception": exception,
        "can_start": list(can_xy),
        "place_target": list(place_xy),
        "seed": seed,
        "end_reason": end_reason,
        "resting": resting,
        "released": not robot_touch,
        "tipped": not upright,
        "tilt_deg": round(tilt, 1),
        "final_can_pos": round_list(pos) if finite else None,
        "can_start_actual": round_list(start_pos),
    }

    motion = None
    if record:
        motion = {
            "format": FORMAT,
            "header": {
                "model_id": MODEL_ID,
                "joint_names": [m.joint(j).name for j in range(m.njnt)],
                "actuator_names": [m.actuator(a).name for a in range(m.nu)],
                "can_start": list(can_xy),
                "place_target": list(place_xy),
                "fps": MOTION_FPS,
                "nq": int(m.nq),
                "nu": int(m.nu),
                "qpos_layout": "7 arm joints, 2 finger joints, can freejoint xyz + quat wxyz",
                "seed": seed,
                "dt": round(1.0 / MOTION_FPS, 6),
            },
            "frames": frames,
            "result": result,
        }
    return result, motion
