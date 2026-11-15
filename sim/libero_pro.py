"""Can positions taken from LIBERO and LIBERO-PRO, for a batch with `positions="libero_pro"`.

The agents practise where LIBERO puts the object to pick, and their controller is measured where LIBERO-PRO moves
it. Only the positions come from the benchmarks: the scene, the can, the controller interface and the scoring
are this sim's own. Nothing of LIBERO runs here.

Where the numbers come from
---------------------------
The LIBERO-Object suite: ten tasks "pick the <grocery item> and place it in the basket" on a floor, each a BDDL
text file that names 5 cm square regions and says which object stands in which.

  * LIBERO (MIT), `libero/libero/bddl_files/libero_object/*.bddl`: the object to pick stands in
    `target_object_region`, at one of two places over the ten tasks, and the basket in `bin_region`.
  * LIBERO-PRO (code MIT, data CC BY 4.0; Zhou et al., arXiv:2510.03827; Hugging Face dataset
    `zhouxueyang/LIBERO-Pro`), `bddl_files/libero_object_swap/*.bddl`: the position perturbation. The object to
    pick swaps regions with another object, so it stands in one of the regions the other objects had.
  * LIBERO-PRO, `bddl_files/07_initial_pose_position_angle/bddl/libero_object/*.bddl`: the initial pose
    perturbation. The object to pick is shifted by (0.17, -0.06) m and turned 45 degrees.

The BDDL files give a region as `(x_min y_min x_max y_max)` in LIBERO's floor frame. LIBERO stands its Panda
at (-0.6, 0, 0) in that frame for a floor task (`OnTheGroundPanda.base_xpos_offset["empty"]`), and this sim has
the same arm with its base at the origin, so a LIBERO point (x, y) is (x + 0.6, y) here. The table below holds
each region's centre in this sim's frame; the regions were read from the files on 2026-11-14.

What is left out
----------------
  * The initial pose perturbation of the second LIBERO layout puts the object 0.835 m from the base. This sim's
    arm reaches a can pointing down out to about 0.78 m (sim/CALIBRATION.md), so no controller could pass
    there: it is not a hidden position (`OUT_OF_REACH`).
  * The 45 degree turn: the can is a cylinder, so its yaw changes nothing.
  * LIBERO's own saved initial states (`init_files/*.pruned_init`, 50 per task): they are pickles, which are
    never loaded here. A position inside a region is drawn here instead, uniformly as LIBERO draws it
    (`hidden_positions`).
"""

from __future__ import annotations

import numpy as np

# LIBERO's floor frame to this sim's: the Panda's base is at x = -0.6 m there and at the origin here.
BASE_X = 0.6
# The side of a LIBERO object region.
REGION_SIDE = 0.05
SEED = 20261114

# The object to pick in LIBERO-Object's first task, "pick the alphabet soup and place it in the basket": its
# `target_object_region`, and the basket's `bin_region`. Both layouts of the suite share the basket.
PRACTICE = {"can_xy": [0.48, -0.24], "place_xy": [0.6, 0.26]}

# Where LIBERO-PRO stands the object to pick, over the ten LIBERO-Object tasks: each region's centre in this
# sim's frame, the perturbation it comes from, and the tasks it is the target's region in.
REGIONS: list[dict] = [
    {"xy": [0.40, -0.08], "source": "position swap", "tasks": ["alphabet_soup", "salad_dressing"]},
    {"xy": [0.65, -0.10], "source": "position swap", "tasks": ["butter", "milk"]},
    {"xy": [0.70, -0.20], "source": "position swap", "tasks": ["chocolate_pudding"]},
    {"xy": [0.75, 0.03], "source": "position swap", "tasks": ["ketchup"]},
    {"xy": [0.45, 0.06], "source": "position swap", "tasks": ["orange_juice"]},
    {"xy": [0.65, -0.30], "source": "initial pose shift", "tasks": ["alphabet_soup", "butter", "chocolate_pudding", "ketchup", "milk"]},
]
# The position swap also sends four tasks' object to the practice region itself: that is the practice spot, so it
# is not measured again. And the one region no controller of this sim can reach.
SAME_AS_PRACTICE = {"xy": [0.48, -0.24], "source": "position swap", "tasks": ["bbq_sauce", "cream_cheese", "tomato_sauce"]}
OUT_OF_REACH = {"xy": [0.82, -0.16], "source": "initial pose shift",
                "tasks": ["bbq_sauce", "cream_cheese", "orange_juice", "salad_dressing", "tomato_sauce"]}

