"""The investigator is blind to what the evaluator knows.

What a batch was built to go wrong (the planted trap, its honest step and its fix), the hidden truth per case (hidden
can positions, holdout labels) and the domain's pitch about how agents fail are the evaluator's. The investigator
has to find the cause from the runs. These tests look at everything that can reach the investigator's model: its
prompts, its subagents' prompts, the skills, the case file view, and what its own file tools return when it goes
looking, including outside the folders it is given.
"""

from __future__ import annotations

import asyncio
import json
import math

import pytest
from langchain_core.messages import BaseMessage, HumanMessage

from deep_research import traps
from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from deep_research.case_file import investigator_view
from deep_research.config import ROOT_DIR, BatchConfig
from deep_research.domains import get as get_domain
from tests.scripted import ScriptedModel, call, say

# Words that only someone who knows the batch's design could write.
ROBOT_LEAKS = ("The batch is planted for", "planted", "report a success rate from the one practice can position")


def _leaks(trap) -> tuple[str, ...]:
    return (trap.planted, trap.description, "trap_info", "planted in it")


class Recording(ScriptedModel):
    """Keeps every message any part of the investigator (main agent or subagent) was given."""

    seen: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        Recording.seen.extend(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _text(messages: list[BaseMessage]) -> str:
    return "\n".join(m.content if isinstance(m.content, str) else json.dumps(m.content) for m in messages)


@pytest.mark.parametrize("trap", [t.name for t in traps.registered()])
def test_no_prompt_names_the_planted_trap(trap):
    t = traps.get(trap)
    d = get_domain("tabular")
    prompts = [inv_mod.main_prompt(t.planted, d.labels(), d.investigator_words, diagnose=True, direct_fix=True),
               inv_mod.main_prompt(t.planted), inv_mod.hypothesis_prompt(d.investigator_words),
               inv_mod.tagger_prompt(d.labels(), d.investigator_words), inv_mod.TRACER_PROMPT, inv_mod.RUBRIC]
    for p in prompts:
        for leak in _leaks(t):
            assert leak not in p, (leak, p[:200])


def test_the_robot_prompt_and_skill_name_no_planted_step():
    d = get_domain("robot_arm")
    prompt = inv_mod.main_prompt(d.planted(BatchConfig(domain="robot_arm")), d.labels(), d.investigator_words,
                                 diagnose=True, direct_fix=True)
    skill = (d.skills_dir / d.investigator_words.skill / "SKILL.md").read_text()
    for leak in ROBOT_LEAKS:
        assert leak not in prompt and leak not in skill, leak
    # The skill still teaches the method errors: it just never says which one this batch has.
    assert "vary_positions" in skill and "which row, if any, applies to this batch" in skill


def test_the_tabular_skill_points_at_no_planted_trap():
    skill = (ROOT_DIR / "skills" / "method-errors" / "SKILL.md").read_text()
    assert "trap_info" not in skill and "planted" not in skill


def test_the_case_view_drops_every_privileged_key():
    data = {
        "config": {"trap": "duplicates", "trap_info": {"label": "deduplicate"}, "trap_strength": 0.5, "trap_noise": 0.0,
                   "trap_hidden_share": 1.0, "hint_level": "light", "n_runs": 4,
                   "domain_info": {"name": "robot_arm", "description": "report a success rate from the one practice can "
                                   "position", "words": {"subject": "robot"}}},
        "runs": {"r01": {"status": "inflated", "true_accuracy": 0.6, "hidden_results": [{"can_xy": [0.61, 0.2]}]}},
        "forks": {"f1": {"children": {"control-1": {"status": "inflated", "hidden_results": [{"can_xy": [0.61, 0.2]}]}}}},
        "baseline": {"true_accuracy": 0.5, "hidden_results": [{"can_xy": [0.61, 0.2]}]},
        "fix": {"measured": {"before": {}, "hidden_results": [{"can_xy": [0.61, 0.2]}]}},
    }
    view = json.dumps(investigator_view(data))
    for leak in ("trap", "hint_level", "description", "words", "hidden_results", "0.61"):
        assert leak not in view, leak
    # What the investigator needs stays: the statuses, the measured numbers, the domain's name.
    assert '"inflated"' in view and '"true_accuracy": 0.6' in view and '"robot_arm"' in view and '"n_runs": 4' in view


@pytest.fixture
def batch(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(trap="repeat_rows"), batch_id="1114-000000-blnd", root=tmp_path)
    assert b.case.data["config"]["trap_info"]["label"] == "group_split"  # the evaluator knows the trap
    b.case.update_run("r01", status="honest", true_accuracy=0.7, hidden_results=[{"secret": "row-label-HIDDEN-1"}])
    b.case.update_run("r02", status="inflated", true_accuracy=0.7, hidden_results=[{"secret": "row-label-HIDDEN-2"}])
    b.case.set_split({"label": "deduplicate", "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1,
                      "fork_run_id": "r02", "fork_at": 2})
    return b


def test_the_investigators_own_tools_find_nothing_privileged(batch, monkeypatch):
    """Everything the model is shown while it reads the case file, the skill, the interventions, and tries the real
    case file and the task folder behind its mounts."""
    Recording.seen = []
    model = Recording(messages=iter([
        call("read_file", {"file_path": "/case/case.json", "limit": 2000}, "c1"),
        call("read_file", {"file_path": "/case/../case.json"}, "c2"),
        call("read_file", {"file_path": "/case/../../task/meta.json"}, "c3"),
        call("ls", {"path": "/"}, "c4"),
        call("glob", {"pattern": "**/*", "path": "/case"}, "c5"),
        call("read_file", {"file_path": "/skills/method-errors/SKILL.md", "limit": 2000}, "c6"),
        call("list_interventions", {}, "c7"),
        call("record_hypothesis", {"kind": "method", "step_label": "deduplicate", "statement": "s",
                                   "supporting_evidence": "e", "prediction": "p", "falsified_if": "f",
                                   "confidence": "low"}, "c8"),
        say("done"), say("done"), say("done"),
    ]))
    real = inv_mod.create_deep_agent

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        kwargs["middleware"] = []
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)
    agent = inv_mod.build_investigator(batch, "unused")
    asyncio.run(agent.ainvoke({"messages": [HumanMessage("Investigate this batch.")]},
                              {"configurable": {"thread_id": "blind"}, "recursion_limit": 100}))

    seen = _text(Recording.seen)
    assert '"status": "inflated"' in seen  # it did read the view
    t = traps.get("repeat_rows")
    for leak in (*_leaks(t), "row-label-HIDDEN", "hidden_results", '"trap"'):
        assert leak not in seen, leak
    # The real case file, next to the view, holds the trap; the investigator's path out of /case/ must not reach it.
    assert "trap_info" in (batch.dir / "case" / "case.json").read_text()


def test_the_trace_never_runs_a_hidden_position():
    """The investigator reads where a controller fails on the trace's positions; the fix it proposes is then measured
    on the hidden ones. The two sets must not overlap, or the fix is tuned on its own test."""
    from sim import hidden
    from sim.domain import diagnostic_positions

    diag, held_out = diagnostic_positions(), hidden.hidden_positions()
    assert len(diag) >= 10
    assert min(math.dist(a, b) for a in diag for b in held_out) >= hidden.MIN_FROM_HIDDEN
