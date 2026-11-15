"""The hidden evaluation bag positions (server side only, never uploaded to the agent's sandbox).

Agents only ever see the practice setup (sim/g1/practice.py): one bag at chest height in front of the right
shoulder, (0.38, -0.15, 1.0). Their controller is scored on bags hung all over the space in front of the robot
that a hand or a foot can reach, in two bands:

    high   the bag's centre between 0.85 m and 1.20 m above the floor: chest to head height, in reach of a fist;
    low    between 0.26 m and 0.46 m: shin to knee height, in reach of a foot and of no hand.

In both, the bag hangs 0.30 m to 0.42 m in front of the robot (0.40 m at most for the high band) and up to 0.22 m
to either side. Nothing hangs between the bands: a bag at hip height is out of a standing robot's reach for a
fist and too high for a kick that keeps its balance (sim/g1/CALIBRATION.md).

Half of the positions are high and half low, each band covered evenly (one position drawn at random in each cell
of a grid over the band). `hidden_positions()` is fixed by `HIDDEN_SEED`; `spread_positions()` draws a different
set from the same space, for tuning and calibration (what a careful agent would sample for itself).
"""

from __future__ import annotations

import numpy as np

HIDDEN_SEED = 20261115
SPREAD_SEED = 7

# Per band: (x range, y range, z range), meters.
BANDS: dict[str, tuple[tuple[float, float], tuple[float, float], tuple[float, float]]] = {
    "high": ((0.30, 0.40), (-0.22, 0.22), (0.85, 1.20)),
    "low": ((0.30, 0.42), (-0.22, 0.22), (0.26, 0.46)),
}
# The height that tells the bands apart: a bag whose centre hangs below it is a low one.
BAND_SPLIT = 0.65


def band_of(pos) -> str:
    """ "high" or "low", by the height of the bag's centre."""
    return "low" if float(pos[2]) < BAND_SPLIT else "high"


def in_space(pos) -> bool:
    """True when `pos` is inside one of the bands."""
    (x0, x1), (y0, y1), (z0, z1) = BANDS[band_of(pos)]
    return x0 <= pos[0] <= x1 and y0 <= pos[1] <= y1 and z0 <= pos[2] <= z1


def _draw_band(band: str, n: int, rng: np.random.Generator) -> list[list[float]]:
    """`n` positions that cover the band evenly: its side to side range is cut into `n` strips, one position per
    strip, with the distance and the height each spread over their own range in a shuffled order."""
    (x0, x1), (y0, y1), (z0, z1) = BANDS[band]
    ys = [y0 + (y1 - y0) * (i + rng.uniform()) / n for i in range(n)]
    xs = [x0 + (x1 - x0) * (i + rng.uniform()) / n for i in rng.permutation(n)]
    zs = [z0 + (z1 - z0) * (i + rng.uniform()) / n for i in rng.permutation(n)]
    return [[round(float(x), 3), round(float(y), 3), round(float(z), 3)] for x, y, z in zip(xs, ys, zs)]


def _draw(n: int, seed: int) -> list[list[float]]:
    rng = np.random.default_rng(seed)
    n_low = n // 2
    out = _draw_band("high", n - n_low, rng) + _draw_band("low", n_low, rng)
    return [out[i] for i in rng.permutation(len(out))]


def hidden_positions(n: int = 20, seed: int = HIDDEN_SEED) -> list[list[float]]:
    """The evaluation bag positions, [[x, y, z], ...] in meters. Same n and seed, same list."""
    return _draw(n, seed)


def spread_positions(n: int = 16, seed: int = SPREAD_SEED) -> list[list[float]]:
    """A tuning set from the same space as the hidden one."""
    return _draw(n, seed)


# The failure tracer's own positions (sim/g1/domain.py `trace_run`): the investigator reads where a controller fails on
# these and proposes a fix, which is then measured on the hidden positions it never saw. Same bands, own seed, half
# high and half low, and every one at least MIN_FROM_HIDDEN from every hidden position.
DIAG_SEED = 31
MIN_FROM_HIDDEN = 0.03


def diagnostic_positions(n: int = 12, seed: int = DIAG_SEED) -> list[list[float]]:
    """The trace's bag positions: never a hidden one, nor within MIN_FROM_HIDDEN of one. Same n and seed, same list."""
    hidden = np.asarray(hidden_positions(), dtype=float)
    out: dict[str, list[list[float]]] = {"high": [], "low": []}
    want = {"high": n - n // 2, "low": n // 2}
    for p in _draw(8 * n, seed):
        band = band_of(p)
        if len(out[band]) < want[band] and float(np.min(np.linalg.norm(hidden - np.asarray(p), axis=1))) >= MIN_FROM_HIDDEN:
            out[band].append(p)
    pts = out["high"] + out["low"]
    if len(pts) < n:
        raise RuntimeError(f"only {len(pts)} diagnostic positions kept away from the hidden ones; draw more")
    return [pts[i] for i in np.random.default_rng(seed).permutation(len(pts))]
