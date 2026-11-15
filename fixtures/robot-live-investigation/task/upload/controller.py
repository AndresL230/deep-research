"""Controller template: copy this file and fill in `act`.

As written it just holds the arm at the home pose with the gripper open, so it runs the full episode
without doing anything (and fails the task).

How an episode calls this class (see sim/episode.py for every detail):
  * `Controller()` is created with no arguments.
  * `reset(task)` is called once. task = {"can_start": [x, y], "place_target": [x, y],
    "control_hz": 50, "max_time": 10.0}. Positions are meters in the world frame, robot base at the
    origin, floor at z = 0. The can is a cylinder 0.05 m wide and 0.10 m tall standing on the floor.
  * `act(obs)` is called 50 times per sim second. Return 8 numbers: 7 arm joint angle targets
    (radians; the arm joints are position servos that move toward them) and a gripper command
    (GRIPPER_CLOSED = 0 .. GRIPPER_OPEN = 255). Return None or set `self.done = True` when finished.
  * obs has: qpos (16), qvel (15), hand_pos (grasp point xyz), can_pos (xyz), can_quat (wxyz),
    finger_width (m), time (s), task (dict).

Success: the can ends standing upright, at rest, released, with its center within 3 cm of the place
target. The episode stops early once that has held for 0.5 s, or at 10 s.

Helpers (sim/control.py):
  ik(xyz, q_init=None, down_weight=0.0)  joint angles putting the grasp point (between the fingertips)
                                         at xyz; down_weight ~0.5 also keeps the gripper pointing down
  hand_position(q)                       grasp point xyz for arm angles q
  hand_down_error(q)                     gripper tilt from vertical in degrees
  HOME_QPOS, JOINT_LOWER, JOINT_UPPER, GRIPPER_OPEN, GRIPPER_CLOSED, CONTROL_DT
"""

import numpy as np

from sim.control import GRIPPER_OPEN, HOME_QPOS


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False

    def act(self, obs):
        # Fill in: decide where the grasp point should go, convert it with ik(...), and set the gripper.
        arm = np.array(HOME_QPOS, dtype=float)
        gripper = GRIPPER_OPEN
        return list(arm) + [gripper]
