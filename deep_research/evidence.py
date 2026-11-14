"""How strong a fork experiment's evidence is, and so how a verdict may word it (`VerdictEvidence` in web/src/api.ts).

The method experiment continues copies of one inflated run in a `control` arm (unchanged) and a `forced` arm (the
suspect step done for it). The step looks like the cause when fewer forced copies come out inflated than control
copies. Two things decide whether that is shown or only suggested:

- enough pairs: `pairs` = min(control_total, forced_total) scored copies, at least NEEDED_PAIRS;
- a real difference: a one-sided Fisher exact test on the 2 x 2 table (arm by inflated or not), the alternative being
  that forced copies inflate less often than control copies, at p < ALPHA.

Both hold: the level is "supported" and a verdict may say the step caused the inflation. Otherwise it is "open" and
the verdict says the step "suggests" why, with the counts and the pairs. Totals count scored copies only (honest
plus inflated): failed and unclear copies are left out, as everywhere else in the fork counts.

The exact test is a few lines of `math.comb`: scipy is not a dependency of this project.
"""

from __future__ import annotations

import math
import re

NEEDED_PAIRS = 8
ALPHA = 0.05
LEVELS = ("open", "supported")

# A sentence that claims a cause: cause, caused, causes, causing, causal.
CAUSAL = re.compile(r"\bcaus(?:e|ed|es|ing|al)\b", re.IGNORECASE)


def fisher_less(forced_inflated: int, forced_total: int, control_inflated: int, control_total: int) -> float | None:
    """One-sided Fisher exact p-value that the forced arm inflates less often than the control arm.

    Under the null hypothesis the inflated copies fall into the two arms at random, given the totals: the forced
    arm's inflated count is hypergeometric. p is the chance of a count as low as the one seen, or lower. None when
    an arm is empty.
    """
    if forced_total <= 0 or control_total <= 0:
        return None
    n = forced_total + control_total
    k = forced_inflated + control_inflated
    total = math.comb(n, forced_total)
    low = max(0, k - control_total)
    p = sum(math.comb(k, x) * math.comb(n - k, forced_total - x) for x in range(low, forced_inflated + 1)) / total
    return min(1.0, p)


def _counts(arms: dict | None, numbers: dict | None) -> tuple[int, int, int, int]:
    """(control_inflated, control_total, forced_inflated, forced_total) from verdict `arms` ({arm: {inflated, total}})
    or, for verdicts saved before arms, the old `numbers` ({arm}_inflated / {arm}_total)."""

    def get(arm: str, key: str) -> int:
        a = (arms or {}).get(arm)
        if isinstance(a, dict) and a.get(key) is not None:
            return int(a[key])
        v = (numbers or {}).get(f"{arm}_{key}")
        return int(v) if v is not None else 0

    return get("control", "inflated"), get("control", "total"), get("forced", "inflated"), get("forced", "total")


def verdict_evidence(arms: dict | None = None, numbers: dict | None = None) -> dict:
    """The evidence of a verdict from its fork arm counts, as saved in `verdict.evidence`."""
    ci, ct, fi, ft = _counts(arms, numbers)
    pairs = min(ct, ft)
    p = fisher_less(fi, ft, ci, ct)
    supported = pairs >= NEEDED_PAIRS and p is not None and p < ALPHA
    return {
        "level": "supported" if supported else "open",
        "pairs": pairs,
        "needed_pairs": NEEDED_PAIRS,
        "control_inflated": ci,
        "control_total": ct,
        "forced_inflated": fi,
        "forced_total": ft,
        "p_value": None if p is None else round(p, 4),
    }


def describe(ev: dict) -> str:
    """The evidence in one line for the investigator: the level, the counts, the pairs and p."""
    p = "n/a" if ev.get("p_value") is None else f"{ev['p_value']:.3f}"
    return (
        f"Evidence level: {ev['level']}. Forced {ev['forced_inflated']} of {ev['forced_total']} inflated, control "
        f"{ev['control_inflated']} of {ev['control_total']} ({ev['pairs']} pairs, {ev['needed_pairs']} needed; one-sided "
        f"Fisher exact p = {p}, below {ALPHA} needed)."
    )


def wording_error(sentence: str, ev: dict) -> str | None:
    """Why `sentence` cannot stand as the verdict at evidence `ev`, or None. While the evidence is open, a sentence
    must not claim a cause: it says what the step "suggests", with the counts and the pairs."""
    if ev.get("level") == "supported" or not CAUSAL.search(sentence or ""):
        return None
    word = CAUSAL.search(sentence).group(0)
    return (
        f"error: the evidence is open ({ev['pairs']} pairs of the {ev['needed_pairs']} needed, p = "
        f"{'n/a' if ev.get('p_value') is None else format(ev['p_value'], '.3f')}), so the verdict cannot say "
        f"'{word}'. Write 'suggests' instead, with the score and the pairs, for example: '<the step> suggests why the "
        f"claims were inflated: forcing it left {ev['forced_inflated']} of {ev['forced_total']} copies inflated, against "
        f"{ev['control_inflated']} of {ev['control_total']} without ({ev['pairs']} pairs).'"
    )
