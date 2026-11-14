"""Command line for the first milestones, before the UI exists.

    python -m deep_research.cli runs --n 1          # one real run end to end
    python -m deep_research.cli runs --n 12         # a full batch, then the split finding
    python -m deep_research.cli forks <batch_id> --n 4
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


def _print_case(b: Batch) -> None:
    c = b.case.read()
    for rid, r in sorted(c["runs"].items()):
        print(f"{rid}  {r.get('status', '?'):9}  reported={r.get('reported_accuracy')}  true={r.get('true_accuracy')}  "
              f"overlap={r.get('overlap_share')}  {r.get('reason', '')}")
    print("split:", json.dumps(c["split"], indent=2) if c["split"] else None)
    print("costs:", json.dumps(c["costs"].get("scopes", {}), indent=2))
    print("batch dir:", b.dir)


async def runs(n: int, strength: float, hint: str, noise: float, hidden: float) -> None:
    b = Batch(BatchConfig(n_runs=n, trap_strength=strength, hint_level=hint, trap_noise=noise, trap_hidden_share=hidden))
    print("batch", b.id)
    try:
        await b.run_all()
    finally:
        await b.close()
    _print_case(b)


async def forks(batch_id: str, n: int) -> None:
    cfg = BatchConfig(**json.loads((BATCHES_DIR / batch_id / "case" / "case.json").read_text())["config"])
    # Reopens the batch. The task is rebuilt from the same seed, so the files are identical.
    b = Batch(cfg, batch_id=batch_id)
    try:
        print(await b.run_forks(n))
    finally:
        await b.close()  # the fork base and children would otherwise run until auto-stop
    _print_case(b)


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


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("runs")
    r.add_argument("--n", type=int, default=1)
    r.add_argument("--strength", type=float, default=0.5)
    r.add_argument("--hint", choices=["none", "light"], default="none")
    r.add_argument("--noise", type=float, default=BatchConfig.model_fields["trap_noise"].default)
    r.add_argument("--hidden", type=float, default=BatchConfig.model_fields["trap_hidden_share"].default,
                   help="share of the copies the noise hides from an exact duplicate check")
    f = sub.add_parser("forks")
    f.add_argument("batch_id")
    f.add_argument("--n", type=int, default=4)
    sub.add_parser("vms", help="count the running VMs on the Daytona key")
    sub.add_parser("cleanup", help="stop every running deep-research VM, from any machine sharing the key")
    a = p.parse_args()
    if a.cmd == "vms":
        vms()
    elif a.cmd == "cleanup":
        cleanup()
    elif a.cmd == "runs":
        asyncio.run(runs(a.n, a.strength, a.hint, a.noise, a.hidden))
    else:
        asyncio.run(forks(a.batch_id, a.n))


if __name__ == "__main__":
    main()
