"""The two-factor grid (plan 6.4) is reachable: the investigator's `run_interaction` tool, behind the same approval as
`run_experiment`, allowed only for two supported suspects, and `cli interaction`. Offline: local VMs, scripted models."""

from __future__ import annotations

import pytest

from deep_research import cli
from deep_research import interaction as ixn
from deep_research.agents import investigator as inv_mod
from tests.scripted import call, say, script_investigator
from tests.test_batch_offline import _case, _run_batch, local_vms  # noqa: F401 - the fixture is used by name
from tests.test_investigator_science import SUSPECTS, _tool_results

GRID = {"suspect_a": "s1", "suspect_b": "s2", "per_cell": 2, "reason": "both are supported; do they add up?"}


def _support(b, sid: str, change: str, fork_id: str) -> None:
    """What two finished experiments leave behind when they each support their suspect."""
    b.case.update_fork(fork_id, status="done", kind="method", suspect_id=sid, change=change, anchor="before_split",
                       pairs=[], score=24.76, level="supported")
    b.case.set_suspect_evidence(sid, {"pairs": 5, "agree": 5, "score": 24.76, "level": "supported",
                                      "experiments": [fork_id]})


async def test_the_investigator_runs_the_grid_after_approval_when_both_suspects_are_supported(local_vms, tmp_path,
                                                                                               monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    assert b.case.record_suspects(SUSPECTS["suspects"]).startswith("suspects saved: s1, s2")
    _support(b, "s1", "force_step:deduplicate", "f8")
    _support(b, "s2", "edit_context:hint_quality", "f9")
    script_investigator(monkeypatch, [call("run_interaction", GRID, "g1"), say("The grid is in.")])
    await b.investigate()
    case = _case(b)
    pending = case["forks"]["pending"]
    assert case["phase"] == "awaiting_approval" and pending["kind"] == "interaction"
    assert (pending["suspect_a"], pending["suspect_b"], pending["per_cell"], pending["vm_count"]) == ("s1", "s2", 2, 9)
    assert "estimate_usd" in pending and case.get("interaction") is None  # nothing ran before the approval

    await b.decide(True, pairs=1)  # the edit path: one copy per cell instead of two
    case = _case(b)
    grid = case["interaction"]
    assert grid["suspects"] == ["s1", "s2"] and grid["per_cell"] == 1 and grid["reason"] == GRID["reason"]
    assert (grid["change_a"], grid["change_b"]) == ("force_step:deduplicate", "edit_context:hint_quality")
    assert sorted(case["forks"][grid["fork_id"]]["children"]) == ["a-1", "b-1", "both-1", "neither-1"]
    assert grid["effect_a"] > 0.05 and abs(grid["effect_b"]) < 0.05
    assert '"effect_a"' in _tool_results(b, "run_interaction")[0]
    await b.close()


async def test_the_grid_is_refused_unless_both_suspects_are_supported(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    b.case.record_suspects(SUSPECTS["suspects"])
    _support(b, "s1", "force_step:deduplicate", "f8")
    case = b.case.read()
    assert "s2 is proposed, not supported" in ixn.suspect_changes(case, "s1", "s2")
    assert "two different suspects" in ixn.suspect_changes(case, "s1", "s1")
    assert "unknown suspect s7" in ixn.suspect_changes(case, "s1", "s7")
    # Declined by the person: nothing runs, and the investigator is told.
    _support(b, "s2", "edit_context:hint_quality", "f9")
    script_investigator(monkeypatch, [call("run_interaction", GRID, "g1"), say("Declined, so no grid.")])
    await b.investigate()
    await b.decide(False)
    assert _case(b).get("interaction") is None and _case(b)["phase"] == "done"
    await b.close()


def test_the_grid_waits_for_the_same_approval_as_an_experiment(local_vms, tmp_path, monkeypatch):
    seen = {}

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return None

    monkeypatch.setattr(inv_mod, "create_deep_agent", spy)
    from deep_research.batch import Batch
    from deep_research.config import BatchConfig

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    inv_mod.build_investigator(Batch(BatchConfig(), batch_id="1115-000000-grid", root=tmp_path), "unused")
    assert seen["interrupt_on"]["run_interaction"] == seen["interrupt_on"]["run_experiment"]
    assert "run_interaction" in {t.name for t in seen["tools"]}
    assert "run_interaction" in inv_mod.main_prompt() and "both `supported`" in inv_mod.main_prompt()


async def test_cli_interaction_runs_the_grid_for_two_supported_suspects(local_vms, tmp_path, monkeypatch, capsys):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False, budget_usd=2.0)
    b.case.record_suspects(SUSPECTS["suspects"])
    _support(b, "s1", "force_step:deduplicate", "f8")
    monkeypatch.setattr(cli, "BATCHES_DIR", b.root)
    with pytest.raises(SystemExit, match="not supported"):
        await cli.interaction(b.id, "s1", "s2", 1, None, True)
    _support(b, "s2", "edit_context:hint_quality", "f9")
    await b.close()
    await cli.interaction(b.id, "s1", "s2", 1, None, True)
    out = capsys.readouterr().out
    assert "yes (auto)" in out and '"effect_a"' in out
    grid = _case(b)["interaction"]
    assert grid["suspects"] == ["s1", "s2"] and grid["per_cell"] == 1


def test_cli_parses_the_interaction_command(monkeypatch):
    got = []

    async def fake(*args):
        got.append(args)

    monkeypatch.setattr(cli, "interaction", fake)
    cli.main(["interaction", "1115-000000-grid", "--a", "s1", "--b", "s2", "--per-cell", "2", "--auto-approve"])
    assert got == [("1115-000000-grid", "s1", "s2", 2, None, True)]
