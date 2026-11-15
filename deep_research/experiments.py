"""Paired experiments (plan 6.4 and 6.5), the plain-Python part: where to fork, how copies pair up, and what the pairs
score. `Batch.run_experiment` runs the copies; everything here is pure and tested offline.

One pair is one control copy and one changed copy from the same fork point, paired by index before either runs
(`control-3` with `forced-3`). The prediction (`smaller_gap` or `larger_gap`) is fixed before any copy starts. A pair
with a failed copy is dropped and logged, never counted.
"""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass

from .forks import Change, resolve_anchor

PREDICTIONS = ("smaller_gap", "larger_gap")
MAX_PAIRS_PER_CALL = 6

# ---- the evidence math -------------------------------------------------------------------------------------------
# TODO(merge): the 6.4 score is being added to evidence.py on docs/plan-status. Once it is there, replace the four
# functions below with imports from `.evidence` (one line); every caller here and in batch.py goes through these names.

AGREE_FACTOR = 1.9
DISAGREE_FACTOR = 0.1
SUPPORTED_AT = 20.0
CLEARED_AFTER = 5
_EXACT_LIMIT = 200_000
_SAMPLES = 20_000


def direction(prediction: str) -> int:
    """+1 when the change is predicted to shrink the gap, -1 when it is predicted to grow it."""
    if prediction not in PREDICTIONS:
        raise ValueError(f"prediction must be one of {list(PREDICTIONS)}")
    return 1 if prediction == "smaller_gap" else -1


def agrees(control_gap: float, changed_gap: float, prediction: str) -> bool:
    """`(control_gap - changed_gap) * direction > 0`. A tie disagrees."""
    return (control_gap - changed_gap) * direction(prediction) > 0


def running_score(agree: list[bool]) -> float:
    """Start at 1, times 1.9 per agreeing pair and 0.1 per disagreeing one. Under "the change does nothing" each pair
    is a fair coin and the expected factor is 1, so the score can be checked after every pair."""
    s = 1.0
    for a in agree:
        s *= AGREE_FACTOR if a else DISAGREE_FACTOR
    return s


def evidence_level(score: float, n_pairs: int) -> str:
    """`supported` at a score of 20 or more, `cleared` after at least 5 pairs with a score under 1, else `open`."""
    if score >= SUPPORTED_AT:
        return "supported"
    if n_pairs >= CLEARED_AFTER and score < 1:
        return "cleared"
    return "open"


def p_exact(control_gaps: list[float], changed_gaps: list[float], prediction: str) -> float | None:
    """One-sided exact permutation test on the gaps, for display: the share of ways to relabel the pooled gaps into a
    control group and a changed group whose difference of means, in the predicted direction, is at least the one seen.
    Exact up to 200,000 relabelings, then a fixed-seed sample of 20,000. None without a gap on each side."""
    nc, nf = len(control_gaps), len(changed_gaps)
    if nc == 0 or nf == 0:
        return None
    d = direction(prediction)
    pooled = list(control_gaps) + list(changed_gaps)
    total = sum(pooled)

    def stat(ctrl_sum: float) -> float:
        return d * (ctrl_sum / nc - (total - ctrl_sum) / nf)

    seen = stat(sum(control_gaps)) - 1e-12
    n = nc + nf
    if math.comb(n, nc) <= _EXACT_LIMIT:
        hits = count = 0
        for idx in itertools.combinations(range(n), nc):
            count += 1
            hits += stat(sum(pooled[i] for i in idx)) >= seen
        return hits / count
    rng = random.Random(0)
    hits = sum(stat(sum(rng.sample(pooled, nc))) >= seen for _ in range(_SAMPLES))
    return (hits + 1) / (_SAMPLES + 1)


# ---- pairs ------------------------------------------------------------------------------------------------------

CONTROL_ARM, CHANGED_ARM = "control", "forced"


def pair_jobs(pairs: int) -> list[tuple[str, int]]:
    """The copies of `pairs` pairs, paired by index before they run: control-1 with forced-1, and so on."""
    return [(arm, i) for i in range(1, pairs + 1) for arm in (CONTROL_ARM, CHANGED_ARM)]


def _gap(child: dict | None) -> float | None:
    if not isinstance(child, dict) or child.get("status") in (None, "failed", "running", "queued"):
        return None
    g = child.get("gap")
    return None if g is None else float(g)


def pair_outcomes(children: dict[str, dict], pairs: int, prediction: str,
                  changed_arm: str = CHANGED_ARM) -> tuple[list[dict], list[dict]]:
    """(kept, dropped) pairs from a fork's `children`. Kept: `{i, control_gap, changed_gap, agree}`. Dropped: `{i,
    reason}`, when a copy of the pair failed or has no gap."""
    kept, dropped = [], []
    for i in range(1, pairs + 1):
        c, f = children.get(f"{CONTROL_ARM}-{i}"), children.get(f"{changed_arm}-{i}")
        cg, fg = _gap(c), _gap(f)
        if cg is None or fg is None:
            bad = [f"{arm}-{i}: {(ch or {}).get('reason') or (ch or {}).get('status') or 'missing'}"
                   for arm, ch, g in ((CONTROL_ARM, c, cg), (changed_arm, f, fg)) if g is None]
            dropped.append({"i": i, "reason": "; ".join(bad)[:300]})
            continue
        kept.append({"i": i, "control_gap": round(cg, 4), "changed_gap": round(fg, 4),
                     "agree": agrees(cg, fg, prediction)})
    return kept, dropped


def score_pairs(pairs: list[dict], prediction: str) -> dict:
    """`{n_pairs, agree, score, p_exact, level}` of a list of kept pairs."""
    agree = [bool(p["agree"]) for p in pairs]
    score = running_score(agree)
    p = p_exact([p["control_gap"] for p in pairs], [p["changed_gap"] for p in pairs], prediction)
    return {"n_pairs": len(pairs), "agree": sum(agree), "score": round(score, 4),
            "p_exact": None if p is None else round(p, 4), "level": evidence_level(score, len(pairs))}


def suspect_evidence(experiments: list[dict]) -> dict:
    """The running evidence of one suspect over its experiments, oldest first. Each experiment is a fork record with
    `id`, `prediction`, `pairs` and optionally `cost_usd`. The score runs over every pair of every experiment (it stays
    a valid test when checked after each pair); `p_exact` is over the pairs of the newest prediction."""
    pairs = [p for e in experiments for p in (e.get("pairs") or [])]
    agree = [bool(p["agree"]) for p in pairs]
    score = running_score(agree)
    latest = experiments[-1]["prediction"] if experiments else "smaller_gap"
    same = [p for e in experiments if e.get("prediction") == latest for p in (e.get("pairs") or [])]
    p = p_exact([p["control_gap"] for p in same], [p["changed_gap"] for p in same], latest)
    costs = [e.get("cost_usd") for e in experiments]
    return {
        "pairs": len(pairs),
        "agree": sum(agree),
        "score": round(score, 4),
        "p_exact": None if p is None else round(p, 4),
        "level": evidence_level(score, len(pairs)),
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
