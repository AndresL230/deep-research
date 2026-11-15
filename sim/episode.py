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

With a layout (a basket and other objects)
------------------------------------------
`run_episode(..., layout=...)` runs the same episode in a scene with a container and other objects standing on
the floor (sim/scene.py, "A layout"). The place target is the container's centre. What changes:

    task      also has "basket": {"xy": [x, y], "height": rim height in m, "opening": [dx, dy] of its inside}
              and "objects": [{"name", "xy": [x, y], "height", "footprint": [dx, dy]}], as they stand at the start.
    obs       also has "basket_pos" (3,) and "objects": {name: (3,) world xyz}. qpos and qvel are longer: the
              first 16 and 15 are as above, then 7 and 6 per added body (the container, then the objects in order).
    success   the can's centre is inside the container (its contain box), the can is at rest and released. It
              need not stand upright, and it rests on the container's floor, not on the ground.
    place_error_cm  horizontal distance from the can's centre to the centre of the container's inside.
    dropped   the can was let go in the air while not over the container, or was lifted and ended on its side
              outside it. Letting it go over the container is how it is put in.
    in_basket True when the can's centre ended inside the container.
With a "target" in the layout the object to pick is that object, not the cylinder: `task["target"]` is
{"name", "height", "footprint": [dx, dy]} as it stands, and everything named "can" above (can_start, obs["can_pos"],
obs["can_quat"]) is about it. Its centre starts at half its height, and it is upright while it stands as it did.
The stopping rule is the same, with "inside the container" in place of "within 3 cm of the place target".
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
from sim.motion import DECIMALS, FORMAT, MOTION_FPS, round_list
from sim.scene import BASKET_NAME, CAN_HALF_HEIGHT, LAYOUT_MODEL_ID, MODEL_ID, build_model, object_body_name

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

    def __init__(self, can_xy, place_xy, can_yaw: float, rng: np.random.Generator, layout: dict | None = None):
        self.model = build_model(can_xy, place_xy, can_yaw, layout)
        self.layout = layout or None
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
        # The object to pick: the cylinder's one geom, or every box of a layout's target object.
        can_body = m.body("can").id
        self.can_geoms = {g for g in range(m.ngeom) if int(m.geom_bodyid[g]) == can_body}
        target = (layout or {}).get("target") or {}
        # Its size as it stands: half its height, and the radius the hand must clear to be away from it.
        self.can_half_height = float(target["height"]) / 2 if target.get("height") else CAN_HALF_HEIGHT
        self.can_radius = max(float(v) for v in target["footprint"]) / 2 if target.get("footprint") else 0.025
        # Where its center stands at the start, and the direction of its own frame that points up then: an object
        # is upright while that direction still points up, whatever its frame is.
        self.can_z0 = float(d.qpos[self.can_qadr + 2])
        w, x, y, z = (float(v) for v in d.qpos[self.can_qadr + 3 : self.can_qadr + 7])
        self.can_up = np.array([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)])
        robot_root = m.body("link0").id
        robot_bodies = {b for b in range(m.nbody) if self._is_descendant(b, robot_root)}
        self.robot_geoms = {g for g in range(m.ngeom) if m.geom_bodyid[g] in robot_bodies}
        fingers = {m.body("left_finger").id, m.body("right_finger").id}
        self.finger_geoms = {g for g in range(m.ngeom) if m.geom_bodyid[g] in fingers}
        self.n_substeps = max(1, int(round(CONTROL_DT / m.opt.timestep)))
        self.ctrl_lo = m.actuator_ctrlrange[:, 0].copy()
        self.ctrl_hi = m.actuator_ctrlrange[:, 1].copy()
        # A layout's container (with the box an object is "in" it inside of) and its other objects.
        basket = (layout or {}).get("basket")
        self.basket_id = m.body(BASKET_NAME).id if basket else None
        self.contain_id = m.site(f"{BASKET_NAME}_contain").id if basket and basket.get("contain") else None
        self.object_ids = {obj["name"]: m.body(object_body_name(obj)).id for obj in (layout or {}).get("objects") or []}

    def basket_pos(self) -> np.ndarray | None:
        return None if self.basket_id is None else self.data.xpos[self.basket_id].copy()

    def object_positions(self) -> dict:
        return {name: self.data.xpos[b].copy() for name, b in self.object_ids.items()}

    def contain_center(self) -> np.ndarray | None:
        """World xyz of the centre of the container's inside, or None without one."""
        return None if self.contain_id is None else self.data.site_xpos[self.contain_id].copy()

    def in_basket(self, pos: np.ndarray) -> bool:
        """Whether world point `pos` is inside the container's contain box, wherever the container now is."""
        if self.contain_id is None:
            return False
        local = self.data.site_xmat[self.contain_id].reshape(3, 3).T @ (np.asarray(pos, dtype=float) - self.data.site_xpos[self.contain_id])
        return bool(np.all(np.abs(local) <= self.model.site_size[self.contain_id]))

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
        w, x, y, z = (v / math.sqrt(n) for v in (w, x, y, z))
        # The world z component of the object's own direction that pointed up at the start (`can_up`): the third
        # row of its rotation matrix, times that direction. For the cylinder that direction is its z axis.
        row = np.array([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)])
        return float(np.degrees(np.arccos(np.clip(float(row @ self.can_up), -1.0, 1.0))))

    def contacts(self) -> tuple[bool, bool]:
        """(can touches any robot geom, can touches a finger geom)."""
        d = self.data
        robot = finger = False
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if g1 in self.can_geoms:
                other = g2
            elif g2 in self.can_geoms:
                other = g1
            else:
                continue
            if other in self.robot_geoms:
                robot = True
                if other in self.finger_geoms:
                    finger = True
        return robot, finger


