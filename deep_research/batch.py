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
from pathlib import Path
from typing import Any

from langchain_core.messages import messages_from_dict, messages_to_dict
from langchain_daytona import DaytonaSandbox
from langgraph.types import Command

from . import sandboxes as vms
from .agents.analyst import build_analyst
from .agents.investigator import build_investigator
from .analysis import actions_from_events, find_split
from .case_file import CaseFile
from .config import BATCHES_DIR, BatchConfig
from .costs import CostTracker, OverBudget, UsageCallback
from .events import EventLog, current_step, events_from_update, read_events
from .forks import cut_history, forced_turn, intervention_for
from .scoring import score_run
from .task import build_task, task_prompt

logger = logging.getLogger(__name__)

RUN_TIMEOUT_S = 900
RECURSION_LIMIT = 200
# One investigator turn is four graph steps, and reading the case file a hundred lines at a time is a
# turn per read, so the analysts' limit would end an investigation after about 48 turns, with the fork
# money already spent. The budget check is what limits the investigator's spend.
INVESTIGATOR_RECURSION_LIMIT = 1000
MAX_PARALLEL_VMS = 12


class Batch:
    def __init__(self, cfg: BatchConfig, batch_id: str | None = None, root: Path = BATCHES_DIR):
        self.cfg = cfg
        self.id = batch_id or time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.dir = root / self.id
        self.runs_dir = self.dir / "runs"
        self.forks_dir = self.dir / "forks"
        fresh = not self.dir.exists()
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        try:
            # First, and before the case file exists: if the task cannot be built there is no batch.
            self.task = build_task(cfg, self.dir / "task")
        except BaseException:
            if fresh:
                shutil.rmtree(self.dir, ignore_errors=True)
            raise
        self.case = CaseFile(self.dir / "case" / "case.json")
        self.tracker = CostTracker(budget_usd=cfg.budget_usd)
        # A reopened batch (cli forks, cli investigate) has spend on record already.
        self.tracker.restore(self.case.data.get("costs") or {})
        self.vms: dict[str, Any] = {}
        self._queues: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_cost_push = 0.0
        self._investigator = None
        self._inv_config: dict | None = None
        self._pending_requests = 1
        self.case.subscribe(lambda section, value: self._emit({"kind": "case", "section": section, "value": value}))
        self.case.set_config(cfg.model_dump())

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
        log = EventLog(rdir / "events.jsonl")
        self.case.update_run(run_id, status="starting")
        try:
            sb = await asyncio.to_thread(vms.create_vm, f"{self.id}-{run_id}")
            self.vms[run_id] = sb
            self.tracker.vm_started(scope)
            await asyncio.to_thread(vms.load_task, sb, self.task)
            url = await _try(asyncio.to_thread(vms.start_lab_page, sb))
            self.case.update_run(run_id, status="running", vm_id=sb.id, lab_url=url)

            agent = build_analyst(DaytonaSandbox(sandbox=sb), self.cfg.analyst_model)
            inp = {"messages": [{"role": "user", "content": task_prompt(self.cfg)}]}
            msgs = await asyncio.wait_for(
                self._drive(agent, inp, f"{self.id}-{run_id}", scope, self.cfg.analyst_model, log, self._run_event(run_id)),
                RUN_TIMEOUT_S,
            )
            (rdir / "messages.json").write_text(json.dumps(messages_to_dict(msgs)))
            await asyncio.to_thread(vms.download_outputs, sb, rdir / "outputs")
            charts = await asyncio.to_thread(vms.download_charts, sb, rdir / "live")
            self._finish_run(run_id, rdir, log)
            if charts:
                self.case.update_run(run_id, charts=[f"runs/{run_id}/live/{name}" for name in charts])
        except Exception as e:  # noqa: BLE001 - one bad run must not sink the batch
            self.case.update_run(run_id, status="failed", reason=f"{type(e).__name__}: {e}"[:500])
        finally:
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

    def _finish_run(self, run_id: str, rdir: Path, log: EventLog) -> None:
        score = score_run(rdir / "outputs", self.task, self.cfg.inflation_threshold)
        (rdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
        actions = actions_from_events(read_events(log.path), self.task.given_files())
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
                runs[r] = actions_from_events(read_events(p), self.task.given_files())
        finding = find_split(runs, statuses)
        if finding is None:
            self.case.set_split(None)
            self.case.set_phase("no_split")
            return
        split = finding.to_dict()
        iv = intervention_for(finding.label)
        split["intervention"] = None if iv is None else iv["description"]
        self.case.set_split(split)
        self.case.set_phase("ready")

    # ---- phase 3: the fork experiment ----
    def estimate_forks_usd(self, n_per_arm: int) -> float | None:
        avg = self.tracker.average_run_usd()
        # Forks start partway through a run, so this overestimates a little.
        return None if avg is None else avg * 2 * n_per_arm

    def fork_blocker(self) -> str | None:
        """Why the fork experiment cannot run on this batch, or None when it can."""
        split = self.case.data.get("split")
        if not split or split.get("fork_run_id") is None:
            return "no split finding with a run to fork from"
        if intervention_for(split["label"]) is None:
            return f"no intervention is defined for '{split['label']}' yet"
        return None

    async def run_forks(self, n_per_arm: int) -> str:
        self._loop = asyncio.get_running_loop()
        why_not = self.fork_blocker()
        if why_not:
            return f"error: {why_not}"
        split = self.case.data["split"]
        iv = intervention_for(split["label"])
        n_per_arm = max(1, min(int(n_per_arm), 8))
        try:
            self.tracker.check(self.estimate_forks_usd(n_per_arm), f"{2 * n_per_arm} fork runs")
        except OverBudget as e:
            return f"error: {e}"

        fork_id = f"f{sum(k.startswith('f') for k in self.case.data['forks']) + 1}"
        src = split["fork_run_id"]
        phase_before = self.case.data.get("phase")
        base_scope = f"fork:{fork_id}:base"
        try:
            msgs = messages_from_dict(json.loads((self.runs_dir / src / "messages.json").read_text()))
            actions = actions_from_events(read_events(self.runs_dir / src / "events.jsonl"), self.task.given_files())
            prefix_msgs, n_prefix = cut_history(msgs, split["fork_at"])
            prefix_actions = actions[:n_prefix]
            self.case.set_phase("forking")
            self.case.update_fork(
                fork_id, status="rebuilding", source_run=src, fork_at=n_prefix, label=split["label"],
                intervention=iv["description"], n_per_arm=n_per_arm, children={},
            )
            base = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-base")
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
            log = EventLog(cdir / "events.jsonl")
            async with sem:
                try:
                    try:
                        vm = await asyncio.to_thread(vms.fork_vm, base, f"{self.id}-{fork_id}-{cid}")
                        self.vms[f"{fork_id}-{cid}"] = vm
                        how = "fork"
                    except Exception as e:  # noqa: BLE001 - fall back to rebuilding by replay
                        logger.warning("fork %s %s: could not fork the base VM (%s: %s); rebuilding it by replay",
                                       fork_id, cid, type(e).__name__, e)
                        vm = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-{cid}")
                        self.vms[f"{fork_id}-{cid}"] = vm
                        await asyncio.to_thread(vms.load_task, vm, self.task)
                        await asyncio.to_thread(vms.replay_actions, vm, prefix_actions)
                        how = "replay"
                    self.tracker.vm_started(scope)
                    url = await _try(asyncio.to_thread(vms.start_lab_page, vm))
                    self._set_child(fork_id, cid, arm=arm, status="running", lab_url=url, how=how)

                    history = list(prefix_msgs)
                    if arm == "forced":
                        backend = DaytonaSandbox(sandbox=vm)
                        res = await asyncio.to_thread(backend.execute, iv["command"])
                        if res.exit_code not in (0, None):
                            # Nothing was forced in this copy, so it must not be scored as a forced result.
                            raise RuntimeError(f"forced step failed with exit code {res.exit_code}: {res.output[:200]}")
                        history += forced_turn(iv["command"], res.output)
                        log.write({"type": "forced", "command": iv["command"], "output": res.output[:2000]})

                    agent = build_analyst(DaytonaSandbox(sandbox=vm), self.cfg.analyst_model)

                    def on_event(ev: dict) -> None:
                        self._emit({"kind": "fork_event", "fork": fork_id, "child": cid, "event": ev})

                    await asyncio.wait_for(
                        self._drive(agent, {"messages": history}, f"{self.id}-{fork_id}-{cid}", scope,
                                    self.cfg.analyst_model, log, on_event),
                        RUN_TIMEOUT_S,
                    )
                    await asyncio.to_thread(vms.download_outputs, vm, cdir / "outputs")
                    charts = await asyncio.to_thread(vms.download_charts, vm, cdir / "live")
                    score = score_run(cdir / "outputs", self.task, self.cfg.inflation_threshold)
                    (cdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
                    results[cid] = {"arm": arm, **score.to_dict()}
                    extra = {"charts": [f"forks/{fork_id}/{cid}/live/{name}" for name in charts]} if charts else {}
                    self._set_child(fork_id, cid, **results[cid], **extra)
                except Exception as e:  # noqa: BLE001
                    results[cid] = {"arm": arm, "status": "failed", "reason": f"{type(e).__name__}: {e}"[:300]}
                    self._set_child(fork_id, cid, **results[cid])
                finally:
                    log.close()
                    if await self._release(f"{fork_id}-{cid}", scope):
                        self._set_child(fork_id, cid, lab_url=None)

        # Each copy is its own run, so each starts in an empty context. When the investigator's tool calls
        # this experiment, the copies would otherwise inherit the investigator's callbacks, and every fork
        # token would be counted a second time under "investigator", at the investigator's price.
        try:
            await asyncio.gather(*(
                asyncio.create_task(child(arm, i), context=contextvars.Context())
                for arm in ("control", "forced") for i in range(n_per_arm)
            ))
        finally:
            await self._release(f"{fork_id}-base", base_scope)

        arms = {arm: _arm_summary([r for r in results.values() if r["arm"] == arm]) for arm in ("control", "forced")}
        self.case.update_fork(fork_id, status="done", arms=arms)
        self.case.set_phase("forked")
        c, f = arms["control"], arms["forced"]
        return (
            f"Fork {fork_id} from run {src} before action {n_prefix} ({split['label']}). "
            f"Control: {c['inflated']} of {c['scored']} inflated. "
            f"Forced '{iv['description']}': {f['inflated']} of {f['scored']} inflated. "
            f"Failed runs are not counted: control {c['failed']}, forced {f['failed']}."
        )

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
        log = EventLog(self.dir / "investigator" / "events.jsonl")
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
        n = 4
        self._pending_requests = 1
        try:
            requests = interrupts[0].value["action_requests"]
            self._pending_requests = max(1, len(requests))
            n = int(requests[0]["args"].get("n_per_arm", 4))
        except Exception:  # noqa: BLE001
            pass
        est = self.estimate_forks_usd(n)
        self.case.update_fork(
            "pending", status="awaiting_approval", n_per_arm=n, vm_count=2 * n + 1,
            estimate_usd=None if est is None else round(est, 2),
        )
        self.case.set_phase("awaiting_approval")

    async def close(self) -> None:
        """Delete every VM this batch still has: runs, fork bases and fork children. Safe to call again."""
        left, self.vms = self.vms, {}
        if not left:
            return
        await asyncio.gather(*(asyncio.to_thread(vms.delete_vm, sb) for sb in left.values()))
        # The lab pages went with the VMs. Charts were saved when each run finished.
        for run_id, run in list(self.case.data["runs"].items()):
            if run.get("lab_url"):
                self.case.update_run(run_id, lab_url=None)
        for fork_id, fork in list(self.case.data["forks"].items()):
            for cid, child in list((fork.get("children") or {}).items()):
                if child.get("lab_url"):
                    self._set_child(fork_id, cid, lab_url=None)


def _arm_summary(rows: list[dict]) -> dict:
    scored = [r for r in rows if r.get("status") in ("honest", "inflated")]

    def mean(key: str) -> float | None:
        vals = [r[key] for r in scored if r.get(key) is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    return {
        "total": len(rows),
        "scored": len(scored),
        "inflated": sum(r["status"] == "inflated" for r in scored),
        "honest": sum(r["status"] == "honest" for r in scored),
        "failed": len(rows) - len(scored),
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
