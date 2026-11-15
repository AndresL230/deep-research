"""How strong a fork experiment's evidence is, and so how a verdict may word it (`VerdictEvidence` in web/src/api.ts).

The method experiment continues copies of one inflated run in a `control` arm (unchanged) and a `forced` arm (the
suspect step done for it). The level follows MASTER_PLAN 6.4, a running score that stays valid when it is checked after
every pair, so more pairs can be added to an open verdict without inflating false positives:

- a pair is control copy i and forced copy i (the same copy number, paired before they run); a pair with a copy that
  was not scored, or has no gap, is dropped;
- the pair agrees when the forced copy's gap (reported minus true) is smaller than the control copy's; a tie disagrees;
- the score starts at 1 and is multiplied by AGREE (1.9) for each agreeing pair and by DISAGREE (0.1) for each other
  one. Under "the step makes no difference" a pair agrees at most half the time, and 0.5 x 1.9 + 0.5 x 0.1 = 1;
- the level is `supported` at a score of SUPPORTED_SCORE (20) or more, `cleared` after at least NEEDED_PAIRS (5)
  pairs with a score under 1, otherwise `open`.

When only arm counts are known (a verdict without its fork's copies), the inflated flag stands in for the gap and the
pairing is the least favourable one the counts allow: the level can be `supported` only if every pairing reaches 20,
and is never `cleared`.

The one-sided Fisher exact test on the 2 x 2 counts (`p_value`) and the exact permutation test on the gaps
(`p_exact`) are kept for display only: neither decides a level. Both are a few lines of `math.comb` or
`itertools`: scipy is not a dependency of this project. Totals count scored copies only (honest plus inflated).
"""

from __future__ import annotations

import itertools
import math
import re

# The running score (MASTER_PLAN 6.4).
AGREE = 1.9
DISAGREE = 0.1
SUPPORTED_SCORE = 20.0
# The fewest pairs a level other than open needs: five agreeing pairs give 24.76 (four give 13.03), and `cleared`
# needs at least five pairs.
NEEDED_PAIRS = 5
# The Fisher p is shown against this bar, and the fix's sign test (`fix_evidence`) still decides by it.
ALPHA = 0.05
LEVELS = ("open", "supported", "cleared")
RULE = "running_score"
# Copies whose gap counts toward a pair: scored ones, as everywhere else in the fork counts.
PAIRED_STATUSES = ("honest", "inflated")
# The exact permutation test walks every split of the pooled gaps; past this many it returns None.
PERM_MAX_POOL = 16

# A sentence that claims a cause: cause, caused, causes, causing, causal.
CAUSAL = re.compile(r"\bcaus(?:e|ed|es|ing|al)\b", re.IGNORECASE)


def running_score(agrees) -> float:
    """The score after the pairs `agrees` (one bool per pair, in order): 1, times AGREE or DISAGREE per pair."""
    s = 1.0
    for a in agrees:
        s *= AGREE if a else DISAGREE
    return s


def score_level(score: float, n_pairs: int) -> str:
    """`supported` at SUPPORTED_SCORE or more, `cleared` after NEEDED_PAIRS or more pairs under 1, else `open`."""
    if score >= SUPPORTED_SCORE:
        return "supported"
    if n_pairs >= NEEDED_PAIRS and score < 1:
        return "cleared"
    return "open"


def pairs_to_support(ev: dict) -> int:
    """The fewest more pairs that could make evidence `ev` supported: agreeing pairs from its score up to
    SUPPORTED_SCORE, at least 1 (0 once supported)."""
    s = 1.0 if ev.get("score") is None else float(ev["score"])
    if s <= 0:
        return 10 ** 6
    if s >= SUPPORTED_SCORE:
        return 0
    return max(1, math.ceil(math.log(SUPPORTED_SCORE / s) / math.log(AGREE) - 1e-9))


def direction_of(prediction: str | None) -> int:
    """+1 when the change should shrink the gap (the forced step's purpose, and the default), -1 for `larger_gap`."""
    return -1 if prediction == "larger_gap" else 1


