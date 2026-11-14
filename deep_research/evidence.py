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


# ---- what an experiment's result says about the hypothesis it tested (computed here, never by the model) ----

OUTCOMES = ("supported", "contradicted", "inconclusive", "no_data")


def method_outcome(ev: dict) -> str:
    """The pre-registered prediction of a method experiment ("forcing the step leaves fewer copies inflated than
    control") against its result `ev` (`verdict_evidence`).

    - supported: the evidence level is supported (enough pairs and p < ALPHA).
    - contradicted: enough pairs, and the forced arm inflated at least as often as control: a powered experiment that
      saw no reduction at all.
    - inconclusive: anything in between (too few pairs, or a reduction that is not significant).
    - no_data: an arm has no scored copy.
    """
    ct, ft = ev.get("control_total") or 0, ev.get("forced_total") or 0
    if ct <= 0 or ft <= 0:
        return "no_data"
    if ev.get("level") == "supported":
        return "supported"
    if ev.get("pairs", 0) >= NEEDED_PAIRS and ev["forced_inflated"] / ft >= ev["control_inflated"] / ct:
        return "contradicted"
    return "inconclusive"


def sign_test_greater(wins: int, losses: int) -> float | None:
    """One-sided exact sign test: the chance of `wins` or more of `wins + losses` discordant cases under a fair coin.
    None when there is no discordant case."""
    n = wins + losses
    if n <= 0:
        return None
    return min(1.0, sum(math.comb(n, k) for k in range(wins, n + 1)) / 2 ** n)


FIX_LEVELS = ("improved", "worse", "no_detectable_change", "unpaired")


def fix_evidence(gained: int | None, lost: int | None, before: float | None = None, after: float | None = None) -> dict:
    """How strong a measured fix is: the patched and the unpatched code on the same held-out cases, paired case by case.

    Only the discordant cases count (a case that passes with the patch and failed without it is `gained`, the other way
    `lost`). An exact one-sided sign test asks whether gains beat losses (improved) or losses beat gains (worse), at
    p < ALPHA. This measures the controller's performance, not the accuracy of any agent's report.
    """
    out = {"measures": "controller_performance", "gained": gained, "lost": lost, "alpha": ALPHA,
           "before": before, "after": after}
    if gained is None or lost is None:
        return {**out, "level": "unpaired", "p_value": None}
    p_better, p_worse = sign_test_greater(gained, lost), sign_test_greater(lost, gained)
    if p_better is not None and p_better < ALPHA:
        level, p = "improved", p_better
    elif p_worse is not None and p_worse < ALPHA:
        level, p = "worse", p_worse
    else:
        level, p = "no_detectable_change", p_better
    return {**out, "level": level, "p_value": None if p is None else round(p, 4)}


def fix_outcome(fe: dict) -> str:
    """A code hypothesis's prediction ("this patch makes the controller succeed more often") against `fix_evidence`.
    A patch that does not help does not refute that the line is at fault (the patch may be wrong), so only a patch that
    makes things significantly worse contradicts it."""
    return {"improved": "supported", "worse": "contradicted", "unpaired": "no_data"}.get(fe.get("level"), "inconclusive")


# A sentence that says the fix worked.
IMPROVED = re.compile(r"\b(improv(?:e|ed|es|ing|ement)|fix(?:ed|es)\b(?! nothing)|solv(?:e|ed|es))\b", re.IGNORECASE)


def fix_wording_error(sentence: str, fe: dict | None) -> str | None:
    """Why `sentence` cannot stand as the fix verdict, or None: it may say the fix improved or fixed the controller
    only when `fix_evidence` says `improved`."""
    if fe is None:
        return "error: the fix has not been measured yet: call request_fix_test first"
    if fe.get("level") == "improved" or not IMPROVED.search(sentence or ""):
        return None
    p = "n/a" if fe.get("p_value") is None else format(fe["p_value"], ".3f")
    return (f"error: the measured fix is '{fe.get('level')}' ({fe.get('gained')} cases gained, {fe.get('lost')} lost, "
            f"one-sided exact sign test p = {p}, below {ALPHA} needed), so the sentence cannot say "
            f"'{IMPROVED.search(sentence).group(0)}'. Say what the two success rates were and that the change is not "
            "shown to help.")


# How `verdict_sentence` names the arms besides control and forced, after their counts.
OTHER_ARMS = {"placebo": "after the placebo step", "show": "when only shown the problem"}


def verdict_sentence(step: str, ev: dict, arms: dict | None = None) -> str:
    """The verdict in one sentence at evidence `ev`, worded by its level the way the investigator is told to word it.

    Used when the evidence changes without the investigator: after more pairs were run (`Batch.run_more_pairs`).
    `step` is the step in plain words ("removing duplicate rows"); `arms` ({arm: {inflated, total}}) adds the
    placebo and show arms' counts when they ran. While the evidence is open the step only "suggests" why, with the
    score and the pairs; "caused" only when it is supported. `wording_error` accepts the open sentence.
    """
    others = [f"{arms[a]['inflated']} of {arms[a]['total']} {words}"
              for a, words in OTHER_ARMS.items() if isinstance((arms or {}).get(a), dict) and arms[a].get("total")]
    against = ", ".join([f"{ev['control_inflated']} of {ev['control_total']} without", *others[:-1]])
    if others:
        against += f"{',' if len(others) > 1 else ''} and {others[-1]}"
    p = ev.get("p_value")
    p = "= n/a" if p is None else "< 0.001" if p < 0.001 else f"= {p:.3f}"
    score = f"forcing it left {ev['forced_inflated']} of {ev['forced_total']} copies inflated, against {against}"
    if ev.get("level") == "supported":
        return f"Skipping the step of {step} caused the inflated claims: {score} ({ev['pairs']} pairs, one-sided Fisher p {p})."
    return (f"Skipping the step of {step} suggests why the claims were inflated: {score} ({ev['pairs']} pairs of the "
            f"{ev['needed_pairs']} needed, p {p}).")
