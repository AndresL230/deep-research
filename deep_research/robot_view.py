"""What the web UI needs to draw a robot run in 3D: the scene's shapes, and where each body is in every frame.

The browser has no MuJoCo, so the kinematics happen here. `scene()` describes the compiled pick-and-place model
(sim/scene.py) once: every visual geom with its body, shape, local pose and color, and the meshes it uses, made small
by vertex clustering (the panda's visual OBJ files are about 33 MB; the JSON is about 1.4 MB, 0.45 MB gzipped).
`motion_poses(path)` loads one motion file (sim/MOTION_FORMAT.md) and runs `mj_kinematics` on every frame's qpos,
giving each moving body's world position and orientation per frame.

mujoco and sim are imported inside the functions, so importing this module (the API does) never needs them.
Both results are cached in memory as gzipped JSON, ready to send.
"""

from __future__ import annotations

import gzip
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

# Geoms in this group are the panda's collision shapes (menagerie's `collision` class): never drawn.
COLLISION_GROUP = 3
# Vertex clustering: vertices closer than about this many meters merge. Small parts get a finer grid (below).
CELL_M = 0.0045
MIN_CELLS = 7
# Meshes smaller than this (screws, logos) are left out: at the viewer's scale they are below a pixel.
MIN_EXTENT_M = 0.004
POS_DECIMALS = 4
QUAT_DECIMALS = 4
# A motion file is at most 200 KB (sim.motion.MAX_BYTES); anything far bigger is not one.
MAX_MOTION_BYTES = 2_000_000
MOTION_CACHE_SIZE = 64
GEOM_TYPES = {0: "plane", 2: "sphere", 3: "capsule", 5: "cylinder", 6: "box", 7: "mesh"}

_lock = threading.Lock()
_model = None
_scene_cache: tuple[dict, bytes] | None = None
_motion_cache: OrderedDict[tuple, bytes] = OrderedDict()


class MotionError(ValueError):
    """The motion file cannot be read as one."""


def _r(values, decimals: int) -> list[float]:
    return [round(float(v), decimals) + 0.0 for v in values]


def model():
    """The scene model, compiled once (nominal can and place positions: each motion file brings its own)."""
    global _model
    with _lock:
        if _model is None:
            from sim.scene import build_model  # needs mujoco and the panda meshes

            _model = build_model([0.5, 0.0], [0.45, -0.3])
        return _model


