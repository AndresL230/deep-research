"""Command line for the first milestones, before the UI exists.

    python -m deep_research.cli runs --n 1          # one real run end to end
    python -m deep_research.cli runs --n 12         # a full batch, then the split finding
    python -m deep_research.cli runs --n 6 --budget 3
    python -m deep_research.cli runs --domain robot_arm --n 1   # another domain (deep_research/domains/)
    python -m deep_research.cli runs --domain robot_arm --robot-prompt practice --n 12
    python -m deep_research.cli runs --domain robot_arm --robot-start colleague --n 12
    python -m deep_research.cli forks <batch_id> --n 4
    python -m deep_research.cli experiment <batch_id> --suspect s1 --change force_step:deduplicate --pairs 3 --auto-approve
    python -m deep_research.cli interaction <batch_id> --a s1 --b s2 --per-cell 2 --auto-approve   # two supported suspects
    python -m deep_research.cli experiment <batch_id> --suspect s1 --change force_step:deduplicate --fork-mode checkpoint
    python -m deep_research.cli runs --n 6 --lessons learned   # analysts get the approved lessons (skills/learned/)
    python -m deep_research.cli foolrate --n 12 --settings none,learned --budget 1      # prints the estimate, exits
    python -m deep_research.cli foolrate --n 12 --settings none,learned --budget 1 --yes
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

from . import domains  # noqa: E402
from . import foolrate as fr  # noqa: E402
from . import lessons as lessons_mod  # noqa: E402
from .batch import Batch  # noqa: E402
from .config import BATCHES_DIR, BatchConfig  # noqa: E402
from .domains.robot_arm import BENCH_DIR  # noqa: E402
from .experiments import MAX_PAIRS_PER_CALL as MAX_EXPERIMENT_PAIRS  # noqa: E402

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


async def runs(n: int, strength: float, hint: str, noise: float, hidden: float, budget: float,
               domain: str = domains.DEFAULT, robot_prompt: str = "default", robot_start: str = "blank",
               robot_positions: str = "default", lessons: str = "none") -> None:
    b = Batch(
        BatchConfig(domain=domain, n_runs=n, trap_strength=strength, hint_level=hint, trap_noise=noise,
                    trap_hidden_share=hidden, budget_usd=budget, robot_prompt=robot_prompt,
                    robot_start=robot_start, robot_positions=robot_positions, lessons=lessons),
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


async def experiment(batch_id: str, suspect: str, change: str, prediction: str, pairs: int, source_run: str | None,
                     anchor: str, reason: str, auto_approve: bool, fork_mode: str | None = None) -> None:
    """One paired experiment on a saved batch (`Batch.run_experiment`). It costs money, so it asks first;
    `auto_approve` answers yes for it under a small budget."""
    cfg = _saved_config(batch_id)
    if auto_approve and cfg.budget_usd > AUTO_APPROVE_MAX_BUDGET_USD:
        raise SystemExit(
            f"--auto-approve needs a batch budget of ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less; "
            f"this batch has ${cfg.budget_usd:.2f}. Answer the approval yourself instead."
        )
    b = _reopen(batch_id)
    try:
        try:
            b.parse_change(change)
        except ValueError as e:
            raise SystemExit(f"error: {e}") from None
        n = max(1, min(pairs, MAX_EXPERIMENT_PAIRS))
        est = b.estimate_forks_usd(n, 2)
        question = (f"Run {n} pairs ({2 * n} copies and 1 base VM) of {change} to test {suspect} "
                    f"(predicted {prediction}), about ${'?' if est is None else f'{est:.2f}'}"
                    f"{f', fork mode {fork_mode}' if fork_mode else ''}. Approve? [y/N] ")
        if auto_approve:
            print(question + "yes (auto)")
        elif input(question).strip().lower() not in ("y", "yes"):
            print("declined: nothing ran")
            return
        out = await b.run_experiment(suspect, change, prediction, pairs=pairs, source_run=source_run,
                                     anchor=anchor, reason=reason, fork_mode=fork_mode)
        print(json.dumps(out, indent=2, default=str))
    finally:
        await b.close()
    _print_case(b)


async def interaction(batch_id: str, a: str, b_: str, per_cell: int, source_run: str | None,
                      auto_approve: bool) -> None:
    """The two-factor grid on a saved batch (`Batch.run_interaction`). `a` and `b_` are two supported suspects (each
    suspect's change comes from its newest experiment) or two registry changes. It costs money, so it asks first."""
    from . import interaction as ixn

    cfg = _saved_config(batch_id)
    if auto_approve and cfg.budget_usd > AUTO_APPROVE_MAX_BUDGET_USD:
        raise SystemExit(
            f"--auto-approve needs a batch budget of ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less; "
            f"this batch has ${cfg.budget_usd:.2f}. Answer the approval yourself instead."
        )
    b = _reopen(batch_id)
    try:
        by_suspect = b.case.suspect(a) is not None or b.case.suspect(b_) is not None
        found = ixn.suspect_changes(b.case.read(), a, b_) if by_suspect else (a, b_, "before_split")
        if isinstance(found, str):
            raise SystemExit(f"error: {found}")
        change_a, change_b, anchor = found
        try:
            b.parse_change(change_a), b.parse_change(change_b)
        except ValueError as e:
            raise SystemExit(f"error: {e}") from None
        n = max(1, min(per_cell, ixn.MAX_PER_CELL))
        est = b.estimate_forks_usd(n, 4)
        question = (f"Run the two-factor grid of {change_a} and {change_b}: 4 cells of {n} copies ({4 * n} copies and "
                    f"1 base VM), about ${'?' if est is None else f'{est:.2f}'}. Approve? [y/N] ")
        if auto_approve:
            print(question + "yes (auto)")
        elif input(question).strip().lower() not in ("y", "yes"):
            print("declined: nothing ran")
            return
        out = await b.run_interaction(change_a, change_b, per_cell=n, source_run=source_run, anchor=anchor,
                                      suspects=(a, b_) if by_suspect else None)
        print(json.dumps(out, indent=2, default=str))
    finally:
        await b.close()
    _print_case(b)


async def foolrate(n: int, settings: list[str], budget: float, yes: bool, domain: str = domains.DEFAULT,
                   noise: float | None = None, hidden: float | None = None, root=None) -> dict | None:
    """MASTER_PLAN Phase 5.3: one batch of `n` runs per setting, the inflated runs counted, the table written to each
    batch's `foolrate` section and to `batches/_foolrate/<stamp>.json`. Real runs cost money, so without `yes` it
    prints the estimate and exits. Returns the table (None when it only estimated)."""
    root = BATCHES_DIR if root is None else root
    trap = {k: v for k, v in (("trap_noise", noise), ("trap_hidden_share", hidden)) if v is not None}
    from .costs import CostTracker

    per_run = None
    for case_path in sorted(root.glob("*/case/case.json"))[-20:]:  # what recent real runs cost on this machine
        try:
            case = json.loads(case_path.read_text())
        except (OSError, ValueError):
            continue
        if (case.get("config") or {}).get("domain", domains.DEFAULT) != domain or (case.get("config") or {}).get("simulated"):
            continue
        t = CostTracker(budget_usd=1.0)
        t.restore(case.get("costs") or {})
        if (avg := t.average_run_usd()) is not None:
            per_run = avg if per_run is None else max(per_run, avg)
    est = fr.estimate_usd(n, settings, per_run)
    basis = "the most a run cost on average in a recent batch here" if per_run is not None else \
        f"${fr.DEFAULT_RUN_USD} a run"
    print(f"fool rate: {len(settings)} batches ({', '.join(settings)}) of {n} runs = {n * len(settings)} real runs, "
          f"about ${est:.2f} ({basis}); budget ${budget:.2f} per batch")
    no_lessons = "learned" in settings and not lessons_mod.approved()
    if no_lessons:
        print(f"warning: no approved lesson in {lessons_mod.learned_dir()}, so 'learned' would be the same as 'none'")
    if no_lessons and yes:
        raise SystemExit("approve a lesson first (the investigator's propose_lesson), or leave 'learned' out")
    if est > budget * len(settings):
        raise SystemExit(f"the estimate ${est:.2f} is over the budget ${budget * len(settings):.2f}; raise --budget")
    if not yes:
        print("nothing ran: pass --yes to run it")
        return None
    rows, batches = [], []
    for setting in settings:
        b = Batch(BatchConfig(domain=domain, n_runs=n, budget_usd=budget, **trap, **fr.config_for(setting)), root=root)
        print(f"setting {setting}: batch {b.id}")
        try:
            await b.run_all()
        finally:
            await b.close()
        batches.append(b)
        rows.append(fr.row(setting, b.case.data["runs"], b.id))
    table = fr.table(rows, n=n, domain=domain, trap=trap, estimate=est)
    for b in batches:
        b.case.set_foolrate(table)
    path = fr.save_report(table, root)
    print("\n".join(fr.lines(table)))
    print("report:", path)
    return table


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
    testable = any(b.domain.intervention_for(lb, b.cfg) for lb in b.domain.labels())
    if why_not and not (b.case.data.get("split") and (testable or b.domain.score_code is not None)):
        # Nothing could test a hypothesis here: neither a fork on any step nor a measured fix. It would only spend tokens.
        # The split's own label need not be testable: the investigator chooses which hypothesis to test.
        raise SystemExit(f"batch {batch_id} (phase {b.case.data.get('phase')}): {why_not}")
    approved = declined_at_limit = 0
    try:
        await b.investigate()
        while b.case.data.get("phase") == "awaiting_approval":
            pending = b.case.data["forks"].get("pending", {})
            about = f" to test {pending['hypothesis_id']} ({pending.get('prediction')})" if pending.get("hypothesis_id") else ""
            if pending.get("kind") == "lesson":
                question = f"The investigator proposes the lesson '{pending.get('name')}': {pending.get('rule')} Save it? [y/N] "
                approve = auto_approve or input(question).strip().lower() in ("y", "yes")
                if auto_approve:
                    print(question + "yes (auto)")
                await b.decide(approve)  # a lesson costs nothing, so it does not count against the auto-approvals
                continue
            if pending.get("kind") == "experiment":
                about = f" to test {pending.get('suspect_id')} with {pending.get('change')} ({pending.get('prediction')})"
                question = (f"The investigator asks for a paired experiment{about}: {pending.get('pairs')} pairs, "
                            f"{pending.get('vm_count')} VMs, about ${pending.get('estimate_usd')}. Approve? [y/N] ")
            elif pending.get("direct"):
                question = f"The investigator asks to run its patched code on the held-out setups{about}, no VMs, $0. Approve? [y/N] "
            else:
                question = (
                    f"The investigator asks for a {pending.get('kind')} experiment{about}: {pending.get('n_per_arm')} "
                    f"runs per arm, {pending.get('vm_count')} VMs, about ${pending.get('estimate_usd')}. Approve? [y/N] "
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


async def benchmarks(batch_id: str) -> None:
    """Add to a saved batch what a batch started today measures on its own: every scored run's code on the
    domain's other test sets (LIBERO-PRO), and the code the runs started from, scored unchanged. Only adds
    keys to the case file; nothing a run or the investigator recorded is changed. No VM and no model."""
    b = Batch(_saved_config(batch_id), batch_id=batch_id, root=BATCHES_DIR, resume=True)
    if b.domain.benchmarks is None:
        raise SystemExit(f"the {b.domain.name} domain has no other test set")
    base = b.case.data.get("baseline")
    if base is None:
        await b.score_baseline()
    elif base.get("status") == "scored":
        # Scored already: measure it on the other test sets again, so its episodes are recorded too.
        found = b.domain.baseline_code(b.cfg, b.task)
        other = await asyncio.to_thread(b.other_benchmarks, found[0].parent, b.dir / "baseline" / BENCH_DIR) if found else {}
        if other:
            b.case.set_baseline({**base, "benchmarks": other})
    base = b.case.data.get("baseline")
    if base:
        print(f"start ({base.get('name')}): measured {base.get('true_accuracy')}  " + "  ".join(
            f"{name} {m['successes']}/{m['n']}" for name, m in (base.get("benchmarks") or {}).items()))
    for run_id, run in sorted(b.case.data["runs"].items()):
        if run.get("status") not in ("honest", "inflated", "unclear"):
            continue
        other = await asyncio.to_thread(b.other_benchmarks, b.runs_dir / run_id / "outputs", b.runs_dir / run_id / BENCH_DIR)
        if other:
            b.case.update_run(run_id, benchmarks=other)
        print(f"{run_id}: measured {run.get('true_accuracy')}  " + "  ".join(
            f"{name} {m['successes']}/{m['n']}" for name, m in other.items()))


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
    r.add_argument("--domain", choices=domains.names(), default=domains.DEFAULT,
                   help="the kind of task; the --strength, --noise and --hidden trap settings are tabular only")
    r.add_argument("--n", type=int, default=1)
    r.add_argument("--strength", type=float, default=0.5)
    r.add_argument("--hint", choices=["none", "light"], default="none")
    r.add_argument("--noise", type=float, default=BatchConfig.model_fields["trap_noise"].default)
    r.add_argument("--hidden", type=float, default=BatchConfig.model_fields["trap_hidden_share"].default,
                   help="share of the copies the noise hides from an exact duplicate check")
    r.add_argument("--budget", type=float, default=BatchConfig.model_fields["budget_usd"].default,
                   help="the batch's budget in US dollars")
    r.add_argument("--robot-prompt", choices=["default", "practice"], default="default",
                   help="robot_arm only: 'practice' asks the agent to make the controller work on the practice setup")
    r.add_argument("--robot-start", choices=["blank", "colleague"], default="blank",
                   help="robot_arm only: 'colleague' starts the agent from a colleague's working controller")
    r.add_argument("--robot-positions", choices=["default", "libero_pro"], default="default",
                   help="robot_arm only: 'libero_pro' practises at LIBERO's spot and measures at LIBERO-PRO's positions")
    r.add_argument("--lessons", choices=["none", "learned"], default="none",
                   help="'learned' gives the analysts the approved lessons under skills/learned/")
    f = sub.add_parser("forks")
    f.add_argument("batch_id")
    f.add_argument("--n", type=int, default=4)
    e = sub.add_parser("experiment", help="one paired experiment: control and changed copies from one fork point")
    e.add_argument("batch_id")
    e.add_argument("--suspect", required=True, help="the suspect id the experiment tests")
    e.add_argument("--change", required=True, help="a registry change, e.g. force_step:deduplicate or control")
    e.add_argument("--prediction", choices=["smaller_gap", "larger_gap"], default="smaller_gap")
    e.add_argument("--pairs", type=int, default=3, help=f"pairs to run, at most {MAX_EXPERIMENT_PAIRS}")
    e.add_argument("--source-run", default=None, help="the run to fork; by default the first eligible one")
    e.add_argument("--anchor", default="before_split", help="before_split, before_label:<label> or index:<n>")
    e.add_argument("--reason", default="")
    e.add_argument("--auto-approve", action="store_true",
                   help=f"approve the spend unattended (budget ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less)")
    e.add_argument("--fork-mode", choices=["messages", "checkpoint"], default=None,
                   help="how the copies get the source run's agent state (default: the batch's fork_mode); "
                        "the VM is rebuilt by replay either way")
    fo = sub.add_parser("foolrate", help="the fool rate per setting; prints the cost and exits unless --yes")
    fo.add_argument("--n", type=int, default=12, help="runs per setting")
    fo.add_argument("--settings", default="none,learned", help=f"comma separated, of {list(fr.SETTINGS)}")
    fo.add_argument("--domain", choices=domains.names(), default=domains.DEFAULT)
    fo.add_argument("--noise", type=float, default=None)
    fo.add_argument("--hidden", type=float, default=None)
    fo.add_argument("--budget", type=float, default=1.0, help="each batch's budget in US dollars")
    fo.add_argument("--yes", action="store_true", help="really run it (real runs cost money)")
    g = sub.add_parser("interaction", help="the two-factor grid of two supported suspects from one fork point")
    g.add_argument("batch_id")
    g.add_argument("--a", required=True, help="a supported suspect id (its newest experiment's change), or a change")
    g.add_argument("--b", required=True, help="another supported suspect id, or a change")
    g.add_argument("--per-cell", type=int, default=2, help="copies per cell (four cells), at most 4")
    g.add_argument("--source-run", default=None, help="the run to fork; by default the first eligible one")
    g.add_argument("--auto-approve", action="store_true",
                   help=f"approve the spend unattended (budget ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less)")
    i = sub.add_parser("investigate")
    i.add_argument("batch_id")
    i.add_argument("--auto-approve", action="store_true",
                   help=f"approve the investigator's experiments unattended (budget ${AUTO_APPROVE_MAX_BUDGET_USD:.0f} or less)")
    m = sub.add_parser("benchmarks", help="add the LIBERO-PRO number and the starting code's score to a saved batch")
    m.add_argument("batch_id")
    sub.add_parser("vms", help="count the running VMs on the Daytona key")
    sub.add_parser("cleanup", help="stop every running deep-research VM, from any machine sharing the key")
    a = p.parse_args(argv)
    if a.cmd == "vms":
        vms()
    elif a.cmd == "cleanup":
        cleanup()
    elif a.cmd == "runs":
        # The domain is named only when it is not the default one, so a plain `runs` calls `runs` as before.
        on = {} if a.domain == domains.DEFAULT else {"domain": a.domain}
        if a.robot_prompt != "default":
            on["robot_prompt"] = a.robot_prompt
        if a.robot_start != "blank":
            on["robot_start"] = a.robot_start
        if a.robot_positions != "default":
            on["robot_positions"] = a.robot_positions
        if a.lessons != "none":
            on["lessons"] = a.lessons
        asyncio.run(runs(a.n, a.strength, a.hint, a.noise, a.hidden, a.budget, **on))
    elif a.cmd == "benchmarks":
        asyncio.run(benchmarks(a.batch_id))
    elif a.cmd == "forks":
        asyncio.run(forks(a.batch_id, a.n))
    elif a.cmd == "interaction":
        asyncio.run(interaction(a.batch_id, a.a, a.b, a.per_cell, a.source_run, a.auto_approve))
    elif a.cmd == "experiment":
        asyncio.run(experiment(a.batch_id, a.suspect, a.change, a.prediction, a.pairs, a.source_run, a.anchor,
                               a.reason, a.auto_approve, **({"fork_mode": a.fork_mode} if a.fork_mode else {})))
    elif a.cmd == "foolrate":
        try:
            settings = fr.parse_settings(a.settings)
        except ValueError as e:
            raise SystemExit(f"error: {e}") from None
        asyncio.run(foolrate(a.n, settings, a.budget, a.yes, a.domain, a.noise, a.hidden))
    else:
        asyncio.run(investigate(a.batch_id, a.auto_approve))


if __name__ == "__main__":
    main()
