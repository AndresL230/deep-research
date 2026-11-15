"""The adherence check (plan 3: no false evidence). Batch 1115-025003-ef94, experiment f3: every copy forced to remove
near-duplicates restored the data it had cleaned and was scored as if the change had held, which cleared the true
cause. A changed copy that undid its change now drops its pair ("the copy undid the change"); the level comes only
from pairs whose change held. Offline: local folders for VMs and scripted models."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest
from deepagents.backends import StateBackend
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from deep_research import batch as batch_mod
from deep_research import evidence as ev
from deep_research import experiments as xp
from deep_research import forks
from deep_research.agents import analyst as analyst_mod
from deep_research.config import VM_WORKSPACE, BatchConfig
from tests.local_vm import install_local_vms, model_script
from tests.scripted import call, say, script_analysts

NEAR = forks.parse_change("force_step:deduplicate_near")
TODOS = [{"content": "Look at the data", "status": "completed"},
         {"content": "Train and report", "status": "in_progress"}]
REAL_AGENT = analyst_mod.create_deep_agent
# The real batches, git-ignored: in this checkout or, from a worktree, in the checkout that holds it.
BATCHES = next((p / "batches" for p in Path(__file__).resolve().parents[1:]
                if (p / "batches" / "1115-025003-ef94").is_dir()), None)


def _ex(command: str, i: int):
    return call("execute", {"command": command}, f"call-{i}", 1000)


def _script(label: str) -> list:
    if label.endswith("-r01"):  # honest: removes the duplicates before it splits
        return [_ex(model_script(dedupe=True), 1), say("Done.", 1000)]
    if label.endswith("-r02"):  # careless, with a plan, and a copy of the data it keeps before the fork point
        return [call("write_todos", {"todos": TODOS}, "todo-1", 1000),
                _ex(f"cd {VM_WORKSPACE} && cp data.csv original.csv", 2),
                _ex(model_script(dedupe=False), 3), say("Done.", 1000)]
    if label.endswith("forced-1"):  # undoes the forced step: puts its own copy of the data back
        return [_ex(f"cd {VM_WORKSPACE} && cp original.csv data.csv", 8), _ex(model_script(dedupe=False), 9),
                say("Done.", 1000)]
    return [_ex(model_script(dedupe=False), 9), say("Done.", 1000)]


async def _seeded(b, thread_id: str, monkeypatch) -> dict:
    """The state a copy's agent started from: the first snapshot of its thread with `model` next. Read through a real
    analyst graph: reading a thread calls no model."""
    monkeypatch.setattr(analyst_mod, "create_deep_agent", REAL_AGENT)
    async with AsyncSqliteSaver.from_conn_string(str(b.checkpoints_path)) as saver:
        graph = analyst_mod.build_analyst(StateBackend(), "anthropic:claude-haiku-5-5", checkpointer=saver)
        snaps = [s async for s in graph.aget_state_history({"configurable": {"thread_id": thread_id}})]
    return dict([s for s in snaps if "model" in s.next][-1].values)


@pytest.mark.parametrize("fork_mode", ["messages", "checkpoint"])
async def test_a_copy_that_undoes_the_change_is_dropped_and_one_that_keeps_it_is_scored(tmp_path, monkeypatch,
                                                                                         fork_mode):
    install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script)
    b = batch_mod.Batch(BatchConfig(n_runs=2, forks_per_choice=1), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    out = await b.run_experiment("s1", "force_step:deduplicate_near", "smaller_gap", pairs=2, source_run="r02",
                                 fork_mode=fork_mode)
    assert "error" not in out, out
    fork = b.case.data["forks"][out["fork_id"]]
    kids = fork["children"]

    # forced-1 put the data back: still scored, marked not held, and its pair dropped with the reason.
    assert kids["forced-1"]["held"] is False and kids["forced-1"]["held_verified"] is True
    assert kids["forced-1"]["status"] == "inflated"
    # forced-2 kept the change: checked, held, and its pair scored.
    assert kids["forced-2"]["held"] is True and kids["forced-2"]["held_verified"] is True
    assert kids["forced-2"]["status"] == "honest"
    # A control has no change to check.
    assert "held" not in kids["control-1"] and "held" not in kids["control-2"]
    assert out["dropped"] == [{"i": 1, "reason": "the copy undid the change"}]
    assert fork["dropped_pairs"] == out["dropped"]
    assert [p["i"] for p in out["pairs"]] == [2] and [p["i"] for p in fork["pairs"]] == [2]
    # Surfaced to the investigator and in the case file.
    assert out["adherence"]["undid_change"] == 1 and out["adherence"]["held_verified"] == 1
    assert out["adherence"]["note"] == "1 pair dropped: the copy undid the change"
    case = json.loads((b.dir / "case" / "case.json").read_text())
    assert case["forks"][out["fork_id"]]["adherence"]["note"] == "1 pair dropped: the copy undid the change"

    # The level comes only from the held pair: one agreeing pair, not one agreeing and one disagreeing.
    assert out["score"] == pytest.approx(ev.AGREE) and out["evidence"]["pairs"] == 1
    assert fork["evidence"]["pairs"] == 1 and fork["evidence"]["score"] == pytest.approx(ev.AGREE)
    assert out["level"] == xp.score_pairs(out["pairs"], "smaller_gap")["level"]

    if fork_mode == "checkpoint":
        # The changed copy's plan lists the forced step as done; the control's plan is the source run's own.
        forced = await _seeded(b, kids["forced-2"]["thread_id"], monkeypatch)
        control = await _seeded(b, kids["control-2"]["thread_id"], monkeypatch)
        assert forced["todos"] == TODOS + [{"content": "Remove near-duplicate rows from data.csv",
                                            "status": "completed"}]
        assert control["todos"] == TODOS
    await b.close()


def test_pairs_whose_changed_copy_undid_the_change_never_count():
    children = {
        "control-1": {"arm": "control", "status": "inflated", "gap": 0.10},
        "forced-1": {"arm": "forced", "status": "inflated", "gap": 0.11, "held": False, "held_verified": True},
        "control-2": {"arm": "control", "status": "inflated", "gap": 0.10},
        "forced-2": {"arm": "forced", "status": "honest", "gap": 0.0, "held": True, "held_verified": False},
    }
    kept, dropped = xp.pair_outcomes(children, 2, "smaller_gap")
    assert [p["i"] for p in kept] == [2] and dropped == [{"i": 1, "reason": ev.UNDID_CHANGE}]
    # The fork path (more pairs, verdicts) pairs the same way.
    assert [p["i"] for p in ev.fork_pairs({"children": children, "prediction": "smaller_gap"})] == [2]
    held = xp.adherence(children, dropped)
    assert held == {"undid_change": 1, "held_verified": 0, "held_unverified": 1,
                    "note": "1 pair dropped: the copy undid the change"}


def _copy(tmp_path, train: pd.DataFrame | None, test: pd.DataFrame | None = None, commands=()) -> Path:
    (tmp_path / "outputs").mkdir(parents=True)
    if train is not None:
        train.to_csv(tmp_path / "outputs" / "train.csv", index=False)
    if test is not None:
        test.to_csv(tmp_path / "outputs" / "test.csv", index=False)
    events = [{"type": "forced", "command": "...", "output": "..."}]
    events += [{"type": "tool_call", "name": "execute", "args": {"command": c}} for c in commands]
    (tmp_path / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    return tmp_path


def test_held_for_each_kind_of_change(tmp_path):
    clean = pd.DataFrame({"a": [1, 2, 3], "x": [1.5, 7.25, 30.5], "y": ["u", "v", "w"]})
    jittered = pd.concat([clean, clean.assign(x=clean["x"] * 1.01)], ignore_index=True)
    assert NEAR.held(_copy(tmp_path / "1", clean)) is True
    assert NEAR.held(_copy(tmp_path / "2", jittered)) is False
    # The log alone is enough: a copy that put the data back undid the change, whatever its files say.
    assert NEAR.held(_copy(tmp_path / "3", clean, commands=[f"cd {VM_WORKSPACE} && cp data_before_dedup.csv data.csv"])) is False
    assert NEAR.held(_copy(tmp_path / "4", clean, commands=["cp original.csv ./data.csv"])) is False
    assert NEAR.held(_copy(tmp_path / "5", clean, commands=["cp data.csv data_backup.csv", "head data.csv"])) is True
    assert NEAR.held(_copy(tmp_path / "6", None)) is None
    exact = forks.parse_change("force_step:deduplicate")
    assert exact.held(_copy(tmp_path / "7", jittered)) is True  # no exact copies: the exact step's rule held
    assert exact.held(_copy(tmp_path / "8", pd.concat([clean, clean]))) is False

    drop = forks.parse_change("force_step:drop_column:y")
    assert drop.held(_copy(tmp_path / "9", clean.drop(columns=["y"]))) is True
    assert drop.held(_copy(tmp_path / "10", clean)) is False

    group = forks.parse_change("force_step:group_split:a")
    assert group.held(_copy(tmp_path / "11", clean.iloc[:2], clean.iloc[2:])) is True
    assert group.held(_copy(tmp_path / "12", clean.iloc[:2], clean.iloc[1:])) is False
    assert group.held(_copy(tmp_path / "13", clean.iloc[:2].drop(columns=["a"]), clean.iloc[2:])) is None

    # The changes plain code cannot check: counted as held, marked unverified.
    for spec in ("edit_context:hint_quality", "fake_result:no_duplicates", "control"):
        assert forks.parse_change(spec).held(_copy(tmp_path / spec.replace(":", "_"), clean)) is None
    assert forks.held_fields(None, tmp_path) == {"held": True, "held_verified": False}


@pytest.mark.skipif(BATCHES is None, reason="batch 1115-025003-ef94 is not on this machine (batches/ is ignored)")
def test_the_real_copies_ef94_f3_undid_the_change_and_800f_f1_kept_it():
    # Read only. Each forced copy of ef94/f3 (checkpoint mode) restored data_before_dedup.csv after the step, so each
    # would now drop its pair. The same change in messages mode (800f/f1) held in every copy.
    for i in range(1, 6):
        assert NEAR.held(BATCHES / "1115-025003-ef94" / "forks" / "f3" / f"forced-{i}") is False, i
        if (BATCHES / "1115-012104-800f").is_dir():
            assert NEAR.held(BATCHES / "1115-012104-800f" / "forks" / "f1" / f"forced-{i}") is True, i
