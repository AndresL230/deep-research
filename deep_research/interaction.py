"""The two-factor grid (plan 6.4): when two suspects are both supported, do they each matter, and do they add up?

Four cells from one fork point: neither change (`g00`), A only (`g10`), B only (`g01`) and both (`g11`), each the mean
gap of its scored copies. With a smaller gap meaning the change helps:

    effect_A = 1/2 [(g00 - g10) + (g01 - g11)]
    effect_B = 1/2 [(g00 - g01) + (g10 - g11)]
    interaction = 1/2 [(g00 - g10) - (g01 - g11)]   (how much A's effect depends on B being there)

Pure functions; `Batch.run_interaction` runs the copies and writes the result to the case file's `interaction`.
"""

from __future__ import annotations

# The grid's arms, as fork child names: `neither-1`, `a-1`, `b-1`, `both-1`.
CELLS = ("neither", "a", "b", "both")
MAX_PER_CELL = 4


def cell_plan(step_a: dict | None, step_b: dict | None) -> dict[str, dict | list | None]:
    """The arms of the grid: no change, A's step, B's step, and both in order (A then B)."""
    return {"neither": None, "a": step_a, "b": step_b, "both": [s for s in (step_a, step_b) if s is not None] or None}


def mean_gap(children: dict[str, dict], cell: str) -> tuple[float | None, int]:
    """The mean gap of a cell's scored copies and how many there were."""
    gaps = [float(c["gap"]) for cid, c in children.items()
            if cid.rsplit("-", 1)[0] == cell and isinstance(c, dict) and c.get("status") not in (None, "failed")
            and c.get("gap") is not None]
    return (sum(gaps) / len(gaps) if gaps else None), len(gaps)


def effects(g00: float | None, g10: float | None, g01: float | None, g11: float | None) -> dict:
    """`effect_a`, `effect_b` and `interaction` from the four cell means (gap reductions, positive = the change
    shrinks the gap). Each is None when a cell it needs has no scored copy."""
    if None in (g00, g10, g01, g11):
        return {"effect_a": None, "effect_b": None, "interaction": None}
    return {
        "effect_a": round(0.5 * ((g00 - g10) + (g01 - g11)), 4),
        "effect_b": round(0.5 * ((g00 - g01) + (g10 - g11)), 4),
        "interaction": round(0.5 * ((g00 - g10) - (g01 - g11)), 4),
    }


def grid_result(children: dict[str, dict]) -> dict:
    """The grid from a fork's children: per cell `{mean_gap, n}` and the effects."""
    cells = {}
    for cell in CELLS:
        g, n = mean_gap(children, cell)
        cells[cell] = {"mean_gap": None if g is None else round(g, 4), "n": n}
    return {"cells": cells, **effects(cells["neither"]["mean_gap"], cells["a"]["mean_gap"],
                                      cells["b"]["mean_gap"], cells["both"]["mean_gap"])}
