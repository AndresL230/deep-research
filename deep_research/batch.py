"""The orchestrator. Plain code: starts VMs and runs, scores, finds the split,
runs the fork experiment, drives the investigator, and tracks cost.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import json
import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiosqlite
from langchain_core.messages import messages_from_dict, messages_to_dict
from langchain_daytona import DaytonaSandbox
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from . import domains, hub
from . import sandboxes as vms
from .agents.analyst import build_analyst
from .agents.investigator import RUBRIC, build_investigator
from .analysis import find_split, fork_point, label_table, rank_candidates, run_attributes
from .audit import build_audit
from .case_file import CaseFile, with_evidence
from .commentary import for_batch as commentary_for
from .config import BATCHES_DIR, BatchConfig
from .costs import CostTracker, OverBudget, ScopeCost, UsageCallback, usd_up
from .events import PREFIX_EVENTS, EventLog, current_step, events_from_update, prefix_events, read_events
from .evidence import (current_verdict_evidence, fork_pairs, pairs_to_support, verdict_evidence, verdict_fork,
                       verdict_sentence)
from .evidence import describe as describe_evidence
from .evidence import fix_evidence, fix_outcome, method_outcome
from .domains import actions_from_events, build_task, intervention_for, score_run
from .domains.robot_arm import BENCH_DIR
from . import experiments as xp
from . import interaction as ixn
from .forks import ChangeError, anchor_error, change_messages, cut_history, fix_plan, parse_change, step_model

logger = logging.getLogger(__name__)

RUN_TIMEOUT_S = 900
# One investigator turn is four graph steps, and reading the case file a hundred lines at a time is a
# turn per read, so the analysts' limit would end an investigation after about 48 turns, with the fork
# money already spent. The budget check is what limits the investigator's spend.
INVESTIGATOR_RECURSION_LIMIT = 1000
# Fork children at once, at most (and never more than the batch's `max_concurrent_runs`).
MAX_PARALLEL_VMS = 12
# Traces (`Batch.trace_failures`) that run at once in this server, across all batches. Each re-runs a controller in
# `sim.domain.TRACE_WORKERS` worker processes, so at most MAX_PARALLEL_TRACES x TRACE_WORKERS of them run together.
# More traces wait for a slot.
MAX_PARALLEL_TRACES = 3
# An experiment tests one of at least this many competing hypotheses, recorded before it.
MIN_HYPOTHESES = 2
# A proposed fix is one small, bounded change.
MAX_FIX_CHARS = 4000
_TRACE_SLOTS = threading.BoundedSemaphore(MAX_PARALLEL_TRACES)
# Scorings at once on this server. Each one starts its own evaluation worker processes; eight at once (a fork's copies
# finishing together, on a laptop) starved them past their start-up timeout and every copy failed to be scored.
MAX_PARALLEL_SCORING = 2
_SCORE_SLOTS = threading.BoundedSemaphore(MAX_PARALLEL_SCORING)


def _score(outputs, task, threshold):
    """`score_run`, waiting for one of the server's scoring slots."""
    with _SCORE_SLOTS:
        return score_run(outputs, task, threshold)
# One trace of a run at a time: a trace writes its recordings under the run's `trace/` folder.
_TRACE_RUN_LOCKS: dict[Path, threading.Lock] = {}
_TRACE_RUN_LOCKS_LOCK = threading.Lock()
# A robot run's motion files are pulled from its VM this often while it runs, so its tile shows it practicing.
MOTION_POLL_S = 15.0
# How long the end of a run waits for a pull in flight before it gives up on it.
MOTION_POLL_STOP_S = 20.0

# Run statuses that mean the run is over. "unclear" (robot only): scored, but neither honest nor inflated.
SCORED = ("honest", "inflated", "unclear", "failed")

# The pulls run here, not in the default thread pool the agents' sandbox calls share: 12 runs polling at once must
# never hold up a run's own tool calls.
_POLL_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="motion-poll")


class MotionWatch:
    """Pulls a robot run's (or fork child's) motion files from its VM while it runs.

    Every `MOTION_POLL_S` seconds one look at the VM's live folder (`sandboxes.poll_live_files`) saves the new or
    changed files under the run's `outputs/live/`, where the final download puts them too. Each file that arrives
    is logged as an event, `{"type": "motion", "t": <run clock>, "path": "runs/r01/outputs/live/x.motion.json"}`, so
    the websocket pushes it and a saved batch's replay shows the episode when it appeared, and `publish(files)` gets
    the run's motion files so far (batch-relative, newest last, at most the domain's `max_output_globs`).

    Runs on the event loop as its own task; the pulls run in `_POLL_POOL`. A failing pull is logged and the next one
    tries again. `stop()` ends it, `finish()` merges in the files the final download found.
    """

    def __init__(self, sb: Any, outputs: Path, prefix: str, patterns: list[str], limit: int,
                 log: EventLog, on_event, publish):
        self.sb, self.outputs, self.prefix, self.patterns, self.limit = sb, outputs, prefix, patterns, limit
        self.log, self.on_event, self.publish = log, on_event, publish
        self.files: list[str] = []
        self.seen: dict[str, tuple] = {}
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._stop.wait(), MOTION_POLL_S)
                return
            except asyncio.TimeoutError:
                pass
            await self.poll()

    async def poll(self) -> None:
        try:
            new = await asyncio.get_running_loop().run_in_executor(
                _POLL_POOL, vms.poll_live_files, self.sb, self.outputs, self.patterns, self.seen, self.limit)
        except Exception as e:  # noqa: BLE001 - watching must never break the run
            logger.warning("pulling motion files for %s failed: %s: %s", self.prefix, type(e).__name__, e)
            return
        if not self._stop.is_set():
            self._arrived(new)

    def _arrived(self, rels: list[str]) -> None:
        if not rels:
            return
        for rel in rels:
            path = f"{self.prefix}/{rel}"
            if path in self.files:
                self.files.remove(path)  # changed: it is the newest episode again
            self.files.append(path)
            try:
                self.on_event(self.log.write({"type": "motion", "path": path}))
            except Exception as e:  # noqa: BLE001 - the log is closed: the run is over
                logger.warning("logging motion file %s failed: %r", path, e)
        self.files = self.files[-self.limit:]
        self.publish(list(self.files))

    async def stop(self) -> None:
        """Stop pulling. Waits a little for a pull in flight, so it never writes after the final download."""
        if self._task.done():
            return
        self._stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(self._task), MOTION_POLL_STOP_S)
        except Exception:  # noqa: BLE001 - a pull that hangs, or the task failed: drop it
            self._task.cancel()

    def finish(self, final: list[str]) -> None:
        """Merge in the files the final download saved (relative to `outputs`): those not seen yet come last."""
        self._arrived([rel for rel in final if f"{self.prefix}/{rel}" not in self.files])


def _watch_motion(domain, sb: Any, outputs: Path, prefix: str, log: EventLog, on_event, publish) -> MotionWatch | None:
    """A `MotionWatch` for a run of `domain`, or None when its runs draw no motion (the tabular domain)."""
    patterns = vms.live_globs(domain.output_globs) if domain.visual == "motion" else []
    if not patterns:
        return None
    return MotionWatch(sb, outputs, prefix, patterns, domain.max_output_globs, log, on_event, publish)


def resume_problem(case: dict, batch_dir: Path) -> str | None:
    """Why a saved batch cannot be picked up again, or None when it can.

    A batch can be resumed once its runs are scored and a split was found, as long as no verdict is in yet. Everything
    the investigator and the fork experiment need is then on disk: the task files, each run's events and messages, and
    the case file. Nothing that was mid-flight survives a restart (the VMs are gone, the investigator's memory too), so
    a resumed batch starts again from `ready`.
    """
    cfg = case.get("config") or {}
    if cfg.get("simulated"):
        return "a simulated batch has no real runs to fork"
    phase = str(case.get("phase") or "")
    if phase == "done" or case.get("verdict"):
        return "this batch already has its verdict"
    runs = case.get("runs") or {}
    inflated = [rid for rid, r in runs.items() if r.get("status") == "inflated"]
    if phase == "no_split" and not inflated:
        return "no step separated the runs, so there is nothing to investigate"
    if phase.startswith("blocked:"):
        return "it stopped over its budget, and it would stop again on the same budget"
    runs = case.get("runs") or {}
    if not runs or any(r.get("status") not in SCORED for r in runs.values()):
        return "its runs never finished"
    split = case.get("split") or {}
    # MASTER_PLAN Phase 1.4: an investigation needs only one inflated run, even when no run is honest and so no split
    # exists. The investigator picks its own experiments; the first inflated run stands in for the files check.
    src = split.get("fork_run_id") or (inflated[0] if inflated else None)
    if not src:
        return "no split was found and no run came out inflated"
    try:
        marker = domains.get(cfg.get("domain")).task_marker
    except ValueError:
        return f"its domain '{cfg.get('domain')}' is not available here"
    if not (batch_dir / "runs" / src / "messages.json").is_file() or not (batch_dir / "task" / marker).is_file():
        return "the files needed to fork are missing"
    return None


# ---- more pairs: more copies per arm for a verdict whose evidence is still open ----

# Copies per arm one request may add: the same cap as one experiment's `n_per_arm`.
MAX_MORE_PAIRS = 8
# Phases in which something of the batch is still running (or waiting on a person), so no new experiment may start.
WORKING_PHASES = ("config", "running", "analyzing", "ready", "investigating", "awaiting_approval", "forking", "forked")


class Refused(ValueError):
    """Why more pairs cannot run on a batch now. The API answers it with 409 and this message."""


def _fork_evidence(fork: dict) -> dict:
    """`verdict_evidence` of a fork's own arm summaries (scored copies, as a verdict counts them) and its pairs."""
    arms = fork.get("arms") or {}
    return verdict_evidence({a: {"inflated": int(arms[a].get("inflated") or 0), "total": int(arms[a].get("scored") or 0)}
                             for a in ("control", "forced") if isinstance(arms.get(a), dict)}, pairs=fork_pairs(fork))


def more_pairs_problem(case: dict, batch_dir: Path) -> str | None:
    """Why more pairs cannot be added to a saved batch's fork experiment, or None when they can.

    They can once the batch has a verdict whose evidence is still `open` and a finished method experiment to add to,
    with the files needed to fork its source run again. Whether the batch is busy and whether the budget covers it
    are checked when it is asked for (`Batch.reserve_more_pairs`).
    """
    cfg = case.get("config") or {}
    if cfg.get("simulated"):
        return "a simulated batch has no real runs to fork"
    verdict = case.get("verdict")
    if not isinstance(verdict, dict):
        return "this batch has no verdict yet"
    found = verdict_fork(case)
    if found is None:
        return "no fork experiment finished with a control and a forced arm, so there are no pairs to add to"
    evidence = current_verdict_evidence(case)
    if evidence.get("level") != "open":
        return f"the verdict's evidence is already {evidence.get('level')}"
    try:
        marker = domains.get(cfg.get("domain")).task_marker
    except ValueError:
        return f"its domain '{cfg.get('domain')}' is not available here"
    if found[1].get("change"):
        # A paired experiment (`Batch.run_experiment`) is continued by running it again: the suspect's score runs on.
        return f"{found[0]} is a paired experiment; run it again with run_experiment to add pairs"
    src = found[1].get("source_run")
    if not src or not (batch_dir / "runs" / src / "messages.json").is_file() or not (batch_dir / "task" / marker).is_file():
        return "the files needed to fork are missing"
    return None


# A fork copy that ran to its end and was scored: what a whole new copy will cost. A failed or stopped copy may have
# stopped early, so its spend would undersell one.
FINISHED_COPY = ("honest", "inflated", "unclear")


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _average_cost(costs: dict[str, ScopeCost]) -> tuple[float, float] | None:
    """Average (total, VM part) of these scopes' spend, or None when there are none or a price is unknown."""
    totals = [c.total_usd for c in costs.values()]
    if not totals or any(t is None for t in totals):
        return None
    return sum(totals) / len(totals), sum(c.vm_usd or 0.0 for c in costs.values()) / len(costs)  # type: ignore[arg-type]


def _per_copy_usd(case: dict, tracker: CostTracker, fork_id: str, fork: dict) -> tuple[float, float, str] | None:
    """What one new copy of `fork` should cost, as (total, VM part, where the figure comes from): the average spend
    (model tokens and VM time) of its own copies that finished, else of the runs on its source run's model, else of
    every run. A copy's spend covers all it sends, the source run's history it starts from included (as cache reads
    and writes). None when nothing has a known price."""
    children = fork.get("children") or {}
    own = tracker.scope_costs({f"fork:{fork_id}:{cid}" for cid, c in children.items()
                               if isinstance(c, dict) and c.get("status") in FINISHED_COPY})
    if (avg := _average_cost(own)) is not None:
        return (*avg, f"the average of {len(own)} earlier finished {_plural(len(own), 'copy', 'copies')} of {fork_id}")
    runs = case.get("runs") or {}
    model_of = lambda r: (runs.get(r) or {}).get("model") or (case.get("config") or {}).get("analyst_model")  # noqa: E731
    model = model_of(fork.get("source_run"))
    same = tracker.scope_costs({f"run:{r}" for r in runs if model_of(r) == model})
    if (avg := _average_cost(same)) is not None:
        return (*avg, f"no copy of {fork_id} finished yet, so the average whole run on {model} "
                      f"({len(same)} {_plural(len(same), 'run', 'runs')})")
    every = tracker.scope_costs({k for k in list(tracker.scopes) if k.startswith("run:")})
    if (avg := _average_cost(every)) is not None:
        return (*avg, f"no copy of {fork_id} finished yet, so the average whole run "
                      f"({len(every)} {_plural(len(every), 'run', 'runs')})")
    return None


