"""The orchestrator. Plain code: starts VMs and runs, scores, finds the split,
runs the fork experiment, drives the investigator, and tracks cost.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from langchain_core.messages import messages_from_dict, messages_to_dict
from langchain_daytona import DaytonaSandbox
from langgraph.types import Command

from . import domains, hub
from . import sandboxes as vms
from .agents.analyst import build_analyst
from .agents.investigator import build_investigator
from .analysis import find_split
from .case_file import CaseFile
from .config import BATCHES_DIR, BatchConfig
from .costs import CostTracker, OverBudget, UsageCallback
from .events import EventLog, current_step, events_from_update, read_events
from .domains import actions_from_events, build_task, intervention_for, score_run
from .forks import apply_step, cut_history, fix_plan, forced_turn, step_text

logger = logging.getLogger(__name__)

RUN_TIMEOUT_S = 900
RECURSION_LIMIT = 200
# One investigator turn is four graph steps, and reading the case file a hundred lines at a time is a
# turn per read, so the analysts' limit would end an investigation after about 48 turns, with the fork
# money already spent. The budget check is what limits the investigator's spend.
INVESTIGATOR_RECURSION_LIMIT = 1000
MAX_PARALLEL_VMS = 12
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
    if phase == "no_split":
        return "no step separated the runs, so there is nothing to investigate"
    if phase.startswith("blocked:"):
        return "it stopped over its budget, and it would stop again on the same budget"
    runs = case.get("runs") or {}
    if not runs or any(r.get("status") not in SCORED for r in runs.values()):
        return "its runs never finished"
    split = case.get("split") or {}
    src = split.get("fork_run_id")
    if not src:
        return "no split was found"
    try:
        marker = domains.get(cfg.get("domain")).task_marker
    except ValueError:
        return f"its domain '{cfg.get('domain')}' is not available here"
    if not (batch_dir / "runs" / src / "messages.json").is_file() or not (batch_dir / "task" / marker).is_file():
        return "the files needed to fork are missing"
    return None


class Batch:
    def __init__(self, cfg: BatchConfig, batch_id: str | None = None, root: Path = BATCHES_DIR, resume: bool = False):
        self.cfg = cfg
        # What the task is, how a run is scored and what its steps are called (deep_research/domains/).
        self.domain = domains.get(cfg.domain)
        # The VM calls name the domain only when it is not the default one, so a tabular batch calls them as before.
        self._vm_domain = {} if cfg.domain == domains.DEFAULT else {"domain": cfg.domain}
        self.id = batch_id or time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.dir = root / self.id
        self.runs_dir = self.dir / "runs"
        self.forks_dir = self.dir / "forks"
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
        self.case = CaseFile(self.dir / "case" / "case.json", labels=self.domain.labels())
        self.tracker = CostTracker(budget_usd=cfg.budget_usd)
        # A reopened batch (Batch.resume, cli forks, cli investigate) has spend on record already.
        self.tracker.restore(self.case.data.get("costs") or {})
        self.vms: dict[str, Any] = {}
        self._queues: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_cost_push = 0.0
        self._investigator = None
        self._inv_config: dict | None = None
        self._pending_requests = 1
        self.case.subscribe(lambda section, value: self._emit({"kind": "case", "section": section, "value": value}))
        # The team hub (hub.py), when it is set up: every change to the case file and every agent event goes there.
        self._hub = hub.pusher()
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        if self._hub is not None:
            self.case.subscribe(lambda section, value: self._push_case())
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
        if "pending" in b.case.data["forks"]:
            b.case.remove_fork("pending")
        b._close_unfinished_forks()
        b._forget_lab_pages()  # the VMs behind them are long gone
        b.case.set_phase("ready")
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

    # ---- driving one agent ----
    async def _drive(self, agent, inp, thread_id: str, scope: str, model: str, log: EventLog, on_event) -> list:
        config = {
            "configurable": {"thread_id": thread_id},
            "callbacks": [UsageCallback(self.tracker, scope, model)],
            "recursion_limit": RECURSION_LIMIT,
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

        return on_event

    # ---- phase 1: the runs ----
    async def run_all(self) -> None:
        self._loop = asyncio.get_running_loop()
        est = self.tracker.average_run_usd()
        self.tracker.check(None if est is None else est * self.cfg.n_runs, f"{self.cfg.n_runs} runs")
        self.case.set_phase("running")
        sem = asyncio.Semaphore(MAX_PARALLEL_VMS)
        run_ids = [f"r{i + 1:02d}" for i in range(self.cfg.n_runs)]
        for r in run_ids:
            self.case.update_run(r, status="queued")

        async def guarded(r: str) -> None:
            async with sem:
                await self.run_one(r)

        await asyncio.gather(*(guarded(r) for r in run_ids))
        self.push_costs(force=True)
        self.analyze()
        if self.case.data.get("phase") == "no_split":
            # Nothing to investigate or fork, so nothing will use the VMs again.
            await self.close()

    async def run_one(self, run_id: str) -> None:
        scope, rdir = f"run:{run_id}", self.runs_dir / run_id
        log = self._log(rdir / "events.jsonl", run_id)
        self.case.update_run(run_id, status="starting")
        watch: MotionWatch | None = None
        try:
            sb = await asyncio.to_thread(vms.create_vm, f"{self.id}-{run_id}", **self._vm_domain)
            self.vms[run_id] = sb
            self.tracker.vm_started(scope)
            await asyncio.to_thread(vms.load_task, sb, self.task)
            url = await _try(asyncio.to_thread(vms.start_lab_page, sb))
            self.case.update_run(run_id, status="running", vm_id=sb.id, lab_url=url)

            on_event = self._run_event(run_id)
            watch = _watch_motion(self.domain, sb, rdir / "outputs", f"runs/{run_id}/outputs", log, on_event,
                                  lambda files: self.case.update_run(run_id, motion_files=files))
            agent = build_analyst(DaytonaSandbox(sandbox=sb), self.cfg.analyst_model)
            inp = {"messages": [{"role": "user", "content": self.domain.task_prompt(self.cfg)}]}
            msgs = await asyncio.wait_for(
                self._drive(agent, inp, f"{self.id}-{run_id}", scope, self.cfg.analyst_model, log, on_event),
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
        score = await asyncio.to_thread(score_run, rdir / "outputs", self.task, self.cfg.inflation_threshold)
        (rdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
        actions = await asyncio.to_thread(
            lambda: actions_from_events(read_events(log.path), self.task)
        )
        (rdir / "actions.json").write_text(
            json.dumps([{"index": a.index, "tool": a.tool, "args": a.args, "labels": a.labels} for a in actions], indent=2)
        )
        self.case.update_run(run_id, **score.to_dict(), n_actions=len(actions), labels=[a.labels for a in actions])

    # ---- phase 2: find the split ----
    def analyze(self) -> None:
        self.case.set_phase("analyzing")
        statuses = {r: v.get("status") for r, v in self.case.data["runs"].items()}
        runs = {}
        for r in statuses:
            p = self.runs_dir / r / "events.jsonl"
            if p.exists():
                runs[r] = actions_from_events(read_events(p), self.task)
        finding = find_split(runs, statuses, prefer=self.domain.prefer_label(self.cfg), steps=self.domain.steps())
        if finding is None:
            self.case.set_split(None)
            self.case.set_phase("no_split")
            return
        split = finding.to_dict()
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
        avg = self.tracker.average_run_usd()
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

    async def run_forks(self, n_per_arm: int) -> str:
        """The method experiment: from the moment before the suspect step, does doing that step change the result?"""
        why_not = self.fork_blocker()
        if why_not:
            return f"error: {why_not}"
        split = self.case.data["split"]
        iv = intervention_for(split["label"], self.cfg)
        return await self._experiment(
            self.arm_plan(), n_per_arm, kind="method", src=split["fork_run_id"], fork_at=split["fork_at"],
            record={"label": split["label"], "intervention": iv["description"]}, headline=f"({split['label']})",
        )

    # ---- the diagnosis: traceback and fix ----
    async def trace_failures(self, run_id: str, max_episodes: int = 3) -> dict:
        """Re-run one run's code where it fails, recording it, and describe each failure (`Domain.trace_run`)."""
        if self.domain.trace_run is None:
            return {"error": f"the {self.domain.name} domain has no recordings to trace"}
        if run_id not in self.case.data["runs"]:
            return {"error": f"unknown run {run_id}"}
        try:
            return await asyncio.to_thread(self.domain.trace_run, self.task, self.runs_dir / run_id, int(max_episodes))
        except Exception as e:  # noqa: BLE001 - the tool reports it instead of ending the investigation
            logger.warning("trace of %s failed: %s: %s", run_id, type(e).__name__, e)
            return {"error": f"could not trace {run_id}: {type(e).__name__}: {e}"[:400]}

    def propose_fix(self, run_id: str, old_string: str, new_string: str, description: str, why: str,
                    line: int | None = None) -> str:
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
            }
        )
        return f"fix proposed for {run_id} at line {line}: call request_fix_test to test it"

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

        fork_id = f"f{sum(k.startswith('f') for k in self.case.data['forks']) + 1}"
        phase_before = self.case.data.get("phase")
        base_scope = f"fork:{fork_id}:base"
        try:
            msgs = messages_from_dict(json.loads((self.runs_dir / src / "messages.json").read_text()))
            actions = actions_from_events(read_events(self.runs_dir / src / "events.jsonl"), self.task)
            prefix_msgs, n_prefix = cut_history(msgs, fork_at)
            prefix_actions = actions[:n_prefix]
            self.case.set_phase("forking")
            self.case.update_fork(
                fork_id, status="rebuilding", kind=kind, source_run=src, fork_at=n_prefix, n_per_arm=n_per_arm,
                children={}, arm_steps={a: (step or {}).get("description") for a, step in plan.items()}, **record,
            )
            base = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-base", **self._vm_domain)
            self.vms[f"{fork_id}-base"] = base
            self.tracker.vm_started(base_scope)
            await asyncio.to_thread(vms.load_task, base, self.task)
            await asyncio.to_thread(vms.replay_actions, base, prefix_actions)
        except Exception as e:  # noqa: BLE001 - returned, so an agent calling this as a tool reads it instead of dying
            logger.warning("fork %s: could not build the base VM: %s: %s", fork_id, type(e).__name__, e)
            await self._release(f"{fork_id}-base", base_scope)
            # No copy ran, so there is no experiment to show, and the batch is back where it was.
            self.case.remove_fork(fork_id)
            self.case.set_phase(phase_before)
            return f"error: could not build the fork's base VM ({type(e).__name__}: {e})"[:400]
        except BaseException:
            await self._release(f"{fork_id}-base", base_scope)
            raise
        self.case.update_fork(fork_id, status="running")

        sem = asyncio.Semaphore(MAX_PARALLEL_VMS)
        results: dict[str, dict] = {}

        async def child(arm: str, i: int) -> None:
            cid, scope = f"{arm}-{i + 1}", f"fork:{fork_id}:{arm}-{i + 1}"
            cdir = self.forks_dir / fork_id / cid
            log = self._log(cdir / "events.jsonl", f"{fork_id}/{cid}")
            watch: MotionWatch | None = None
            async with sem:
                try:
                    try:
                        vm = await asyncio.to_thread(vms.fork_vm, base, f"{self.id}-{fork_id}-{cid}")
                        self.vms[f"{fork_id}-{cid}"] = vm
                        self.tracker.vm_started(scope)
                        how = "fork"
                    except Exception as e:  # noqa: BLE001 - fall back to rebuilding by replay
                        logger.warning("fork %s %s: could not fork the base VM (%s: %s); rebuilding it by replay",
                                       fork_id, cid, type(e).__name__, e)
                        vm = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-{cid}", **self._vm_domain)
                        self.vms[f"{fork_id}-{cid}"] = vm
                        # From here, not after the rebuild: the VM is up and billing while it replays.
                        self.tracker.vm_started(scope)
                        await asyncio.to_thread(vms.load_task, vm, self.task)
                        await asyncio.to_thread(vms.replay_actions, vm, prefix_actions)
                        how = "replay"
                    url = await _try(asyncio.to_thread(vms.start_lab_page, vm))
                    self._set_child(fork_id, cid, arm=arm, status="running", lab_url=url, how=how)

                    history = list(prefix_msgs)
                    step = plan[arm]
                    if step is not None:
                        backend = DaytonaSandbox(sandbox=vm)
                        try:
                            output = await asyncio.to_thread(apply_step, backend, step)
                        except RuntimeError as e:
                            # Nothing was forced here, so this copy must not be scored as a result of its arm.
                            raise RuntimeError(f"the {arm} step failed: {e}") from e
                        history += forced_turn(step, output)
                        log.write({"type": "forced", "command": step_text(step), "output": output[:2000]})

                    agent = build_analyst(DaytonaSandbox(sandbox=vm), self.cfg.analyst_model)

                    def on_event(ev: dict) -> None:
                        self._emit({"kind": "fork_event", "fork": fork_id, "child": cid, "event": ev})

                    watch = _watch_motion(self.domain, vm, cdir / "outputs", f"forks/{fork_id}/{cid}/outputs", log,
                                          on_event, lambda files: self._set_child(fork_id, cid, motion_files=files))
                    await asyncio.wait_for(
                        self._drive(agent, {"messages": history}, f"{self.id}-{fork_id}-{cid}", scope,
                                    self.cfg.analyst_model, log, on_event),
                        RUN_TIMEOUT_S,
                    )
                    if watch is not None:
                        await watch.stop()
                    motion = await asyncio.to_thread(vms.download_outputs, vm, cdir / "outputs", **self._vm_domain)
                    charts = await asyncio.to_thread(vms.download_charts, vm, cdir / "live")
                    score = await asyncio.to_thread(
                        score_run, cdir / "outputs", self.task, self.cfg.inflation_threshold
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
        try:
            await asyncio.gather(*(
                asyncio.create_task(child(arm, i), context=contextvars.Context())
                for arm in plan for i in range(n_per_arm)
            ))
        finally:
            await self._release(f"{fork_id}-base", base_scope)

        arms = {arm: _arm_summary([r for r in results.values() if r["arm"] == arm]) for arm in plan}
        self.case.update_fork(fork_id, status="done", arms=arms)
        self.case.set_phase("forked")
        lines = [
            f"Fork {fork_id} from run {src} before action {n_prefix} {headline}. "
            f"Every arm starts from the same moment of the same run. Failed copies are not counted."
        ]
        for arm, step in plan.items():
            a = arms[arm]
            what = "continues unchanged" if step is None else step["description"]
            if kind == "fix":
                rate = "unknown" if a["mean_true"] is None else f"{a['mean_true']:.0%}"
                lines.append(f"{arm.capitalize()}: mean true success rate {rate} over {a['scored']} copies "
                             f"({what}; {a['failed']} failed).")
            else:
                lines.append(f"{arm.capitalize()}: {a['inflated']} of {a['scored']} inflated ({what}; {a['failed']} failed).")
        if kind == "fix":
            self.case.update_fix(status="tested", fork_id=fork_id,
                                 result={arm: {"mean_true": a["mean_true"], "scored": a["scored"]} for arm, a in arms.items()})
        return " ".join(lines)

    def _set_child(self, fork_id: str, cid: str, **fields: Any) -> None:
        children = dict(self.case.data["forks"][fork_id].get("children", {}))
        children[cid] = {**children.get(cid, {}), **fields}
        self.case.update_fork(fork_id, children=children)

    # ---- the investigator ----
    async def investigate(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._investigator = build_investigator(self, self.cfg.investigator_model)
        self._inv_config = {
            "configurable": {"thread_id": f"{self.id}-investigator"},
            "callbacks": [UsageCallback(self.tracker, "investigator", self.cfg.investigator_model)],
            "recursion_limit": INVESTIGATOR_RECURSION_LIMIT,
        }
        self.case.set_phase("investigating")
        await self._stream_investigator({"messages": [{"role": "user", "content": "Investigate this batch."}]})

    async def decide(self, approve: bool) -> None:
        """Answer the investigator's pending request_forks approval."""
        decision = {"type": "approve"} if approve else {"type": "reject", "message": "The person declined the cost."}
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
            async for chunk in self._investigator.astream(inp, self._inv_config, stream_mode="updates", subgraphs=True):
                ns, update = chunk if isinstance(chunk, tuple) else ((), chunk)
                if "__interrupt__" in update:
                    self._on_interrupt(update["__interrupt__"])
                    return
                for ev in events_from_update(update):
                    ev = log.write({**ev, "agent": ns[-1].split(":")[0] if ns else "investigator"})
                    self._emit({"kind": "investigator", "event": ev})
                self.push_costs()
                self._check_budget()
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

    def _on_interrupt(self, interrupts) -> None:
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
        n_arms = max(2, len(self.fix_arm_plan() if kind == "fix" else self.arm_plan()))
        est = self.estimate_forks_usd(n, n_arms)
        self.case.update_fork(
            "pending", status="awaiting_approval", kind=kind, n_per_arm=n, vm_count=n_arms * n + 1,
            estimate_usd=None if est is None else round(est, 2),
        )
        self.case.set_phase("awaiting_approval")

    async def close(self) -> None:
        """Delete every VM this batch still has: runs, fork bases and fork children. Safe to call again."""
        left, self.vms = self.vms, {}
        if left:
            await asyncio.gather(*(asyncio.to_thread(vms.delete_vm, sb) for sb in left.values()))
        # The lab pages went with the VMs. Charts were saved when each run finished.
        self._forget_lab_pages()


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