def _arm_and_number(cid: str, child: dict) -> tuple[str, int | None]:
    arm, _, num = str(cid).rpartition("-")
    try:
        return child.get("arm") or arm, int(num)
    except ValueError:
        return child.get("arm") or arm, None


def pair_up(children: dict | None, direction: int = 1, base: str = "control", changed: str = "forced"
            ) -> tuple[list[dict], list[dict]]:
    """The complete pairs of a fork's `children` ({id: {arm, status, gap}}), matched by copy number, and the dropped
    ones. A pair: {i, control_gap, changed_gap, agree}, agree being (control_gap - changed_gap) * direction > 0 at four
    places (a tie disagrees). A dropped pair: {i, why}. A pair with a copy still to come is neither, unless its other
    copy already failed."""
    by: dict[str, dict[int, tuple[str, dict]]] = {base: {}, changed: {}}
    for cid, c in (children or {}).items():
        if isinstance(c, dict):
            arm, i = _arm_and_number(cid, c)
            if arm in by and i is not None:
                by[arm][i] = (cid, c)
    done: list[dict] = []
    dropped: list[dict] = []
    for i in sorted(set(by[base]) | set(by[changed])):
        ends = [by[base].get(i), by[changed].get(i)]
        failed = next((e[0] for e in ends if e is not None and e[1].get("status") == "failed"), None)
        if failed:
            dropped.append({"i": i, "why": f"{failed} failed"})
            continue
        if any(e is None or e[1].get("status") in (None, "running", "pending", "rebuilding") for e in ends):
            continue
        bad = next((e[0] for e in ends if e[1].get("status") not in PAIRED_STATUSES
                    or not isinstance(e[1].get("gap"), (int, float))), None)
        if bad is not None:
            dropped.append({"i": i, "why": f"{bad} was not scored"})
            continue
        cg, xg = float(ends[0][1]["gap"]), float(ends[1][1]["gap"])
        done.append({"i": i, "control_gap": cg, "changed_gap": xg, "agree": agrees(cg, xg, direction)})
    return done, dropped


def agrees(control_gap: float, changed_gap: float, direction: int = 1) -> bool:
    """A pair agrees when (control_gap - changed_gap) * direction > 0 at four places. A tie disagrees."""
    return round((float(control_gap) - float(changed_gap)) * direction, 4) > 0


def score_pairs(pairs: list[dict], direction: int = 1) -> dict:
    """`{n_pairs, agree, score, p_exact, level}` of complete pairs (`pair_up`). The one scoring rule: a fork's
    verdict evidence (`verdict_evidence`), more pairs and `Batch.run_experiment` all go through it."""
    agree = [bool(p.get("agree")) for p in pairs]
    score = running_score(agree)
    exact = p_exact([p["control_gap"] for p in pairs], [p["changed_gap"] for p in pairs], direction) if pairs else None
    return {"n_pairs": len(pairs), "agree": sum(agree), "score": float(f"{score:.6g}"),
            "p_exact": None if exact is None else round(exact, 4), "level": score_level(score, len(pairs))}


def fork_pairs(fork: dict | None) -> list[dict] | None:
    """`pair_up` of a method fork's copies by its prediction's direction, or None when it has no copy with a gap (a
    verdict saved without its fork's copies): then the level comes from the counts."""
    if not isinstance(fork, dict) or not isinstance(fork.get("children"), dict):
        return None
    if not any(isinstance(c, dict) and isinstance(c.get("gap"), (int, float)) for c in fork["children"].values()):
        return None
    return pair_up(fork["children"], direction_of(fork.get("prediction")))[0]


def p_exact(control_gaps: list[float], changed_gaps: list[float], direction: int = 1) -> float | None:
    """Exact one-sided permutation test on the gaps, for display: of every way to split the pooled gaps into arms of
    these sizes, the share whose difference in means is at least the one seen. None past PERM_MAX_POOL gaps or with an
    empty arm."""
    n1, n2 = len(control_gaps), len(changed_gaps)
    pool = [*control_gaps, *changed_gaps]
    if not n1 or not n2 or len(pool) > PERM_MAX_POOL:
        return None
    seen = direction * (sum(control_gaps) / n1 - sum(changed_gaps) / n2)
    total = sum(pool)
    hits = count = 0
    for idx in itertools.combinations(range(len(pool)), n1):
        s = sum(pool[j] for j in idx)
        count += 1
        if direction * (s / n1 - (total - s) / n2) >= seen - 1e-9:
            hits += 1
    return hits / count


