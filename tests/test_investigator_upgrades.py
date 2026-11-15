"""The analyst without compaction, the investigator's notebook, its rubric check, its structured verdict and its
parallel traces. Scripted models, no keys, no VMs."""

import asyncio
import dataclasses
import json
import threading
import time

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import deepagents.graph as da_graph
from deep_research import batch as batch_mod
from deep_research import notebook
from deep_research.agents import analyst as analyst_mod
from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from deep_research.config import BatchConfig
from tests.scripted import ScriptedModel, call, grade, grader, saved_messages, say, script_investigator


@pytest.fixture
def batch(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(placebo_arm=True, show_arm=False), batch_id="1114-000000-abcd", root=tmp_path)
    for r, status in (("r01", "honest"), ("r02", "inflated"), ("r03", "inflated"), ("r04", "inflated")):
        b.case.update_run(r, status=status)
    b.case.set_split({"label": "deduplicate", "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 3,
                      "fork_run_id": "r02", "fork_at": 2})
    return b


class Recording(ScriptedModel):
    """A scripted model that keeps every list of messages it was called with."""

    seen: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _stacks(monkeypatch) -> list[list]:
    """Every middleware stack `create_deep_agent` hands to `create_agent` from now on (main agents only)."""
    stacks: list[list] = []
    real = da_graph.create_agent

    def capture(*args, **kwargs):
        stacks.append(list(kwargs["middleware"]))
        return real(*args, **kwargs)

    monkeypatch.setattr(da_graph, "create_agent", capture)
    return stacks


def _system(messages) -> str:
    return "\n".join(str(m.content) for m in messages if isinstance(m, SystemMessage))


async def _run(agent, inp, thread="x"):
    return await agent.ainvoke(inp, {"configurable": {"thread_id": thread}, "recursion_limit": 200})


_REAL_CREATE = inv_mod.create_deep_agent


def _scripted(monkeypatch, model):
    real = _REAL_CREATE

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)


# ---- 1. the analyst never compacts its history; the investigator still does ----

def test_the_analyst_has_no_summarization_and_keeps_prompt_caching(batch, monkeypatch):
    from deepagents.backends import StateBackend
    from deepagents.middleware.summarization import _DeepAgentsSummarizationMiddleware

    stacks = _stacks(monkeypatch)
    analyst_mod.build_analyst(StateBackend(), "anthropic:claude-haiku-5-5")
    (stack,) = stacks
    assert not any(isinstance(m, _DeepAgentsSummarizationMiddleware) for m in stack)
    assert any(isinstance(m, analyst_mod.NoCompaction) for m in stack)
    names = [m.name for m in stack]
    assert "AnthropicPromptCachingMiddleware" in names and "TodoListMiddleware" in names
    # Flat: no `task` tool, so no subagent stacks either. `NoSubagents` holds the subagent middleware's place.
    from deepagents.middleware.subagents import SubAgentMiddleware

    assert not any(isinstance(m, SubAgentMiddleware) for m in stack)
    assert any(isinstance(m, analyst_mod.NoSubagents) for m in stack)

    stacks.clear()
    inv_mod.build_investigator(batch, "anthropic:claude-sonnet-5-5")
    main = stacks[-1]
    assert any(isinstance(m, _DeepAgentsSummarizationMiddleware) for m in main)
    assert {"MemoryMiddleware", "RubricMiddleware", "AnthropicPromptCachingMiddleware"} <= {m.name for m in main}


# ---- 2. the notebook ----

def test_the_notebook_is_loaded_into_the_prompt_and_an_entry_is_appended(batch, monkeypatch):
    path = notebook.notebook_path(batch.root, "tabular")
    notebook.ensure(path, "tabular")
    path.write_text(path.read_text().replace(notebook.END, "## 2026-11-01 batch 1101-000000-aaaa\n- surprising: NOTE-42\n\n" + notebook.END))
    entry = "## 2026-11-14 batch 1114-000000-abcd\n- split: deduplicate, honest 1.00 of 1 vs inflated 0.00 of 3\n- forks: none ran\n"
    model = Recording(messages=iter([
        call("edit_file", {"file_path": "/memory/AGENTS.md", "old_string": notebook.END, "new_string": entry + "\n" + notebook.END}, "e1"),
        say("done"),
    ]))
    model.seen = []
    _scripted(monkeypatch, model)
    asyncio.run(_run(inv_mod.build_investigator(batch, "unused"), {"messages": [HumanMessage("go")]}))

    first = _system(model.seen[0])
    assert "NOTE-42" in first and "<agent_memory>" in first  # MemoryMiddleware put it in the system prompt
    assert "## " in first and "batch 1114-000000-abcd" in first  # the prompt names this batch's entry
    text = path.read_text()
    assert "NOTE-42" in text and "batch 1114-000000-abcd" in text
    assert text.rstrip().endswith(notebook.END) and text.index("NOTE-42") < text.index("1114-000000-abcd")


