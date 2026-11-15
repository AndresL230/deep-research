"""Run one motion tracking episode with a controller file and score it.

The task is ExBody2's (Ji et al., arXiv:2412.13196): the robot follows a reference motion with its whole body, and
is scored by how far it is from the reference. The references are CMU motion capture clips fitted to the G1
(sim/g1/track/motions.py). The errors are the paper's three, and an episode succeeds when the robot stays on its
feet and two of them are under a limit.

Controller protocol
-------------------
A controller is a Python file defining a class `Controller` with:

    reset(self, task: dict) -> None
        Called once before the first step. task = {
            "motion": {"name", "kind", "description", "seconds"},
            "reference": {"fps": 30, "lead_in": 1.5, "qpos": (n, 36) array},   the whole reference, known from the start
            "ready_qpos": (36,) the pose the robot starts in, which is the reference's first frame,
            "limits": {"e_mpkpe": meters, "e_mpjpe": radians},                 what an episode must stay under
            "key_bodies": the bodies whose positions are compared, "control_hz": 50, "max_time": seconds}

    act(self, obs: dict) -> sequence of 29 floats, or None
        Called every control step (50 Hz). Returns the 29 joint angle targets (radians), in the order of
        sim.g1.control.JOINT_NAMES. Values are clipped to the joint limits.
        Return None, or set `self.done = True`, to say the controller is finished (see "Stopping").

obs keys (numpy arrays are copies, changing them has no effect):
    qpos        (36,) the robot's pose: pelvis xyz, pelvis quaternion wxyz, 29 joint angles
    qvel        (35,) its velocities
    com, com_vel                       (3,) the centre of mass and its velocity
    left_foot, right_foot, left_toe, right_toe, left_hand, right_hand, pelvis
                (3,)  world xyz of the named points of sim.g1.control.POINTS, as they really are
    left_foot_down, right_foot_down    bool, whether that foot touches the floor
    tilt_deg    float, how far the torso leans from upright
    ref_qpos    (36,) the reference pose at this time
    time        float, sim seconds since the start
    task        dict, same as in reset

Physics runs at the model timestep (0.002 s), 10 physics steps per act.

Seed noise
----------
`seed` feeds np.random.default_rng(seed). It adds up to 0.005 rad (uniform) to each initial joint angle. Same seed,
same episode, bit for bit.

Stopping
--------
The episode runs until the first of:
  * "finished": 1 s after the reference's last frame, so a robot that is still falling is scored where it ends;
  * "controller_done": the controller signalled done; physics then continues with the last command to that same time;
  * "fell": the robot fell (see below); physics stops 0.5 s later;
  * "exception" / "physics_error": the controller raised, returned a bad action, or the sim blew up.

Scoring
-------
The errors are means over the reference proper: from the end of the lead-in to the reference's last frame, or to the
fall. They are ExBody2's, measured as follows:

    e_mpjpe      rad   mean per joint position error: |joint angle - reference's|, over the 29 joints
    e_mpkpe      m     mean per key body position error: the distance between each key body and where the reference
                       has it, in the world frame (the reference stands where the robot starts)
    e_vel        m/s   the difference between the pelvis's linear velocity and the reference's
    e_mpjpe_upper, e_mpjpe_lower, e_mpkpe_upper, e_mpkpe_lower
                       the same over the waist and arms, and over the legs

    success      not fell, no exception, e_mpkpe <= 0.06 m and e_mpjpe <= 0.05 rad
    fell         at any time the pelvis was below 0.45 m, the torso leaned more than 50 degrees, or a part of
                 the robot other than its feet touched the floor
    tracked_s    the seconds the errors were measured over
    time_taken   sim seconds when the episode stopped
    exception    None, or "TypeName: message" plus a short traceback tail
plus motion, kind, seed and a few diagnostics (end_reason, fell_at, pelvis_min_z, max_tilt_deg).
"""

from __future__ import annotations

import mujoco
import numpy as np

from sim.g1.control import CONTROL_DT, CONTROL_HZ, POINTS
from sim.g1.episode import FALL_PELVIS_Z, FALL_TILT_DEG, QPOS_JITTER, _format_exception, load_controller
from sim.g1.motion import DECIMALS, MOTION_FPS, round_list
from sim.g1.scene import TRACK_MODEL_ID, build_track_model
from sim.g1.track.motions import (
    KEY_BODIES,
    LOWER_BODIES,
    LOWER_JOINTS,
    UPPER_BODIES,
    UPPER_JOINTS,
    duration,
    interpolate,
    public_info,
    reference,
    resolve,
)

FORMAT = "g1-track-motion/1"
MPKPE_MAX = 0.06  # m
MPJPE_MAX = 0.05  # rad
AFTER_TIME = 1.0  # s of physics after the reference's last frame
AFTER_FALL_TIME = 0.5