def verdict_fork(case: dict) -> tuple[str, dict] | None:
    """The fork experiment a verdict rests on, as (fork id, fork): the newest method experiment (not a fix test) whose
    first round finished, so it has `control` and `forced` arm summaries. None when there is none."""
    found = None
    for fork_id, fork in (case.get("forks") or {}).items():
        if fork_id == "pending" or not isinstance(fork, dict) or fork.get("kind", "method") == "fix":
            continue
        arms = fork.get("arms") or {}
        if "control" in arms and "forced" in arms:
            found = (fork_id, fork)
    return found


def current_verdict_evidence(case: dict) -> dict | None:
    """The saved verdict's evidence by today's rule (`verdict_evidence` with its fork's pairs), or None without a
    verdict. Read only: nothing in `case` changes."""
    verdict = case.get("verdict")
    if not isinstance(verdict, dict):
        return None
    found = verdict_fork(case)
    return verdict_evidence(verdict.get("arms"), verdict.get("numbers"), pairs=fork_pairs(found[1]) if found else None)


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


def _counts_agreements(ci: int, ct: int, fi: int, ft: int) -> int:
    """The fewest agreeing pairs arm counts allow, with the inflated flag standing in for the gap: the min(ct, ft)
    pairs holding as few inflated control copies and as many inflated forced copies as the counts permit."""
    n = min(ct, ft)
    return max(0, max(0, ci - (ct - n)) - min(fi, n))


def verdict_evidence(arms: dict | None = None, numbers: dict | None = None, pairs: list[dict] | None = None,
                     direction: int = 1) -> dict:
    """The evidence of a verdict, as saved in `verdict.evidence` and `forks.<id>.evidence`: the running score and its
    level from the fork's `pairs` (`fork_pairs`), else from the arm counts (`arms`, or the old `numbers`) at their
    least favourable pairing; the Fisher p on the counts and, with pairs, the exact gap test, for display."""
    ci, ct, fi, ft = _counts(arms, numbers)
    fisher = fisher_less(fi, ft, ci, ct)
    if pairs is not None:
        scored = score_pairs(pairs, direction)
        n, agree, score, level, exact = (scored["n_pairs"], scored["agree"], scored["score"], scored["level"],
                                         scored["p_exact"])
        basis = "pairs"
    else:
        n = min(ct, ft)
        agree = _counts_agreements(ci, ct, fi, ft)
        score = running_score([True] * agree + [False] * (n - agree))
        level = "supported" if score >= SUPPORTED_SCORE else "open"
        exact = None
        basis = "counts"
    return {
        "level": level,
        "pairs": n,
        "needed_pairs": NEEDED_PAIRS,
        "control_inflated": ci,
        "control_total": ct,
        "forced_inflated": fi,
        "forced_total": ft,
        "p_value": None if fisher is None else round(fisher, 4),
        "rule": RULE,
        "score": float(f"{score:.6g}"),  # six significant digits: a score can be very small
        "needed_score": SUPPORTED_SCORE,
        "agree": agree,
        "disagree": n - agree,
        "basis": basis,
        "p_exact": None if exact is None else round(exact, 4),
    }


def describe(ev: dict) -> str:
    """The evidence in one line for the investigator: the level, the score, the counts, the pairs and the Fisher p."""
    p = "n/a" if ev.get("p_value") is None else f"{ev['p_value']:.3f}"
    score = ev.get("score")
    score = "n/a" if score is None else f"{score:.2f}"
    return (
        f"Evidence level: {ev['level']}. Running score {score} ({ev.get('agree', 0)} of {ev['pairs']} pairs agree; "
        f"supported at {SUPPORTED_SCORE:g} or more, cleared after {ev['needed_pairs']} or more pairs under 1). Forced "
        f"{ev['forced_inflated']} of {ev['forced_total']} inflated, control {ev['control_inflated']} of "
        f"{ev['control_total']} (one-sided Fisher exact p = {p}, shown only: it does not decide the level)."
    )