def _decimate(verts, faces):
    """Vertex clustering: snap vertices to a grid, merge each cell into its mean, drop collapsed and repeated faces."""
    import numpy as np

    extent = float((verts.max(0) - verts.min(0)).max()) if len(verts) else 0.0
    cell = min(CELL_M, extent / MIN_CELLS) if extent > 0 else CELL_M
    keys = np.floor((verts - verts.min(0)) / cell).astype(np.int64)
    _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(-1)
    sums = np.zeros((len(counts), 3))
    np.add.at(sums, inverse, verts)
    new_verts = sums / counts[:, None]
    f = inverse[faces]
    keep = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    f = f[keep]
    if len(f):
        _, first = np.unique(np.sort(f, axis=1), axis=0, return_index=True)
        f = f[np.sort(first)]
    used = np.unique(f.reshape(-1)) if len(f) else np.zeros(0, dtype=np.int64)
    remap = -np.ones(len(new_verts), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return new_verts[used], remap[f]


# Models of scenes with a layout (a basket and other objects, sim/scene.py), by the layout's bodies and shapes.
_layout_models: OrderedDict[str, Any] = OrderedDict()
LAYOUT_MODELS = 8


def _layout_key(layout: dict) -> str:
    """What makes two layouts the same model: their bodies and shapes, not where each stands (qpos says that)."""
    shape = lambda o: [o.get("name"), o.get("boxes"), o.get("quat"), o.get("z"), o.get("contain"), o.get("rgba")]  # noqa: E731
    return json.dumps([shape(layout["basket"]) if layout.get("basket") else None,
                       [shape(o) for o in layout.get("objects") or []],
                       shape(layout["target"]) if layout.get("target") else None], sort_keys=True)


MAX_LAYOUT_OBJECTS = 12
MAX_OBJECT_BOXES = 40


def _check_layout(layout: dict) -> None:
    """A layout read from a file an agent may have written: only a small scene of finite boxes is built."""
    import math

    num = lambda v, n: isinstance(v, list) and len(v) == n and all(  # noqa: E731
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and abs(x) < 10 for x in v)
    objects = layout.get("objects") or []
    entries = ([layout["basket"]] if layout.get("basket") else []) + (objects if isinstance(objects, list) else [None])
    if layout.get("target"):
        entries.append({"xy": [0.0, 0.0], **layout["target"]} if isinstance(layout["target"], dict) else None)
    if len(entries) > MAX_LAYOUT_OBJECTS + 2:
        raise MotionError("the file's scene layout has too many objects")
    for o in entries:
        boxes = o.get("boxes") if isinstance(o, dict) else None
        if not isinstance(o.get("name") if isinstance(o, dict) else None, str) or not num(o.get("xy"), 2) \
                or not isinstance(boxes, list) or not 1 <= len(boxes) <= MAX_OBJECT_BOXES:
            raise MotionError("the file's scene layout is not one")
        for b in boxes:
            if not isinstance(b, dict) or not num(b.get("pos"), 3) or not num(b.get("size"), 3) or not num(b.get("quat", [1, 0, 0, 0]), 4) \
                    or min(b["size"]) <= 0:
                raise MotionError("the file's scene layout has a box that is not one")
        if not num(o.get("quat", [1, 0, 0, 0]), 4) or not isinstance(o.get("z", 0), (int, float)):
            raise MotionError("the file's scene layout is not one")
        if "rgba" in o and not num(o["rgba"], 4):
            raise MotionError("the file's scene layout is not one")


def layout_model(layout: dict):
    """The model of a scene with `layout`'s container and objects, compiled once per set of bodies. The arm, the
    place zone and the can have the same body ids as in `model()`: the layout's bodies come after them."""
    _check_layout(layout)
    key = _layout_key(layout)
    with _lock:
        hit = _layout_models.get(key)
        if hit is not None:
            _layout_models.move_to_end(key)
            return hit
    from sim.scene import build_model

    try:
        m = build_model([0.5, 0.0], [0.45, -0.3], layout=layout)
    except Exception as e:  # noqa: BLE001 - a layout from a file: anything wrong with it is the file's problem
        raise MotionError(f"the file's scene layout cannot be built: {type(e).__name__}") from e
    with _lock:
        _layout_models[key] = m
        while len(_layout_models) > LAYOUT_MODELS:
            _layout_models.popitem(last=False)
    return m


def layout_geoms(m, first_body: int, also: int | None = None) -> list[dict]:
    """The visual geoms of the bodies from `first_body` on (a layout's container and objects), as `build_scene`
    gives a scene's: boxes, in each body's own frame. `also`: one more body to give the geoms of (the body "can",
    when the layout makes it out of an object's boxes)."""
    import mujoco

    out: list[dict] = []
    for g in range(m.ngeom):
        body = int(m.geom_bodyid[g])
        if (body < first_body and body != also) or int(m.geom_group[g]) == COLLISION_GROUP:
            continue
        gtype = GEOM_TYPES.get(int(m.geom_type[g]))
        if gtype is None or gtype == "mesh":
            continue
        out.append({
            "body": int(m.geom_bodyid[g]), "type": gtype, "name": mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g) or "",
            "size": _r(m.geom_size[g], 5), "pos": _r(m.geom_pos[g], POS_DECIMALS), "quat": _r(m.geom_quat[g], QUAT_DECIMALS),
            "rgba": _r(m.geom_rgba[g], 3),
        })
    return out


# The scenes the viewer can draw, by the name a motion file's poses give it (`poses()["scene"]`, absent for the arm's).
PANDA = "panda"
G1 = "g1"
SCENES = (PANDA, G1)
# The format of the humanoid sim's motion files (sim/g1/motion.py), copied so reading one never imports that sim.
G1_FORMAT = "g1-motion/1"
_g1_model = None


def g1_model():
    """The humanoid scene's model (sim/g1/scene.py), compiled once, with the bag hung at a nominal spot: each
    motion file says where its own hangs."""
    global _g1_model
    with _lock:
        if _g1_model is None:
            from sim.g1.scene import build_model  # needs mujoco and the G1 meshes

            _g1_model = build_model([0.38, -0.15, 1.0])
        return _g1_model


