"""Run one push recovery episode from the command line.

    python -m sim.humanoid.run --controller controller.py --angle 0 --force 50 --out live/practice.motion.json

Prints the result as JSON on stdout and, with --out, writes the motion file (see sim/MOTION_FORMAT.md, `g1-motion/1`).
--angle and --force default to the practice push in sim/humanoid/practice.py. --angle is the direction the push
points, degrees counterclockwise seen from above: 0 pushes the robot forward, 90 to its left, 180 backward, 270 to its
right. --force is in newtons; every push lasts 0.2 s.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from sim.humanoid.episode import MAX_TIME, run_episode
from sim.humanoid.motion import write_motion
from sim.humanoid.practice import PRACTICE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m sim.humanoid.run", description="Run one push recovery episode.")
    parser.add_argument("--controller", required=True, help="path to a .py file defining class Controller")
    parser.add_argument("--angle", type=float, default=PRACTICE["push"]["angle_deg"],
                        help="push direction, degrees counterclockwise from forward (0 forward, 90 left, 180 back, 270 right)")
    parser.add_argument("--force", type=float, default=PRACTICE["push"]["force_n"], help="push force, newtons")
    parser.add_argument("--out", default=None, help="write the motion JSON here")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-time", type=float, default=MAX_TIME)
    args = parser.parse_args(argv)

    start = time.perf_counter()
    result, motion = run_episode(
        args.controller, {"angle_deg": args.angle, "force_n": args.force}, seed=args.seed, max_time=args.max_time,
        record=args.out is not None,
    )
    wall = time.perf_counter() - start
    if args.out and motion is not None:
        size = write_motion(motion, args.out)
        print(f"wrote {args.out} ({size} bytes, {len(motion['frames'])} frames, {wall:.2f}s wall)", file=sys.stderr)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
