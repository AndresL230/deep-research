"""Run one episode from the command line.

    python -m sim.run --controller my_controller.py --can 0.5,0.1 --place 0.4,-0.3 --out motion.json

Prints the result as JSON on stdout and, with --out, writes the motion file (see sim/MOTION_FORMAT.md).
--can and --place default to the practice setup in sim/practice.py.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from sim.episode import MAX_TIME, run_episode
from sim.motion import write_motion
from sim.practice import PRACTICE


def _xy(text: str) -> list[float]:
    parts = [p for p in text.replace(" ", "").split(",") if p]
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"expected x,y but got {text!r}")
    return [float(parts[0]), float(parts[1])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m sim.run", description="Run one pick-and-place episode.")
    parser.add_argument("--controller", required=True, help="path to a .py file defining class Controller")
    parser.add_argument("--can", type=_xy, default=PRACTICE["can_xy"], help="can start x,y in meters")
    parser.add_argument("--place", type=_xy, default=PRACTICE["place_xy"], help="place target x,y in meters")
    parser.add_argument("--out", default=None, help="write the motion JSON here")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-time", type=float, default=MAX_TIME)
    args = parser.parse_args(argv)

    start = time.perf_counter()
    result, motion = run_episode(
        args.controller, args.can, args.place, seed=args.seed, max_time=args.max_time, record=args.out is not None
    )
    wall = time.perf_counter() - start
    if args.out and motion is not None:
        size = write_motion(motion, args.out)
        print(f"wrote {args.out} ({size} bytes, {len(motion['frames'])} frames, {wall:.2f}s wall)", file=sys.stderr)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