def build_scene(which: str = PANDA) -> dict:
    """The scene as plain data: bodies, meshes (decimated, flat arrays) and visual geoms. See `scene()`."""
    import mujoco
    import numpy as np

    if which == G1:
        from sim.g1.scene import MODEL_ID

        m = g1_model()
    else:
        from sim.scene import MODEL_ID

        m = model()
    name = lambda kind, i: mujoco.mj_id2name(m, kind, i) or ""  # noqa: E731
    meshes: dict[str, dict] = {}
    geoms: list[dict] = []
    for g in range(m.ngeom):
        if int(m.geom_group[g]) == COLLISION_GROUP:
            continue
        gtype = GEOM_TYPES.get(int(m.geom_type[g]))
        if gtype is None:
            continue
        rgba = m.mat_rgba[m.geom_matid[g]] if m.geom_matid[g] >= 0 else m.geom_rgba[g]
        geom: dict[str, Any] = {
            "body": int(m.geom_bodyid[g]),
            "type": gtype,
            "name": name(mujoco.mjtObj.mjOBJ_GEOM, g),
            "size": _r(m.geom_size[g], 5),
            "pos": _r(m.geom_pos[g], POS_DECIMALS),
            "quat": _r(m.geom_quat[g], QUAT_DECIMALS),
            "rgba": _r(rgba, 3),
        }
        if gtype == "mesh":
            mid = int(m.geom_dataid[g])
            key = str(mid)
            if key not in meshes:
                va, vn = int(m.mesh_vertadr[mid]), int(m.mesh_vertnum[mid])
                fa, fn = int(m.mesh_faceadr[mid]), int(m.mesh_facenum[mid])
                verts = np.asarray(m.mesh_vert[va : va + vn], dtype=float)
                faces = np.asarray(m.mesh_face[fa : fa + fn], dtype=np.int64)
                if not vn or float((verts.max(0) - verts.min(0)).max()) < MIN_EXTENT_M:
                    meshes[key] = {}
                else:
                    v, f = _decimate(verts, faces)
                    meshes[key] = {"v": _r(v.reshape(-1), POS_DECIMALS), "f": [int(x) for x in f.reshape(-1)]} if len(f) else {}
            if not meshes[key]:
                continue
            geom["mesh"] = key
        geoms.append(geom)
    bodies = sorted({gm["body"] for gm in geoms})
    return {
        "model_id": MODEL_ID,
        "bodies": [{"id": b, "name": name(mujoco.mjtObj.mjOBJ_BODY, b)} for b in bodies],
        "meshes": {k: v for k, v in meshes.items() if v},
        "geoms": geoms,
    }


def _pack(data: dict) -> bytes:
    return gzip.compress(json.dumps(data, separators=(",", ":"), allow_nan=False).encode(), compresslevel=6)


def scene(which: str = PANDA) -> tuple[dict, bytes]:
    """The static scene for the viewer, and the same as gzipped JSON. Built on the first call, then cached.
    `which`: one of SCENES, the arm's by default.

    {"model_id", "bodies": [{"id", "name"}], "meshes": {"<mesh id>": {"v": [x, y, z, ...], "f": [i, j, k, ...]}},
     "geoms": [{"body", "type": "mesh" | "cylinder" | "plane" | ..., "name", "size", "pos", "quat" (w, x, y, z),
                "rgba", "mesh"?}]}
    Positions are meters in the body's frame; the world body (0) holds the floor.
    """
    global _scene_cache
    if which == G1:
        hit = _other_scenes.get(which)
        if hit is None:
            data = build_scene(which)
            hit = _other_scenes[which] = (data, _pack(data))
        return hit
    if which != PANDA:
        raise ValueError(f"unknown scene {which!r}: there are {SCENES}")
    if _scene_cache is None:
        data = build_scene()
        _scene_cache = (data, _pack(data))
    return _scene_cache


_other_scenes: dict[str, tuple[dict, bytes]] = {}