class _Sim:
    """The model and state of one episode, with the readings the episode loop needs."""

    def __init__(self, rng: np.random.Generator, ready: np.ndarray):
        self.model = m = build_track_model()
        self.data = d = mujoco.MjData(m)
        d.qpos[:] = ready
        d.ctrl[:] = d.qpos[7:]
        d.qpos[7:] += rng.uniform(-QPOS_JITTER, QPOS_JITTER, size=m.nu)
        self.ctrl_lo, self.ctrl_hi = m.actuator_ctrlrange[:, 0].copy(), m.actuator_ctrlrange[:, 1].copy()
        self.n_substeps = int(round(CONTROL_DT / m.opt.timestep))
        self.floor = m.geom("floor").id
        self.torso = m.body("torso_link").id
        self.key = [m.body(b).id for b in KEY_BODIES]
        self.point_body = {name: m.body(body).id for name, (body, _) in POINTS.items()}
        self.point_offset = {name: np.array(off) for name, (_, off) in POINTS.items()}
        feet = {m.body("left_ankle_roll_link").id: "left", m.body("right_ankle_roll_link").id: "right"}
        self.foot_of_geom = {g: feet[int(m.geom_bodyid[g])] for g in range(m.ngeom) if int(m.geom_bodyid[g]) in feet}
        mujoco.mj_forward(m, d)

    def point(self, name: str) -> np.ndarray:
        b = self.point_body[name]
        return self.data.xpos[b] + self.data.xmat[b].reshape(3, 3) @ self.point_offset[name]

    def tilt_deg(self) -> float:
        up_z = float(self.data.xmat[self.torso].reshape(3, 3)[2, 2])
        return float(np.degrees(np.arccos(np.clip(up_z, -1.0, 1.0))))

    def contacts(self) -> tuple[set[str], bool]:
        """(feet on the floor, whether another part of the robot touches the floor)."""
        d = self.data
        feet: set[str] = set()
        other = False
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = int(c.geom1), int(c.geom2)
            if self.floor not in (g1, g2):
                continue
            g = g2 if g1 == self.floor else g1
            if g in self.foot_of_geom:
                feet.add(self.foot_of_geom[g])
            else:
                other = True
        return feet, other

    def key_positions(self, qpos_frames: np.ndarray) -> np.ndarray:
        """Where the key bodies are in each of `qpos_frames`: (n, bodies, 3)."""
        scratch = mujoco.MjData(self.model)
        out = np.zeros((len(qpos_frames), len(self.key), 3))
        for i, q in enumerate(qpos_frames):
            scratch.qpos[:] = q
            mujoco.mj_kinematics(self.model, scratch)
            out[i] = scratch.xpos[self.key]
        return out


def task_dict(motion: dict) -> dict:
    return {
        "motion": public_info(motion),
        "reference": {"fps": motion["fps"], "lead_in": motion["lead_in"], "qpos": motion["qpos"].copy()},
        "ready_qpos": motion["qpos"][0].copy(),
        "limits": {"e_mpkpe": MPKPE_MAX, "e_mpjpe": MPJPE_MAX},
        "key_bodies": list(KEY_BODIES),
        "control_hz": CONTROL_HZ,
        "max_time": round(duration(motion) + AFTER_TIME, 3),
    }


def _mean(total, n: int):
    return None if n == 0 else round(float(total) / n, 4)


