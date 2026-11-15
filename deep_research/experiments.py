"""Paired experiments (plan 6.4 and 6.5), the plain-Python part: where to fork, how copies pair up, and what the pairs
score. `Batch.run_experiment` runs the copies; everything here is pure and tested offline.

One pair is one control copy and one changed copy from the same fork point, paired by index before either runs
(`control-3` with `forced-3`). The prediction (`smaller_gap` or `larger_gap`) is fixed before any copy starts. A pair
with a failed copy is dropped and logged, never counted.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import evidence as ev
from .forks import Change, resolve_anchor

PREDICTIONS = ("smaller_gap", "larger_gap")
MAX_PAIRS_PER_CALL = 6

# ---- the evidence math: one source, `evidence.py` (MASTER_PLAN 6.4) ----------------------------------------------

def direction(prediction: str) -> int:
    """+1 when the change is predicted to shrink the gap, -1 when it is predicted to grow it."""
    if prediction not in PREDICTIONS:
        raise ValueError(f"prediction must be one of {list(PREDICTIONS)}")
    return ev.direction_of(prediction)


# ---- pairs ------------------------------------------------------------------------------------------------------

CONTROL_ARM, CHANGED_ARM = "control", "forced"


def pair_jobs(pairs: int) -> list[tuple[str, int]]:
    """The copies of `pairs` pairs, paired by index before they run: control-1 with forced-1, and so on."""
    return [(arm, i) for i in range(1, pairs + 1) for arm in (CONTROL_ARM, CHANGED_ARM)]


def pair_outcomes(children: dict[str, dict], pairs: int, prediction: str,
                  changed_arm: str = CHANGED_ARM) -> tuple[list[dict], list[dict]]:
    """(kept, dropped) pairs from a fork's `children`, paired by `evidence.pair_up` (the fork path's rule). Kept:
    `{i, control_gap, changed_gap, agree}`. Dropped: `{i, reason}`, when a copy of the pair failed, has no gap or
    never ran."""
    kept, gone = ev.pair_up(children, direction(prediction), CONTROL_ARM, changed_arm)
    kept = [{**p, "control_gap": round(p["control_gap"], 4), "changed_gap": round(p["changed_gap"], 4)}
            for p in kept if 1 <= p["i"] <= pairs]
    def why(d: dict) -> str:
        bad = [f"{arm}-{d['i']}: {c.get('reason') or c.get('status')}" for arm in (CONTROL_ARM, changed_arm)
               if isinstance(c := children.get(f"{arm}-{d['i']}"), dict)
               and (c.get("status") not in ev.PAIRED_STATUSES or not isinstance(c.get("gap"), (int, float)))]
        return ("; ".join(bad) or d["why"])[:300]

    dropped = [{"i": d["i"], "reason": why(d)} for d in gone if 1 <= d["i"] <= pairs]
    seen = {p["i"] for p in kept} | {d["i"] for d in dropped}
    dropped += [{"i": i, "reason": "a copy of the pair is missing or unfinished"}
                for i in range(1, pairs + 1) if i not in seen]
    return kept, sorted(dropped, key=lambda d: d["i"])


def score_pairs(pairs: list[dict], prediction: str) -> dict:
    """`{n_pairs, agree, score, p_exact, level}` of a list of kept pairs (`evidence.score_pairs`)."""
    return ev.score_pairs(pairs, direction(prediction))


def suspect_evidence(experiments: list[dict]) -> dict:
    """The running evidence of one suspect over its experiments, oldest first. Each experiment is a fork record with
    `id`, `prediction`, `pairs` and optionally `cost_usd`. The score runs over every pair of every experiment (it stays
    a valid test when checked after each pair); `p_exact` is over the pairs of the newest prediction."""
    pairs = [p for e in experiments for p in (e.get("pairs") or [])]
    latest = experiments[-1]["prediction"] if experiments else "smaller_gap"
    same = [p for e in experiments if e.get("prediction") == latest for p in (e.get("pairs") or [])]
    scored = ev.score_pairs(pairs, direction(latest))
    exact = ev.score_pairs(same, direction(latest))["p_exact"]
    costs = [e.get("cost_usd") for e in experiments]
    return {
        "pairs": scored["n_pairs"],
        "agree": scored["agree"],
        "score": round(scored["score"], 4),
        "p_exact": exact,
        "level": scored["level"],
        "cost_usd": None if any(c is None for c in costs) else round(sum(costs), 4),
        "experiments": [e["id"] for e in experiments],
    }


# ---- where to fork -------------------------------------------------------------------------------------------

class ExperimentError(ValueError):
    """An experiment that cannot run, with the reason in words for the caller."""


@dataclass(frozen=True)
class Source:
    run_id: str
    fork_at: int
    anchor: str


def wanted_status(prediction: str) -> str:
    """The kind of run a change is tested on: an inflated run when it is predicted to shrink the gap (a fix), an
    honest one when it is predicted to grow it (a way to fool the agent)."""
    return "inflated" if direction(prediction) > 0 else "honest"


def _eligible(actions: list, change: Change, anchor: str, split_label: str) -> tuple[int | None, str | None]:
    at = resolve_anchor(actions, anchor, split_label)
    if at is None:
        return None, f"has no moment '{anchor}'"
    if change.kind == "force_step" and change.about and any(change.about in a.labels for a in actions[:at]):
        return None, f"already did '{change.about}' before that moment"
    return at, None


def pick_source(change: Change, anchor: str | None, prediction: str, runs: dict[str, list], statuses: dict[str, str],
                split_label: str = "split", source_run: str | None = None) -> Source:
    """The run and the action to fork before. A named `source_run` is checked; otherwise the first run, in id order,
    of the status the prediction needs (`wanted_status`) where the fork point exists and, for a forced step, which had
    not done that step yet. Raises ExperimentError saying why no run qualifies."""
    anchor = (anchor or "").strip() or change.default_anchor or "before_split"
    if anchor == "before_split" and change.default_anchor:
        anchor = change.default_anchor
    if source_run:
        if source_run not in statuses:
            raise ExperimentError(f"unknown run {source_run}")
        if source_run not in runs:
            raise ExperimentError(f"run {source_run} has no saved actions to fork from")
        if statuses[source_run] not in ("honest", "inflated"):
            raise ExperimentError(f"run {source_run} is {statuses[source_run]}; fork a scored run")
        at, why = _eligible(runs[source_run], change, anchor, split_label)
        if at is None:
            raise ExperimentError(f"run {source_run} {why}")
        return Source(source_run, at, anchor)
    want = wanted_status(prediction)
    reasons = []
    for rid in sorted(statuses):
        if statuses[rid] != want or rid not in runs:
            continue
        at, why = _eligible(runs[rid], change, anchor, split_label)
        if at is not None:
            return Source(rid, at, anchor)
        reasons.append(f"{rid} {why}")
    if not any(s == want for s in statuses.values()):
        raise ExperimentError(f"no {want} run to fork: a '{prediction}' prediction is tested on {want} runs")
    raise ExperimentError(f"no {want} run qualifies for {change.spec} at '{anchor}': " + "; ".join(reasons)[:400])
