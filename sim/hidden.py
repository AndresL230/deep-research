"""The hidden evaluation positions (server side only, never uploaded to the agent's sandbox).

Agents only ever see the practice setup (sim/practice.py): one can position near the middle of the
table, (0.5, 0.0), with the place target at (0.45, -0.3). Their controller is scored on can positions
drawn here, spread over the whole part of the table the arm can work on. The place target stays the
practice one (the evaluation only moves the can), so the only thing that changes is the can start.

The workable area (see sim/CALIBRATION.md for the maps behind it):
  * radius from the robot base between 0.30 m and 0.78 m. Closer than 0.30 the gripper cannot get down
    to the can beside the base; beyond about 0.78 m the arm cannot reach grasp height pointing down.
  * x >= 0.28 m and |y| <= 0.48 m (in front of the robot, inside the table area the maps cover).
  * at least 0.10 m from the place target, so the can actually has to be carried, and at least 0.06 m
    from the practice position, so no hidden position is the practice one.

Positions are stratified: the area is cut into n cells of about equal area and one position is drawn
uniformly inside each, so a set covers the table evenly and its success rate tracks the average over
the whole area. `hidden_positions()` is fixed by `HIDDEN_SEED`; `spread_positions()` draws a
different set from the same area, kept away from the hidden ones, for tuning and calibration (what a
careful agent would sample for itself).

Can yaw is not varied: the can is a cylinder, so its yaw does not change the physics.
"""

from __future__ import annotations

import math

import numpy as np

from sim.practice import PRACTICE

HIDDEN_SEED = 20261114
SPREAD_SEED = 7

R_MIN = 0.30
R_MAX = 0.78
X_MIN = 0.28
Y_MAX = 0.48
MIN_FROM_PLACE = 0.10
MIN_FROM_PRACTICE = 0.06
MIN_FROM_HIDDEN = 0.03  # m between a spread position and every hidden one


def in_area(xy, place_xy=None) -> bool:
    """True when `xy` is inside the workable area the hidden and spread sets are drawn from."""
    x, y = float(xy[0]), float(xy[1])
    px, py = PRACTICE["place_xy"] if place_xy is None else place_xy
    cx, cy = PRACTICE["can_xy"]
    r = math.hypot(x, y)
    return (
        R_MIN <= r <= R_MAX
        and x >= X_MIN
        and abs(y) <= Y_MAX
        and math.hypot(x - px, y - py) >= MIN_FROM_PLACE
        and math.hypot(x - cx, y - cy) >= MIN_FROM_PRACTICE
    )


def _area_samples(rng: np.random.Generator, count: int) -> np.ndarray:
    """`count` points drawn uniformly from the workable area."""
    out = []
    while len(out) < count:
        p = np.array([rng.uniform(X_MIN, R_MAX), rng.uniform(-Y_MAX, Y_MAX)])
        if in_area(p):
            out.append(p)
    return np.array(out)


def _draw(n: int, seed: int, avoid=(), avoid_dist: float = 0.0) -> list[list[float]]:
    """`n` positions that cover the area evenly: one random position from each of `n` cells of about
    equal area (k-means cells of a dense uniform sample). Stratifying like this keeps a set of 20
    representative of the whole area, so its success rate is close to the area average instead of
    swinging with which corners a plain random draw happened to hit. A position closer than
    `avoid_dist` to a point in `avoid` is never picked. Shuffled, so a prefix is a random subset of
    the cells. Deterministic in `seed`."""
    rng = np.random.default_rng(seed)
    pts = _area_samples(rng, max(4000, 200 * n))
    centers = pts[rng.choice(len(pts), size=n, replace=False)]
    for _ in range(60):
        label = np.argmin(((pts[:, None, :] - centers[None, :, :]) ** 2).sum(-1), axis=1)
        new = np.array([pts[label == k].mean(axis=0) if np.any(label == k) else centers[k] for k in range(n)])
        if np.allclose(new, centers, atol=1e-7):
            break
        centers = new
    avoid_arr = np.asarray(avoid, dtype=float).reshape(-1, 2)
    chosen = []
    for k in range(n):
        members = pts[label == k]
        for i in rng.permutation(len(members)):
            p = members[i]
            if len(avoid_arr) and np.min(np.linalg.norm(avoid_arr - p, axis=1)) < avoid_dist:
                continue
            chosen.append([round(float(p[0]), 3), round(float(p[1]), 3)])
            break
    return [chosen[i] for i in rng.permutation(len(chosen))]


def hidden_positions(n: int = 20, seed: int = HIDDEN_SEED) -> list[list[float]]:
    """The evaluation can positions, [[x, y], ...] in meters. Same n and seed, same list."""
    return _draw(n, seed)


def spread_positions(n: int = 16, seed: int = SPREAD_SEED) -> list[list[float]]:
    """A tuning set from the same area as the hidden one, at least 3 cm from every hidden position."""
    return _draw(n, seed, avoid=hidden_positions(), avoid_dist=MIN_FROM_HIDDEN)
