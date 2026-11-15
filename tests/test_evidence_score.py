"""The running score that decides a fork experiment's evidence level (MASTER_PLAN 6.4, deep_research/evidence.py)."""

import copy
import itertools
import json

import pytest

from deep_research import evidence as ev
from deep_research.case_file import with_evidence
from deep_research.config import FIXTURES_DIR


def test_the_score_starts_at_1_and_multiplies_by_1_9_or_0_1():
    assert ev.running_score([]) == 1
    assert ev.running_score([True] * 4) == pytest.approx(13.0321)
    assert ev.running_score([True] * 5) == pytest.approx(24.76099)
    assert ev.running_score([True, False]) == pytest.approx(0.19)
    # The order does not change the score, only how many pairs agreed.
    assert ev.running_score([False, True, True]) == pytest.approx(ev.running_score([True, True, False]))


def test_the_levels():
    assert ev.score_level(20.0, 4) == "supported"  # the bar itself is supported
    assert ev.score_level(13.03, 4) == "open"
    assert ev.score_level(0.5, 4) == "open"  # under 1, but fewer than 5 pairs
    assert ev.score_level(0.5, 5) == "cleared"
    assert ev.score_level(1.0, 9) == "open"  # exactly 1 is not under 1
    assert ev.LEVELS == ("open", "supported", "cleared") and ev.NEEDED_PAIRS == 5


def test_the_score_is_valid_when_checked_after_every_pair():
    # Under "the step makes no difference" each pair agrees with chance 1/2. Looking after every one of 14 pairs and
    # stopping the first time the score reaches 20 still says "supported" at most 1 time in 20 (Ville's inequality).
    n = 14
    hits = 0
    for seq in itertools.product((True, False), repeat=n):
        s = 1.0
        for a in seq:
            s *= ev.AGREE if a else ev.DISAGREE
            if s >= ev.SUPPORTED_SCORE:
                hits += 1
                break
    assert hits / 2 ** n <= 1 / ev.SUPPORTED_SCORE


def test_pairs_match_by_copy_number_a_tie_disagrees_and_a_failed_copy_is_dropped():
    children = {
        "control-1": {"arm": "control", "status": "inflated", "gap": 0.3},
        "forced-1": {"arm": "forced", "status": "honest", "gap": 0.0},
        "control-2": {"arm": "control", "status": "honest", "gap": 0.01},
        "forced-2": {"arm": "forced", "status": "honest", "gap": 0.01},  # a tie
        "control-3": {"arm": "control", "status": "failed"},
        "forced-3": {"arm": "forced", "status": "honest", "gap": 0.0},
        "control-4": {"arm": "control", "status": "running"},  # still to come: neither pair nor dropped
        "forced-4": {"arm": "forced", "status": "honest", "gap": 0.0},
        "placebo-1": {"arm": "placebo", "status": "inflated", "gap": 0.3},
    }
    done, dropped = ev.pair_up(children)
    assert done == [{"i": 1, "control_gap": 0.3, "changed_gap": 0.0, "agree": True},
                    {"i": 2, "control_gap": 0.01, "changed_gap": 0.01, "agree": False}]
    assert dropped == [{"i": 3, "why": "control-3 failed"}]
    # A larger_gap prediction turns the direction around.
    assert [p["agree"] for p in ev.pair_up(children, direction=-1)[0]] == [False, False]
    assert ev.pairs_to_support({"score": 13.0321}) == 1 and ev.pairs_to_support({"score": 1.0}) == 5
    assert ev.pairs_to_support({"score": 24.8}) == 0


def test_the_plans_known_answers_from_the_demo_batch_fork():
    case = json.loads((FIXTURES_DIR / "demo-batch" / "case" / "case.json").read_text())
    fork = case["forks"]["f1"]
    pairs = ev.fork_pairs(fork)
    assert len(pairs) == 4 and all(p["agree"] for p in pairs)
    got = ev.verdict_evidence({"control": {"inflated": 3, "total": 4}, "forced": {"inflated": 0, "total": 4}}, pairs=pairs)
    assert got["p_value"] == pytest.approx(5 / 70, abs=1e-4)  # one-sided Fisher on the counts, display only
    assert got["p_exact"] == pytest.approx(1 / 70, abs=1e-4)  # exact permutation test on the gaps, display only
    assert got["score"] == pytest.approx(13.03, abs=0.01) and got["level"] == "open"
    # The fixture carries the same, on the fork and on the verdict.
    assert fork["score"] == got["score"] and fork["level"] == "open" and fork["pairs"] == pairs
    assert case["verdict"]["evidence"] == got


def test_an_old_verdict_is_read_by_the_new_rule_and_keeps_what_it_recorded():
    # A real batch's shape (1114-032554-c05a): the Fisher rule, rerun after a round of more pairs, called 0 of 8
    # against 4 of 8 supported and the sentence said "caused". Two of its 8 pairs are ties.
    gaps = [(-0.0605, -0.0605), (-0.0394, -0.0605), (0.1365, -0.0394), (0.1224, -0.0605),
            (-0.0377, -0.0394), (0.1224, -0.0605), (-0.0394, -0.0394), (0.1224, -0.0507)]
    children = {}
    for i, (c, f) in enumerate(gaps, 1):
        children[f"control-{i}"] = {"arm": "control", "status": "inflated" if c > 0.05 else "honest", "gap": c}
        children[f"forced-{i}"] = {"arm": "forced", "status": "honest", "gap": f}
    old_ev = {"level": "supported", "pairs": 8, "needed_pairs": 8, "control_inflated": 4, "control_total": 8,
              "forced_inflated": 0, "forced_total": 8, "p_value": 0.0385}
    sentence = "Skipping the duplicate check caused the inflated scores."
    case = {"forks": {"f1": {"status": "done", "label": "deduplicate", "children": children,
                             "arms": {"control": {"inflated": 4, "scored": 8}, "forced": {"inflated": 0, "scored": 8}}}},
            "verdict": {"sentence": sentence, "step_label": "deduplicate",
                        "arms": {"control": {"inflated": 4, "total": 8}, "forced": {"inflated": 0, "total": 8}},
                        "evidence": copy.deepcopy(old_ev)}}
    with_evidence(case)
    v = case["verdict"]
    assert v["sentence"] == sentence and v["evidence_old_rule"] == old_ev
    assert v["evidence"]["rule"] == "running_score" and v["evidence"]["agree"] == 6 and v["evidence"]["pairs"] == 8
    assert v["evidence"]["level"] == "cleared"  # 1.9^6 x 0.1^2 = 0.47, under 1 after 8 pairs
    assert ev.wording_error(sentence, v["evidence"]) is not None  # so its "caused" reads as an overclaim
    assert case["forks"]["f1"]["level"] == "cleared" and "evidence_old_rule" not in case["forks"]["f1"]
