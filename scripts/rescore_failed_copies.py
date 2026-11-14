"""Score fork copies whose agent finished but whose scoring on this server failed, then recompute the experiment.

    uv run python scripts/rescore_failed_copies.py <batch_id> <fork_id>

A copy counts as a failed scoring when its status is "failed", its reason starts with "evaluation failed" and its
downloaded outputs hold the report and the code: the agent's work is complete and only the measurement is missing.
Scoring is deterministic (same code, same hidden positions, same result), so scoring the saved outputs afterwards
gives the number the copy would have had. No agent and no model runs. Copies that failed for any other reason stay
failed.

Each re-scored copy keeps a `rescored` record ({at, reason_before}); the fork gets `rescored` too, with the copies'
ids, and its arms, evidence and outcome are recomputed from the stored counts with the same functions the experiment
uses. A verdict recorded before the re-scoring is marked `stale`: its arm counts are the incomplete ones.
"""

from __future__ import annotations

import json
import sys
import time

from deep_research.batch import _arm_summary
from deep_research.case_file import CaseFile
from deep_research.config import BATCHES_DIR, BatchConfig
from deep_research.domains import get as get_domain
from deep_research.evidence import method_outcome, verdict_evidence


def main(batch_id: str, fork_id: str) -> None:
    bdir = BATCHES_DIR / batch_id
    case = CaseFile(bdir / "case" / "case.json", view_path=bdir / "case" / "view" / "case.json")
    cfg = BatchConfig(**case.data["config"])
    domain = get_domain(cfg.domain)
    task = domain.open_task(bdir / "task")
    fork = case.data["forks"][fork_id]
    children = dict(fork["children"])
    redone = []
    for cid, c in sorted(children.items()):
        out = bdir / "forks" / fork_id / cid / "outputs"
        if not (c.get("status") == "failed" and str(c.get("reason", "")).startswith("evaluation failed")):
            continue
        if not all((out / f).is_file() for f in domain.output_files):
            print(f"{cid}: outputs incomplete, left failed")
            continue
        score = domain.score_run(out, task, cfg.inflation_threshold).to_dict()
        (out.parent / "score.json").write_text(json.dumps(score, indent=2))
        children[cid] = {**c, **score, "arm": c.get("arm"), "reason": None,
                         "rescored": {"at": time.time(), "reason_before": c.get("reason")}}
        redone.append(cid)
        print(f"{cid}: {score['status']} (claimed {score['reported_accuracy']}, measured {score['true_accuracy']})")
    if not redone:
        print("nothing to re-score")
        return
    arms_order = list(fork.get("arm_steps") or fork.get("arms") or {})
    arms = {a: _arm_summary([c for c in children.values() if c.get("arm") == a]) for a in arms_order}
    extra = {}
    if "control" in arms and "forced" in arms:
        ev = verdict_evidence({a: {"inflated": arms[a]["inflated"], "total": arms[a]["scored"]} for a in ("control", "forced")})
        extra = {"evidence": ev, "outcome": method_outcome(ev)}
    case.update_fork(fork_id, children=children, arms=arms,
                     rescored={"at": time.time(), "copies": redone, "why": "server-side scoring timed out under load; "
                               "the agents' saved outputs were scored afterwards, deterministically, with no agent"},
                     arms_before_rescore=fork.get("arms"), **extra)
    if fork.get("hypothesis_id") and extra:
        case.set_hypothesis_status(fork["hypothesis_id"], extra["outcome"], tested_by=fork_id)
    v = case.data.get("verdict")
    if isinstance(v, dict) and v.get("arms") != {a: {"inflated": s["inflated"], "total": s["scored"]}
                                                 for a, s in arms.items() if s["scored"]}:
        with case._lock:
            v["stale"] = "recorded before the failed copies were re-scored: its arm counts are the incomplete ones"
            case._changed("verdict")
    print("arms:", json.dumps({a: {k: s[k] for k in ("scored", "inflated", "honest", "failed")} for a, s in arms.items()}))
    print("evidence:", json.dumps(extra.get("evidence")), "outcome:", extra.get("outcome"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