def _frames_of(motion: dict, m, d, moving: list[int]) -> tuple[list[float], list[list[float]]]:
    """Each frame's time and the world pose of every body in `moving`, from `mj_kinematics` on the frame's qpos."""
    import mujoco
    import numpy as np

    times: list[float] = []
    frames: list[list[float]] = []
    for i, fr in enumerate(motion["frames"]):
        qpos = fr.get("qpos") if isinstance(fr, dict) else None
        if not isinstance(qpos, list) or len(qpos) != m.nq:
            raise MotionError(f"frame {i} has no qpos of {m.nq} numbers")
        try:
            d.qpos[:] = np.asarray(qpos, dtype=float)
        except (TypeError, ValueError) as e:
            raise MotionError(f"frame {i} has a qpos that is not numbers") from e
        if not np.all(np.isfinite(d.qpos)):
            raise MotionError(f"frame {i} has a qpos that is not finite")
        mujoco.mj_kinematics(m, d)
        row: list[float] = []
        for b in moving:
            row += _r(d.xpos[b], POS_DECIMALS) + _r(d.xquat[b], QUAT_DECIMALS)
        frames.append(row)
        t = fr.get("t")
        times.append(round(float(t), 4) if isinstance(t, (int, float)) and np.isfinite(t) else (times[-1] if times else 0.0))
    return times, frames


def _xyz(v) -> bool:
    import math

    return isinstance(v, list) and len(v) == 3 and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and abs(x) < 10 for x in v)


def g1_poses(motion: dict) -> dict:
    """`poses()` of a humanoid recording (sim/g1/motion.py): the same shape, with "scene": "g1" for the viewer to
    draw the humanoid scene, and "bag_pos", where the bag hung, in place of a can start and a place target."""
    import copy

    import mujoco

    header = motion.get("header") if isinstance(motion.get("header"), dict) else {}
    result = motion.get("result") if isinstance(motion.get("result"), dict) else {}
    bag = header.get("bag_pos") or result.get("bag_pos")
    if not _xyz(bag):
        raise MotionError("the file does not say where the bag hung")
    from sim.g1.scene import BAG_BODY, ROPE_LENGTH

    # The bag's body is the rope's fixed top end: a copy of the model with it above this file's bag.
    m = copy.copy(g1_model())
    m.body_pos[m.body(BAG_BODY).id] = [float(bag[0]), float(bag[1]), float(bag[2]) + ROPE_LENGTH]
    d = mujoco.MjData(m)
    moving = _moving_bodies(m)
    times, frames = _frames_of(motion, m, d, moving)
    return {
        "scene": G1,
        "fps": header.get("fps", 30),
        "can_start": None,
        "place_target": None,
        "bag_pos": _r(bag, POS_DECIMALS),
        "result": _public_result(result),
        "n": len(frames),
        "t": times,
        "bodies": moving,
        "frames": frames,
        "static": {},
    }


def _moving_bodies(m) -> list[int]:
    """Bodies with a joint between them and the world: the arm links, the hand, the fingers and the can."""
    return [b for b in range(1, m.nbody) if int(m.body_weldid[b]) != 0]


def poses(motion: dict) -> dict:
    """Each frame's world pose of every moving body: `mj_kinematics` on the frame's qpos.

    {"fps", "can_start", "place_target", "result", "n": frames, "t": [...], "bodies": [body ids],
     "frames": [[x, y, z, qw, qx, qy, qz for each body in `bodies`], ...],
     "static": {"<body id>": [x, y, z, qw, qx, qy, qz]} (bodies that never move; the place zone where this file has it)}

    A file recorded in a scene with a layout (its header's `layout`: a basket and other objects) also has
    "extra": the visual geoms of the layout's bodies, as the scene gives its own (`layout_geoms`), for the viewer
    to draw on top of the scene, and "hide": ["place_zone"], the scene geom the basket stands in place of. Their
    bodies are in `bodies` like any other moving body.
    """
    import mujoco
    import numpy as np

    if not isinstance(motion, dict) or not isinstance(motion.get("frames"), list) or not motion["frames"]:
        raise MotionError("not a motion file: no frames")
    if motion.get("format") == G1_FORMAT:
        return g1_poses(motion)
    header = motion.get("header") if isinstance(motion.get("header"), dict) else {}
    layout = header.get("layout") if isinstance(header.get("layout"), dict) else None
    m = layout_model(layout) if layout else model()
    d = mujoco.MjData(m)
    moving = _moving_bodies(m)
    times, frames = _frames_of(motion, m, d, moving)
    result = motion.get("result") if isinstance(motion.get("result"), dict) else {}
    can_start = header.get("can_start") or result.get("can_start")
    place = header.get("place_target") or result.get("place_target")
    static: dict[str, list[float]] = {}
    for b in range(1, m.nbody):
        if b in moving:
            continue
        pose = _r(d.xpos[b], POS_DECIMALS) + _r(d.xquat[b], QUAT_DECIMALS)
        if mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, b) == "place_zone" and _xy(place):
            pose = [round(float(place[0]), 4), round(float(place[1]), 4), 0.0, 1.0, 0.0, 0.0, 0.0]
        static[str(b)] = pose
    return {
        "fps": header.get("fps", 30),
        "can_start": can_start if _xy(can_start) else None,
        "place_target": place if _xy(place) else None,
        "result": _public_result(result),
        "n": len(frames),
        "t": times,
        "bodies": moving,
        "frames": frames,
        "static": static,
        **(_layout_extra(m, layout) if layout else {}),
    }


