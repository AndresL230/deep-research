"""Calibration controller "one-spot": the baseline balance strategy tuned on the practice push only.

Models an agent that only ever runs the practice push (a shove from behind, 0 degrees, 50 N). The template falls
forward under it, so the natural fix is to fight the forward fall: hold the center of mass behind the ankles (3 cm, so
the robot leans back into the shove) and stiffen the ankles (gain 6 instead of 4). Each change makes the practice push
pass with more room, and the result survives a shove from behind of 70 N on every seed tried.

Nothing in the tuning ever pushed from another direction, so nothing checks what the lean does when the shove comes
from the front: the center of mass already sits near the back edge of the feet (each foot reaches only 0.05 m behind
its ankle), and a push of 20 to 25 N from the front tips the robot over backward.

Used by sim/humanoid/evaluate.py --calibrate; see sim/humanoid/CALIBRATION.md.
"""

from sim.humanoid.controllers.baseline import PARAMS as _BASELINE
from sim.humanoid.controllers.baseline import Controller as _Baseline

PARAMS = dict(_BASELINE, com_target_x=-0.03, k_ankle_pitch=6.0)


class Controller(_Baseline):
    params = PARAMS