def test_subagents_cannot_write_the_notebook_and_hidden_data_is_refused(batch, monkeypatch):
    (batch.dir / "task" / "hidden_positions.json").write_text(json.dumps([[0.371, 0.195], [0.39, 0.457]]))
    path = notebook.notebook_path(batch.root, "tabular")
    model = ScriptedModel(messages=iter([
        call("task", {"subagent_type": "step-tagger", "description": "label r01"}, "t1"),
        call("write_file", {"file_path": "/memory/AGENTS.md", "content": "hacked"}, "s1"),  # inside the subagent
        say("could not"),
        call("edit_file", {"file_path": "/memory/AGENTS.md", "old_string": notebook.END,
                           "new_string": "## x batch y\n- failed with the can at 0.371, 0.195\n" + notebook.END}, "e1"),
        call("write_file", {"file_path": "/memory/other.md", "content": "x"}, "e2"),
        say("done"),
    ]))
    _scripted(monkeypatch, model)
    out = asyncio.run(_run(inv_mod.build_investigator(batch, "unused"), {"messages": [HumanMessage("go")]}))
    tools = [m.content for m in out["messages"] if isinstance(m, ToolMessage)]
    assert tools[0] == "could not"
    assert "hidden can position" in tools[1]
    assert "only /memory/AGENTS.md" in tools[2]
    text = path.read_text()
    assert "hacked" not in text and "0.371" not in text
    assert not (path.parent / "other.md").exists()


def test_the_notebook_keeps_one_entry_per_batch_and_stays_under_its_size_cap():
    entries = "".join(f"## 2026-01-{i % 28 + 1:02d} batch b{i:03d}\n- split: x\n- forks: y\n\n" for i in range(120))
    text = notebook.tidy(notebook.header("robot_arm") + entries + notebook.END + "\n", "robot_arm")
    lines = text.splitlines()
    assert len(lines) <= notebook.MAX_LINES
    assert lines[0] == "# Investigator notebook: robot_arm" and lines[-1] == notebook.END
    assert "batch b119" in text and "batch b000" not in text  # the oldest went first

    again = notebook.tidy(text.replace(notebook.END, "## 2026-02-01 batch b119\n- split: redone\n\n" + notebook.END), "robot_arm")
    assert again.count("batch b119") == 1 and "redone" in again  # the batch's later entry replaced the earlier one
    # A notebook whose end marker the model dropped gets it back, last.
    assert notebook.tidy("## d batch z\n- a\n", "tabular").rstrip().endswith(notebook.END)

    assert notebook.leak("honest 0.80 of 10 vs inflated 0.00 of 1", [(0.371, 0.195)]) is None
    assert notebook.leak("can at (0.37, 0.195)", [(0.371, 0.195)]) is not None
    assert notebook.leak("labels " + ", ".join(["0", "1"] * 10), []) is not None


def test_tabular_and_robot_notebooks_are_separate(batch, monkeypatch):
    for domain, note in (("tabular", "TAB-NOTE"), ("robot_arm", "ROBOT-NOTE")):
        p = notebook.notebook_path(batch.root, domain)
        notebook.ensure(p, domain)
        p.write_text(p.read_text().replace(notebook.END, f"## d batch {domain}\n- {note}\n\n{notebook.END}"))
    assert notebook.notebook_path(batch.root, "tabular") != notebook.notebook_path(batch.root, "robot_arm")
    with pytest.raises(ValueError):
        notebook.notebook_path(batch.root, "../etc")

    def system_for(domain_obj) -> str:
        monkeypatch.setattr(batch, "domain", domain_obj)
        model = Recording(messages=iter([say("done")]))
        model.seen = []
        _scripted(monkeypatch, model)
        asyncio.run(_run(inv_mod.build_investigator(batch, "unused"), {"messages": [HumanMessage("go")]}))
        return _system(model.seen[0])

    tab = system_for(batch.domain)
    robot = system_for(dataclasses.replace(batch.domain, name="robot_arm"))
    assert "TAB-NOTE" in tab and "ROBOT-NOTE" not in tab
    assert "ROBOT-NOTE" in robot and "TAB-NOTE" not in robot


