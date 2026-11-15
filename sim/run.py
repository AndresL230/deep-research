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

# Frames per second of a recording made in a scene with a layout (sim/scene.py).
LAYOUT_FPS = 15
from sim.practice import PRACTICE


def _xy(text: str) -> list[float]:
    parts = [p for p in text.replace(" ", "").split(",") if p]
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"expected x,y but got {text!r}")
    return [float(parts[0]), float(parts[1])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m sim.run", description="Run one pick-and-place episode.")
    parser.add_argument("--controller", required=True, help="path to a .py file defining class Controller")
    parser.add_argument("--can", type=_xy, default=None, help="can start x,y in meters (default: the practice one)")
    parser.add_argument("--place", type=_xy, default=PRACTICE["place_xy"], help="place target x,y in meters")
    parser.add_argument("--out", default=None, help="write the motion JSON here")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-time", type=float, default=MAX_TIME)
    layout = PRACTICE.get("layout")
    if layout:
        parser.add_argument("--no-scene", action="store_true",
                            help="leave the basket and the other objects out: only the can and a flat place zone")
        others = [o["name"] for o in layout.get("objects") or []]
        if layout.get("target") and others:
            parser.add_argument("--target", choices=others, default=None,
                                help=f"pick this object of the scene instead of the {layout['target']['name']}, from where it stands")
    args = parser.parse_args(argv)
    can = args.can
    if layout and args.no_scene:
        layout = None
    if layout and getattr(args, "target", None):
        from sim.scene import retarget

        layout, stands = retarget(layout, args.target, PRACTICE["can_xy"])
        can = can or stands
    args.can = can or PRACTICE["can_xy"]

    start = time.perf_counter()
    # A scene with more bodies has more to record per frame: half the frame rate keeps the file in its size limit.
    fps = {"motion_fps": LAYOUT_FPS} if layout else {}
    result, motion = run_episode(
        args.controller, args.can, args.place, seed=args.seed, max_time=args.max_time, record=args.out is not None,
        layout=layout, **fps
    )
    wall = time.perf_counter() - start
    if args.out and motion is not None:
        size = write_motion(motion, args.out)
        print(f"wrote {args.out} ({size} bytes, {len(motion['frames'])} frames, {wall:.2f}s wall)", file=sys.stderr)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
