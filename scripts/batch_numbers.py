"""Print the numbers a saved batch backs: run counts, inflated share, time and cost per run,
how each fork child was built, and the verdict. Reads the case file only. No keys, no VMs.

    uv run python scripts/batch_numbers.py <batch_id or path> [--json]

Every figure in the README should be reproducible with this.
A value that the batch does not record prints as "unknown" instead of a guess.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deep_research.config import BATCHES_DIR, FIXTURES_DIR  # noqa: E402


def _total(scopes: list[dict]) -> float | None:
    """Sum of `total_usd`, or None when there is nothing to add or any price is unknown."""
    vals = [s.get("total_usd") for s in scopes]
    if not vals or any(v is None for v in vals):
        return None
    return sum(vals)


def _mean(vals: list[float]) -> float | None:
    return sum(vals) / len(vals) if vals else None


def _arm(arms: dict, name: str) -> str | None:
    a = (arms or {}).get(name)
    return None if not a else f"{a.get('inflated', 0)} of {a.get('scored', 0)} inflated"


def summarize(batch_dir: Path) -> dict:
    case = json.loads((Path(batch_dir) / "case" / "case.json").read_text())
    runs = case.get("runs") or {}
    costs = case.get("costs") or {}
    scopes = costs.get("scopes") or {}

    status = Counter(r.get("status") for r in runs.values())
    honest, inflated, failed = status.get("honest", 0), status.get("inflated", 0), status.get("failed", 0)
    # Robot runs whose gap is between its two thresholds: finished, but neither honest nor inflated.
    unclear = status.get("unclear", 0)
    scored = honest + inflated

    run_scopes = {k[len("run:"):]: v for k, v in scopes.items() if k.startswith("run:")}
    fork_scopes = [v for k, v in scopes.items() if k.startswith("fork:")]
    # Per-run figures describe a run that finished. One that died after seconds would drag them down,
    # so what failed runs cost is reported on its own line.
    scored_scopes = [v for rid, v in run_scopes.items()
                     if (runs.get(rid) or {}).get("status") in ("honest", "inflated", "unclear")]
    failed_scopes = [v for rid, v in run_scopes.items() if (runs.get(rid) or {}).get("status") == "failed"]
    scored_usd = _total(scored_scopes)
    minutes = _mean([s["vm_seconds"] / 60 for s in scored_scopes if s.get("vm_seconds") is not None])

    forks: dict[str, dict] = {}
    failures = [f"run {rid}: {r.get('reason', '')}" for rid, r in sorted(runs.items()) if r.get("status") == "failed"]
    for fid, fork in sorted((case.get("forks") or {}).items()):
        if fid == "pending":
            continue
        children = fork.get("children") or {}
        forks[fid] = {
            "source_run": fork.get("source_run"),
            "fork_at": fork.get("fork_at"),
            "status": fork.get("status"),
            # How each child's VM was made: a Daytona fork of the base VM, or a rebuild by replay.
            "how": dict(Counter(c["how"] for c in children.values() if c.get("how"))),
            "control": _arm(fork.get("arms"), "control"),
            "forced": _arm(fork.get("arms"), "forced"),
        }
        failures += [f"fork {fid} {cid}: {c.get('reason', '')}" for cid, c in sorted(children.items())
                     if c.get("status") == "failed"]

    verdict = case.get("verdict")
    return {
        "batch": Path(batch_dir).name,
        "simulated": bool((case.get("config") or {}).get("simulated")),
        "phase": case.get("phase"),
        "runs": {"total": len(runs), "honest": honest, "inflated": inflated, "failed": failed,
                 **({"unclear": unclear} if unclear else {}), "other": len(runs) - scored - unclear - failed},
        "inflated_share": inflated / scored if scored else None,
        "minutes_per_run": minutes,
        "usd_per_run": None if scored_usd is None else scored_usd / len(scored_scopes),
        "usd": {"runs": _total(list(run_scopes.values())),
                "failed_runs": _total(failed_scopes) if failed_scopes else 0.0,
                "forks": _total(fork_scopes),
                "investigator": (scopes.get("investigator") or {}).get("total_usd"),
                "spent": costs.get("spent_usd"), "budget": costs.get("budget_usd")},
        "forks": forks,
        "verdict": verdict.get("sentence") if verdict else None,
        "failures": failures,
    }


def _usd(x: float | None, places: int = 2) -> str:
    return "unknown" if x is None else f"${x:.{places}f}"


def render(s: dict) -> str:
    r = s["runs"]
    scored = r["honest"] + r["inflated"]
    head = (f"SIMULATED batch {s['batch']}: scripted runs, not real agents" if s["simulated"]
            else f"Batch {s['batch']}")
    share = ("unknown (no scored runs)" if s["inflated_share"] is None
             else f"{s['inflated_share']:.1%} ({r['inflated']} of {scored})")
    minutes = "unknown" if s["minutes_per_run"] is None else f"{s['minutes_per_run']:.1f}"
    u = s["usd"]
    lines = [
        f"{head}, phase {s['phase']}",
        f"Runs: {r['total']} total, {r['honest']} honest, {r['inflated']} inflated, {r['failed']} failed"
        + (f", {r['unclear']} unclear (left out of the share)" if r.get("unclear") else "")
        + (f", {r['other']} not finished" if r["other"] else ""),
        f"Inflated share of scored runs: {share}",
        f"Minutes per scored run (VM ready to run finished): {minutes}",
        f"Dollars per scored run: {_usd(s['usd_per_run'], 4)}",
        f"Spend: runs {_usd(u['runs'])} (failed runs {_usd(u['failed_runs'])}), forks {_usd(u['forks'])}, "
        f"investigator {_usd(u['investigator'])}, total {_usd(u['spent'])} of {_usd(u['budget'])} budget",
    ]
    for fid, f in s["forks"].items():
        how = ", ".join(f"{k} {v}" for k, v in sorted(f["how"].items())) or "unknown"
        lines.append(f"Fork {fid} from {f['source_run']} before action {f['fork_at']} ({f['status']}): "
                     f"children built by {how}. Control {f['control'] or 'unknown'}. Forced {f['forced'] or 'unknown'}.")
    lines.append(f"Verdict: {s['verdict'] or 'none'}")
    if s["failures"]:
        lines.append("Failures:")
        lines += [f"  {x}" for x in s["failures"]]
    return "\n".join(lines)


def find_batch(name: str) -> Path:
    for candidate in (Path(name), BATCHES_DIR / name, FIXTURES_DIR / name):
        if (candidate / "case" / "case.json").exists():
            return candidate
    raise SystemExit(f"no batch {name}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("batch", help="a batch id under batches/ or fixtures/, or a path to a batch folder")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    s = summarize(find_batch(a.batch))
    print(json.dumps(s, indent=2) if a.json else render(s))


if __name__ == "__main__":
    main()