def test_the_memory_route_serves_a_domains_notebook_and_nothing_else(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from deep_research import api

    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    client = TestClient(api.app)
    assert client.get("/api/memory/tabular").status_code == 404  # none yet
    p = notebook.notebook_path(tmp_path / "batches", "tabular")
    notebook.ensure(p, "tabular")
    r = client.get("/api/memory/tabular")
    assert r.status_code == 200 and r.text.startswith("# Investigator notebook: tabular")
    assert r.headers["content-type"].startswith("text/plain")
    (tmp_path / "batches" / "secret.txt").write_text("no")
    for bad in ("nope", "..", "..%2Fsecret.txt", "tabular%2F..%2F..%2Fsecret.txt"):
        assert client.get(f"/api/memory/{bad}").status_code == 404, bad


# ---- 3. the rubric check, bounded ----

class Counting(ScriptedModel):
    """A scripted grader that counts its calls and keeps what it was shown."""

    calls: int = 0
    shown: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls += 1
        self.shown.append("\n".join(str(m.content) for m in messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


VERDICT = {"sentence": "Skipping the duplicate check suggests why, but no fork experiment ran.", "step_label": "deduplicate",
           "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 3, "confidence": "low", "arms": {}}


async def test_the_rubric_grades_the_verdict_and_stops_after_two_revisions(batch, monkeypatch):
    g = Counting(messages=iter([grade("needs_revision", call_id=f"g{i}") for i in range(10)]))
    g.calls, g.shown = 0, []
    script_investigator(monkeypatch, [
        call("record_verdict", VERDICT, "v1"),
        say("Verdict recorded."),
        call("record_verdict", {**VERDICT, "sentence": VERDICT["sentence"] + " Only 1 honest run."}, "v2"),
        say("Revised once."),
        say("Revised twice."),
        say("never reached"),
    ], grader_model=g)
    await batch.investigate()

    case = json.loads((batch.dir / "case" / "case.json").read_text())
    assert g.calls == inv_mod.MAX_RUBRIC_ITERATIONS == 3  # one check and two revisions, then it stops
    assert [r["result"] for r in case["rubric"]] == ["needs_revision", "needs_revision", "max_iterations_reached"]
    assert case["rubric"][0]["failing"][0]["gap"] == "cite the placebo arm's counts"
    assert case["phase"] == "done" and case["verdict"]["sentence"].endswith("Only 1 honest run.")
    # The grader sees the rubric, and the case file's evidence and the recorded verdict next to the transcript.
    assert "fork arm" in g.shown[0] and "Case file evidence" in g.shown[0] and "Recorded verdict" in g.shown[0]
    assert '"n_inflated":3' in g.shown[0]
    # The verdict comes before the evidence, so the grader's per-message cut never drops it.
    assert g.shown[0].index("Recorded verdict") < g.shown[0].index("Case file evidence")
    # Each revision reached the investigator as a message from the grader.
    msgs = await saved_messages(batch)
    revisions = [m for m in msgs if isinstance(m, HumanMessage) and m.name == "rubric_grader"]
    assert len(revisions) == 2 and "cite the placebo arm's counts" in revisions[0].content


async def test_a_satisfied_rubric_ends_after_one_check(batch, monkeypatch):
    g = Counting(messages=iter([grade("satisfied")]))
    g.calls, g.shown = 0, []
    script_investigator(monkeypatch, [call("record_verdict", VERDICT, "v1"), say("Verdict recorded.")], grader_model=g)
    await batch.investigate()
    case = json.loads((batch.dir / "case" / "case.json").read_text())
    assert g.calls == 1 and [r["result"] for r in case["rubric"]] == ["satisfied"]


# ---- 4. the hypothesis and the verdict as fields ----

def _fork_done(b: Batch) -> None:
    b.case.update_fork("f1", kind="method", status="done", label="deduplicate", arms={
        "control": {"total": 4, "scored": 4, "inflated": 3, "honest": 1, "failed": 0},
        "placebo": {"total": 4, "scored": 3, "inflated": 3, "honest": 0, "failed": 1},
        "forced": {"total": 4, "scored": 4, "inflated": 0, "honest": 4, "failed": 0},
    })


def test_the_verdict_is_saved_as_fields_and_checked_against_the_fork(batch, monkeypatch):
    _fork_done(batch)
    arms = {"control": {"inflated": 3, "total": 4}, "placebo": {"inflated": 3, "total": 3}, "forced": {"inflated": 0, "total": 4}}
    good = {**VERDICT, "sentence": "Forcing the duplicate check removed the inflation.", "confidence": "medium", "arms": arms}
    hypothesis = {"kind": "method", "step_label": "deduplicate", "statement": "Skipping dedupe inflates.",
                  "supporting_evidence": "1 of 1 honest runs dedupe (df.drop_duplicates()), 0 of 3 inflated (fit(df))",
                  "prediction": "forced copies inflate less often than control", "falsified_if": "they inflate as often",
                  "confidence": "low"}
    model = ScriptedModel(messages=iter([
        call("task", {"subagent_type": "hypothesis", "description": "compare"}, "t1"),
        call("record_hypothesis", hypothesis, "h1"),
        say("Skipping dedupe inflates."),
        call("record_verdict", {**good, "confidence": "sure"}, "v1"),
        call("record_verdict", {**good, "arms": {"control": {"inflated": 3, "total": 4}, "forced": {"inflated": 0, "total": 4}}}, "v2"),
        call("record_verdict", {**good, "honest_rate": 1.5}, "v3"),
        call("record_verdict", good, "v4"),
        say("done"),
    ]))
    _scripted(monkeypatch, model)
    out = asyncio.run(_run(inv_mod.build_investigator(batch, "unused"), {"messages": [HumanMessage("go")]}))
    tools = [str(m.content) for m in out["messages"] if isinstance(m, ToolMessage)]
    assert "confidence" in tools[1]  # pydantic refused "sure"
    assert "placebo 3/3" in tools[2]  # the placebo arm is missing: the error gives the true counts
    assert "honest_rate" in tools[3]
    assert tools[4] == "verdict saved"

    case = json.loads((batch.dir / "case" / "case.json").read_text())
    v = case["verdict"]
    assert v["sentence"] == good["sentence"] and v["step_label"] == v["step"] == "deduplicate"
    assert (v["honest_rate"], v["inflated_rate"], v["n_honest"], v["n_inflated"], v["confidence"]) == (1.0, 0.0, 1, 3, "medium")
    assert v["arms"] == arms
    # The old fields are still there, for older readers (the UI's verdict dots read them without a fork).
    assert v["numbers"] == {"control_inflated": 3, "control_total": 4, "placebo_inflated": 3, "placebo_total": 3,
                            "forced_inflated": 0, "forced_total": 4}
    (h,) = case["hypotheses"]
    assert h["id"] == "h1" and h["kind"] == "method" and h["status"] == "untested"
    assert h["evidence"] == hypothesis["supporting_evidence"] and h["step_label"] == "deduplicate"
    assert (h["prediction"], h["falsified_if"]) == (hypothesis["prediction"], hypothesis["falsified_if"])
    assert (h["confidence"], h["sentence"]) == ("low", "Skipping dedupe inflates.")


def test_older_callers_of_the_case_file_still_work(batch):
    assert batch.case.record_hypothesis("deduplicate", "a", "b", "c") == "hypothesis saved"
    assert "step" not in batch.case.data["hypotheses"][0]
    assert batch.case.record_verdict("s", "deduplicate", {"control_inflated": 1}) == "verdict saved"
    v = dict(batch.case.data["verdict"])
    assert v.pop("evidence")["level"] == "open"  # the counts it can read: one control copy, no forced ones
    assert v == {"sentence": "s", "step_label": "deduplicate", "numbers": {"control_inflated": 1}}
    assert batch.case.record_structured_verdict("s", "deduplicate", 1, 0, 1, 3, {"control": {"inflated": 1, "total": 1}}, "low") \
        .startswith("error: no fork experiment finished")


# ---- 5. tracing several runs at once ----

class Concurrency:
    """A fake `Domain.trace_run` that takes a while and counts how many run at once, per run and in all."""

    def __init__(self, seconds: float = 0.3):
        self.seconds, self.lock = seconds, threading.Lock()
        self.active, self.peak, self.per_run, self.per_run_peak, self.calls = 0, 0, {}, {}, []

    def __call__(self, task, run_dir, n):
        run = run_dir.name
        with self.lock:
            self.active += 1
            self.per_run[run] = self.per_run.get(run, 0) + 1
            self.peak = max(self.peak, self.active)
            self.per_run_peak[run] = max(self.per_run_peak.get(run, 0), self.per_run[run])
            self.calls.append(run)
        try:
            out = run_dir / "trace"
            out.mkdir(parents=True, exist_ok=True)
            (out / "hidden_00.motion.json").write_text(json.dumps({"run": run}))
            time.sleep(self.seconds)
            # What this trace wrote is still its own when it reads it back.
            return {"run": run, "read_back": json.loads((out / "hidden_00.motion.json").read_text())["run"],
                    "source": f"   1  # {run}", "episodes": []}
        finally:
            with self.lock:
                self.active -= 1
                self.per_run[run] -= 1


def _diagnosing(monkeypatch, b: Batch, fake) -> None:
    monkeypatch.setattr(b, "domain", dataclasses.replace(b.domain, trace_run=fake, fix_file="/w/model.py", fix_output="model.py"))


async def test_traces_of_different_runs_run_at_once_and_one_run_is_traced_once_at_a_time(batch, monkeypatch):
    fake = Concurrency()
    _diagnosing(monkeypatch, batch, fake)
    t0 = time.monotonic()
    outs = await asyncio.gather(*(batch.trace_failures(r, 2) for r in ("r02", "r03", "r04")))
    assert [o["run"] for o in outs] == ["r02", "r03", "r04"] and all(o["read_back"] == o["run"] for o in outs)
    assert fake.peak == 3 and time.monotonic() - t0 < 2 * fake.seconds

    # The same run twice: one after the other (its recordings live in one folder).
    fake2 = Concurrency(0.1)
    _diagnosing(monkeypatch, batch, fake2)
    await asyncio.gather(batch.trace_failures("r02"), batch.trace_failures("r02"))
    assert fake2.per_run_peak["r02"] == 1 and fake2.calls == ["r02", "r02"]

    # The server-wide cap: with two slots, three traces never run three at once.
    monkeypatch.setattr(batch_mod, "_TRACE_SLOTS", threading.BoundedSemaphore(2))
    fake3 = Concurrency(0.1)
    _diagnosing(monkeypatch, batch, fake3)
    await asyncio.gather(*(batch.trace_failures(r) for r in ("r02", "r03", "r04")))
    assert fake3.peak == 2


class Routed(BaseChatModel):
    """Answers by role, so subagents running at once never take each other's scripted turns.

    The investigator asks for three traces in one turn, then finishes. Each code-tracer traces the run its task
    names, records one trace, and replies.
    """

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        system = _system(messages)
        last = messages[-1]
        if "You trace a robot controller" in system:
            first = next(m for m in messages if isinstance(m, HumanMessage))
            run = str(first.content).split()[-1]
            if isinstance(last, HumanMessage):
                msg = call("trace_failures", {"run_id": run, "max_episodes": 1}, f"tf-{run}")
            elif isinstance(last, ToolMessage) and last.name == "trace_failures":
                msg = call("record_trace", {"run_id": run, "symptom": f"{run} slips", "line": 3, "excerpt": "x", "why": "fixed"}, f"rt-{run}")
            else:
                msg = say(f"traced {run}")
        elif not any(isinstance(m, ToolMessage) for m in messages):
            msg = AIMessage(content="", tool_calls=[
                {"name": "task", "args": {"subagent_type": "code-tracer", "description": f"Trace run {r}"}, "id": f"task-{r}"}
                for r in ("r02", "r03", "r04")
            ])
        else:
            msg = say("done")
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def bind_tools(self, tools, **kwargs):
        return self

    @property
    def _llm_type(self) -> str:
        return "routed"


async def test_the_investigator_traces_three_runs_in_parallel(batch, monkeypatch):
    fake = Concurrency()
    _diagnosing(monkeypatch, batch, fake)
    assert "In ONE turn, call `task`" in inv_mod.main_prompt(diagnose=True)
    _scripted(monkeypatch, Routed())
    out = await _run(inv_mod.build_investigator(batch, "unused"), {"messages": [HumanMessage("go")]})

    replies = sorted(str(m.content) for m in out["messages"] if isinstance(m, ToolMessage) and m.name == "task")
    assert replies == ["traced r02", "traced r03", "traced r04"]
    assert fake.peak == 3  # all three traces were running at the same moment
    trace = json.loads((batch.dir / "case" / "case.json").read_text())["trace"]
    assert sorted((t["run_id"], t["symptom"]) for t in trace) == [("r02", "r02 slips"), ("r03", "r03 slips"), ("r04", "r04 slips")]

    # The comparison of the traces is saved as a field too.
    assert batch.case.record_trace_comparison("same", "All three slip at line 3.", ["r02", "r03", "r04"]) == "trace comparison saved"
    assert batch.case.record_trace_comparison("maybe", "x", ["r02"]).startswith("error")
    assert batch.case.data["trace_comparison"]["same"] == "same"
