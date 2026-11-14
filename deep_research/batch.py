"""The orchestrator. Plain code: starts VMs and runs, scores, finds the split,
runs the fork experiment, drives the investigator, and tracks cost.
"""

from __future__ import annotations

import asyncio
import json
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

RUN_TIMEOUT_S = 900
RECURSION_LIMIT = 200
MAX_PARALLEL_VMS = 12


class Batch:
    def __init__(self, cfg: BatchConfig, batch_id: str | None = None, root: Path = BATCHES_DIR):
        self.cfg = cfg
        self.id = batch_id or time.strftime("%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.dir = root / self.id
        self.runs_dir = self.dir / "runs"
        self.forks_dir = self.dir / "forks"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.case = CaseFile(self.dir / "case" / "case.json")
        self.tracker = CostTracker(budget_usd=cfg.budget_usd)
        self.task = build_task(cfg, self.dir / "task")
        self.vms: dict[str, Any] = {}
        self._queues: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_cost_push = 0.0
        self._investigator = None
        self._inv_config: dict | None = None
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
            self._finish_run(run_id, rdir, log)
        except Exception as e:  # noqa: BLE001 - one bad run must not sink the batch
            self.case.update_run(run_id, status="failed", reason=f"{type(e).__name__}: {e}"[:500])
        finally:
            log.close()
            self.tracker.vm_stopped(scope)
            self.push_costs(force=True)

    def _finish_run(self, run_id: str, rdir: Path, log: EventLog) -> None:
        score = score_run(rdir / "outputs", self.task, self.cfg.inflation_threshold)
        (rdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
        actions = actions_from_events(read_events(log.path))
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
                runs[r] = actions_from_events(read_events(p))
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

    async def run_forks(self, n_per_arm: int) -> str:
        self._loop = asyncio.get_running_loop()
        split = self.case.data.get("split")
        if not split or split.get("fork_run_id") is None:
            return "error: no split finding with a run to fork from"
        iv = intervention_for(split["label"])
        if iv is None:
            return f"error: no intervention is defined for '{split['label']}' yet"
        n_per_arm = max(1, min(int(n_per_arm), 8))
        try:
            self.tracker.check(self.estimate_forks_usd(n_per_arm), f"{2 * n_per_arm} fork runs")
        except OverBudget as e:
            return f"error: {e}"

        fork_id = f"f{sum(k.startswith('f') for k in self.case.data['forks']) + 1}"
        src = split["fork_run_id"]
        msgs = messages_from_dict(json.loads((self.runs_dir / src / "messages.json").read_text()))
        actions = actions_from_events(read_events(self.runs_dir / src / "events.jsonl"))
        prefix_msgs, n_prefix = cut_history(msgs, split["fork_at"])
        prefix_actions = actions[:n_prefix]
        self.case.set_phase("forking")
        self.case.update_fork(
            fork_id, status="rebuilding", source_run=src, fork_at=n_prefix, label=split["label"],
            intervention=iv["description"], n_per_arm=n_per_arm, children={},
        )

        base_scope = f"fork:{fork_id}:base"
        base = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-base")
        self.tracker.vm_started(base_scope)
        await asyncio.to_thread(vms.load_task, base, self.task)
        await asyncio.to_thread(vms.replay_actions, base, prefix_actions)
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
                        how = "fork"
                    except Exception:  # noqa: BLE001 - fall back to rebuilding by replay
                        vm = await asyncio.to_thread(vms.create_vm, f"{self.id}-{fork_id}-{cid}")
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
                    score = score_run(cdir / "outputs", self.task, self.cfg.inflation_threshold)
                    (cdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
                    results[cid] = {"arm": arm, **score.to_dict()}
                    self._set_child(fork_id, cid, **results[cid])
                except Exception as e:  # noqa: BLE001
                    results[cid] = {"arm": arm, "status": "failed", "reason": f"{type(e).__name__}: {e}"[:300]}
                    self._set_child(fork_id, cid, **results[cid])
                finally:
                    log.close()
                    self.tracker.vm_stopped(scope)
                    self.push_costs(force=True)

        await asyncio.gather(*(child(arm, i) for arm in ("control", "forced") for i in range(n_per_arm)))
        self.tracker.vm_stopped(base_scope)
        await asyncio.to_thread(vms.stop_vm, base)

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
            "recursion_limit": RECURSION_LIMIT,
        }
        self.case.set_phase("investigating")
        await self._stream_investigator({"messages": [{"role": "user", "content": "Investigate this batch."}]})

    async def decide(self, approve: bool) -> None:
        """Answer the investigator's pending request_forks approval."""
        decision = {"type": "approve"} if approve else {"type": "reject", "message": "The person declined the cost."}
        self.case.remove_fork("pending")
        self.case.set_phase("investigating")
        await self._stream_investigator(Command(resume={"decisions": [decision]}))

    async def _stream_investigator(self, inp) -> None:
        log = EventLog(self.dir / "investigator" / "events.jsonl")
        try:
            async for chunk in self._investigator.astream(inp, self._inv_config, stream_mode="updates", subgraphs=True):
                ns, update = chunk if isinstance(chunk, tuple) else ((), chunk)
                if "__interrupt__" in update:
                    self._on_interrupt(update["__interrupt__"])
                    return
                for ev in events_from_update(update):
                    ev = log.write({**ev, "agent": ns[-1].split(":")[0] if ns else "investigator"})
                    self._emit({"kind": "investigator", "event": ev})
                self.push_costs()
            self.case.set_phase("done")
        finally:
            log.close()
            self.push_costs(force=True)

    def _on_interrupt(self, interrupts) -> None:
        n = 4
        try:
            req = interrupts[0].value["action_requests"][0]
            n = int(req["args"].get("n_per_arm", 4))
        except Exception:  # noqa: BLE001
            pass
        est = self.estimate_forks_usd(n)
        self.case.update_fork(
            "pending", status="awaiting_approval", n_per_arm=n, vm_count=2 * n + 1,
            estimate_usd=None if est is None else round(est, 2),
        )
        self.case.set_phase("awaiting_approval")

    async def close(self) -> None:
        await asyncio.gather(*(asyncio.to_thread(vms.stop_vm, sb) for sb in self.vms.values()))


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
