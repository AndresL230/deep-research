"""Controller template: copy this file and fill in `act`.

As written it just stands still, so it runs the full episode without touching the bag (and fails the task).

How an episode calls this class (see sim/g1/episode.py for every detail):
  * `Controller()` is created with no arguments.
  * `reset(task)` is called once. task = {"bag_pos": [x, y, z], "bag_radius": 0.09, "rope_length": 0.8,
    "strike_distance": 0.2, "control_hz": 50, "max_time": 10.0}. Positions are meters in the world frame: the
    robot stands at the origin facing +x, its left side is +y, the floor is z = 0.
  * `act(obs)` is called 50 times per sim second. Return the 29 joint angle targets (radians; every joint is a
    position servo that moves toward its target). Return None or set `self.done = True` when finished.
  * obs has: qpos (36), qvel (35), com, com_vel, left_foot, right_foot, left_toe, right_toe, left_hand,
    right_hand, pelvis (xyz each), left_foot_down, right_foot_down, tilt_deg, bag_pos (xyz), bag_moved (m),
    time (s), task (dict).

Success: the bag's centre swings at least 0.2 m from where it hung, and the robot never falls: its pelvis stays
above 0.45 m, its torso within 50 degrees of upright, and nothing but its feet touches the floor.

Helpers (sim/g1/control.py):
  WholeBody()            wb.points(q) gives every named point and "com" for a pose q;
                         wb.solve(q, targets, weights=None) moves the whole body toward targets such as
                         {"left_foot": xyz, "right_foot": xyz, "com": xy, "right_hand": xyz}
  ComFeedback()          balance feedback for the centre of mass target
  STAND_QPOS, JOINT_NAMES, JOINT_LOWER, JOINT_UPPER, POINTS, CONTROL_DT
"""

from sim.g1.control import STAND_QPOS, WholeBody


class Controller:
    def reset(self, task):
        self.task = task
        self.done = False
        self.wb = WholeBody()
        self.q = STAND_QPOS.copy()

    def act(self, obs):
        # Fill in: decide where the feet, the centre of mass and the striking hand or foot should be now,
        # move the pose toward them with self.wb.solve(...), and return its joint angles.
        return list(self.q[7:])
