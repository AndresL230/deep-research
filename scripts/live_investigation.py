"""Run the real investigator on a saved batch under a fixed, written-down approval policy.

    uv run python scripts/live_investigation.py <batch_id> [--budget 6] [--max-concurrent 8] [--max-per-arm 8]

The policy stands in for the person at the approval prompt, so a run can be left unattended within limits a person
set beforehand:
- a direct fix test (patched code scored on this server, no VM, $0): approved, at most MAX_FIX_TESTS times;
- the first method fork experiment: approved when it asks for at most `--max-per-arm` copies per arm and its estimate
  fits in what is left of the budget; every later fork experiment is declined;
- anything else is declined.
Every decision, with the request it answered, goes to `<batch>/investigator/approvals.jsonl`.

The batch budget is set to `--budget` (spend so far included) and its concurrency to `--max-concurrent`, so at most
that many fork copies plus one base VM run at once. The budget guard (costs.py) prices model tokens and VM time.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

from dotenv import load_dotenv

load_dotenv()  # the keys, as cli.py loads them; before deep_research builds any client

from deep_research.batch import Batch  # noqa: E402

MAX_FIX_TESTS = 3


async def main(batch_id: str, budget: float, max_concurrent: int, max_per_arm: int) -> None:
    b = Batch.resume(batch_id)
    b.cfg = b.cfg.model_copy(update={"budget_usd": budget, "max_concurrent_runs": max_concurrent})
    b.tracker.budget_usd = budget
    b.case.set_config({**b.case.data["config"], "budget_usd": budget, "max_concurrent_runs": max_concurrent})
    spent0 = b.tracker.total_usd() or 0.0
    print(f"batch {batch_id}: spent ${spent0:.2f} before this run, budget ${budget:.2f}, "
          f"peak VMs {max_concurrent} copies + 1 base", flush=True)
    log = b.dir / "investigator" / "approvals.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    forks_approved = fix_tests = 0
    try:
        await b.investigate()
        while b.case.data.get("phase") == "awaiting_approval":
            p = dict(b.case.data["forks"].get("pending", {}))
            spent = b.tracker.total_usd() or 0.0
            if p.get("direct"):
                ok, why = fix_tests < MAX_FIX_TESTS, f"direct fix test {fix_tests + 1} of at most {MAX_FIX_TESTS}, $0"
                fix_tests += ok
            elif p.get("kind") == "method":
                est = p.get("estimate_usd")
                fits = est is not None and spent + est <= budget
                ok = forks_approved == 0 and int(p.get("n_per_arm") or 0) <= max_per_arm and fits
                why = (f"method fork {forks_approved + 1}: {p.get('n_per_arm')}/arm (max {max_per_arm}), est ${est}, "
                       f"spent ${spent:.2f} of ${budget:.2f}; at most one fork is approved")
                forks_approved += ok
            else:
                ok, why = False, f"{p.get('kind')} experiments are not in this run's policy"
            row = {"at": time.time(), "approved": ok, "why": why, "request": p}
            with log.open("a") as f:
                f.write(json.dumps(row, default=str) + "\n")
            print(("APPROVE " if ok else "DECLINE ") + why, flush=True)
            await b.decide(ok)
    finally:
        await b.close()
    c = b.case.read()
    print("phase:", c["phase"], "| spent this run: $%.2f" % ((b.tracker.total_usd() or 0) - spent0), flush=True)
    print("hypotheses:", json.dumps([{k: h.get(k) for k in ("id", "kind", "step_label", "sentence", "status")}
                                     for h in c["hypotheses"]], indent=1))
    print("verdict:", json.dumps(c["verdict"], indent=1))
    print("fix:", json.dumps({k: (c.get("fix") or {}).get(k) for k in ("run_id", "description", "status", "outcome",
                                                                       "verdict")}, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("batch_id")
    ap.add_argument("--budget", type=float, default=6.0)
    ap.add_argument("--max-concurrent", type=int, default=8)
    ap.add_argument("--max-per-arm", type=int, default=8)
    a = ap.parse_args()
    asyncio.run(main(a.batch_id, a.budget, a.max_concurrent, a.max_per_arm))
