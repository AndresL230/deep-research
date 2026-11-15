"""Run one motion tracking episode from the command line.

    python3 -m sim.g1.track.run --controller controller.py --out live/practice.motion.json
    python3 -m sim.g1.track.run --controller controller.py --motion NAME
    python3 -m sim.g1.track.run --list

Prints the episode's result as JSON and, with --out, saves its recording. Without --motion the reference is the
practice motion (sim/g1/track/practice.py). `--list` prints the reference motions there are, and runs nothing.
"""

from __future__ import annotations

import argparse
import json
import sys

from sim.g1.track.practice import PRACTICE


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run one G1 motion tracking episode and print its result as JSON.")
    ap.add_argument("--controller", help="path to the controller .py file")
    ap.add_argument("--motion", default=PRACTICE["motion"], help="the name of the reference motion to follow")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", help="save the episode's recording to this file (use a name ending in .motion.json)")
    ap.add_argument("--list", action="store_true", help="print the reference motions there are, and run nothing")
    args = ap.parse_args(argv)
    from sim.g1.track.motions import load, names, public_info

    if args.list:
        print(json.dumps([public_info(load(n)) for n in names()], indent=2))
        return 0
    if not args.controller:
        ap.error("--controller is required")
    from sim.g1.track.episode import run_episode

    try:
        result, motion = run_episode(args.controller, args.motion, seed=args.seed, record=bool(args.out))
    except ValueError as e:
        ap.error(str(e))
    if args.out and motion is not None:
        from sim.g1.motion import write_motion

        result["motion_bytes"] = write_motion(motion, args.out)
        result["motion_file"] = args.out
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