def wording_error(sentence: str, ev: dict) -> str | None:
    """Why `sentence` cannot stand as the verdict at evidence `ev`, or None. Unless the evidence is supported, a
    sentence must not claim a cause: it says what the step "suggests", with the score and the pairs."""
    if ev.get("level") == "supported" or not CAUSAL.search(sentence or ""):
        return None
    word = CAUSAL.search(sentence).group(0)
    score = ev.get("score")
    return (
        f"error: the evidence is {ev.get('level', 'open')} (score {'n/a' if score is None else format(score, '.2f')} "
        f"of the {SUPPORTED_SCORE:g} needed, {ev['pairs']} pairs), so the verdict cannot say "
        f"'{word}'. Write 'suggests' instead, with the score and the pairs, for example: '<the step> suggests why the "
        f"claims were inflated: forcing it left {ev['forced_inflated']} of {ev['forced_total']} copies inflated, against "
        f"{ev['control_inflated']} of {ev['control_total']} without ({ev['pairs']} pairs).'"
    )


# How `verdict_sentence` names the arms besides control and forced, after their counts.
OTHER_ARMS = {"placebo": "after the placebo step", "show": "when only shown the problem"}


def verdict_sentence(step: str, ev: dict, arms: dict | None = None) -> str:
    """The verdict in one sentence at evidence `ev`, worded by its level the way the investigator is told to word it.

    Used when the evidence changes without the investigator: after more pairs were run (`Batch.run_more_pairs`).
    `step` is the step in plain words ("removing duplicate rows"); `arms` ({arm: {inflated, total}}) adds the
    placebo and show arms' counts when they ran. While the evidence is open the step only "suggests" why, with the
    score and the pairs; "caused" only when it is supported; a cleared step "does not explain" it. `wording_error`
    accepts the open and the cleared sentence.
    """
    others = [f"{arms[a]['inflated']} of {arms[a]['total']} {words}"
              for a, words in OTHER_ARMS.items() if isinstance((arms or {}).get(a), dict) and arms[a].get("total")]
    against = ", ".join([f"{ev['control_inflated']} of {ev['control_total']} without", *others[:-1]])
    if others:
        against += f"{',' if len(others) > 1 else ''} and {others[-1]}"
    s = ev.get("score")
    s = "n/a" if s is None else f"{s:.2f}"
    counts = f"forcing it left {ev['forced_inflated']} of {ev['forced_total']} copies inflated, against {against}"
    if ev.get("level") == "supported":
        return f"Skipping the step of {step} caused the inflated claims: {counts} ({ev['pairs']} pairs, score {s})."
    if ev.get("level") == "cleared":
        return (f"Skipping the step of {step} does not explain the inflated claims: {counts} ({ev['pairs']} pairs, "
                f"score {s}, under 1).")
    return (f"Skipping the step of {step} suggests why the claims were inflated: {counts} ({ev['pairs']} pairs, score "
            f"{s} of the {SUPPORTED_SCORE:g} needed).")


# ---- what an experiment's result says about the hypothesis it tested (computed here, never by the model) ----

OUTCOMES = ("supported", "contradicted", "inconclusive", "no_data")


def method_outcome(ev: dict) -> str:
    """The pre-registered prediction of a method experiment ("forcing the step leaves the copies' gap smaller than
    control") against its result `ev` (`verdict_evidence`).

    - supported: the evidence level is supported (a running score of SUPPORTED_SCORE or more).
    - contradicted: the evidence level is cleared (NEEDED_PAIRS or more pairs, score under 1).
    - inconclusive: open.
    - no_data: an arm has no scored copy.
    """
    ct, ft = ev.get("control_total") or 0, ev.get("forced_total") or 0
    if ct <= 0 or ft <= 0:
        return "no_data"
    if ev.get("level") == "supported":
        return "supported"
    if ev.get("level") == "cleared":
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