def _over_basket(sim: "_Sim", pos: np.ndarray) -> bool:
    """Whether the can's centre is above the container's inside (its contain box, at any height)."""
    if sim.contain_id is None:
        return False
    local = sim.data.site_xmat[sim.contain_id].reshape(3, 3).T @ (np.asarray(pos, dtype=float) - sim.data.site_xpos[sim.contain_id])
    return bool(np.all(np.abs(local[:2]) <= sim.model.site_size[sim.contain_id][:2]))


def run_episode(
    controller_path,
    can_xy,
    place_xy,
    seed: int = 0,
    can_yaw: float = 0.0,
    max_time: float = MAX_TIME,
    record: bool = True,
    motion_fps: int = MOTION_FPS,
    motion_decimals: int = DECIMALS,
    layout: dict | None = None,
) -> tuple[dict, dict | None]:
    """Run one episode and return (result, motion). motion is None when record is False.

    `layout`: a container and other objects to stand in the scene (sim/scene.py). The episode then counts the can
    as placed when it ends inside the container (module docstring, "With a layout").

    `motion_fps` and `motion_decimals` set the recording's frame rate and rounding (sim/MOTION_FORMAT.md); they never
    change the episode itself.

    Never raises because of the controller: load errors, exceptions in reset/act, bad actions and
    physics blow-ups all end the episode as a failure with result["exception"] set.
    See the module docstring for the protocol, stopping rule and scoring.
    """
    can_xy = [float(can_xy[0]), float(can_xy[1])]
    place_xy = [float(place_xy[0]), float(place_xy[1])]
    max_time = float(max_time)
    rng = np.random.default_rng(seed)
    layout = layout or None
    sim = _Sim(can_xy, place_xy, can_yaw, rng, layout)
    m, d = sim.model, sim.data
    place = np.array(place_xy)
    task = {"can_start": list(can_xy), "place_target": list(place_xy), "control_hz": CONTROL_HZ, "max_time": max_time}
    basket = (layout or {}).get("basket")
    if layout:
        if basket:
            contain = basket.get("contain") or {}
            task["basket"] = {
                "xy": [float(v) for v in basket["xy"]], "height": float(basket.get("height") or 0.0),
                "opening": [2 * float(v) for v in (contain.get("size") or [0.0, 0.0])[:2]],
            }
        task["objects"] = [
            {"name": o["name"], "xy": [float(v) for v in o["xy"]], "height": float(o.get("height") or 0.0),
             "footprint": [float(v) for v in o.get("footprint") or [0.0, 0.0]]}
            for o in layout.get("objects") or []
        ]
        if layout.get("target"):
            tg = layout["target"]
            task["target"] = {"name": tg["name"], "height": float(tg.get("height") or 0.0),
                              "footprint": [float(v) for v in tg.get("footprint") or [0.0, 0.0]]}
    start_pos = sim.can_pos()

    def placed_at(pos: np.ndarray, horiz: float) -> bool:
        """The can's centre is where it should end: inside the container, or within 3 cm of the place target."""
        return sim.in_basket(pos) if basket else horiz <= SUCCESS_RADIUS

    def horizontal_error(pos: np.ndarray) -> float:
        center = sim.contain_center() if basket else None
        return float(np.linalg.norm(pos[:2] - (place if center is None else center[:2])))

    frames: list[dict] = []
    next_frame_t = 0.0

    def capture() -> None:
        mujoco.mj_kinematics(m, d)  # body poses for the current qpos (mj_step leaves them one substep behind)
        frames.append(
            {
                "t": round(float(d.time), 4),
                "qpos": round_list(d.qpos, motion_decimals),
                "ctrl": round_list(d.ctrl, motion_decimals),
                "hand": round_list(sim.hand_pos(), motion_decimals),
                "can_pos": round_list(sim.can_pos(), motion_decimals),
                "can_quat": round_list(sim.can_quat(), motion_decimals),
            }
        )

    def maybe_capture() -> None:
        nonlocal next_frame_t
        if record and d.time + 1e-9 >= next_frame_t:
            capture()
            next_frame_t += 1.0 / motion_fps

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
            if layout:
                obs["objects"] = sim.object_positions()
                if basket:
                    obs["basket_pos"] = sim.basket_pos()
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
        horiz_err = horizontal_error(pos)
        if finger_touch:
            had_finger_contact = True
        elif had_finger_contact:
            # Contact with the fingers just ended (or stays ended): a release high up away from the target
            # is a drop. Only the moment of release counts, so a can that is merely falling is not re-counted.
            # Over a container, letting go in the air is how the can is put in.
            away = not _over_basket(sim, pos) if basket else horiz_err > SUCCESS_RADIUS
            if pos[2] - sim.can_z0 > DROP_HEIGHT and away:
                dropped_in_air = True
            had_finger_contact = False

        if np.linalg.norm(pos[:2]) > OUT_OF_BOUNDS_R or pos[2] < -0.05:
            end_reason = "out_of_bounds"
            break

        still = lin < REST_LIN_SPEED and ang < REST_ANG_SPEED
        # In a container the can rests on its floor, upright or not; on the ground it stands at its own height.
        resting = still if basket else still and abs(pos[2] - sim.can_z0) < REST_Z_TOL
        upright = True if basket else sim.can_tilt_deg() <= UPRIGHT_DEG
        if done_at is not None:
            if (resting and not robot_touch) or d.time - done_at >= AFTER_DONE_TIME:
                end_reason = "controller_done"
                break
            continue

        hand = sim.hand_pos()
        hand_rel = hand - pos
        hand_away = (
            hand_rel[2] > sim.can_half_height + HAND_CLEAR or np.linalg.norm(hand_rel[:2]) > sim.can_radius + HAND_CLEAR
        )
        if resting and upright and not robot_touch and hand_away and placed_at(pos, horiz_err):
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
    place_err = horizontal_error(pos) if finite else float("inf")
    in_basket = bool(finite and basket and sim.in_basket(pos))
    resting = bool(
        finite
        and lin < REST_LIN_SPEED
        and ang < REST_ANG_SPEED
        and (basket or abs(pos[2] - sim.can_z0) < REST_Z_TOL)
        and not robot_touch
    )
    lift = max_z - float(start_pos[2])
    if basket:
        # In the container counts however the can lies; outside it, a lifted can that ended on its side was dropped.
        dropped = bool(not in_basket and (dropped_in_air or (lift > LIFT_FOR_DROP and not upright)))
        success = bool(exception is None and in_basket and resting)
    else:
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
    if basket:
        result["in_basket"] = in_basket
    if layout and layout.get("target"):
        result["target"] = str(layout["target"]["name"])  # what was picked: "milk"

    motion = None
    if record:
        motion = {
            "format": FORMAT,
            "header": {
                "model_id": str(layout.get("model_id") or LAYOUT_MODEL_ID) if layout else MODEL_ID,
                "joint_names": [m.joint(j).name for j in range(m.njnt)],
                "actuator_names": [m.actuator(a).name for a in range(m.nu)],
                "can_start": list(can_xy),
                "place_target": list(place_xy),
                "fps": int(motion_fps),
                "nq": int(m.nq),
                "nu": int(m.nu),
                "qpos_layout": "7 arm joints, 2 finger joints, can freejoint xyz + quat wxyz"
                + (", then xyz + quat wxyz per body of the layout: the container, then its objects in order" if layout else ""),
                "seed": seed,
                "dt": round(1.0 / motion_fps, 6),
                # The scene's container and objects, so a reader can build the same model and pose every body.
                **({"layout": layout} if layout else {}),
            },
            "frames": frames,
            "result": result,
        }
    return result, motion
