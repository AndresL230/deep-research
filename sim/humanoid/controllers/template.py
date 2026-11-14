"""Controller template: copy this file and fill in `act`.

As written it holds the standing pose the episode starts in, stiffly, and does nothing about a push. A shove of a few
tens of newtons tips it over like a plank.

How an episode calls this class (see sim/humanoid/episode.py for every detail):
  * `Controller()` is created with no arguments.
  * `reset(task)` is called once. task = {"control_hz": 50, "max_time": 5.0, "joints": [the 29 joint names]}. The
    push is not in it: the controller only sees the robot's own state, in obs.
  * `act(obs)` is called 50 times per sim second. Return 29 numbers: one target angle (radians) per joint, in the
    order of JOINTS (each joint is a position servo that moves toward its target). Return None to keep the previous
    targets.
  * obs has: qpos (36), qvel (35), joint_pos (29), joint_vel (29), com and com_vel (the center of mass, xyz),
    pelvis_pos, pelvis_quat, torso_quat (wxyz), torso_angvel, left_foot and right_foot (ankle positions, xyz),
    foot_contact (2 bools), time (s), task (dict).

The world: z up, floor at z = 0, the robot starts at the origin facing +x with its left side toward +y.

Success: the robot is still on its feet at the end of the episode (5 s): its pelvis never went below 0.45 m and no
part of it other than the feet touched the floor.

Helpers (sim/humanoid/control.py):
  JOINTS, JOINT_INDEX, index(name)   joint names in action order, and a name's index ("left_ankle_pitch")
  STAND_CTRL                         the standing pose (29 target angles)
  JOINT_LOWER, JOINT_UPPER           joint limits
  FOOT_CORNERS                       where each foot touches the floor, relative to its ankle
  MASS, CONTROL_DT, tilt_deg(quat)
"""

import numpy as np

from sim.humanoid.control import STAND_CTRL


class Controller:
    def reset(self, task):
        self.task = task

    def act(self, obs):
        # Fill in: read the robot's state from obs and decide the joint targets that keep it standing.
        return np.array(STAND_CTRL, dtype=float)
