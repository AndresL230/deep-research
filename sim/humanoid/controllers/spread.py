"""Calibration controller "spread": the baseline balance strategy tuned on pushes from every direction.

Models an agent that pushes its robot from many directions and with many forces (it draws its own pushes, see
`sim.humanoid.hidden.spread_pushes`, which never overlap the hidden evaluation set) and tunes for all of them. A grid
search over where to hold the center of mass (com_target_x 0, 0.02, 0.035, 0.05 m in front of the ankles), the knee
bend (crouch 0, 0.2, 0.4 rad), the ankle gain (3, 5, 7) and the hip gain (0, 1) on 16 spread pushes x 3 seeds found that
the center of mass target is what matters: every setting with com_target_x of 0.02 or more scored 48/48, and
every setting with 0 (the baseline's, over the ankles) failed the pushes from the front. This one holds the center of
mass over the middle of the feet (0.035 m in front of the ankles: the feet reach 0.12 m in front and 0.05 m behind),
and for margin bends the knees a little (0.2 rad) and uses ankle gain 5.

Used by sim/humanoid/evaluate.py --calibrate; see sim/humanoid/CALIBRATION.md.
"""

from sim.humanoid.controllers.baseline import PARAMS as _BASELINE
from sim.humanoid.controllers.baseline import Controller as _Baseline

PARAMS = dict(_BASELINE, com_target_x=0.035, crouch=0.2, k_ankle_pitch=5.0)


class Controller(_Baseline):
    params = PARAMS
