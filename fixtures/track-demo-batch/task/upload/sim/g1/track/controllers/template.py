"""Template controller for the G1 motion tracking task. Copy this file and fill in `act`.

It runs as it is, but it only holds the pose the robot starts in, so it tracks nothing.

See `sim/g1/track/episode.py` for everything in `task` and `obs`, `sim/g1/track/motions.py` for what a reference
is, and `sim/g1/control.py` for the helpers (`WholeBody`, `ComFeedback`, `JOINT_NAMES`, `POINTS`).
"""

import numpy as np


class Controller:
    def reset(self, task):
        # The whole reference is known from the start: task["reference"]["qpos"] is an (n, 36) array of poses,
        # task["reference"]["fps"] a second. A pose is pelvis xyz, pelvis quaternion wxyz, then the 29 joint angles.
        self.task = task
        self.ready = np.array(task["ready_qpos"], dtype=float)[7:]

    def act(self, obs):
        # obs["ref_qpos"] is the reference pose at this time; obs["qpos"] is where the robot really is.
        # Return the 29 joint angle targets.
        return self.ready