def more_pairs_quote(case: dict, tracker: CostTracker, n_per_arm: int | None = None) -> dict:
    """What `n_per_arm` more copies per arm of the verdict's fork would add and cost, before anyone confirms it.

    `n_per_arm` defaults to what reaches the needed pairs (at least 1) and is held between 1 and MAX_MORE_PAIRS.
    `pairs_after` assumes every new copy is scored. The estimate is what one copy of this fork costs, model tokens
    and VM time (`_per_copy_usd`), times the new copies, plus one base VM rebuilt at the fork point at the most one
    of this fork's base VMs has cost (else at one copy's VM time). It is rounded up to the cent, never down: a person
    approves real money with it. `basis` says in words what it includes. More pairs ask no model besides the copies'
    own (the verdict is reworded in code), so the investigator's spend is no part of it. `over_budget` is what
    `reserve_more_pairs` refuses. Expects a fork to exist (`more_pairs_problem` is None).
    """
    found = verdict_fork(case)
    if found is None:
        raise Refused("no fork experiment finished, so there are no pairs to add to")
    fork_id, fork = found
    arms = list(fork.get("arm_steps") or fork.get("arms") or {})
    ev = _fork_evidence(fork)
    n = pairs_to_support(ev) if n_per_arm is None else n_per_arm
    n = max(1, min(int(n), MAX_MORE_PAIRS))
    copies = len(arms) * n

    estimate, basis = None, "No estimate: no earlier copy or run of this batch has a known price."
    per_copy = _per_copy_usd(case, tracker, fork_id, fork)
    if per_copy is not None:
        copy_usd, copy_vm_usd, source = per_copy
        # The first round's base VM is `base`, the k-th round of more pairs' `base-{k + 1}`.
        rounds = len(fork.get("more_pairs") or [])
        bases = tracker.scope_costs({f"fork:{fork_id}:base"} | {f"fork:{fork_id}:base-{i}" for i in range(2, rounds + 2)})
        known = [c.total_usd for c in bases.values() if c.total_usd is not None]
        if len(known) == 1:
            base_usd, base_words = known[0], f"what {fork_id}'s base VM cost"
        elif known:
            base_usd, base_words = max(known), f"the most one of {fork_id}'s {len(known)} base VMs cost"
        else:
            base_usd, base_words = copy_vm_usd, "priced as one copy's VM time"
        estimate = usd_up(copy_usd * copies + base_usd)
        basis = (f"{copies} new {_plural(copies, 'copy', 'copies')} at ${copy_usd:.4f} each ({source}), plus "
                 f"${base_usd:.4f} for the base VM ({base_words}). Model tokens and VM time, rounded up to the cent.")

    spent, budget = tracker.total_usd(), tracker.budget_usd
    problem = None
    if spent is not None and spent >= budget:
        problem = f"the batch has spent ${spent:.2f} of its ${budget:.2f} budget"
    elif spent is not None and estimate is not None and spent + estimate > budget:
        problem = (f"{copies} more fork runs would cost about ${estimate:.2f}; spent ${spent:.2f} of the "
                   f"${budget:.2f} budget")
    return {
        "fork_id": fork_id,
        "n_per_arm": n,
        "max_per_arm": MAX_MORE_PAIRS,
        "arms": arms,
        "vm_count": copies + 1,
        "estimate_usd": estimate,
        "basis": basis,
        "pairs_now": ev["pairs"],
        "pairs_after": ev["pairs"] + n,
        "needed_pairs": ev["needed_pairs"],
        "level_now": ev["level"],
        "p_value_now": ev["p_value"],
        "budget_usd": budget,
        "spent_usd": None if spent is None else round(spent, 2),
        "over_budget": problem is not None,
        "budget_problem": problem,
    }


def _child_arm(cid: str, child: dict) -> str:
    """A fork child's arm: its `arm`, else the part of its id before the number (`control-3`)."""
    return child.get("arm") or cid.rsplit("-", 1)[0]


