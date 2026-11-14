"""Command line for the first milestones, before the UI exists.

    python -m deep_research.cli runs --n 1          # one real run end to end
    python -m deep_research.cli runs --n 12         # a full batch, then the split finding
    python -m deep_research.cli runs --n 6 --budget 3
    python -m deep_research.cli forks <batch_id> --n 4
    python -m deep_research.cli investigate <batch_id>                  # asks before each experiment
    python -m deep_research.cli investigate <batch_id> --auto-approve   # unattended, small budgets only
    python -m deep_research.cli vms                 # count the running VMs on the Daytona key
    python -m deep_research.cli cleanup             # stop every running deep-research VM (any machine)
"""

from __future__ import annotations

import argparse
import asyncio
import json

from dotenv import load_dotenv

load_dotenv()

from . import hub  # noqa: E402

hub.load_runner_env()  # keys this machine does not have come from the team hub

from .batch import Batch  # noqa: E402
from .config import BATCHES_DIR, BatchConfig  # noqa: E402

# Unattended approval is for small test batches only: nobody is there to say no.
AUTO_APPROVE_MAX_BUDGET_USD = 3.0
MAX_AUTO_APPROVALS = 3


def _print_case(b: Batch) -> None:
    c = b.case.read()
    for rid, r in sorted(c["runs"].items()):
        print(f"{rid}  {r.get('status', '?'):9}  reported={r.get('reported_accuracy')}  true={r.get('true_accuracy')}  "
              f"overlap={r.get('overlap_share')}  {r.get('reason', '')}")
    print("split:", json.dumps(c["split"], indent=2) if c["split"] else None)
    print("costs:", json.dumps(c["costs"].get("scopes", {}), indent=2))
    print("batch dir:", b.dir)


def _saved_config(batch_id: str) -> BatchConfig:
    path = BATCHES_DIR / batch_id / "case" / "case.json"
    if not path.exists():
        raise SystemExit(f"no batch {batch_id} under {BATCHES_DIR}")
    return BatchConfig(**json.loads(path.read_text())["config"])


def _reopen(batch_id: str) -> Batch:
    """Open a saved batch again. The task is rebuilt from the same seed, so the files are identical,
    and the spend already on record carries over."""
    return Batch(_saved_config(batch_id), batch_id=batch_id, root=BATCHES_DIR)


async def runs(n: int, strength: float, hint: str, noise: float, hidden: float, budget: float) -> None:
    b = Batch(
        BatchConfig(n_runs=n, trap_strength=strength, hint_level=hint, trap_noise=noise, trap_hidden_share=hidden,
                    budget_usd=budget),
        root=BATCHES_DIR,
    )
    print("batch", b.id)
    try:
        await b.run_all()
    finally:
        await b.close()
    _print_case(b)


async def forks(batch_id: str, n: int) -> None:
    b = _reopen(batch_id)
    try:
        print(await b.run_forks(n))
    finally:
        # The fork children's VMs are done once they are scored.
        await b.close()
    _print_case(b)


async def investigate(batch_id: str, auto_approve: bool) -> None:
    """Run the investigator on a saved batch. It asks before each experiment; `auto_approve` answers yes for it."""
    cfg = _saved_config(batch_id)
    if auto_approve and cfg.budget_usd > AUTO_APPROVE_MAX_BUDGET_USD:
        raise SystemExit(
            f"--auto-approve needs a batch budget of ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less; "
            f"this batch has ${cfg.budget_usd:.2f}. Answer the approval yourself instead."
        )
    b = _reopen(batch_id)
    why_not = b.fork_blocker()
    if why_not:
        # The investigator tests its suspect with the fork experiment. Without one it would only spend tokens.
        raise SystemExit(f"batch {batch_id} (phase {b.case.data.get('phase')}): {why_not}")
    approved = declined_at_limit = 0
    try:
        await b.investigate()
        while b.case.data.get("phase") == "awaiting_approval":
            pending = b.case.data["forks"].get("pending", {})
            arms = list(b.arm_plan()) or ["control", "forced"]
            question = (
                f"The investigator asks for a fork experiment: {pending.get('n_per_arm')} runs in each of "
                f"{len(arms)} arms ({', '.join(arms)}), {pending.get('vm_count')} VMs, "
                f"about ${pending.get('estimate_usd')}. Approve? [y/N] "
            )
            if not auto_approve:
                approve = input(question).strip().lower() in ("y", "yes")
            elif approved < MAX_AUTO_APPROVALS:
                approve = True
                print(question + "yes (auto)")
            elif not declined_at_limit:
                # Say no once, so the investigator can conclude from what it has.
                approve, declined_at_limit = False, 1
                print(question + f"no (auto-approval stops after {MAX_AUTO_APPROVALS})")
            else:
                print("The investigator keeps asking for experiments. Stopping it.")
                b.case.remove_fork("pending")
                b.case.set_phase("stopped")
                break
            approved += approve
            await b.decide(approve)
    finally:
        await b.close()
    _print_case(b)
    c = b.case.read()
    print("verdict:", json.dumps(c["verdict"], indent=2) if c["verdict"] else "none recorded")


def vms() -> None:
    from . import sandboxes

    running = sandboxes.running_vms()
    print(f"{len(running)} running deep-research VMs")
    for sb in running:
        print(f"  {sb.id}  {(sb.labels or {}).get('run', '?')}  since {sb.created_at}")


def cleanup() -> None:
    from . import sandboxes

    stopped, failed = sandboxes.stop_all_vms()
    print(f"stopped {stopped} VMs" + (f", {failed} failed (see warnings)" if failed else ""))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("runs")
    r.add_argument("--n", type=int, default=1)
    r.add_argument("--strength", type=float, default=0.5)
    r.add_argument("--hint", choices=["none", "light"], default="none")
    r.add_argument("--noise", type=float, default=BatchConfig.model_fields["trap_noise"].default)
    r.add_argument("--hidden", type=float, default=BatchConfig.model_fields["trap_hidden_share"].default,
                   help="share of the copies the noise hides from an exact duplicate check")
    r.add_argument("--budget", type=float, default=BatchConfig.model_fields["budget_usd"].default,
                   help="the batch's budget in US dollars")
    f = sub.add_parser("forks")
    f.add_argument("batch_id")
    f.add_argument("--n", type=int, default=4)
    i = sub.add_parser("investigate")
    i.add_argument("batch_id")
    i.add_argument("--auto-approve", action="store_true",
                   help=f"approve the investigator's experiments unattended (budget ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less)")
    sub.add_parser("vms", help="count the running VMs on the Daytona key")
    sub.add_parser("cleanup", help="stop every running deep-research VM, from any machine sharing the key")
    a = p.parse_args(argv)
    if a.cmd == "vms":
        vms()
    elif a.cmd == "cleanup":
        cleanup()
    elif a.cmd == "runs":
        asyncio.run(runs(a.n, a.strength, a.hint, a.noise, a.hidden, a.budget))
    elif a.cmd == "forks":
        asyncio.run(forks(a.batch_id, a.n))
    else:
        asyncio.run(investigate(a.batch_id, a.auto_approve))


if __name__ == "__main__":
    main()
