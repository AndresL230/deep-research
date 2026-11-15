"""MASTER_PLAN 6.2: the blind view. The evaluator's measure of the flaw (`overlap_share`, `n_test_copies`), the data
seed, and the plan's banned sections never reach the investigator, and a run's score.json is unreadable under /runs/,
by read_file, ls, glob and grep. The words "planted" and "trap" are in none of the view, the prompts or the skills."""

from __future__ import annotations

import asyncio
import json
import re

import pytest
from langchain_core.messages import HumanMessage

from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from deep_research.case_file import BANNED_VIEW_KEYS, investigator_view
from deep_research.config import FIXTURES_DIR, BatchConfig
from deep_research.domains import registered
from tests.scripted import ScriptedModel, call, say
from tests.test_blind_investigator import _text

WORDS = re.compile(r"planted|trap", re.IGNORECASE)


def _keys(x) -> set[str]:
    if isinstance(x, dict):
        return set(x) | {k for v in x.values() for k in _keys(v)}
    if isinstance(x, list):
        return {k for v in x for k in _keys(v)}
    return set()


def test_the_view_drops_every_banned_key():
    data = {
        "config": {"trap": "duplicates", "trap_strength": 0.5, "trap_noise": 0.0, "seed": 7, "n_runs": 2},
        "runs": {"r01": {"status": "inflated", "gap": 0.2, "overlap_share": 0.52, "n_test_copies": 80}},
        "forks": {"f1": {"children": {"control-1": {"status": "inflated", "overlap_share": 0.52, "n_test_copies": 80}}}},
        "baseline": {"overlap_share": 0.1}, "fix": {"measured": {"overlap_share": 0.1}},
        "candidates": [{"label": "deduplicate"}], "audit": {"r01": {}},
        "split": {"label": "deduplicate"},
    }
    view = investigator_view(data)
    assert not _keys(view) & set(BANNED_VIEW_KEYS)
    assert view["runs"]["r01"] == {"status": "inflated", "gap": 0.2} and view["config"] == {"n_runs": 2}
    assert not WORDS.search(json.dumps(view))
    # Kept on purpose (docs/PLAN_STATUS.md): the deterministic split.
    assert view["split"] == {"label": "deduplicate"}


@pytest.mark.parametrize("fixture", sorted(p.name for p in FIXTURES_DIR.iterdir() if (p / "case" / "case.json").is_file()))
def test_no_fixtures_view_holds_a_banned_key_or_the_words(fixture):
    view = investigator_view(json.loads((FIXTURES_DIR / fixture / "case" / "case.json").read_text()))
    assert not _keys(view) & set(BANNED_VIEW_KEYS)
    assert not WORDS.search(json.dumps(view))


@pytest.mark.parametrize("name", [d.name for d in registered()])
def test_no_prompt_or_skill_says_planted_or_trap(name):
    d = next(x for x in registered() if x.name == name)
    texts = {
        "main": inv_mod.main_prompt(d.planted(BatchConfig(domain=name)), d.labels(), d.investigator_words,
                                    diagnose=True, direct_fix=True),
        "hypothesis": inv_mod.hypothesis_prompt(d.investigator_words),
        "tagger": inv_mod.tagger_prompt(d.labels(), d.investigator_words),
        "tracer": inv_mod.TRACER_PROMPT,
        "rubric": inv_mod.RUBRIC,
        "skill": (d.skills_dir / d.investigator_words.skill / "SKILL.md").read_text(),
    }
    for where, text in texts.items():
        assert not WORDS.search(text), (where, WORDS.search(text).group(0))


class Recording(ScriptedModel):
    seen: list = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        Recording.seen.extend(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def test_score_json_is_unreadable_under_runs_by_every_file_tool(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    b = Batch(BatchConfig(), batch_id="1114-000000-scor", root=tmp_path)
    b.case.update_run("r01", status="inflated", overlap_share=0.52, n_test_copies=80)
    (b.runs_dir / "r01").mkdir(parents=True, exist_ok=True)
    (b.runs_dir / "r01" / "score.json").write_text(json.dumps({"overlap_share": 0.5217, "secret": "SCORE-SECRET"}))
    (b.runs_dir / "r01" / "notes.txt").write_text("the analyst's own notes")
    Recording.seen = []
    model = Recording(messages=iter([
        call("read_file", {"file_path": "/runs/r01/score.json"}, "c1"),
        call("ls", {"path": "/runs/r01"}, "c2"),
        call("glob", {"pattern": "**/score.json", "path": "/runs"}, "c3"),
        call("grep", {"pattern": "SCORE-SECRET", "path": "/runs"}, "c4"),
        call("grep", {"pattern": "overlap_share"}, "c5"),
        call("read_file", {"file_path": "/runs/r01/notes.txt"}, "c6"),
        call("read_file", {"file_path": "/case/case.json", "limit": 2000}, "c7"),
        say("done"),
    ]))
    real = inv_mod.create_deep_agent

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        kwargs["middleware"] = []
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)
    agent = inv_mod.build_investigator(b, "unused")
    asyncio.run(agent.ainvoke({"messages": [HumanMessage("Investigate this batch.")]},
                              {"configurable": {"thread_id": "score"}, "recursion_limit": 60}))
    seen = _text(Recording.seen)
    assert "the analyst's own notes" in seen and '"status": "inflated"' in seen  # the tools did run
    assert "SCORE-SECRET" not in seen and "0.5217" not in seen and "0.52" not in seen
    assert "overlap_share" not in seen.replace('"pattern": "overlap_share"', "")
