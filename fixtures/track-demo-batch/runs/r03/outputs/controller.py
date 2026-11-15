"""Plays the reference's joint angles back as they are, with no feedback.

This is what a first attempt looks like, and it is enough for a calm motion: the servos follow the angles and the
reference keeps the centre of mass over the feet. It knows nothing about where the robot really is, so when a
motion shifts the weight, twists the trunk or swings the arms fast, the robot sways further than the reference
does and nothing brings it back.
"""

import numpy as np


class Controller:
    def reset(self, task):
        self.task = task

    def act(self, obs):
        return np.asarray(obs["ref_qpos"], dtype=float)[7:]
