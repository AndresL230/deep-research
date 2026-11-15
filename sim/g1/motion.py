"""Motion files of the humanoid sim: a compact JSON recording of one episode.

    {"format": "g1-motion/1",
     "header": {"model_id", "joint_names", "actuator_names", "bag_pos", "fps", "nq", "nu", "seed", "dt"},
     "frames": [{"t", "qpos", "bag"}, ...],
     "result": {...}}

`qpos` is the whole state (sim/g1/scene.py: pelvis xyz + quaternion wxyz, 29 joint angles, the bag's ball joint
quaternion), enough to pose every body; `bag` is the bag's centre xyz, for a reader that draws only that.
"""

from __future__ import annotations

from sim.motion import DECIMALS, LOW_DECIMALS, LOW_FPS, MOTION_FPS, dumps, read_motion, round_list, write_motion

FORMAT = "g1-motion/1"

__all__ = ["FORMAT", "DECIMALS", "LOW_DECIMALS", "LOW_FPS", "MOTION_FPS", "dumps", "read_motion", "round_list",
           "write_motion"]
