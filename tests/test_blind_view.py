"""MASTER_PLAN 6.2: the blind view. The evaluator's measure of the flaw (`overlap_share`, `n_test_copies`), the data
seed, and the plan's banned sections never reach the investigator, and a run's score.json is unreadable under /runs/,
by read_file, ls, glob and grep. The words "planted" and "trap" are in none of the view, the prompts or the skills."""

from __future__ import annotations

import asyncio
import json
import re

import pytest
from deepagents.middleware.rubric import RubricMiddleware
from langchain_core.messages import HumanMessage

from deep_research import forks, traps
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


# ---- the trap catalog: no trap's name and no trap's own column reaches the investigator ----

def _trap_words() -> re.Pattern:
    words = {*traps.names(), *(c for t in traps.registered() for c in t.columns)}
    assert {"duplicates", "leaky_column", "repeat_rows", "followup_score", "subject_id"} <= words
    return re.compile(r"(?<![A-Za-z0-9_])(%s)(?![A-Za-z0-9_])" % "|".join(map(re.escape, sorted(words))), re.IGNORECASE)


def _hit(rx: re.Pattern, text: str) -> str | None:
    m = rx.search(text)
    return None if m is None else text[max(0, m.start() - 80):m.end() + 40]


@pytest.mark.parametrize("name", [d.name for d in registered()])
def test_no_prompt_skill_or_change_list_names_a_trap_or_its_column(name):
    rx = _trap_words()
    d = next(x for x in registered() if x.name == name)
    cfg = BatchConfig(domain=name)
    texts = {
        "main": inv_mod.main_prompt(d.planted(cfg), d.labels(), d.investigator_words, diagnose=True, direct_fix=True),
        "hypothesis": inv_mod.hypothesis_prompt(d.investigator_words),
        "tagger": inv_mod.tagger_prompt(d.labels(), d.investigator_words),
        "lenses": " ".join(inv_mod.lens_prompt(k, d.investigator_words) for k in ("omission", "commission", "data")),
        "others": " ".join((inv_mod.SKEPTIC_PROMPT, inv_mod.GENERAL_PROMPT, inv_mod.TRACER_PROMPT, inv_mod.RUBRIC)),
        "skills": " ".join(p.read_text() for p in d.skills_dir.rglob("*.md")),
        "list_changes": json.dumps(forks.blind_changes(lambda lb: d.intervention_for(lb, cfg), d.labels(),
                                                       tabular=name == "tabular")),
    }
    for where, text in texts.items():
        assert _hit(rx, text) is None, (where, _hit(rx, text))


def test_the_change_list_is_generic_and_maps_nothing_to_a_trap():
    listed = forks.blind_changes()
    names = [row["change"] for rows in listed.values() for row in rows]
    assert {"control", "force_step:deduplicate", "force_step:deduplicate_near", "force_step:drop_column:<column>",
            "force_step:group_split:<column>", "fake_result:no_duplicates"} <= set(names)
    # A trap's own fixed step (the leak column's drop, the one-visit-per-subject keep) is not offered by its label.
    assert "force_step:drop_leak" not in names and "force_step:group_split" not in names
    assert all(set(row) == {"change", "does"} for rows in listed.values() for row in rows)
    # The orchestrator's full registry still has them.
    assert "force_step:drop_leak" in forks.registry()["force_step"] and forks.trap_fixes()


def test_a_named_column_is_checked_against_the_data_and_a_trap_step_by_label_is_refused():
    cols = ["age", "visit", "label"]
    assert forks.parse_change("force_step:drop_column:age", columns=cols).step is not None
    step = forks.parse_change("force_step:group_split:visit", columns=cols)
    assert step.about == "group_split" and "subset=['visit']" in step.step["command"]
    for spec in ("force_step:drop_column:nope", "force_step:group_split:nope"):
        with pytest.raises(forks.ChangeError, match="not a column of this batch's data.csv") as e:
            forks.parse_change(spec, columns=cols)
        assert "age" not in str(e.value)  # the error never lists the columns
    for spec in ("force_step:drop_leak", "force_step:group_split"):
        assert "generic changes" in forks.blind_change_error(forks.parse_change(spec))
    for spec in ("force_step:deduplicate", "force_step:drop_column:age", "edit_context:hint_quality", "control"):
        assert forks.blind_change_error(forks.parse_change(spec)) is None


