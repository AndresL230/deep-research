"""Calibrate every registered trap offline. No agents, no VMs, no keys.

For each trap: build its task on Pima over 5 seeds and train a random forest two ways, naive (random
split, every column) and honest (the trap's fix first). A trap is usable when the naive gap between
reported and true accuracy is well above the inflation threshold and the honest gap is below it.

Run from the repo root: uv run python scripts/calibrate_traps.py [--seeds 5] [--trees 300] [--markdown]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deep_research import traps  # noqa: E402
from deep_research.calibration import ARMS, measure  # noqa: E402
from deep_research.config import BatchConfig  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--seeds", type=int, default=5)
    p.add_argument("--trees", type=int, default=300)
    p.add_argument("--dataset", default="pima")
    p.add_argument("--target", default=None)
    p.add_argument("--strength", type=float, default=None, help="trap_strength, instead of the default")
    p.add_argument("--noise", type=float, default=None, help="trap_noise, instead of the default")
    p.add_argument("--markdown", action="store_true", help="print the table as Markdown, for the README")
    args = p.parse_args()

    settings = {"dataset": args.dataset, "target": args.target}
    if args.strength is not None:
        settings["trap_strength"] = args.strength
    if args.noise is not None:
        settings["trap_noise"] = args.noise
    threshold = BatchConfig().inflation_threshold

    head = ["Trap", "Run", "Reported", "True", "Gap", "Usable"]
    rows = []
    for trap in traps.registered():
        result = measure(trap.name, tuple(range(args.seeds)), args.trees, **settings)
        usable = result["naive"]["gap"] > threshold and result["honest"]["gap"] < threshold
        for arm in ARMS:
            r = result[arm]
            rows.append([
                trap.name if arm == ARMS[0] else "", arm, f"{r['reported']:.1%}", f"{r['true']:.1%}",
                f"{r['gap'] * 100:+.1f} pts", ("yes" if usable else "NO") if arm == ARMS[0] else "",
            ])

    if args.markdown:
        print("| " + " | ".join(head) + " |")
        print("| " + " | ".join("---" for _ in head) + " |")
        for row in rows:
            print("| " + " | ".join(row) + " |")
    else:
        widths = [max(len(str(r[i])) for r in [head, *rows]) for i in range(len(head))]
        for row in [head, *rows]:
            print("  ".join(str(c).ljust(w) for c, w in zip(row, widths)).rstrip())
    print(f"\n{args.seeds} seeds, {args.trees} trees, dataset {args.dataset}. "
          f"Usable: naive gap above {threshold * 100:.0f} pts and honest gap below it.")


if __name__ == "__main__":
    main()