# Hidden positions per region: its centre, then points drawn inside it.
PER_REGION = 4


def practice_setup() -> dict:
    return {"can_xy": list(PRACTICE["can_xy"]), "place_xy": list(PRACTICE["place_xy"])}


def hidden_positions(per_region: int = PER_REGION, seed: int = SEED) -> list[list[float]]:
    """The can positions a LIBERO-PRO batch is measured at: `per_region` in each of `REGIONS`.

    A region's first position is its centre; the others are drawn uniformly inside its 5 cm square, as LIBERO
    draws an object's place in a region. The list goes round the regions (every region's centre, then every
    region's second point, ...), so its first n positions cover the regions evenly for any n.
    """
    rng = np.random.default_rng(seed)
    half = REGION_SIDE / 2
    per: list[list[list[float]]] = []
    for region in REGIONS:
        cx, cy = region["xy"]
        points = [[cx, cy]]
        for _ in range(max(0, per_region - 1)):
            dx, dy = rng.uniform(-half, half, size=2)
            points.append([round(cx + float(dx), 4), round(cy + float(dy), 4)])
        per.append(points)
    return [per[r][i] for i in range(per_region) for r in range(len(REGIONS))]


def measure(controller, evaluate_fn=None, record_dir=None, motion_prefix: str | None = None) -> dict:
    """One controller file at the LIBERO-PRO positions, with LIBERO's basket as the place target.

    Returns {"success_rate", "successes", "n", "by_source", "results", "practice_xy", "place_xy"}: `by_source` maps
    each perturbation ("position swap", "initial pose shift") to its own {"successes", "n"}, and `results` has one
    entry per episode, in order: `sim.domain.hidden_result` (where the can stood, what happened, its recording)
    plus `source`. A second number beside a batch's own hidden test, never a replacement for it: these positions
    sit within a 35 cm patch, the hidden test covers the whole table.

    `record_dir`: every episode is recorded there (as in `sim.domain.score_run`), and each result's `motion` is
    `motion_prefix/<file name>`. Without it nothing is recorded and every `motion` is None.
    """
    from pathlib import Path

    from sim.domain import hidden_result

    if evaluate_fn is None:
        from sim.evaluate import evaluate as evaluate_fn
    positions = hidden_positions()
    extra = {} if record_dir is None else {"record_dir": str(record_dir)}
    result = evaluate_fn(str(controller), positions, place_xy=PRACTICE["place_xy"], seeds=(0,), **extra)
    results = result.get("results") or []
    by_source: dict[str, dict] = {}
    episodes: list[dict] = []
    for r in results:
        source = source_of(r.get("can_xy") or (0, 0)) or "other"
        tally = by_source.setdefault(source, {"successes": 0, "n": 0})
        tally["n"] += 1
        tally["successes"] += 1 if r.get("success") else 0
        path = Path(r["motion_path"]) if r.get("motion_path") else None
        motion = f"{motion_prefix}/{path.name}" if path is not None and motion_prefix and path.is_file() else None
        episodes.append({**hidden_result(r, motion), "source": source})
    n = int(result.get("n") or len(results) or len(positions))
    successes = result.get("successes")
    if successes is None and results:
        successes = sum(1 for r in results if r.get("success"))
    return {"success_rate": float(result["success_rate"]), "successes": None if successes is None else int(successes),
            "n": n, "by_source": by_source, "results": episodes,
            "practice_xy": list(PRACTICE["can_xy"]), "place_xy": list(PRACTICE["place_xy"])}


def source_of(xy) -> str | None:
    """The perturbation a hidden position comes from ("position swap", "initial pose shift"), or None."""
    half = REGION_SIDE / 2 + 1e-9
    for region in REGIONS:
        if abs(float(xy[0]) - region["xy"][0]) <= half and abs(float(xy[1]) - region["xy"][1]) <= half:
            return region["source"]
    return None
