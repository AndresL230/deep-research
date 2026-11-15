"""The hidden evaluation pushes (server side only, never uploaded to the agent's sandbox).

Agents only ever see the practice push (sim/humanoid/practice.py): a shove from behind, angle 0 degrees, 50 N. Their
controller is scored on pushes drawn here: from every direction around the robot, with forces from F_MIN to F_MAX. A
push is [angle_deg, force_n]; every push lasts 0.2 s (sim/humanoid/episode.py).

The range (see sim/humanoid/CALIBRATION.md for the maps behind it): without taking a step, the robot can only keep
its center of mass over its feet, which reach 0.12 m in front of the ankles, 0.05 m behind them and 0.15 m to either
side. A balance controller that holds the center of mass over the middle of the feet survives 0.2 s pushes of 50 N
from every direction; much past that the push carries the center of mass beyond the feet and only a step would save
it. Up to F_MAX every push is survivable by such a controller.

Pushes are stratified: the directions are cut into n equal sectors and the forces into n equal bins; each push takes a
random angle inside its own sector and a random force inside a bin given by a random permutation, so a set covers
every direction and every force evenly. No hidden push is close to the practice one (within MIN_FROM_PRACTICE_DEG
degrees and MIN_FROM_PRACTICE_N newtons of it at once). `hidden_pushes()` is fixed by HIDDEN_SEED;
`spread_pushes()` draws a different set the same way, kept away from the hidden ones, for tuning and calibration
(what a careful agent would try for itself).
"""

from __future__ import annotations

import math

import numpy as np

from sim.humanoid.practice import PRACTICE

HIDDEN_SEED = 20261114
SPREAD_SEED = 7

F_MIN = 25.0
F_MAX = 50.0
MIN_FROM_PRACTICE_DEG = 15.0
MIN_FROM_PRACTICE_N = 5.0
# A spread push is at least this far from every hidden one, in units of (ANGLE_SCALE degrees, FORCE_SCALE newtons).
ANGLE_SCALE = 8.0
FORCE_SCALE = 3.0


def angle_diff(a: float, b: float) -> float:
    """The smallest angle between two directions in degrees, 0 to 180."""
    d = abs(float(a) - float(b)) % 360.0
    return min(d, 360.0 - d)


def near_practice(push) -> bool:
    p = PRACTICE["push"]
    return angle_diff(push[0], p["angle_deg"]) < MIN_FROM_PRACTICE_DEG and abs(float(push[1]) - p["force_n"]) < MIN_FROM_PRACTICE_N


def _distance(a, b) -> float:
    return math.hypot(angle_diff(a[0], b[0]) / ANGLE_SCALE, (float(a[1]) - float(b[1])) / FORCE_SCALE)


def _draw(n: int, seed: int, avoid=(), f_min: float = F_MIN, f_max: float = F_MAX) -> list[list[float]]:
    """`n` pushes [angle_deg, force_n] covering every direction and force evenly (see the module docstring). A push
    near the practice one or within distance 1 of a push in `avoid` is drawn again inside the same cell. Shuffled.
    Deterministic in `seed`."""
    rng = np.random.default_rng(seed)
    sector = 360.0 / n
    bin_w = (f_max - f_min) / n
    bins = rng.permutation(n)
    out = []
    for k in range(n):
        for _ in range(1000):
            angle = round(float((k + rng.uniform()) * sector) % 360.0, 1)
            force = round(float(f_min + (bins[k] + rng.uniform()) * bin_w), 1)
            push = [angle, force]
            if near_practice(push) or any(_distance(push, q) < 1.0 for q in avoid):
                continue
            break
        out.append(push)
    return [out[i] for i in rng.permutation(n)]


def hidden_pushes(n: int = 20, seed: int = HIDDEN_SEED) -> list[list[float]]:
    """The evaluation pushes, [[angle_deg, force_n], ...]. Same n and seed, same list."""
    return _draw(n, seed)


# The failure tracer's own pushes (sim/humanoid/domain.py `trace_run`): the investigator reads where a controller falls
# on these and proposes a fix, which is then measured on the hidden pushes it never saw. Same range, own seed, and every
# one away from every hidden push (`_draw`'s `avoid`: at least ANGLE_SCALE degrees or FORCE_SCALE newtons apart).
DIAG_SEED = 31


def diagnostic_pushes(n: int = 12, seed: int = DIAG_SEED) -> list[list[float]]:
    """The trace's pushes: never a hidden one, nor near one. Same n and seed, same list."""
    return _draw(n, seed, avoid=hidden_pushes())


def spread_pushes(n: int = 16, seed: int = SPREAD_SEED) -> list[list[float]]:
    """A tuning set from the same range as the hidden one, away from every hidden push."""
    return _draw(n, seed, avoid=hidden_pushes())
