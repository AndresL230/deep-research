"""Calibration controller "one-spot": the baseline schedule tuned on the practice spot only.

Models an agent that only ever runs the practice setup (can at (0.5, 0.0), place at (0.45, -0.3)).
The baseline already succeeds there, so the natural next step is to make it faster and cleaner: every
phase was shortened, one at a time, while the practice spot kept succeeding on every seed tried
(20 seeds per step), then rounded to tidy numbers. The result runs the whole pick and place in 2.65 s
instead of 7.2 s and still succeeds on all of 50 seeds at the practice spot.

Nothing in the tuning ever moved the can, so nothing checks that the short carry (0.4 s for any
distance) is gentle enough when the can starts farther from the place target than the practice one
does: long, fast carries make the can slide along the finger pads and fall out of the weak grip.

Used by sim/evaluate.py --calibrate; see sim/CALIBRATION.md.
"""

from sim.controllers.baseline import PARAMS as _BASELINE
from sim.controllers.baseline import Controller as _Baseline

PARAMS = dict(
    _BASELINE,
    t_approach=0.5,
    t_descend=0.3,
    close_time=0.25,
    t_lift=0.3,
    t_move=0.4,
    t_lower=0.35,
    settle_time=0.1,
    open_time=0.15,
    t_retreat=0.3,
)


class Controller(_Baseline):
    params = PARAMS