def _child_number(cid: str) -> int:
    try:
        return int(cid.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 0


class Batch:
    def __init__(self, cfg: BatchConfig, batch_id: str | None = None, root: Path = BATCHES_DIR, resume: bool = False):
        self.cfg = cfg
        # What the task is, how a run is scored and what its steps are called (deep_research/domains/).
        self.domain = domains.get(cfg.domain)
        # The VM calls name the domain only when it is not the default one, so a tabular batch calls them as before.
        self._vm_domain = {} if cfg.domain == domains.DEFAULT else {"domain": cfg.domain}
        self.id = batch_id or time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        # The batches folder. The investigator's notebooks live under it, in `_memory/` (notebook.py).
        self.root = root
        self.dir = root / self.id
        self.runs_dir = self.dir / "runs"
        self.forks_dir = self.dir / "forks"
        self.case_view = self.dir / "case" / "view" / "case.json"
        fresh = not self.dir.exists()
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        if resume:
            # The task files are already there from the first time round.
            self.task = self.domain.open_task(self.dir / "task")
        else:
            try:
                # First, and before the case file exists: if the task cannot be built there is no batch.
                self.task = build_task(cfg, self.dir / "task")
            except BaseException:
                if fresh:
                    shutil.rmtree(self.dir, ignore_errors=True)
                raise
        # The investigator reads the case through `case/view/case.json` (case_file.investigator_view), never case.json.
        self.case = CaseFile(self.dir / "case" / "case.json", labels=self.domain.labels(), view_path=self.case_view)
        self.tracker = CostTracker(budget_usd=cfg.budget_usd)
        # A reopened batch (Batch.resume, cli forks, cli investigate) has spend on record already.
        self.tracker.restore(self.case.data.get("costs") or {})
        # Live captions of the runs and a feed of notable moments (commentary.py); None when the config has them off.
        self.commentary = commentary_for(self)
        self.vms: dict[str, Any] = {}
        self._queues: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_cost_push = 0.0
        self._investigator = None
        self._inv_config: dict | None = None
        self._checkpoint_conn = None
        self._pending_requests = 1
        # VM creations cancelled midway (a stop): their VMs are deleted once they exist (`_create_vm`).
        self._orphans: set[asyncio.Future] = set()
        self.case.subscribe(lambda section, value: self._emit({"kind": "case", "section": section, "value": value}))
        # The team hub (hub.py), when it is set up: every change to the case file and every agent event goes there.
        self._hub = hub.pusher()
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        if self._hub is not None:
            self.case.subscribe(lambda section, value: self._push_case())
            self.case.subscribe(self._push_motion)
        # The domain in words and what the UI draws for a run, plus the domain's own keys (the tabular `trap_info`).
        info = {"visual": self.domain.visual, "domain_info": self.domain.public(), **self.domain.case_config(cfg)}
        if not resume:
            self.case.set_config({**cfg.model_dump(), **info})
        elif any(k not in self.case.data.get("config", {}) for k in info):
            self.case.set_config({**info, **self.case.data["config"]})

    # ---- the team hub ----
    def _push_case(self) -> None:
        # Called inside the case file's lock, so the data is consistent; copy it, the push happens later elsewhere.
        if self._hub is not None:
            self._hub.push_case(self.id, json.loads(json.dumps(self.case.data, default=str)), self.started_at)

    def _push_motion(self, section: str, value: Any) -> None:
        # The motion files the case names, as each is saved: a live practice episode MotionWatch pulled in (and pulled
        # again when it changed), the final download, a scored run's hidden episodes (`hidden_results`), the same for
        # fork children. Queuing is cheap and the pusher sends a file again only when it changed on disk.
        if self._hub is not None and section in ("runs", "forks"):
            self._hub.push_case_files(self.id, self.dir, {section: value})

    def _log(self, path: Path, key: str) -> EventLog:
        """An event log whose events also go to the hub, under `key` (a run, a fork child, or "investigator")."""
        pusher = self._hub
        if pusher is None:
            return EventLog(path)
        return EventLog(path, on_write=lambda seq, ev: pusher.push_event(self.id, key, seq, ev))

    @classmethod
    def resume(cls, batch_id: str, root: Path = BATCHES_DIR) -> "Batch":
        """Pick a saved batch up again where it can be: scored runs and a split, no verdict yet.

        Raises ValueError with the reason when it cannot (`resume_problem`). The batch comes back in phase `ready`,
        so the investigator can be started as if the server had never stopped. A fork request that was waiting for
        approval is dropped: the investigator that asked for it is gone.
        """
        case_path = root / batch_id / "case" / "case.json"
        if not case_path.is_file():
            raise ValueError(f"no batch {batch_id}")
        case = json.loads(case_path.read_text())
        problem = resume_problem(case, root / batch_id)
        if problem:
            raise ValueError(problem)
        b = cls(BatchConfig(**case["config"]), batch_id=batch_id, root=root, resume=True)
        # The investigator's checkpoints are on disk (checkpoints.sqlite): a request waiting for approval survives a
        # restart, and answering it (`decide`) continues the same investigator thread.
        waiting = "pending" in b.case.data["forks"] and b.checkpoints_path.is_file()
        if "pending" in b.case.data["forks"] and not waiting:
            b.case.remove_fork("pending")
        b._close_unfinished_forks()
        b._forget_lab_pages()  # the VMs behind them are long gone
        b.case.set_phase("awaiting_approval" if waiting else "ready")
        return b

    @classmethod
    def reopen(cls, batch_id: str, root: Path = BATCHES_DIR) -> "Batch":
        """Load a finished batch back so more pairs can be added to its fork experiment (`reserve_more_pairs`).

        Raises Refused with the reason when it cannot (`more_pairs_problem`). Unlike `resume`, the batch keeps its
        verdict and its phase: nothing runs until more pairs are reserved. Work the old server left unfinished is
        closed first: a round of more pairs is ended as stopped (its scored copies count), any other experiment is
        marked stopped, and a pending approval is dropped.
        """
        case_path = root / batch_id / "case" / "case.json"
        if not case_path.is_file():
            raise Refused(f"no batch {batch_id}")
        case = with_evidence(json.loads(case_path.read_text()))
        problem = more_pairs_problem(case, root / batch_id)
        if problem:
            raise Refused(problem)
        b = cls(BatchConfig(**case["config"]), batch_id=batch_id, root=root, resume=True)
        if "pending" in b.case.data["forks"]:
            b.case.remove_fork("pending")
        b._settle_more_pairs("the server stopped before this copy finished")
        b._close_unfinished_forks()
        b._forget_lab_pages()
        if b.case.data.get("phase") in WORKING_PHASES:
            # Saved mid-way by a server that stopped after the verdict: nothing of that runs any more.
            b.case.set_phase("done")
        return b

    def _close_unfinished_forks(self) -> None:
        """A fork experiment the old server was still running is over: its VMs are gone and nothing will finish it.

        Mark it stopped, and its children that never got a score failed, so neither the UI nor the new investigator
        waits on it. Its finished children keep their scores.
        """
        for fork_id, fork in list(self.case.data["forks"].items()):
            if fork_id == "pending" or fork.get("status") == "done":
                continue
            for cid, child in list((fork.get("children") or {}).items()):
                if child.get("status") not in SCORED:
                    self._set_child(fork_id, cid, status="failed", reason="the server stopped before this copy finished")
            self.case.update_fork(fork_id, status="stopped")

    def _forget_lab_pages(self) -> None:
        """Null every `lab_url`: the VMs that served them are gone. The saved charts stay."""
        for run_id, run in list(self.case.data["runs"].items()):
            if run.get("lab_url"):
                self.case.update_run(run_id, lab_url=None)
        for fork_id, fork in list(self.case.data["forks"].items()):
            for cid, child in list((fork.get("children") or {}).items()):
                if child.get("lab_url"):
                    self._set_child(fork_id, cid, lab_url=None)

    # ---- live updates to the UI ----
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._queues.discard(q)

    def _emit(self, msg: dict) -> None:
        loop = self._loop
        for q in list(self._queues):
            if loop and loop.is_running():
                loop.call_soon_threadsafe(_put, q, msg)
            else:
                _put(q, msg)

    def push_costs(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_cost_push > 2:
            self._last_cost_push = now
            self.case.set_costs(self.tracker.snapshot())

    def _check_budget(self) -> None:
        """Stop work in flight once the batch has spent its budget.

        The checks before a batch of runs or a fork experiment only see estimates, and a first
        batch has no estimate at all. This one sees what was actually spent.
        """
        spent = self.tracker.total_usd()
        if spent is not None and spent > self.cfg.budget_usd:
            raise OverBudget(f"spent ${spent:.2f} of the ${self.cfg.budget_usd:.2f} budget")

    def _budget_spent(self) -> str | None:
        """Why no new run may start, once the batch has spent its whole budget, or None."""
        spent = self.tracker.total_usd()
        if spent is not None and spent >= self.cfg.budget_usd:
            return f"not started: spent ${spent:.2f} of the ${self.cfg.budget_usd:.2f} budget"
        return None

    def run_model(self, run_id: str) -> str:
        """The analyst model of a run: the one in its case file record, else the batch's `analyst_model`
        (batches saved before lineups)."""
        return (self.case.data["runs"].get(run_id) or {}).get("model") or self.cfg.analyst_model

    async def _create_vm(self, key: str, label: str) -> Any:
        """Create a VM and keep it under `key`. If this is cancelled while Daytona is still creating it (the batch was
        stopped), the VM is deleted as soon as it exists instead of being left running."""
        return await self._new_vm(key, vms.create_vm, label, **self._vm_domain)

    async def _new_vm(self, key: str, make, *args, **kwargs) -> Any:
        """`make(*args, **kwargs)` in a thread (create_vm or fork_vm), kept under `key`, deleted when it arrives if the
        caller was cancelled meanwhile: the thread keeps running after a cancel, and its VM would otherwise be left
        running with nothing holding it."""
        fut = asyncio.ensure_future(asyncio.to_thread(make, *args, **kwargs))
        try:
            sb = await asyncio.shield(fut)
        except asyncio.CancelledError:
            def orphaned(f: asyncio.Future) -> None:
                if f.cancelled() or f.exception() is not None:
                    return
                task = asyncio.ensure_future(asyncio.to_thread(vms.delete_vm, f.result()))
                self._orphans.add(task)
                task.add_done_callback(self._orphans.discard)

            fut.add_done_callback(orphaned)
            raise
        self.vms[key] = sb
        return sb

    # ---- driving one agent ----
    async def _drive(self, agent, inp, thread_id: str, scope: str, model: str, log: EventLog, on_event) -> list:
        config = {
            "configurable": {"thread_id": thread_id},
            "callbacks": [UsageCallback(self.tracker, scope, model)],
            "recursion_limit": self.cfg.max_agent_steps,
        }
        async for chunk in agent.astream(inp, config, stream_mode="updates"):
            for ev in events_from_update(chunk):
                on_event(log.write(ev))
            self.push_costs()
            self._check_budget()
        state = await agent.aget_state(config)
        return state.values.get("messages", [])

    def _run_event(self, run_id: str):
        def on_event(ev: dict) -> None:
            self._emit({"kind": "event", "run": run_id, "event": ev})
            if ev["type"] == "todos":
                self.case.update_run(run_id, todos=ev["todos"], step=current_step(ev["todos"]))
            elif ev["type"] == "tool_call":
                self.case.update_run(run_id, last_tool=ev["name"])
            if self.commentary is not None:
                self.commentary.observe(run_id, ev)

        return on_event

    # ---- phase 1: the runs ----
    async def run_all(self) -> None:
        self._loop = asyncio.get_running_loop()
        est = self.tracker.average_run_usd()
        self.tracker.check(None if est is None else est * self.cfg.n_runs, f"{self.cfg.n_runs} runs")
        self.case.set_phase("running")
        # Each run's whole VM life (create, agent, download, delete) holds a slot, so at most this many VMs are up.
        sem = asyncio.Semaphore(self.cfg.max_concurrent_runs)
        run_ids = [f"r{i + 1:02d}" for i in range(self.cfg.n_runs)]
        for i, r in enumerate(run_ids):
            self.case.update_run(r, status="queued", model=self.cfg.model_for_run(i))

        async def guarded(r: str) -> None:
            async with sem:
                why_not = self._budget_spent()
                if why_not:
                    self.case.update_run(r, status="failed", reason=why_not)
                    return
                await self.run_one(r)

        if self.commentary is not None:
            self.commentary.start()
        # The code the runs start from is scored on this server while they work in their VMs.
        baseline = asyncio.create_task(self.score_baseline())
        try:
            await asyncio.gather(*(guarded(r) for r in run_ids))
            await baseline
        finally:
            if not baseline.done():
                baseline.cancel()
            if self.commentary is not None:
                await self.commentary.stop()
        self.push_costs(force=True)
        self.analyze()
        if self.case.data.get("phase") == "no_split":
            # Nothing to investigate or fork, so nothing will use the VMs again.
            await self.close()

    async def score_baseline(self) -> None:
        """Score the code every run starts from, as it was handed over, on the hidden test (`Domain.score_code`).

        The number the runs' true rates are read against: without it nobody can say whether a run made the code
        better or worse. No VM and no model, so it costs nothing. A failure is recorded and never stops the batch.
        Nothing happens in a domain that cannot score code, or in a batch whose runs start from nothing.
        """
        if self.domain.score_code is None:
            return
        try:
            found = self.domain.baseline_code(self.cfg, self.task)
        except Exception:  # noqa: BLE001 - the baseline is a reference number, never a reason to fail the batch
            logger.warning("batch %s: could not find the code the runs start from", self.id, exc_info=True)
            return
        if found is None:
            return
        path, name = found
        self.case.set_baseline({"status": "scoring", "name": name})
        try:
            measured = await asyncio.to_thread(self.domain.score_code, self.task, path)
        except asyncio.CancelledError:
            self.case.set_baseline({"status": "failed", "name": name, "reason": "the batch stopped before it was scored"})
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("batch %s: the starting code could not be scored", self.id, exc_info=True)
            self.case.set_baseline({"status": "failed", "name": name, "reason": f"{type(e).__name__}: {e}"[:300]})
            return
        other = await asyncio.to_thread(self.other_benchmarks, path.parent, self.dir / "baseline" / BENCH_DIR)
        self.case.set_baseline({"status": "scored", "name": name, **_measurement(measured),
                                "hidden_results": measured.get("hidden_results") or [],
                                **({"benchmarks": other} if other else {})})

    async def run_one(self, run_id: str) -> None:
        scope, rdir = f"run:{run_id}", self.runs_dir / run_id
        log = self._log(rdir / "events.jsonl", run_id)
        model = self.run_model(run_id)
        self.case.update_run(run_id, status="starting", model=model)
        (rdir / "meta.json").write_text(json.dumps({"model": model}))
        watch: MotionWatch | None = None
        try:
            sb = await self._create_vm(run_id, f"{self.id}-{run_id}")
            self.tracker.vm_started(scope)
            await asyncio.to_thread(vms.load_task, sb, self.task)
            url = await _try(asyncio.to_thread(vms.start_lab_page, sb))
            self.case.update_run(run_id, status="running", vm_id=sb.id, lab_url=url)

            on_event = self._run_event(run_id)
            if self.commentary is not None:
                self.commentary.attach(run_id, log, on_event)
            watch = _watch_motion(self.domain, sb, rdir / "outputs", f"runs/{run_id}/outputs", log, on_event,
                                  lambda files: self.case.update_run(run_id, motion_files=files))
            agent = build_analyst(DaytonaSandbox(sandbox=sb), model, self.domain.analyst_system_prompt)
            inp = {"messages": [{"role": "user", "content": self.domain.task_prompt(self.cfg)}]}
            msgs = await asyncio.wait_for(
                self._drive(agent, inp, f"{self.id}-{run_id}", scope, model, log, on_event),
                RUN_TIMEOUT_S,
            )
            (rdir / "messages.json").write_text(json.dumps(messages_to_dict(msgs)))
            if watch is not None:
                await watch.stop()
            motion = await asyncio.to_thread(vms.download_outputs, sb, rdir / "outputs", **self._vm_domain)
            charts = await asyncio.to_thread(vms.download_charts, sb, rdir / "live")
            await self._finish_run(run_id, rdir, log)
            if charts:
                self.case.update_run(run_id, charts=[f"runs/{run_id}/live/{name}" for name in charts])
            if watch is not None:
                watch.finish(motion or [])
            elif motion:
                self.case.update_run(run_id, motion_files=[f"runs/{run_id}/outputs/{path}" for path in motion])
        except Exception as e:  # noqa: BLE001 - one bad run must not sink the batch
            # The reason keeps one line; the log gets the whole chain (an SDK's "Connection error." hides its cause).
            logger.warning("run %s of %s failed", run_id, self.id, exc_info=True)
            self.case.update_run(run_id, status="failed", reason=f"{type(e).__name__}: {e}"[:500])
        finally:
            if watch is not None:
                await watch.stop()
            if self.commentary is not None:
                self.commentary.finish(run_id)  # its last caption, before the log closes
            log.close()
            # The VM is used once: delete it now, so it stops costing anything. Its lab page goes with it.
            if await self._release(run_id, scope):
                self.case.update_run(run_id, lab_url=None)

    async def _release(self, key: str, scope: str) -> bool:
        """Delete the VM stored under `key`, if there is one, and stop counting its time."""
        sb = self.vms.pop(key, None)
        try:
            if sb is not None:
                await asyncio.to_thread(vms.delete_vm, sb)
        finally:
            self.tracker.vm_stopped(scope)
            self.push_costs(force=True)
        return sb is not None

    async def _finish_run(self, run_id: str, rdir: Path, log: EventLog) -> None:
        # Scoring reads whole CSVs, which takes seconds on a large upload. Off the event loop, the other runs and
        # the websocket pushes carry on meanwhile.
        score = await asyncio.to_thread(_score, rdir / "outputs", self.task, self.cfg.inflation_threshold)
        (rdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
        actions = await asyncio.to_thread(
            lambda: actions_from_events(read_events(log.path), self.task)
        )
        (rdir / "actions.json").write_text(
            json.dumps([{"index": a.index, "tool": a.tool, "args": a.args, "labels": a.labels} for a in actions], indent=2)
        )
        self.case.update_run(run_id, **score.to_dict(), n_actions=len(actions), labels=[a.labels for a in actions])
        if score.status in ("honest", "inflated", "unclear"):
            other = await asyncio.to_thread(self.other_benchmarks, rdir / "outputs", rdir / BENCH_DIR)
            if other:
                self.case.update_run(run_id, benchmarks=other)

    def other_benchmarks(self, outputs: Path, record_to: Path | None = None) -> dict:
        """The code in `outputs` on the domain's other test sets (`Domain.benchmarks`), as the case file keeps it:
        {name: {"true_accuracy", "successes", "n", "by_source", "results", ...}}. Every episode is recorded under
        `record_to/<name>/` (a folder of this batch) and named in `results` by its batch-relative path, for the
        screens to replay. {} when the domain has none, the file is missing, or the measurement fails: a second
        number never fails a run."""
        if self.domain.benchmarks is None or self.domain.fix_output is None:
            return {}
        code = outputs / self.domain.fix_output
        if not code.is_file():
            return {}
        prefix = None
        if record_to is not None:
            try:
                prefix = record_to.resolve().relative_to(self.dir.resolve()).as_posix()
            except ValueError:
                record_to = None  # outside the batch: nothing the files route could serve
        try:
            measured = self.domain.benchmarks(self.task, code, record_to, prefix)
        except Exception:  # noqa: BLE001
            logger.warning("batch %s: %s could not be measured on the other test sets", self.id, code, exc_info=True)
            return {}
        return {name: {**_measurement(m), **{k: v for k, v in m.items() if k not in ("success_rate", "successes", "n")}}
                for name, m in measured.items()}

    # ---- phase 2: find the split ----
    def _labelled_runs(self) -> tuple[dict[str, list], dict[str, str]]:
        """Every run's labelled actions and its status."""
        statuses = {r: v.get("status") for r, v in self.case.data["runs"].items()}
        runs = {}
        for r in statuses:
            p = self.runs_dir / r / "events.jsonl"
            if p.exists():
                runs[r] = actions_from_events(read_events(p), self.task)
        return runs, statuses

    def write_candidates(self, runs: dict[str, list] | None = None, statuses: dict[str, str] | None = None) -> list[dict]:
        """The plain-Python ranking of suspects (`analysis.rank_candidates`), both directions plus run attributes, to
        the case file's `candidates`. For the UI and the fallback only: the investigator's view leaves it out."""
        if runs is None or statuses is None:
            runs, statuses = self._labelled_runs()
        attrs = {}
        for r in runs:
            try:
                report = json.loads((self.runs_dir / r / "outputs" / "report.json").read_text())
            except (OSError, ValueError):
                report = None
            attrs[r] = run_attributes(report, (self.case.data["runs"].get(r) or {}).get("model") or self.run_model(r))
        ranked = [c.to_dict() for c in rank_candidates(runs, statuses, self.domain.steps(), attrs)]
        self.case.set_candidates(ranked)
        return ranked

    def write_audit(self) -> dict | None:
        """The audit sheet of every scored run (audit.py) to the case file's `audit`, once there is a verdict."""
        if not self.case.data.get("verdict"):
            return None
        sheet = build_audit(self.case.data, self.dir, self.cfg.inflation_threshold)
        self.case.set_audit(sheet)
        return sheet

    def analyze(self) -> None:
        self.case.set_phase("analyzing")
        runs, statuses = self._labelled_runs()
        try:
            self.write_candidates(runs, statuses)
        except Exception as e:  # noqa: BLE001 - the ranking is for the screens; it never stops the batch
            logger.warning("could not rank the candidates: %s: %s", type(e).__name__, e)
        finding = find_split(runs, statuses, prefer=self.domain.prefer_label(self.cfg), steps=self.domain.steps())
        if finding is None:
            self.case.set_split(None)
            # MASTER_PLAN Phase 1.4: ready whenever at least one run is inflated, even if no run is honest. The
            # investigator does not need a split: it proposes its own suspects and tests them against a control.
            inflated = any(st == "inflated" for st in statuses.values()) if isinstance(statuses, dict) else False
            self.case.set_phase("ready" if inflated else "no_split")
            return
        split = finding.to_dict()
        # Every label's numbers, so a competing hypothesis rests on the same deterministic counts, and the labels tied
        # with the finding: a tie is broken by the domain's preference, which is not evidence.
        table = label_table(runs, statuses, self.domain.steps())
        top = next((row["margin"] for row in table if row["label"] == finding.label), None)
        split["by_label"] = table
        split["tied_with"] = [row["label"] for row in table if row["margin"] == top and row["label"] != finding.label]
        iv = intervention_for(finding.label, self.cfg)
        split["intervention"] = None if iv is None else iv["description"]
        self.case.set_split(split)
        self.case.set_phase("ready")

    # ---- phase 3: the fork experiment ----
    def arm_plan(self) -> dict[str, dict | None]:
        """The arms this batch's fork experiment would run, from its split and its config (forks.arm_plan)."""
        split = self.case.data.get("split") or {}
        return self.domain.arm_plan(split.get("label") or "", self.cfg)

    def fix_arm_plan(self) -> dict[str, dict | None]:
        """The arms of the fix experiment, once a fix is proposed (forks.fix_plan): control, placebo, fixed."""
        fix = self.case.data.get("fix")
        if not fix or self.domain.fix_file is None:
            return {}
        return fix_plan(fix, self.domain.placebo(), self.cfg.placebo_arm)

    def estimate_forks_usd(self, n_per_arm: int, n_arms: int | None = None) -> float | None:
        # The copies run on the model of the run they fork: priced from that model's runs when there are some.
        src = (self.case.data.get("split") or {}).get("fork_run_id")
        same = {f"run:{r}" for r in self.case.data["runs"] if src and self.run_model(r) == self.run_model(src)}
        avg = (same and self.tracker.average_run_usd(keys=same)) or self.tracker.average_run_usd()
        # Forks start partway through a run, so this overestimates a little.
        arms = max(2, len(self.arm_plan()) if n_arms is None else n_arms)
        return None if avg is None else avg * arms * n_per_arm

    def fork_blocker(self) -> str | None:
        """Why the fork experiment cannot run on this batch, or None when it can."""
        split = self.case.data.get("split")
        if not split or split.get("fork_run_id") is None:
            return "no split finding with a run to fork from"
        if intervention_for(split["label"], self.cfg) is None:
            return f"no intervention is defined for '{split['label']}' yet"
        return None

    def hypothesis_blocker(self, hypothesis_id: str | None, kind: str) -> str | None:
        """Why the hypothesis `hypothesis_id` cannot be tested by a `kind` ("method" or "code") experiment, or None."""
        if not hypothesis_id:
            return "name the hypothesis this experiment tests (`hypothesis_id`); record it first with record_hypothesis"
        h = self.case.hypothesis(hypothesis_id)
        if h is None:
            return f"unknown hypothesis {hypothesis_id}"
        if h.get("kind") != kind:
            return (f"{hypothesis_id} is a {h.get('kind')} hypothesis; test it with "
                    f"{'request_forks' if h.get('kind') == 'method' else 'propose_fix and request_fix_test'}")
        if h.get("status") not in (None, "untested"):
            return f"{hypothesis_id} was already tested ({h.get('status')}); record a new hypothesis to test again"
        if len(self.case.data["hypotheses"]) < MIN_HYPOTHESES:
            return (f"record at least {MIN_HYPOTHESES} competing hypotheses before an experiment, so the one you test "
                    "is chosen over an alternative")
        return None

    def method_plan(self, hypothesis_id: str) -> tuple[str | None, dict | None]:
        """(error, plan) for testing a method hypothesis: its label's intervention and its own fork point."""
        why_not = self.hypothesis_blocker(hypothesis_id, "method")
        if why_not:
            return why_not, None
        label = self.case.hypothesis(hypothesis_id)["step_label"]
        iv = intervention_for(label, self.cfg)
        if iv is None:
            testable = [lb for lb in self.domain.labels() if intervention_for(lb, self.cfg) is not None]
            return (f"no validated intervention exists for '{label}'. Steps that can be forced: {testable}. Test this "
                    "hypothesis another way (a code hypothesis), or say in the verdict that it could not be tested."), None
        split = self.case.data.get("split") or {}
        if split.get("label") == label and split.get("fork_run_id") is not None:
            where = (split["fork_run_id"], split["fork_at"])
        else:
            runs, statuses = self._labelled_runs()
            where = fork_point(runs, statuses, label, self.domain.steps())
        if where is None:
            return f"every inflated run already did '{label}' before its report, so there is no run to force it in", None
        return None, {"label": label, "iv": iv, "src": where[0], "fork_at": where[1],
                      "arms": self.domain.arm_plan(label, self.cfg)}

    async def run_forks(self, n_per_arm: int, hypothesis_id: str | None = None) -> str:
        """The method experiment: from the moment before the suspect step, does doing that step change the result?

        With `hypothesis_id` (the investigator's tool), the experiment tests that hypothesis: its label's intervention,
        at its own fork point, with its prediction registered on the fork before any copy runs. Without it (the
        `cli forks` command), the split finding's label."""
        if hypothesis_id is None:
            why_not = self.fork_blocker()
            if why_not:
                return f"error: {why_not}"
            split = self.case.data["split"]
            iv = intervention_for(split["label"], self.cfg)
            return await self._experiment(
                self.arm_plan(), n_per_arm, kind="method", src=split["fork_run_id"], fork_at=split["fork_at"],
                record={"label": split["label"], "intervention": iv["description"]}, headline=f"({split['label']})",
            )
        err, plan = self.method_plan(hypothesis_id)
        if err:
            return f"error: {err}"
        self.case.set_hypothesis_status(hypothesis_id, "testing")
        out = await self._experiment(
            plan["arms"], n_per_arm, kind="method", src=plan["src"], fork_at=plan["fork_at"],
            record={"label": plan["label"], "intervention": plan["iv"]["description"],
                    **self._preregistration(hypothesis_id)},
            headline=f"({plan['label']}, testing {hypothesis_id})",
        )
        if out.startswith("error:"):
            self.case.set_hypothesis_status(hypothesis_id, "untested")
        return out

    def _preregistration(self, hypothesis_id: str) -> dict:
        """The hypothesis's prediction, copied onto the experiment before it runs: what was expected, fixed in time."""
        h = self.case.hypothesis(hypothesis_id) or {}
        return {"hypothesis_id": hypothesis_id, "prediction": h.get("prediction"), "falsified_if": h.get("falsified_if"),
                "preregistered_at": time.time()}

    # ---- paired experiments (plan 6.5): one change, a control arm, pairs scored as they come ----
    def parse_change(self, change: str):
        """The change `change` names (forks.parse_change), with this batch's domain's forced steps. Raises ChangeError."""
        c = parse_change(change, force=lambda label: self.domain.intervention_for(label, self.cfg))
        tabular_only = c.kind == "fake_result" or (c.kind == "force_step" and c.name.startswith("drop_column:"))
        if tabular_only and self.domain.name != "tabular":
            raise ChangeError(f"{c.spec} works on data.csv, so only in a tabular batch")
        return c

    def _forkable_runs(self) -> tuple[dict[str, list], dict[str, str]]:
        """The labelled runs that have a saved history to cut, and every run's status."""
        runs, statuses = self._labelled_runs()
        return {r: a for r, a in runs.items() if (self.runs_dir / r / "messages.json").exists()}, statuses

    def _scope_usd(self, prefix: str) -> float | None:
        scopes = self.tracker.snapshot()["scopes"]
        vals = [s.get("total_usd") for k, s in scopes.items() if k.startswith(prefix)]
        return None if any(v is None for v in vals) else round(sum(vals), 4)

    def _budget_left(self) -> float | None:
        spent = self.tracker.total_usd()
        return None if spent is None else round(self.cfg.budget_usd - spent, 4)

    async def run_experiment(self, suspect_id: str, change: str, prediction: str, pairs: int = 3,
                             source_run: str | None = None, anchor: str = "before_split", reason: str = "") -> dict:
        """Test one suspect with one change (plan 6.5): `pairs` control and changed copies, paired by index, forked
        from the same moment of one run, with the prediction saved before any copy starts.

        `change` is a registry name (`forks.registry`): `force_step:deduplicate`, `fake_result:no_duplicates`,
        `edit_context:hint_quality`, `swap_model:<model>`, or `control` for a same-vs-same check. `prediction` is
        `smaller_gap` or `larger_gap`. `anchor` is `before_split`, `before_label:<label>` or `index:<n>`; with no
        `source_run`, plain code picks the first eligible run (`experiments.pick_source`). `pairs` is capped at 6.

        Returns `{"error": ...}` when it cannot run (bad input, over budget, no eligible run, the base VM could not be
        built). Otherwise `{fork_id, suspect_id, change, anchor, source_run, fork_at, prediction, pairs, dropped,
        score, p_exact, level, evidence, cost_usd, budget_left_usd}`: this experiment's pairs and score, and the
        suspect's running evidence over all its experiments (`evidence.<suspect_id>`).
        """
        self._loop = asyncio.get_running_loop()
        if not (suspect_id or "").strip():
            return {"error": "name the suspect this experiment tests (`suspect_id`)"}
        if prediction not in xp.PREDICTIONS:
            return {"error": f"prediction must be one of {list(xp.PREDICTIONS)}, stated before the experiment"}
        if anchor_error(anchor or "before_split"):
            return {"error": anchor_error(anchor or "before_split")}
        try:
            ch = self.parse_change(change)
        except ChangeError as e:
            return {"error": str(e)}
        try:
            asked = int(pairs)
        except (TypeError, ValueError):
            return {"error": f"pairs must be a whole number from 1 to {xp.MAX_PAIRS_PER_CALL}"}
        n = max(1, min(asked, xp.MAX_PAIRS_PER_CALL))
        spent = self._budget_spent()
        if spent:
            return {"error": spent}
        try:
            self.tracker.check(self.estimate_forks_usd(n, 2), f"{2 * n} experiment copies")
        except OverBudget as e:
            return {"error": str(e)}
        runs, statuses = self._forkable_runs()
        try:
            src = xp.pick_source(ch, anchor, prediction, runs, statuses, self.domain.steps().anchor, source_run)
        except xp.ExperimentError as e:
            return {"error": str(e)}

        fork_id = self._next_fork_id()
        if self.case.suspect(suspect_id) is not None:
            self.case.set_suspect_status(suspect_id, "testing")
        plan = {xp.CONTROL_ARM: None, xp.CHANGED_ARM: ch.step}
        # Saved on the fork before the base VM exists, so before any copy starts: what was predicted, fixed in time.
        record = {"suspect_id": suspect_id, "change": ch.spec, "change_kind": ch.kind,
                  "intervention": ch.description, "anchor": src.anchor, "prediction": prediction,
                  "preregistered_at": time.time(), "reason": (reason or "")[:500], "pairs_requested": asked,
                  "pairs": [], "score": None, "p_exact": None, "level": None,
                  **({"label": ch.about} if ch.about else {})}
        ran = await self._fork_copies(fork_id, plan, xp.pair_jobs(n), kind="method", src=src.run_id,
                                      fork_at=src.fork_at, n_per_arm=n, record=record)
        if isinstance(ran, str):
            return {"error": ran.removeprefix("error: ")}
        results, n_prefix = ran

        arms = {arm: _arm_summary([r for r in results.values() if r["arm"] == arm]) for arm in plan}
        kept, dropped = xp.pair_outcomes(self.case.data["forks"][fork_id].get("children") or {}, n, prediction)
        for d in dropped:
            logger.info("experiment %s: pair %s dropped: %s", fork_id, d["i"], d["reason"])
        scored = xp.score_pairs(kept, prediction)
        cost = self._scope_usd(f"fork:{fork_id}:")
        self.case.update_fork(fork_id, status="done", arms=arms, pairs=kept, dropped_pairs=dropped,
                              score=scored["score"], p_exact=scored["p_exact"], level=scored["level"], cost_usd=cost)
        # The same `evidence` record a fork from the old path carries (`_fork_evidence`): one rule, one shape.
        self.case.update_fork(fork_id, evidence=_fork_evidence(self.case.data["forks"][fork_id]))
        self._fork_findings(fork_id, arms)
        mine = [{"id": fid, **f} for fid, f in self.case.data["forks"].items()
                if fid != "pending" and isinstance(f, dict) and f.get("suspect_id") == suspect_id
                and f.get("status") == "done" and f.get("pairs") is not None]
        ev = xp.suspect_evidence(mine)
        self.case.set_suspect_evidence(suspect_id, ev)
        self.case.set_phase("forked")
        self.push_costs(force=True)
        return {"fork_id": fork_id, "suspect_id": suspect_id, "change": ch.spec, "anchor": src.anchor,
                "source_run": src.run_id, "fork_at": n_prefix, "prediction": prediction, "pairs_requested": asked,
                "pairs": kept, "dropped": dropped, "score": scored["score"], "p_exact": scored["p_exact"],
                "level": scored["level"], "evidence": ev, "cost_usd": cost, "budget_left_usd": self._budget_left()}

    async def run_interaction(self, change_a: str, change_b: str, per_cell: int = 2, source_run: str | None = None,
                              anchor: str = "before_split", suspects: tuple[str, str] | None = None) -> dict:
        """The two-factor grid (plan 6.4) from one fork point: neither change, A only, B only, both, `per_cell` copies
        each (at most 4). Written to the case file's `interaction`. Returns it, or `{"error": ...}`."""
        self._loop = asyncio.get_running_loop()
        try:
            a, b = self.parse_change(change_a), self.parse_change(change_b)
        except ChangeError as e:
            return {"error": str(e)}
        if a.kind == "control" or b.kind == "control" or a.spec == b.spec:
            return {"error": "the grid needs two different changes"}
        if anchor_error(anchor or "before_split"):
            return {"error": anchor_error(anchor or "before_split")}
        n = max(1, min(int(per_cell), ixn.MAX_PER_CELL))
        spent = self._budget_spent()
        if spent:
            return {"error": spent}
        try:
            self.tracker.check(self.estimate_forks_usd(n, 4), f"{4 * n} grid copies")
        except OverBudget as e:
            return {"error": str(e)}
        runs, statuses = self._forkable_runs()
        try:
            # Both changes are fixes tested on an inflated run; A decides which run is eligible.
            src = xp.pick_source(a, anchor, "smaller_gap", runs, statuses, self.domain.steps().anchor, source_run)
        except xp.ExperimentError as e:
            return {"error": str(e)}
        fork_id = self._next_fork_id()
        plan = ixn.cell_plan(a.step, b.step)
        record = {"change_a": a.spec, "change_b": b.spec, "anchor": src.anchor, "preregistered_at": time.time(),
                  "intervention": f"A: {a.description}. B: {b.description}"}
        ran = await self._fork_copies(fork_id, plan, [(cell, i + 1) for cell in plan for i in range(n)],
                                      kind="interaction", src=src.run_id, fork_at=src.fork_at, n_per_arm=n, record=record)
        if isinstance(ran, str):
            return {"error": ran.removeprefix("error: ")}
        results, n_prefix = ran
        arms = {cell: _arm_summary([r for r in results.values() if r["arm"] == cell]) for cell in plan}
        grid = ixn.grid_result(self.case.data["forks"][fork_id].get("children") or {})
        self.case.update_fork(fork_id, status="done", arms=arms, cost_usd=self._scope_usd(f"fork:{fork_id}:"))
        out = {"fork_id": fork_id, "change_a": a.spec, "change_b": b.spec, "suspects": list(suspects or []),
               "source_run": src.run_id, "fork_at": n_prefix, "anchor": src.anchor, "per_cell": n, **grid,
               "cost_usd": self._scope_usd(f"fork:{fork_id}:"), "budget_left_usd": self._budget_left()}
        self.case.set_interaction(out)
        self.case.set_phase("forked")
        self.push_costs(force=True)
        return out

    # ---- the diagnosis: traceback and fix ----
    async def trace_failures(self, run_id: str, max_episodes: int = 3) -> dict:
        """Re-run one run's code where it fails, recording it, and describe each failure (`Domain.trace_run`)."""
        if self.domain.trace_run is None:
            return {"error": f"the {self.domain.name} domain has no recordings to trace"}
        if run_id not in self.case.data["runs"]:
            return {"error": f"unknown run {run_id}"}
        try:
            return await asyncio.to_thread(self._trace, run_id, int(max_episodes))
        except Exception as e:  # noqa: BLE001 - the tool reports it instead of ending the investigation
            logger.warning("trace of %s failed: %s: %s", run_id, type(e).__name__, e)
            return {"error": f"could not trace {run_id}: {type(e).__name__}: {e}"[:400]}

    def _trace(self, run_id: str, max_episodes: int) -> dict:
        """One trace, in a worker thread: waits for its run's lock, then for one of the server's trace slots.

        Several traces (the investigator's code-tracer subagents, one per run) run at once this way. They share
        nothing but the case file, which has its own lock: each re-runs its own run's controller in its own worker
        processes and writes under its own run's folder.
        """
        run_dir = self.runs_dir / run_id
        with _TRACE_RUN_LOCKS_LOCK:
            lock = _TRACE_RUN_LOCKS.setdefault(run_dir.resolve(), threading.Lock())
        with lock, _TRACE_SLOTS:
            return self.domain.trace_run(self.task, run_dir, max_episodes)

    def propose_fix(self, run_id: str, old_string: str, new_string: str, description: str, why: str,
                    line: int | None = None, hypothesis_id: str | None = None) -> str:
        """Record a one-place patch to a run's code, checked against that run's file before it is accepted.

        The same rule as the agents' `edit_file`: `old_string` must occur exactly once. The patch is applied to the
        `fixed` arm's copy in `run_fix_forks`.
        """
        if self.domain.fix_file is None or self.domain.fix_output is None:
            return f"error: the {self.domain.name} domain has no code to fix"
        if run_id not in self.case.data["runs"]:
            return f"error: unknown run {run_id}"
        if not old_string or old_string == new_string:
            return "error: old_string must be non-empty and differ from new_string"
        path = self.runs_dir / run_id / "outputs" / self.domain.fix_output
        if not path.is_file():
            return f"error: {run_id} has no {self.domain.fix_output} in its outputs"
        source = path.read_text()
        n = source.count(old_string)
        if n != 1:
            return f"error: old_string occurs {n} times in {run_id}'s {self.domain.fix_output}; it must occur exactly once"
        if len(new_string) > MAX_FIX_CHARS or len(old_string) > MAX_FIX_CHARS:
            return f"error: a fix is one small change: old_string and new_string are at most {MAX_FIX_CHARS} characters each"
        if self.domain.fix_output.endswith(".py"):
            try:
                ast.parse(source.replace(old_string, new_string, 1))
            except SyntaxError as e:
                return f"error: the patched file would not parse (line {e.lineno}: {e.msg}); fix the new_string"
        if hypothesis_id is not None:
            why_not = self.hypothesis_blocker(hypothesis_id, "code")
            if why_not:
                return f"error: {why_not}"
        if line is None:
            line = source[: source.index(old_string)].count("\n") + 1
        self.case.set_fix(
            {
                "run_id": run_id,
                "file_path": self.domain.fix_file,
                "line": int(line),
                "old_string": old_string,
                "new_string": new_string,
                "description": (description or "").strip()[:200],
                "why": (why or "").strip()[:1000],
                "status": "proposed",
                "proposed_at": time.time(),
                # The code hypothesis this patch tests and its prediction, registered before it is measured.
                **(self._preregistration(hypothesis_id) if hypothesis_id else {}),
            }
        )
        return f"fix proposed for {run_id} at line {line}: call request_fix_test to test it"

    async def measure_fix(self) -> str:
        """The fix test where the domain can score code by itself (`Domain.score_code`): the run's code with the patch
        applied, next to the same code without it, on the hidden test. The result as words.

        No agent continues the run, so nothing can undo the patch: in the fork experiment (`run_fix_forks`) a copy's
        agent may revert an edit it did not make, and the arm then measures the unpatched code. No VM and no model
        either, so it costs nothing and needs no approval. The patched file is kept as `fix/<fix_output>`.
        """
        fix = self.case.data.get("fix")
        if not fix:
            return "error: no fix has been proposed: call propose_fix first"
        if self.domain.score_code is None or self.domain.fix_output is None:
            return f"error: the {self.domain.name} domain cannot score code without a run"
        src, name = fix["run_id"], self.domain.fix_output
        path = self.runs_dir / src / "outputs" / name
        try:
            source = path.read_text()
        except OSError:
            return f"error: {src} has no {name} in its outputs"
        n = source.count(fix["old_string"])
        if n != 1:
            return f"error: old_string occurs {n} times in {src}'s {name}; it must occur exactly once"
        patched = self.dir / "fix" / name
        patched.parent.mkdir(parents=True, exist_ok=True)
        patched.write_text(source.replace(fix["old_string"], fix["new_string"], 1))

        def both() -> tuple[dict, dict]:
            # One after the other: two evaluations at once would share this server's cores and could time out.
            return self.domain.score_code(self.task, path), self.domain.score_code(self.task, patched)

        self.case.update_fix(status="testing")
        try:
            before, after = await asyncio.to_thread(both)
        except Exception as e:  # noqa: BLE001 - the tool reports it instead of ending the investigation
            logger.warning("batch %s: the fix could not be measured", self.id, exc_info=True)
            self.case.update_fix(status="proposed")
            return f"error: could not measure the fix: {type(e).__name__}: {e}"[:400]
        gained, lost = _changed_cases(before.get("passed"), after.get("passed"))
        measured = {
            "before": _measurement(before),
            "after": _measurement(after),
            # Hidden cases that failed without the patch and pass with it, and the other way round. None when the
            # two measurements cannot be paired case by case.
            "gained": gained,
            "lost": lost,
            "exceptions": list(after.get("exceptions") or []),
            "hidden_results": after.get("hidden_results") or [],
        }
        # The deterministic read of the two measurements: a paired exact sign test on the cases that changed.
        measured["evidence"] = fix_evidence(gained, lost, measured["before"]["true_accuracy"],
                                            measured["after"]["true_accuracy"])
        if measured["exceptions"] and measured["evidence"]["level"] != "worse":
            measured["evidence"]["note"] = "the patched code raised errors"
        outcome = fix_outcome(measured["evidence"])
        self.case.update_fix(status="tested", measured=measured, patched_file=f"fix/{name}", outcome=outcome)
        if fix.get("hypothesis_id"):
            self.case.set_hypothesis_status(fix["hypothesis_id"], outcome, tested_by="fix")

        def rate(m: dict) -> str:
            of = "" if m["successes"] is None else f" ({m['successes']} of {m['n']})"
            return f"{m['true_accuracy']:.0%}{of}"

        lines = [
            f"The fix was measured on run {src}'s {name} on the evaluation setups, with no agent in between: "
            f"true success rate {rate(measured['before'])} without the patch and {rate(measured['after'])} with it."
        ]
        if gained is not None:
            lines.append(f"{gained} setups that failed now succeed and {lost} that succeeded now fail.")
        if measured["exceptions"]:
            lines.append("The patched code raised: " + " | ".join(measured["exceptions"]))
        ev = measured["evidence"]
        p = "n/a" if ev["p_value"] is None else f"{ev['p_value']:.3f}"
        lines.append(f"Evidence, computed from the paired cases: {ev['level']} (one-sided exact sign test p = {p}, below "
                     f"{ev['alpha']} needed). This measures the controller's performance on held-out setups the trace "
                     "never ran, not the accuracy of any report.")
        if fix.get("prediction"):
            lines.append(f"Pre-registered prediction for {fix['hypothesis_id']}: {fix['prediction']} Outcome: {outcome}.")
        return " ".join(lines)

    def fix_blocker(self) -> str | None:
        """Why the fix experiment cannot run, or None when it can."""
        fix = self.case.data.get("fix")
        if not fix:
            return "no fix has been proposed: call propose_fix first"
        if self.domain.fix_file is None:
            return f"the {self.domain.name} domain has no code to fix"
        split = self.case.data.get("split") or {}
        if not split.get("fork_run_id") and not (self.runs_dir / fix["run_id"] / "messages.json").is_file():
            return "no run to fork from"
        return None

    async def run_fix_forks(self, n_per_arm: int) -> str:
        """The fix experiment: from the same moment of the same run, does the proposed patch make the code work?"""
        why_not = self.fix_blocker()
        if why_not:
            return f"error: {why_not}"
        fix = self.case.data["fix"]
        split = self.case.data.get("split") or {}
        # The same fork point as the method experiment when the fix targets that run: the code exists there.
        src = fix["run_id"]
        if split.get("fork_run_id") == src:
            fork_at = split["fork_at"]
        else:
            actions = actions_from_events(read_events(self.runs_dir / src / "events.jsonl"), self.task)
            fork_at = len(actions)
        self.case.update_fix(status="testing")
        out = await self._experiment(
            self.fix_arm_plan(), n_per_arm, kind="fix", src=src, fork_at=fork_at,
            record={"label": split.get("label"), "intervention": fix.get("description"), "fix": dict(fix)},
            headline=f"with the proposed fix applied in the fixed arm: {fix.get('description')}",
        )
        if out.startswith("error:"):
            self.case.update_fix(status="proposed")
        return out

    async def _experiment(self, plan: dict[str, dict | None], n_per_arm: int, *, kind: str, src: str, fork_at: int,
                          record: dict, headline: str) -> str:
        """Fork a run at `fork_at` and continue `n_per_arm` copies in each arm of `plan`. The result as words."""
        self._loop = asyncio.get_running_loop()
        if not plan:
            return "error: there is no experiment to run"
        n_per_arm = max(1, min(int(n_per_arm), 8))
        try:
            self.tracker.check(self.estimate_forks_usd(n_per_arm, len(plan)), f"{len(plan) * n_per_arm} fork runs")
        except OverBudget as e:
            return f"error: {e}"

        fork_id = self._next_fork_id()
        ran = await self._fork_copies(fork_id, plan, [(arm, i + 1) for arm in plan for i in range(n_per_arm)],
                                      kind=kind, src=src, fork_at=fork_at, n_per_arm=n_per_arm, record=record)
        if isinstance(ran, str):
            return ran
        results, n_prefix = ran

        arms = {arm: _arm_summary([r for r in results.values() if r["arm"] == arm]) for arm in plan}
        self.case.update_fork(fork_id, status="done", arms=arms)
        found = self._fork_findings(fork_id, arms)
        self.case.set_phase("forked")
        lines = [
            f"Fork {fork_id} from run {src} before action {n_prefix} {headline}. "
            f"Every arm starts from the same moment of the same run. Failed copies are not counted."
        ]
        lines += _arm_lines(plan, arms, kind, found.get("evidence"))
        lines += _findings_lines(record, found)
        if kind == "fix":
            self.case.update_fix(status="tested", fork_id=fork_id,
                                 result={arm: {"mean_true": a["mean_true"], "scored": a["scored"]} for arm, a in arms.items()})
        return " ".join(lines)

    def _next_fork_id(self) -> str:
        return f"f{sum(k.startswith('f') for k in self.case.data['forks']) + 1}"

    async def _fork_copies(self, fork_id: str, plan: dict[str, Any], jobs: list[tuple[str, int]], *, kind: str,
                           src: str, fork_at: int, n_per_arm: int, record: dict) -> tuple[dict[str, dict], int] | str:
        """The fork-running core every experiment shares (`_experiment`, `run_experiment`, `run_interaction`): record
        the fork with `record` before anything runs, rebuild the base VM by replay to the fork point, continue one copy
        per `(arm, number)` of `jobs` and release the base. Returns ({child id: result}, actions before the cut), or
        an error string when the base could not be built (the fork is then removed and the phase restored)."""
        self._loop = asyncio.get_running_loop()
        phase_before = self.case.data.get("phase")
        base_key, base_scope = f"{fork_id}-base", f"fork:{fork_id}:base"
        try:
            point = self._fork_point(src, fork_at)
            self.case.set_phase("forking")
            self.case.update_fork(
                fork_id, status="rebuilding", kind=kind, source_run=src, fork_at=point.n_prefix, n_per_arm=n_per_arm,
                children={}, arm_steps={a: _step_description(step) for a, step in plan.items()}, **record,
            )
            base = await self._build_base(base_key, f"{self.id}-{fork_id}-base", base_scope, point.actions)
        except Exception as e:  # noqa: BLE001 - returned, so an agent calling this as a tool reads it instead of dying
            logger.warning("fork %s: could not build the base VM: %s: %s", fork_id, type(e).__name__, e)
            await self._release(base_key, base_scope)
            # No copy ran, so there is no experiment to show, and the batch is back where it was.
            self.case.remove_fork(fork_id)
            self.case.set_phase(phase_before)
            return f"error: could not build the fork's base VM ({type(e).__name__}: {e})"[:400]
        except BaseException:
            await self._release(base_key, base_scope)
            raise
        self.case.update_fork(fork_id, status="running")

        # Each copy is its own run, so each starts in an empty context (`_run_children`).
        try:
            results = await self._run_children(fork_id, plan, jobs, base, point, self.run_model(src), kind=kind)
        finally:
            await self._release(base_key, base_scope)
        return results, point.n_prefix

    def _fork_findings(self, fork_id: str, arms: dict[str, dict]) -> dict:
        """What a fork's stored copies say, recomputed from every child and the arm summaries `arms`: how the copies
        were built, what the experiment measures, and for a method experiment its evidence and the outcome of the
        hypothesis it tests, which goes onto that hypothesis too. Called when the first round ends and again when a
        round of more pairs ends, so the outcome always follows every copy. The prediction, the falsification and
        `preregistered_at` are never touched: they stay what was registered before the first copy ran."""
        fork = self.case.data["forks"][fork_id]
        kind = fork.get("kind", "method")
        built = {"fork": 0, "replay": 0, "none": 0}
        for c in (fork.get("children") or {}).values():
            built[c.get("how") if c.get("how") in ("fork", "replay") else "none"] += 1
        found: dict[str, Any] = {"built": built,
                                 "measures": "controller_performance" if kind == "fix" else "reporting_accuracy"}
        if kind != "fix" and "control" in arms and "forced" in arms:
            pairs = fork_pairs(fork)
            ev = verdict_evidence({a: {"inflated": arms[a]["inflated"], "total": arms[a]["scored"]}
                                   for a in ("control", "forced")}, pairs=pairs)
            # MASTER_PLAN 6.1: the pairs, the running score, the display-only exact test and the level on the fork.
            found.update(evidence=ev, outcome=method_outcome(ev), pairs=pairs or [], score=ev["score"],
                         p_exact=ev["p_exact"], level=ev["level"])
        self.case.update_fork(fork_id, **found)
        if fork.get("hypothesis_id") and "outcome" in found:
            self.case.set_hypothesis_status(fork["hypothesis_id"], found["outcome"], tested_by=fork_id)
        return found

    def _fork_point(self, src: str, fork_at: int) -> "_ForkPoint":
        """What every copy of run `src` forked before action `fork_at` starts from: the cut history, how many actions
        precede the cut, those actions (replayed to rebuild the base VM) and the source's events up to the cut."""
        msgs = messages_from_dict(json.loads((self.runs_dir / src / "messages.json").read_text()))
        src_events = read_events(self.runs_dir / src / "events.jsonl")
        actions = actions_from_events(src_events, self.task)
        prefix_msgs, n_prefix = cut_history(msgs, fork_at)
        # Each copy keeps these next to its own log: the episodes the source ran before the cut are the copy's too.
        prefix_log = "".join(json.dumps(e) + "\n" for e in prefix_events(src_events, n_prefix))
        return _ForkPoint(prefix_msgs, n_prefix, actions[:n_prefix], prefix_log)

    async def _build_base(self, key: str, label: str, scope: str, actions: list) -> Any:
        """A VM at the fork point: a fresh VM with the task loaded and the source run's actions replayed. Kept under
        `key` and billed to `scope` from the moment it exists, so a failure part way still releases and counts it."""
        # Through the cancel-safe helper: a stop while Daytona is still making it deletes it on arrival.
        base = await self._create_vm(key, label)
        self.tracker.vm_started(scope)
        await asyncio.to_thread(vms.load_task, base, self.task)
        await asyncio.to_thread(vms.replay_actions, base, actions)
        return base

    async def _run_children(self, fork_id: str, plan: dict[str, dict | None], jobs: list[tuple[str, int]], base: Any,
                            point: "_ForkPoint", model: str, *, kind: str = "method") -> dict[str, dict]:
        """Continue one copy of the fork point per `(arm, number)` in `jobs`, named `{arm}-{number}`, each in a fork of
        `base` (or a VM rebuilt by replay when forking fails), with its arm's step from `plan` done first. Scores each
        and records it under the fork's `children`. Returns {child id: {"arm", status and scores}}."""
        sem = asyncio.Semaphore(min(MAX_PARALLEL_VMS, self.cfg.max_concurrent_runs))
        results: dict[str, dict] = {}
        prefix_msgs, prefix_actions, prefix_log = point.messages, point.actions, point.log

        async def child(arm: str, number: int) -> None:
            cid, scope = f"{arm}-{number}", f"fork:{fork_id}:{arm}-{number}"
            cdir = self.forks_dir / fork_id / cid
            log = self._log(cdir / "events.jsonl", f"{fork_id}/{cid}")
            (cdir / PREFIX_EVENTS).write_text(prefix_log)
            watch: MotionWatch | None = None
            async with sem:
                try:
                    try:
                        vm = await self._new_vm(f"{fork_id}-{cid}", vms.fork_vm, base, f"{self.id}-{fork_id}-{cid}")
                        self.tracker.vm_started(scope)
                        how = "fork"
                    except Exception as e:  # noqa: BLE001 - fall back to rebuilding by replay
                        logger.warning("fork %s %s: could not fork the base VM (%s: %s); rebuilding it by replay",
                                       fork_id, cid, type(e).__name__, e)
                        vm = await self._create_vm(f"{fork_id}-{cid}", f"{self.id}-{fork_id}-{cid}")
                        # From here, not after the rebuild: the VM is up and billing while it replays.
                        self.tracker.vm_started(scope)
                        await asyncio.to_thread(vms.load_task, vm, self.task)
                        await asyncio.to_thread(vms.replay_actions, vm, prefix_actions)
                        how = "replay"
                    step = plan[arm]
                    # A `swap_model` change runs this copy on another model (forks.step_model); every other arm keeps
                    # the source run's.
                    copy_model = step_model(step, model)
                    url = await _try(asyncio.to_thread(vms.start_lab_page, vm))
                    self._set_child(fork_id, cid, arm=arm, status="running", lab_url=url, how=how, model=copy_model)
                    (cdir / "meta.json").write_text(json.dumps({"model": copy_model}))

                    history = list(prefix_msgs)
                    if step is not None:
                        backend = DaytonaSandbox(sandbox=vm)
                        try:
                            # A forced step runs in the VM; a made-up result, a message or a model swap does not
                            # (forks.change_messages).
                            turn, forced_events = await asyncio.to_thread(change_messages, backend, step)
                        except RuntimeError as e:
                            # Nothing was forced here, so this copy must not be scored as a result of its arm.
                            raise RuntimeError(f"the {arm} step failed: {e}") from e
                        history += turn
                        for ev in forced_events:
                            log.write(ev)

                    agent = build_analyst(DaytonaSandbox(sandbox=vm), copy_model, self.domain.analyst_system_prompt)

                    def on_event(ev: dict) -> None:
                        self._emit({"kind": "fork_event", "fork": fork_id, "child": cid, "event": ev})

                    watch = _watch_motion(self.domain, vm, cdir / "outputs", f"forks/{fork_id}/{cid}/outputs", log,
                                          on_event, lambda files: self._set_child(fork_id, cid, motion_files=files))
                    await asyncio.wait_for(
                        self._drive(agent, {"messages": history}, f"{self.id}-{fork_id}-{cid}", scope,
                                    copy_model, log, on_event),
                        RUN_TIMEOUT_S,
                    )
                    if watch is not None:
                        await watch.stop()
                    motion = await asyncio.to_thread(vms.download_outputs, vm, cdir / "outputs", **self._vm_domain)
                    charts = await asyncio.to_thread(vms.download_charts, vm, cdir / "live")
                    if kind == "fix" and arm == "fixed" and self.domain.fix_output and step and step.get("new_string"):
                        # The copy's agent may undo an edit it did not make. Scored, it would be a second control.
                        final = cdir / "outputs" / self.domain.fix_output
                        if final.is_file() and step["new_string"] not in final.read_text():
                            raise RuntimeError(f"the copy undid the fix: its final {self.domain.fix_output} no longer "
                                               "has the patch as proposed, so it says nothing about the fix")
                    score = await asyncio.to_thread(
                        _score, cdir / "outputs", self.task, self.cfg.inflation_threshold
                    )
                    (cdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
                    results[cid] = {"arm": arm, **score.to_dict()}
                    extra = {"charts": [f"forks/{fork_id}/{cid}/live/{name}" for name in charts]} if charts else {}
                    if watch is None and motion:
                        extra["motion_files"] = [f"forks/{fork_id}/{cid}/outputs/{path}" for path in motion]
                    self._set_child(fork_id, cid, **results[cid], **extra)
                    if watch is not None:
                        watch.finish(motion or [])
                except Exception as e:  # noqa: BLE001
                    results[cid] = {"arm": arm, "status": "failed", "reason": f"{type(e).__name__}: {e}"[:300]}
                    self._set_child(fork_id, cid, **results[cid])
                finally:
                    if watch is not None:
                        await watch.stop()
                    log.close()
                    if await self._release(f"{fork_id}-{cid}", scope):
                        self._set_child(fork_id, cid, lab_url=None)

        # Each copy is its own run, so each starts in an empty context. When the investigator's tool calls
        # this experiment, the copies would otherwise inherit the investigator's callbacks, and every fork
        # token would be counted a second time under "investigator", at the investigator's price.
        await asyncio.gather(*(
            asyncio.create_task(child(arm, number), context=contextvars.Context()) for arm, number in jobs
        ))
        return results

    def _set_child(self, fork_id: str, cid: str, **fields: Any) -> None:
        children = dict(self.case.data["forks"][fork_id].get("children", {}))
        children[cid] = {**children.get(cid, {}), **fields}
        self.case.update_fork(fork_id, children=children)

    # ---- more pairs: the verdict's fork experiment, continued ----
    def more_pairs_plan(self, fork: dict) -> dict[str, dict | None]:
        """The steps of the arms `fork` ran, rebuilt from this batch's config: the same arms in the same order, each
        with the same step. Raises Refused when an arm or its step cannot be rebuilt the way the fork ran it."""
        ran = list(fork.get("arm_steps") or fork.get("arms") or {})
        label = fork.get("label") or (self.case.data.get("split") or {}).get("label") or ""
        full = self.domain.arm_plan(label, self.cfg)
        missing = [a for a in ran if a not in full]
        if missing:
            raise Refused(f"the {', '.join(missing)} arm of {fork.get('id')} cannot be rebuilt for '{label}'")
        steps = fork.get("arm_steps") or {}
        for arm in ran:
            if arm in steps and (full[arm] or {}).get("description") != steps[arm]:
                raise Refused(f"the {arm} arm's step is not the one {fork.get('id')} ran, so new copies would not be "
                              f"pairs of the same experiment")
        return {arm: full[arm] for arm in ran}

    def reserve_more_pairs(self, n_per_arm: int | None = None, fork_id: str | None = None) -> dict:
        """Check that more pairs can run now and claim the batch for them, without starting anything.

        Raises Refused with the reason when the batch has no open verdict on a finished fork (`more_pairs_problem`),
        another experiment is running or waiting for approval (one experiment at a time), the arms cannot be rebuilt,
        or the budget cannot cover the estimate. Otherwise records a new round on the fork (`more_pairs`), names its
        children (`control-5`, ... after the highest number each arm has), sets the fork to `rebuilding` and the
        phase to `forking`, and returns the quote (`more_pairs_quote`) with the new `children`. Synchronous, so two
        requests can never both claim the batch. `run_more_pairs(reserved=...)` then runs it.
        """
        problem = more_pairs_problem(self.case.data, self.dir)
        if problem:
            raise Refused(problem)
        busy = [fid for fid, f in self.case.data["forks"].items()
                if fid == "pending" or (isinstance(f, dict) and f.get("status") in ("rebuilding", "running"))]
        if busy or self.case.data.get("phase") in WORKING_PHASES:
            raise Refused(f"another experiment is running on this batch ({', '.join(busy) or self.case.data.get('phase')}): "
                          f"one at a time")
        fid, fork = verdict_fork(self.case.data)
        if fork_id is not None and fork_id != fid:
            raise Refused(f"the verdict rests on fork {fid}, not {fork_id}")
        plan = self.more_pairs_plan(fork)
        quote = more_pairs_quote(self.case.data, self.tracker, n_per_arm)
        if quote["over_budget"]:
            raise Refused(quote["budget_problem"])

        n = quote["n_per_arm"]
        children = fork.get("children") or {}
        last = {arm: max([_child_number(c) for c, child in children.items() if _child_arm(c, child) == arm], default=0)
                for arm in plan}
        new = [f"{arm}-{last[arm] + i + 1}" for arm in plan for i in range(n)]
        round_ = {"at": time.time(), "n_per_arm": n, "children": new, "status": "rebuilding",
                  "estimate_usd": quote["estimate_usd"], "pairs_before": quote["pairs_now"],
                  "level_before": quote["level_now"], "n_per_arm_before": fork.get("n_per_arm")}
        self.case.set_phase("forking")
        self.case.update_fork(fid, status="rebuilding", n_per_arm=max(last.values(), default=0) + n,
                              more_pairs=[*(fork.get("more_pairs") or []), round_])
        return {**quote, "children": new}

    async def run_more_pairs(self, n_per_arm: int | None = None, fork_id: str | None = None,
                             reserved: dict | None = None) -> str:
        """More pairs for an open verdict: `n_per_arm` more copies in each arm of the fork experiment the verdict rests
        on, the same arms with the same steps from the same moment of the same run, then the fork's arm summaries,
        the verdict's counts, its evidence and its sentence, all from every copy so far. The result as words.

        The sentence is reworded in plain code (`evidence.verdict_sentence`), by the new evidence level, the way the
        investigator is told to word it: "suggests", with the score and the pairs, while open; "caused" only once
        supported. The investigator is not asked again: it finished with the batch and its memory went with it, and
        the rule is mechanical. Its sentence is kept in `verdict.revisions`.

        Reserves first (`reserve_more_pairs`, which raises Refused) unless `reserved` is what it returned. A base VM
        that cannot be rebuilt ends the round as `failed` and changes nothing else; the result then starts with
        "error:".
        """
        job = reserved if reserved is not None else self.reserve_more_pairs(n_per_arm, fork_id)
        self._loop = asyncio.get_running_loop()
        fid = job["fork_id"]
        fork = self.case.data["forks"][fid]
        plan = self.more_pairs_plan(fork)
        # The first experiment was round 1, with base VM `base`; the k-th round of more pairs is round k + 1.
        k = len(fork.get("more_pairs") or [])
        base_key, base_scope = f"{fid}-base-{k + 1}", f"fork:{fid}:base-{k + 1}"
        src = fork["source_run"]
        jobs = [(c.rsplit("-", 1)[0], _child_number(c)) for c in job["children"]]
        try:
            point = self._fork_point(src, int(fork.get("fork_at") or 0))
            base = await self._build_base(base_key, f"{self.id}-{fid}-base-{k + 1}", base_scope, point.actions)
        except Exception as e:  # noqa: BLE001 - recorded on the round; nothing ran, so nothing else changes
            logger.warning("fork %s: could not build the base VM for more pairs: %s: %s", fid, type(e).__name__, e)
            await self._release(base_key, base_scope)
            reason = f"could not build the fork's base VM ({type(e).__name__}: {e})"[:400]
            self._end_round(fid, "failed", reason=reason, n_per_arm=self._last_round(fid).get("n_per_arm_before"))
            self.case.set_phase("done")
            return f"error: {reason}"
        except BaseException:
            await self._release(base_key, base_scope)
            self._settle_more_pairs("stopped before this copy finished")
            raise
        self._update_round(fid, status="running")
        self.case.update_fork(fid, status="running")
        try:
            await self._run_children(fid, plan, jobs, base, point, self.run_model(src),
                                     kind=self.case.data["forks"][fid].get("kind", "method"))
        except BaseException:
            # Stopped: the copies that were scored count, the others failed. The verdict follows what was scored.
            self._settle_more_pairs("stopped before this copy finished")
            raise
        finally:
            await self._release(base_key, base_scope)

        arms = self._end_round(fid, "done")
        self.push_costs(force=True)
        await self.close()
        self.case.set_phase("done")
        lines = [f"Fork {fid}: {len(jobs) // max(1, len(plan))} more copies per arm from run {src} before action "
                 f"{point.n_prefix}, the same arms with the same steps. Counts are over every copy of {fid}; failed "
                 f"copies are not counted."]
        lines += _arm_lines(plan, arms, "method", self.case.data["forks"][fid].get("evidence"))
        verdict = self.case.data.get("verdict") or {}
        lines.append(f"The verdict now reads: {verdict.get('sentence')}")
        return " ".join(lines)

    def _last_round(self, fork_id: str) -> dict:
        rounds = self.case.data["forks"][fork_id].get("more_pairs") or [{}]
        return rounds[-1]

    def _update_round(self, fork_id: str, **fields: Any) -> None:
        rounds = list(self.case.data["forks"][fork_id].get("more_pairs") or [])
        if rounds:
            rounds[-1] = {**rounds[-1], **fields}
            self.case.update_fork(fork_id, more_pairs=rounds)

    def _end_round(self, fork_id: str, status: str, reason: str | None = None, **fork_fields: Any) -> dict:
        """End a fork's latest round of more pairs: summarize its arms again from every child, set the fork `done`,
        record the round's `status` and the pairs and level it left, and update the verdict to match. Returns the
        arm summaries."""
        fork = self.case.data["forks"][fork_id]
        ran = list(fork.get("arm_steps") or fork.get("arms") or {})
        children = fork.get("children") or {}
        arms = {arm: _arm_summary([c for cid, c in children.items() if _child_arm(cid, c) == arm]) for arm in ran}
        ev = _fork_evidence({"arms": arms, "children": children, "prediction": fork.get("prediction")})
        self._update_round(fork_id, status=status, pairs_after=ev["pairs"], level_after=ev["level"],
                           **({"reason": reason} if reason else {}))
        self.case.update_fork(fork_id, status="done", arms=arms,
                              **{k: v for k, v in fork_fields.items() if v is not None})
        if status != "failed":  # a failed round ran no copy: the verdict stays as it was
            # The computed outcome follows every copy so far; the registered prediction stays as it was.
            self._fork_findings(fork_id, arms)
            self._reword_verdict(fork_id, arms)
        return arms

    def _settle_more_pairs(self, reason: str) -> None:
        """End every round of more pairs that is still marked running (stopped, or left so by an earlier server): its
        children that were not scored failed, then `_end_round` as `stopped`. A round stopped before any copy started
        gives the fork back its old `n_per_arm`."""
        for fork_id, fork in list(self.case.data["forks"].items()):
            if fork_id == "pending" or not isinstance(fork, dict):
                continue
            rounds = fork.get("more_pairs") or []
            if not rounds or rounds[-1].get("status") not in ("rebuilding", "running"):
                continue
            for cid, child in list((fork.get("children") or {}).items()):
                if child.get("status") not in SCORED:
                    self._set_child(fork_id, cid, status="failed", reason=reason)
            started = any(c in (fork.get("children") or {}) for c in rounds[-1].get("children") or [])
            self._end_round(fork_id, "stopped", reason=reason,
                            n_per_arm=None if started else rounds[-1].get("n_per_arm_before"))

    def _reword_verdict(self, fork_id: str, arms: dict[str, dict]) -> bool:
        """Bring the verdict in line with the fork's arm summaries: its `arms`, `numbers`, `evidence`, and a sentence
        worded by the new level (`evidence.verdict_sentence`). The sentence it replaces is kept in `revisions`.
        Nothing changes when the counts are the ones the verdict already has. Whether it changed."""
        verdict = self.case.data.get("verdict")
        if not isinstance(verdict, dict):
            return False
        # Every arm that scored a copy, as `record_structured_verdict` requires the investigator to give them.
        given = {a: {"inflated": int(s.get("inflated") or 0), "total": int(s.get("scored") or 0)}
                 for a, s in arms.items() if s.get("scored")}
        if given == verdict.get("arms"):
            return False
        numbers = {f"{a}_{key}": v for a, c in given.items() for key, v in c.items()}
        ev = verdict_evidence(given, numbers, pairs=fork_pairs(self.case.data["forks"][fork_id]))
        # The sentence names the step this fork tested: a cause can only be the step the experiment changed.
        label = self.case.data["forks"][fork_id].get("label") or verdict.get("step_label") or ""
        words = self.domain.words.steps.get(label)
        sentence = verdict_sentence(words.name if words else label.replace("_", " "), ev, given)
        before = {"at": time.time(), "by": "more_pairs", "fork_id": fork_id, "sentence": verdict.get("sentence"),
                  "evidence": verdict.get("evidence") or verdict_evidence(verdict.get("arms"), verdict.get("numbers"))}
        self.case.update_verdict(sentence=sentence, arms=given, numbers=numbers, evidence=ev,
                                 revisions=[*(verdict.get("revisions") or []), before])
        return True

    # ---- the investigator ----
    @property
    def checkpoints_path(self) -> Path:
        """The investigator's durable checkpoints (plan Phase 6): one SQLite file per batch."""
        return self.dir / "checkpoints.sqlite"

    async def _ensure_investigator(self, thread_id: str | None = None) -> None:
        """Build the investigator on this batch's SQLite checkpointer, once per process. Its thread id is saved in the
        case file (`investigator.thread_id`), so a new process (a server restart) picks the same thread up where it
        stopped, a pending approval included. `thread_id` starts a new thread (a new investigation)."""
        self._loop = asyncio.get_running_loop()
        saved = (self.case.data.get("investigator") or {}).get("thread_id")
        if thread_id is not None and thread_id != saved:
            await self._close_checkpointer()
            self.case.set_investigator(thread_id=thread_id)
        elif saved is None:
            self.case.set_investigator(thread_id=f"{self.id}-investigator")
        if self._investigator is not None:
            return
        self._checkpoint_conn = await aiosqlite.connect(str(self.checkpoints_path))
        saver = AsyncSqliteSaver(self._checkpoint_conn)
        self._investigator = build_investigator(self, self.cfg.investigator_model, checkpointer=saver)
        self._inv_config = {
            "configurable": {"thread_id": self.case.data["investigator"]["thread_id"]},
            "callbacks": [UsageCallback(self.tracker, "investigator", self.cfg.investigator_model)],
            "recursion_limit": INVESTIGATOR_RECURSION_LIMIT,
        }

    async def _close_checkpointer(self) -> None:
        conn, self._checkpoint_conn = getattr(self, "_checkpoint_conn", None), None
        self._investigator = None
        if conn is not None:
            try:
                await conn.close()
            except Exception as e:  # noqa: BLE001 - closing a file never stops the batch
                logger.warning("could not close the checkpoint file: %s", e)

    async def investigate(self, opening: str = "Investigate this batch.") -> None:
        # A new investigation of a batch investigated before starts a new thread: the old one stays in the file.
        before = (self.case.data.get("investigator") or {}).get("thread_id")
        await self._ensure_investigator(None if before is None else f"{self.id}-investigator-{int(time.time())}")
        self.case.set_phase("investigating")
        # The rubric turns on the grader (RubricMiddleware) that checks the verdict before the investigator finishes.
        await self._stream_investigator(
            {"messages": [{"role": "user", "content": opening}], "rubric": RUBRIC}
        )

    async def decide(self, approve: bool, pairs: int | None = None) -> None:
        """Answer the investigator's pending approval. `pairs` (approve only) edits the experiment's size first: the
        `edit` decision, with the tool call's other arguments unchanged."""
        await self._ensure_investigator()
        decision = {"type": "approve"} if approve else {"type": "reject", "message": "The person declined the cost."}
        action = (self.case.data["forks"].get("pending") or {}).get("action") or {}
        size_key = {"run_experiment": "pairs", "request_forks": "n_per_arm"}.get(action.get("name"))
        if approve and pairs is not None and size_key:
            args = {**(action.get("args") or {}), size_key: int(pairs)}
            decision = {"type": "edit", "edited_action": {"name": action["name"], "args": args}}
        pending_lesson = (self.case.data["forks"].get("pending") or {}).get("lesson_id")
        if pending_lesson and not approve:
            self.case.update_lesson(pending_lesson, status="rejected")
        # One answer covers one experiment. If the investigator asked for several in one turn, the rest are declined.
        rest = {"type": "reject", "message": "Only one experiment is approved at a time. Ask again if you still need it."}
        decisions = [decision] + [rest] * (self._pending_requests - 1)
        self._pending_requests = 1
        self.case.remove_fork("pending")
        self.case.set_phase("investigating")
        await self._stream_investigator(Command(resume={"decisions": decisions}))

    async def _stream_investigator(self, inp) -> None:
        log = self._log(self.dir / "investigator" / "events.jsonl", "investigator")
        try:
            self._check_budget()
            interrupted = None
            # The stream is read to its end, even after an interrupt: the checkpoint that holds the pending approval
            # is written to SQLite as the run winds down, and leaving the loop early could cut that write off.
            # `durability="sync"` saves each step before the next one starts, so a restart loses nothing.
            async for chunk in self._investigator.astream(inp, self._inv_config, stream_mode="updates", subgraphs=True,
                                                          durability="sync"):
                ns, update = chunk if isinstance(chunk, tuple) else ((), chunk)
                if "__interrupt__" in update:
                    interrupted = update["__interrupt__"] if interrupted is None else interrupted
                    continue
                if interrupted is not None:
                    continue
                agent = self._agent_name(ns, update)
                for ev in events_from_update(update):
                    ev = log.write({**ev, "agent": agent})
                    self._emit({"kind": "investigator", "event": ev})
                    if ev.get("type") == "todos" and agent == "investigator":
                        self.case.set_investigator(todos=ev["todos"])
                self.case.set_investigator(subagent=None if agent == "investigator" else agent)
                self.push_costs()
                self._check_budget()
            if interrupted is not None:
                self._on_interrupt(interrupted)
                return
            try:
                self.write_audit()
            except Exception as e:  # noqa: BLE001 - the audit sheet is for the screens; it never stops the batch
                logger.warning("could not write the audit sheet: %s: %s", type(e).__name__, e)
            self.case.set_investigator(subagent=None)
            self.case.set_phase("done")
            # The investigator has finished and the verdict is in: the batch is over, so stop paying for its VMs.
            await self.close()
        except OverBudget as e:
            # The budget stops the investigator too. Nothing more will run, so the VMs can go.
            self.case.set_phase(f"blocked: {e}")
            await self.close()
        except Exception:
            # A crash ends the investigation as well: stop paying for the VMs, then let the error surface.
            await self.close()
            raise
        finally:
            log.close()
            self.push_costs(force=True)

    def _agent_name(self, ns: tuple, update: dict) -> str:
        """Who an update comes from: the investigator, or the subagent by its name (a subgraph's namespace is
        `tools:<uuid>`; its model's AIMessage carries the subagent's name), remembered per namespace."""
        if not ns:
            return "investigator"
        key = ns[-1]
        names = self.__dict__.setdefault("_ns_names", {})
        if key not in names:
            for delta in (update or {}).values():
                for m in (delta.get("messages") or []) if isinstance(delta, dict) else []:
                    if getattr(m, "type", None) == "ai" and getattr(m, "name", None):
                        names[key] = m.name
                        break
        return names.get(key, "subagent")

    def _on_interrupt(self, interrupts) -> None:
        try:
            first = interrupts[0].value["action_requests"][0]
            action = {"name": first.get("name"), "args": dict(first.get("args") or {})}
        except Exception:  # noqa: BLE001
            action = {}
        if action.get("name") in ("run_experiment", "propose_lesson"):
            self._pending_requests = max(1, len(interrupts[0].value.get("action_requests") or []))
            return self._on_new_interrupt(action)
        n, kind = 4, "method"
        self._pending_requests = 1
        try:
            requests = interrupts[0].value["action_requests"]
            self._pending_requests = max(1, len(requests))
            n = int(requests[0]["args"].get("n_per_arm", 4))
            if requests[0].get("name") == "request_fix_test":
                kind = "fix"
        except Exception:  # noqa: BLE001
            pass
        hid = None
        try:
            hid = interrupts[0].value["action_requests"][0]["args"].get("hypothesis_id")
        except Exception:  # noqa: BLE001
            pass
        fix = self.case.data.get("fix") or {}
        if kind == "fix":
            hid = hid or fix.get("hypothesis_id")
        h = self.case.hypothesis(hid) if hid else None
        # What the person is approving: which hypothesis, what it predicts, and what would falsify it.
        about = {"hypothesis_id": hid, "prediction": (h or {}).get("prediction"), "falsified_if": (h or {}).get("falsified_if"),
                 "hypothesis": (h or {}).get("sentence")}
        if kind == "fix" and self.domain.score_code is not None:
            # Measured on this server: no VM and no model, but the patched code is run, so a person still approves it.
            self.case.update_fork("pending", status="awaiting_approval", kind="fix", direct=True, n_per_arm=0,
                                  vm_count=0, estimate_usd=0.0, patch=fix.get("description"), **about)
            self.case.set_phase("awaiting_approval")
            return
        if kind == "method" and hid:
            _, plan = self.method_plan(hid)
            n_arms = max(2, len(plan["arms"])) if plan else 2
        else:
            n_arms = max(2, len(self.fix_arm_plan() if kind == "fix" else self.arm_plan()))
        est = self.estimate_forks_usd(n, n_arms)
        self.case.update_fork(
            "pending", status="awaiting_approval", kind=kind, n_per_arm=n, vm_count=n_arms * n + 1,
            estimate_usd=usd_up(est), **about, action=action,
        )
        self.case.set_phase("awaiting_approval")

    def _on_new_interrupt(self, action: dict) -> None:
        """`forks.pending` for a paired experiment (`run_experiment`) or a lesson (`propose_lesson`): what the person
        is asked to approve, and what it costs. The estimate is per pair, so an edited `pairs` is priced the same way."""
        args = action["args"]
        if action["name"] == "propose_lesson":
            lid = self.case.add_lesson(str(args.get("name") or "")[:60], str(args.get("rule") or "")[:1000],
                                       args.get("suspect_id"))
            self.case.update_fork("pending", status="awaiting_approval", kind="lesson", lesson_id=lid,
                                  name=args.get("name"), rule=args.get("rule"), n_per_arm=0, pairs=0, vm_count=0,
                                  estimate_usd=0.0, action=action)
            self.case.set_phase("awaiting_approval")
            return
        try:
            n = max(1, min(int(args.get("pairs", 3)), xp.MAX_PAIRS_PER_CALL))
        except (TypeError, ValueError):
            n = 3
        sid = args.get("suspect_id")
        per_pair = self.estimate_forks_usd(1, 2)
        self.case.update_fork(
            "pending", status="awaiting_approval", kind="experiment", suspect_id=sid,
            suspect=self.case.suspect(sid) if sid else None, change=args.get("change"),
            anchor=args.get("anchor") or "before_split", source_run=args.get("source_run"),
            prediction=args.get("prediction"), reason=args.get("reason") or "", pairs=n, n_per_arm=n,
            vm_count=2 * n + 1, estimate_usd=usd_up(self.estimate_forks_usd(n, 2)),
            cost_per_pair_usd=None if per_pair is None else round(per_pair, 4), action=action,
        )
        self.case.set_phase("awaiting_approval")

    async def close(self) -> None:
        """Delete every VM this batch still has: runs, fork bases and fork children. Safe to call again."""
        await self._close_checkpointer()
        left, self.vms = self.vms, {}
        if left:
            await asyncio.gather(*(asyncio.to_thread(vms.delete_vm, sb) for sb in left.values()))
        # The lab pages went with the VMs. Charts were saved when each run finished.
        self._forget_lab_pages()


def _measurement(measured: dict) -> dict:
    """What `Domain.score_code` measured, as the case file keeps it: the rate and its counts."""
    return {"true_accuracy": round(float(measured["success_rate"]), 4), "successes": measured.get("successes"),
            "n": measured.get("n")}


def _changed_cases(before: list | None, after: list | None) -> tuple[int | None, int | None]:
    """(gained, lost) between two `passed` lists of one task's hidden cases: how many fail before and pass after,
    and how many pass before and fail after. (None, None) when they cannot be paired."""
    if not before or not after or len(before) != len(after):
        return None, None
    return sum(a and not b for b, a in zip(before, after)), sum(b and not a for b, a in zip(before, after))


def _arm_summary(rows: list[dict]) -> dict:
    """An arm's counts. `scored` is honest plus inflated: an unclear child (robot only) is counted on its own and
    left out of the rate, like a failed one. The `unclear` key is there only when some child is unclear."""
    scored = [r for r in rows if r.get("status") in ("honest", "inflated")]
    unclear = sum(r.get("status") == "unclear" for r in rows)

    def mean(key: str) -> float | None:
        vals = [r[key] for r in scored if r.get(key) is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    return {
        "total": len(rows),
        "scored": len(scored),
        "inflated": sum(r["status"] == "inflated" for r in scored),
        "honest": sum(r["status"] == "honest" for r in scored),
        **({"unclear": unclear} if unclear else {}),
        "failed": len(rows) - len(scored) - unclear,
        "mean_reported": mean("reported_accuracy"),
        "mean_true": mean("true_accuracy"),
    }


def _findings_lines(record: dict, found: dict) -> list[str]:
    """The pre-registered prediction against its computed outcome, and how the copies were built, in words."""
    lines = []
    if record.get("prediction") and "outcome" in found:
        lines.append(f"Pre-registered prediction for {record['hypothesis_id']}: {record['prediction']} "
                     f"Outcome, computed from the counts: {found['outcome']}.")
    b = found["built"]
    lines.append(f"Copies built by VM fork: {b['fork']}, by replay: {b['replay']}, not built: {b['none']}.")
    return lines


def _arm_lines(plan: dict[str, dict | None], arms: dict[str, dict], kind: str, ev: dict | None = None) -> list[str]:
    """An experiment's result per arm in words, then, for a method experiment, how strong its evidence is."""
    lines = []
    for arm, step in plan.items():
        a = arms[arm]
        what = "continues unchanged" if step is None else step["description"]
        if kind == "fix":
            rate = "unknown" if a["mean_true"] is None else f"{a['mean_true']:.0%}"
            lines.append(f"{arm.capitalize()}: mean true success rate {rate} over {a['scored']} copies "
                         f"({what}; {a['failed']} failed).")
        else:
            lines.append(f"{arm.capitalize()}: {a['inflated']} of {a['scored']} inflated ({what}; {a['failed']} failed).")
    if kind != "fix" and "control" in arms and "forced" in arms:
        # How strong this is, so the verdict's words can follow it (evidence.py).
        lines.append(describe_evidence(ev or verdict_evidence(
            {a: {"inflated": arms[a]["inflated"], "total": arms[a]["scored"]} for a in ("control", "forced")})))
    return lines


@dataclass(frozen=True)
class _ForkPoint:
    """Where the copies of a fork start (`Batch._fork_point`)."""

    messages: list
    n_prefix: int
    actions: list
    log: str


def _step_description(step: dict | list | None) -> str | None:
    """An arm's step in words for `arm_steps`: None for no step, the steps joined for a two-factor cell."""
    if step is None:
        return None
    if isinstance(step, list):
        return "; then ".join(s.get("description") or "" for s in step) or None
    return step.get("description")


def _put(q: asyncio.Queue, msg: dict) -> None:
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        pass


async def _try(coro):
    try:
        return await coro
    except Exception:  # noqa: BLE001
        return None