def run_episode(
    controller_path,
    motion,
    seed: int = 0,
    record: bool = True,
    motion_fps: int = MOTION_FPS,
    motion_decimals: int = DECIMALS,
) -> tuple[dict, dict | None]:
    """Run one episode and return (result, motion file). The motion file is None when record is False.

    `motion`: a public motion's name, {"set": ..., "name": ...}, or a motion itself (sim/g1/track/motions.py); one
    that is not a motion raises ValueError before anything runs. Never raises because of the controller: load
    errors, exceptions in reset/act, bad actions and physics blow-ups all end the episode as a failure with
    result["exception"] set.
    """
    ref = resolve(motion)
    rng = np.random.default_rng(seed)
    sim = _Sim(rng, ref["qpos"][0])
    m, d = sim.model, sim.data
    task = task_dict(ref)
    end_time = task["max_time"]
    ref_end = duration(ref)
    ref_keys = sim.key_positions(ref["qpos"])
    ref_vel = np.gradient(ref["qpos"][:, :3], 1.0 / ref["fps"], axis=0)

    frames: list[dict] = []
    frame_every = max(1, int(round(1.0 / (motion_fps * m.opt.timestep))))
    step_count = 0

    def capture() -> None:
        frames.append({"t": round(float(d.time), 4), "qpos": round_list(d.qpos, motion_decimals)})

    if record:
        capture()

    exception = None
    end_reason = "finished"
    controller = None
    try:
        controller = load_controller(controller_path)
        controller.reset(task_dict(ref))
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, KeyboardInterrupt):
            raise
        exception = _format_exception(exc)
        end_reason = "exception"

    upper_b = [KEY_BODIES.index(b) for b in UPPER_BODIES]
    lower_b = [KEY_BODIES.index(b) for b in LOWER_BODIES]
    sums = {"vel": 0.0, "kp": 0.0, "kp_u": 0.0, "kp_l": 0.0, "jp": 0.0, "jp_u": 0.0, "jp_l": 0.0}
    scored = 0
    done_at: float | None = None
    fell_at: float | None = None
    pelvis_min = float(d.qpos[2])
    max_tilt = 0.0
    feet_down: set[str] = {"left", "right"}
    com_jac = np.zeros((3, m.nv))
    n_steps = int(round(end_time / CONTROL_DT))

    for _ in range(n_steps if exception is None else 0):
        if done_at is None and fell_at is None:
            mujoco.mj_jacSubtreeCom(m, d, com_jac, 1)
            obs = {
                "qpos": d.qpos.copy(),
                "qvel": d.qvel.copy(),
                "com": d.subtree_com[1].copy(),
                "com_vel": com_jac @ d.qvel,
                **{name: sim.point(name).copy() for name in POINTS},
                "left_foot_down": "left" in feet_down,
                "right_foot_down": "right" in feet_down,
                "tilt_deg": sim.tilt_deg(),
                "ref_qpos": reference(ref, float(d.time)),
                "time": float(d.time),
                "task": task_dict(ref),
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

        feet_down, other_on_floor = sim.contacts()
        t = float(d.time)
        pelvis_min = min(pelvis_min, float(d.qpos[2]))
        tilt = sim.tilt_deg()
        max_tilt = max(max_tilt, tilt)
        if fell_at is None and (other_on_floor or d.qpos[2] < FALL_PELVIS_Z or tilt > FALL_TILT_DEG):
            fell_at = t
        # The robot against the reference, after the step, over the reference proper and while it stands.
        if fell_at is None and ref["lead_in"] < t <= ref_end + 1e-9:
            want = reference(ref, t)
            dj = np.abs(d.qpos[7:] - want[7:])
            dk = np.linalg.norm(d.xpos[sim.key] - interpolate(ref_keys, ref["fps"], t), axis=1)
            sums["jp"] += dj.mean()
            sums["jp_u"] += dj[list(UPPER_JOINTS)].mean()
            sums["jp_l"] += dj[list(LOWER_JOINTS)].mean()
            sums["kp"] += dk.mean()
            sums["kp_u"] += dk[upper_b].mean()
            sums["kp_l"] += dk[lower_b].mean()
            sums["vel"] += float(np.linalg.norm(d.qvel[:3] - interpolate(ref_vel, ref["fps"], t)))
            scored += 1
        if fell_at is not None and d.time - fell_at >= AFTER_FALL_TIME:
            end_reason = "fell"
            break
    else:
        if exception is None and done_at is not None:
            end_reason = "controller_done"

    if record and (not frames or frames[-1]["t"] < round(float(d.time), 4)):
        capture()

    fell = fell_at is not None
    e_mpkpe, e_mpjpe = _mean(sums["kp"], scored), _mean(sums["jp"], scored)
    close = e_mpkpe is not None and e_mpkpe <= MPKPE_MAX and e_mpjpe <= MPJPE_MAX
    result = {
        "success": bool(exception is None and not fell and close),
        "fell": bool(fell),
        "e_vel": _mean(sums["vel"], scored),
        "e_mpkpe": e_mpkpe,
        "e_mpkpe_upper": _mean(sums["kp_u"], scored),
        "e_mpkpe_lower": _mean(sums["kp_l"], scored),
        "e_mpjpe": e_mpjpe,
        "e_mpjpe_upper": _mean(sums["jp_u"], scored),
        "e_mpjpe_lower": _mean(sums["jp_l"], scored),
        "tracked_s": round(scored * CONTROL_DT, 2),
        "fell_at": None if fell_at is None else round(fell_at, 3),
        "time_taken": round(float(d.time), 3),
        "exception": exception,
        "motion": ref["name"],
        "kind": ref["kind"],
        "seed": seed,
        "end_reason": end_reason,
        "pelvis_min_z": round(pelvis_min, 3),
        "max_tilt_deg": round(max_tilt, 1),
    }

    out = None
    if record:
        out = {
            "format": FORMAT,
            "header": {
                "model_id": TRACK_MODEL_ID,
                "joint_names": [m.joint(j).name for j in range(m.njnt)],
                "actuator_names": [m.actuator(a).name for a in range(m.nu)],
                "motion": public_info(ref),
                "motion_set": motion.get("set", "public") if isinstance(motion, dict) and "qpos" not in motion and "root" not in motion else "public",
                "lead_in": ref["lead_in"],
                "fps": int(motion_fps),
                "nq": int(m.nq),
                "nu": int(m.nu),
                "qpos_layout": "pelvis xyz + quat wxyz, 29 joint angles",
                "seed": seed,
                "dt": round(1.0 / motion_fps, 6),
            },
            "frames": frames,
            "result": result,
        }
    return result, out
