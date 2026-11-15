"""Run one strike episode from the command line.

    python3 -m sim.g1.run --controller controller.py --bag 0.38,-0.15,1.0 --out live/practice.motion.json

Prints the episode's result as JSON and, with --out, saves its motion. Without --bag the bag hangs at the practice
position (sim/g1/practice.py).
"""

from __future__ import annotations

import argparse
import json
import sys

from sim.g1.episode import MAX_TIME, run_episode
from sim.g1.practice import PRACTICE


def _xyz(text: str) -> list[float]:
    parts = [float(v) for v in text.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(f"expected x,y,z, got {text!r}")
    return parts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run one G1 strike episode and print its result as JSON.")
    ap.add_argument("--controller", required=True, help="path to the controller .py file")
    ap.add_argument("--bag", type=_xyz, default=list(PRACTICE["bag_pos"]), help="where the bag's centre hangs: x,y,z in meters")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-time", type=float, default=MAX_TIME, help="sim seconds before the episode stops")
    ap.add_argument("--out", help="save the episode's motion to this file (use a name ending in .motion.json)")
    args = ap.parse_args(argv)
    result, motion = run_episode(args.controller, args.bag, seed=args.seed, max_time=args.max_time, record=bool(args.out))
    if args.out and motion is not None:
        from sim.g1.motion import write_motion

        result["motion_bytes"] = write_motion(motion, args.out)
        result["motion_file"] = args.out
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
