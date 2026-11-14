"""Calibration controller "spread": the baseline schedule tuned on positions spread over the table.

Models an agent that tests its controller on many can positions (it draws its own, see
`sim.hidden.spread_positions`, which never overlap the hidden evaluation set) and tunes for all of them.
A grid search over carry height (0.20, 0.15, 0.12), hover height (0.20, 0.15), orientation weight
(0.5, 1.0), carry time (1.4, 2.0, 2.6) and approach time (1.2, 1.6) on 16 spread positions x 3 seeds
found that the carry height is what matters: carrying the can at 0.15 m or 0.12 m instead of 0.20 m
fixed every failure of the baseline there (38/48 -> 48/48). This one takes the lower carry height and,
for margin on long carries, a slower carry (2.0 s) and a firmer hold on the vertical gripper
(down_weight 1.0), which also score 48/48. The whole schedule is 7.8 s.

Used by sim/evaluate.py --calibrate; see sim/CALIBRATION.md.
"""

from sim.controllers.baseline import PARAMS as _BASELINE
from sim.controllers.baseline import Controller as _Baseline

PARAMS = dict(
    _BASELINE,
    lift_height=0.12,
    t_move=2.0,
    down_weight=1.0,
)


class Controller(_Baseline):
    params = PARAMS
