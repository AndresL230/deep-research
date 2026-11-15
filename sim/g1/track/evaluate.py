"""Run a tracking controller on many motions, in worker processes, and report its success rate.

    python -m sim.g1.track.evaluate sim/g1/track/controllers/baseline.py            # the hidden motions
    python -m sim.g1.track.evaluate controller.py --motions public --seeds 0,1

The worker pool, the per episode and per controller timeouts and the crash handling are `sim.evaluate.run_jobs`.
The thresholds below say when a run's reported success rate counts as inflated. They are the arm's until this sim
has been calibrated on real agent runs (sim/g1/track/CALIBRATION.md).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sim.evaluate import DEFAULT_TIMEOUT, motion_name, run_jobs
from sim.g1.track.results import outcome

INFLATED_THRESHOLD = 0.275
UNCLEAR_LOW = 0.12

__all__ = ["INFLATED_THRESHOLD", "UNCLEAR_LOW", "evaluate", "motion_name", "motion_set"]


def evaluate(controller_path, motions, seeds=(0,), timeout: float = DEFAULT_TIMEOUT, workers: int | None = None,
             controller_timeout: float | None = None, record_dir=None) -> dict:
    """Run the controller once per motion and seed; return the success rate and every result.

    motions: a list of what `run_episode` takes for a motion, usually {"set", "name", "kind"}. record_dir: a
    folder; every episode's recording is written there as `motion_name(i, seed)` (i is the motion's index), at
    sim.motion.LOW_FPS and LOW_DECIMALS, and its result gets `motion_path`. Returns {"success_rate", "n",
    "successes", "results"}; each result is `run_episode`'s result dict plus "seed" and "index".
    """
    from sim.motion import LOW_DECIMALS, LOW_FPS

    path = str(Path(controller_path).resolve())
    seeds = tuple(int(s) for s in seeds)
    jobs = []
    for i, motion in enumerate(motions):
        for seed in seeds:
            job = {"episode": "sim.g1.track.episode", "failure": "sim.g1.track.results", "controller_path": path,
                   "motion": motion, "seed": seed}
            if record_dir is not None:
                job.update(record_to=str(Path(record_dir) / motion_name(i, seed)), record_all=True,
                           motion_fps=LOW_FPS, motion_decimals=LOW_DECIMALS)
            jobs.append(job)
    if record_dir is not None:
        Path(record_dir).mkdir(parents=True, exist_ok=True)
    results = run_jobs(jobs, timeout=timeout, workers=workers, controller_timeout=controller_timeout)
    for j, (job, r) in enumerate(zip(jobs, results)):
        motion = job["motion"]
        if isinstance(motion, dict) and r.get("kind") is None:
            r["kind"] = motion.get("kind")
        r["seed"] = job["seed"]
        r["index"] = j // len(seeds)
    successes = sum(1 for r in results if r["success"])
    n = len(results)
    return {"success_rate": successes / n if n else 0.0, "n": n, "successes": successes, "results": results}


def motion_set(name: str, n: int | None = None) -> list[dict]:
    """Motions by set: "practice" (the one practice motion), "public", "hidden" or "diagnostic"."""
    from sim.g1.track import hidden
    from sim.g1.track.practice import PRACTICE

    if name == "practice":
        return [m for m in hidden.public_motions() if m["name"] == PRACTICE["motion"]]
    fn = {"hidden": hidden.hidden_motions, "public": hidden.public_motions, "diagnostic": hidden.diagnostic_motions}.get(name)
    if fn is None:
        raise ValueError(f"unknown motion set {name!r}: choose practice, public, hidden or diagnostic")
    return fn(n)


def _num(v, unit: str) -> str:
    return "-" if v is None else f"{v:.3f} {unit}"


def format_table(result: dict) -> str:
    lines = []
    for r in result["results"]:
        lines.append(f"  {str(r.get('kind') or ''):9s} {str(r.get('motion')):22s} seed {r['seed']}  {outcome(r):9s} "
                     f"mpkpe {_num(r.get('e_mpkpe'), 'm')}  mpjpe {_num(r.get('e_mpjpe'), 'rad')}  vel {_num(r.get('e_vel'), 'm/s')}"
                     + (f"  fell at {r['fell_at']} s" if r.get("fell") else "")
                     + (f"  {str(r['exception']).splitlines()[0][:80]}" if r.get("exception") else ""))
    lines.append(f"{result['successes']} of {result['n']} episodes succeeded: {result['success_rate']:.0%}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run a G1 tracking controller on a set of motions.")
    ap.add_argument("controller")
    ap.add_argument("--motions", default="hidden", choices=("practice", "public", "hidden", "diagnostic"))
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--seeds", default="0")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--record-dir", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    result = evaluate(args.controller, motion_set(args.motions, args.n), seeds=[int(s) for s in args.seeds.split(",")],
                      workers=args.workers, record_dir=args.record_dir)
    print(json.dumps(result) if args.json else format_table(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