@pytest.mark.parametrize("trap", [t.name for t in traps.registered()])
def test_nothing_the_investigator_reads_or_gets_back_names_a_trap(trap, tmp_path, monkeypatch):
    """Every file it is pointed at and every tool output it gets, list_changes included, in a batch of each trap."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    rx = _trap_words()
    # The method gate (plan, lenses, skeptic first) is off: this test is about what the tools say, not the order.
    b = Batch(BatchConfig(trap=trap, investigator_strict=False), batch_id="1114-000000-cata", root=tmp_path)
    b.case.update_run("r01", status="honest", true_accuracy=0.8, overlap_share=0.0)
    b.case.update_run("r02", status="inflated", true_accuracy=0.6, overlap_share=0.5)
    b.case.set_split({"label": "deduplicate", "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1,
                      "fork_run_id": "r02", "fork_at": 2})
    assert b.data_columns()  # the task's data.csv is there, with the trap's columns in it
    suspects = {"suspects": [{"target": "deduplicate", "kind": "omission", "rationale": "r01 did it, r02 did not"},
                             {"target": "inspect", "kind": "omission", "rationale": "r01 looked first, r02 did not"}]}
    Recording.seen = []
    model = Recording(messages=iter([
        call("list_changes", {}, "c1"),
        call("list_interventions", {}, "c2"),
        call("read_file", {"file_path": "/case/case.json", "limit": 2000}, "c3"),
        call("ls", {"path": "/"}, "c4"),
        call("glob", {"pattern": "**/*", "path": "/skills"}, "c5"),
        call("read_file", {"file_path": "/skills/method-errors/SKILL.md", "limit": 2000}, "c6"),
        call("read_file", {"file_path": "/memories/casebook.md"}, "c7"),
        call("grep", {"pattern": "followup", "path": "/runs"}, "c8"),
        call("record_suspects", suspects, "c9"),
        # A trap's own step by its label is refused, and a column the data does not have is refused, both by name.
        call("run_experiment", {"suspect_id": "s1", "change": "force_step:drop_leak", "prediction": "smaller_gap"}, "c10"),
        call("run_experiment", {"suspect_id": "s1", "change": "force_step:group_split", "prediction": "smaller_gap"},
             "c11"),
        call("run_experiment", {"suspect_id": "s1", "change": "force_step:drop_column:nope",
                                "prediction": "smaller_gap"}, "c12"),
        call("run_interaction", {"suspect_a": "s1", "suspect_b": "s2"}, "c13"),
        say("done"),
    ]))
    real = inv_mod.create_deep_agent

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        kwargs["middleware"] = [m for m in kwargs.get("middleware") or [] if not isinstance(m, RubricMiddleware)]
        kwargs["interrupt_on"] = {}  # the tools' own answers are what is checked here, not the approval
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)
    agent = inv_mod.build_investigator(b, "unused")
    asyncio.run(agent.ainvoke({"messages": [HumanMessage("Investigate this batch.")]},
                              {"configurable": {"thread_id": "catalog"}, "recursion_limit": 80}))
    seen = _text(Recording.seen)
    assert "force_step:group_split:<column>" in seen and '"status": "inflated"' in seen  # the tools did run
    assert "'force_step:drop_leak' is not one of the generic changes" in seen
    assert "'force_step:group_split' is not one of the generic changes" in seen
    assert "not a column of this batch's data.csv" in seen and "not supported" in seen
    assert _hit(rx, seen) is None, _hit(rx, seen)