def _layout_extra(m, layout: dict) -> dict:
    """What a recording with a layout adds to and takes from the scene: the geoms of its container and objects,
    and of the object to pick when that is one of its own (in place of the scene's cylinder)."""
    import mujoco

    picked = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "can") if layout.get("target") else None
    hide = (["place_zone"] if layout.get("basket") else []) + (["can"] if picked is not None else [])
    return {"extra": layout_geoms(m, model().nbody, picked), "hide": hide}


def _xy(v) -> bool:
    return isinstance(v, list) and len(v) >= 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v[:2])


RESULT_KEYS = (
    "success", "place_error_cm", "upright", "dropped", "max_height_cm", "time_taken", "exception", "end_reason",
    "resting", "released", "tipped", "tilt_deg", "seed", "in_basket", "target",
    # The humanoid sim's (sim/g1/episode.py).
    "struck", "touched", "struck_with", "fell", "bag_peak_cm", "standing",
)


def _public_result(result: dict) -> dict:
    """The episode result keys the viewer shows. A hidden episode's file only gets here once its run is scored (api.py)."""
    out = {k: result[k] for k in RESULT_KEYS if k in result}
    if isinstance(out.get("exception"), str):
        out["exception"] = out["exception"][:400]
    return out


def motion_poses(path: Path) -> bytes:
    """`poses()` of the motion file at `path`, as gzipped JSON, cached by path, size and modification time."""
    st = path.stat()
    if st.st_size > MAX_MOTION_BYTES:
        raise MotionError("the file is too large to be a motion file")
    key = (str(path), st.st_size, st.st_mtime_ns)
    with _lock:
        hit = _motion_cache.get(key)
        if hit is not None:
            _motion_cache.move_to_end(key)
            return hit
    try:
        motion = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise MotionError("the file is not JSON") from e
    packed = _pack(poses(motion))
    with _lock:
        _motion_cache[key] = packed
        while len(_motion_cache) > MOTION_CACHE_SIZE:
            _motion_cache.popitem(last=False)
    return packed


_summary_cache: OrderedDict[tuple, dict] = OrderedDict()


def motion_summary(path: Path) -> dict:
    """What the viewer's file picker shows for a motion file, without the frames: no mujoco needed.

    {"can_start", "place_target", "duration" (seconds), "n" (frames), "result"}, and for a humanoid recording
    "bag_pos", where its bag hung."""
    st = path.stat()
    if st.st_size > MAX_MOTION_BYTES:
        raise MotionError("the file is too large to be a motion file")
    key = (str(path), st.st_size, st.st_mtime_ns)
    with _lock:
        hit = _summary_cache.get(key)
        if hit is not None:
            return hit
    try:
        motion = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise MotionError("the file is not JSON") from e
    if not isinstance(motion, dict) or not isinstance(motion.get("frames"), list) or not motion["frames"]:
        raise MotionError("not a motion file: no frames")
    header = motion.get("header") if isinstance(motion.get("header"), dict) else {}
    result = motion.get("result") if isinstance(motion.get("result"), dict) else {}
    last = motion["frames"][-1]
    t = last.get("t") if isinstance(last, dict) else None
    can_start = header.get("can_start") or result.get("can_start")
    place = header.get("place_target") or result.get("place_target")
    bag = header.get("bag_pos") or result.get("bag_pos")
    out = {
        "can_start": can_start if _xy(can_start) else None,
        "place_target": place if _xy(place) else None,
        **({"bag_pos": bag} if _xyz(bag) else {}),
        "duration": round(float(t), 3) if isinstance(t, (int, float)) and not isinstance(t, bool) else None,
        "n": len(motion["frames"]),
        "result": _public_result(result),
    }
    with _lock:
        _summary_cache[key] = out
        while len(_summary_cache) > MOTION_CACHE_SIZE * 4:
            _summary_cache.popitem(last=False)
    return out
