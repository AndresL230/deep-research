"""The whole batch pipeline, offline: real orchestrator code, a scripted model, and a local folder in place of each VM.

The scripted analyst runs real shell commands and really trains a random forest on the trapped data, so
scoring, the split finding, replay, the forced step and both fork arms are exercised end to end.
No keys, no VMs, no model calls.
"""

import json

import pandas as pd
import pytest
from langchain_core.messages import AIMessage, messages_from_dict

from deep_research import batch as batch_mod
from deep_research import forks as forks_mod
from deep_research.batch import Batch
from deep_research.config import VM_WORKSPACE, BatchConfig
from deep_research.events import PREFIX_EVENTS, read_events
from tests.local_vm import COUNT_DUPLICATES, LOOK, install_local_vms, model_script
from tests.scripted import call, say, script_analysts, script_investigator

# Every scripted analyst response reports this many prompt tokens, so costs are exercised too.
ANALYST_TOKENS = 1000


def _execute(command: str, i: int):
    return call("execute", {"command": command}, f"call-{i}", ANALYST_TOKENS)


def _script_for(label: str) -> list:
    if label.endswith("-r01"):  # the honest analyst: looks, checks duplicates, removes them, then models
        return [_execute(LOOK, 1), _execute(COUNT_DUPLICATES, 2), _execute(model_script(dedupe=True), 3),
                say("Done. I removed the duplicate rows before splitting.", ANALYST_TOKENS)]
    if label.endswith("-r02"):  # the careless analyst: looks, then models
        return [_execute(LOOK, 1), _execute(model_script(dedupe=False), 2), say("Done.", ANALYST_TOKENS)]
    # A fork child picks up the careless run after its first look and models whatever data it finds.
    return [_execute(model_script(dedupe=False), 9), say("Done.", ANALYST_TOKENS)]


@pytest.fixture
def local_vms(tmp_path, monkeypatch):
    """Every VM call lands on a local folder, and each analyst gets the script for its VM."""
    log = install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script_for)
    return log


def _case(b: Batch) -> dict:
    return json.loads((b.dir / "case" / "case.json").read_text())


async def _run_batch(tmp_path, **config) -> Batch:
    b = Batch(BatchConfig(n_runs=2, forks_per_choice=1, **config), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    return b


async def test_runs_are_scored_against_the_hidden_holdout_and_the_split_is_found(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    case = _case(b)
    honest, inflated = case["runs"]["r01"], case["runs"]["r02"]

    assert case["phase"] == "ready"
    assert honest["status"] == "honest" and honest["overlap_share"] == 0.0
    assert inflated["status"] == "inflated" and inflated["overlap_share"] > 0.3
    assert inflated["gap"] > b.cfg.inflation_threshold > honest["gap"]
    # Both runs really predicted the hidden holdout: the true scores are close, only the claims differ.
    assert abs(honest["true_accuracy"] - inflated["true_accuracy"]) < 0.08
    assert inflated["reported_accuracy"] - honest["reported_accuracy"] > 0.08

    # Every tool call was logged, in order, with the labels the split finder needs.
    assert honest["n_actions"] == 3 and inflated["n_actions"] == 2
    # Counting the copies is a look (inspect); the script that drops them and then splits is the step.
    assert "inspect" in honest["labels"][1] and "deduplicate" not in honest["labels"][1]
    assert {"deduplicate", "split"} <= set(honest["labels"][2])
    assert "deduplicate" not in sum(inflated["labels"], []) and "split" in inflated["labels"][1]
    events = read_events(b.runs_dir / "r02" / "events.jsonl")
    assert [e["type"] for e in events] == ["tool_call", "tool_result", "tool_call", "tool_result", "thought"]
    assert "test accuracy" in events[3]["content"]

    split = case["split"]
    assert split["label"] == "deduplicate" and (split["honest_rate"], split["inflated_rate"]) == (1.0, 0.0)
    assert (split["fork_run_id"], split["fork_at"]) == ("r02", 1)
    assert split["intervention"]

    # The saved history is what a fork is cut from: it must hold the run's tool calls, in the same order as the log.
    msgs = messages_from_dict(json.loads((b.runs_dir / "r02" / "messages.json").read_text()))
    calls = [tc["args"]["command"] for m in msgs if isinstance(m, AIMessage) for tc in m.tool_calls]
    assert calls == [e["args"]["command"] for e in events if e["type"] == "tool_call"]

    # The holdout labels stayed on the server: never copied into a VM folder.
    assert not list(local_vms["root"].rglob("holdout_labels*"))
    assert {"run:r01", "run:r02"} <= set(case["costs"]["scopes"])
    await b.close()
    assert sorted(local_vms["stopped"]) == ["t-r01", "t-r02"]


async def test_the_fork_experiment_changes_one_step_and_keeps_a_control(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    summary = await b.run_forks(1)
    case = _case(b)
    fork = case["forks"]["f1"]
    control, forced = fork["children"]["control-1"], fork["children"]["forced-1"]

    assert case["phase"] == "forked" and fork["status"] == "done"
    assert (fork["source_run"], fork["fork_at"], fork["label"]) == ("r02", 1, "deduplicate")
    # Same starting point, one difference: the control copy repeats the inflated result, the forced copy does not.
    assert control["status"] == "inflated" and control["how"] == "fork"
    assert forced["status"] == "honest" and forced["how"] == "fork"
    assert forced["overlap_share"] == 0.0 and control["overlap_share"] > 0.3
    assert fork["arms"]["control"]["inflated"] == 1 and fork["arms"]["forced"]["inflated"] == 0
    assert "Control: 1 of 1 inflated" in summary and "0 of 1 inflated" in summary

    # The base VM was rebuilt by replaying the source run's actions before the fork point, then forked once per arm.
    arms = list(b.arm_plan())
    assert "t-f1-base" in local_vms["created"]
    assert sorted(local_vms["forked"]) == sorted(f"t-f1-{a}-1" for a in arms)
    vms_root = local_vms["root"]
    data = lambda vm: pd.read_csv(vms_root / vm / VM_WORKSPACE.lstrip("/") / "data.csv")  # noqa: E731
    assert data("t-f1-control-1").duplicated().sum() > 0   # untouched
    assert data("t-f1-forced-1").duplicated().sum() == 0   # the forced step really ran in this copy only
    assert data("t-f1-base").duplicated().sum() > 0

    # The forced copy's log starts with the forced step, and its model saw that step as a normal tool call.
    forced_events = read_events(b.forks_dir / "f1" / "forced-1" / "events.jsonl")
    assert forced_events[0]["type"] == "forced" and "Removed" in forced_events[0]["output"]
    control_events = read_events(b.forks_dir / "f1" / "control-1" / "events.jsonl")
    assert control_events[0]["type"] == "tool_call"
    # Next to each copy's log, the source run's events up to the fork: its one action and that action's result.
    prefix = read_events(b.forks_dir / "f1" / "forced-1" / PREFIX_EVENTS)
    source = read_events(b.runs_dir / "r02" / "events.jsonl")
    assert prefix == source[: len(prefix)] and [e["type"] for e in prefix if e["type"].startswith("tool")] == ["tool_call", "tool_result"]

    assert {"fork:f1:base", *(f"fork:f1:{a}-1" for a in arms)} <= set(case["costs"]["scopes"])
    assert "t-f1-base" in local_vms["stopped"]
    await b.close()
    assert {f"t-f1-{a}-1" for a in arms} <= set(local_vms["stopped"])


async def test_fork_children_are_rebuilt_by_replay_when_the_vm_cannot_be_forked(local_vms, tmp_path, monkeypatch):
    def no_fork(sb, name=None):
        raise RuntimeError("forking is not available on this plan")

    monkeypatch.setattr(batch_mod.vms, "fork_vm", no_fork)
    b = await _run_batch(tmp_path)
    await b.run_forks(1)
    fork = _case(b)["forks"]["f1"]
    control, forced = fork["children"]["control-1"], fork["children"]["forced-1"]
    assert control["how"] == "replay" and forced["how"] == "replay"
    assert control["status"] == "inflated" and forced["status"] == "honest"
    await b.close()


async def test_the_reason_a_vm_could_not_be_forked_is_logged(local_vms, tmp_path, monkeypatch, caplog):
    def no_fork(sb, name=None):
        raise RuntimeError("forking is not available on this plan")

    monkeypatch.setattr(batch_mod.vms, "fork_vm", no_fork)
    b = await _run_batch(tmp_path)
    with caplog.at_level("WARNING"):
        await b.run_forks(1)
    assert caplog.text.count("forking is not available on this plan") == len(b.arm_plan())  # once per child
    assert "replay" in caplog.text
    await b.close()


async def test_a_forced_step_that_fails_is_a_failed_copy_not_a_forced_result(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)
    broken = {"description": "Remove duplicate rows", "command": f"cd {VM_WORKSPACE} && echo no pandas here >&2 && exit 3"}
    # The duplicates trap brings its own fix, so swap the lookup, not the table.
    monkeypatch.setattr(forks_mod, "intervention_for", lambda label, trap=None: broken)
    monkeypatch.setattr(batch_mod, "intervention_for", lambda label, trap=None: broken)
    await b.run_forks(1)
    fork = _case(b)["forks"]["f1"]
    forced = fork["children"]["forced-1"]
    # Nothing was forced in that copy, so it must not be counted as a forced result, honest or inflated.
    assert forced["status"] == "failed" and "forced step failed" in forced["reason"] and "exit code 3" in forced["reason"]
    assert fork["arms"]["forced"]["scored"] == 0 and fork["arms"]["forced"]["failed"] == 1
    assert fork["children"]["control-1"]["status"] == "inflated"
    await b.close()


async def test_runs_stop_spending_once_the_batch_is_over_budget(local_vms, tmp_path):
    # One scripted model response costs about $0.000105 at the shipped Haiku price, so the first one breaks this budget.
    b = await _run_batch(tmp_path, budget_usd=0.0001)
    case = _case(b)
    for run in case["runs"].values():
        assert run["status"] == "failed" and "OverBudget" in run["reason"], run
    # Each run made one model call and was stopped before the next: 2 calls, not the 7 the scripts hold.
    assert sum(s["input_tokens"] for s in case["costs"]["scopes"].values()) <= 2 * ANALYST_TOKENS
    assert case["phase"] == "no_split"
    assert sorted(local_vms["stopped"]) == ["t-r01", "t-r02"]  # nothing left running


VERDICT = {"sentence": "Skipping the duplicate check suggests why the scores were inflated.", "step_label": "deduplicate",
           "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1, "confidence": "low",
           "arms": {"control": {"inflated": 1, "total": 1}, "forced": {"inflated": 0, "total": 1}}}


async def test_fork_tokens_are_charged_to_the_fork_and_never_also_to_the_investigator(local_vms, tmp_path, monkeypatch):
    # Control and forced only: the verdict must give every arm the experiment scored, and VERDICT gives those two.
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    script_investigator(monkeypatch, [
        call("request_forks", {"n_per_arm": 1}, "i1", 500),
        call("record_verdict", VERDICT, "i2", 500),
        say("The verdict is saved.", 500),
    ])
    await b.investigate()
    assert _case(b)["phase"] == "awaiting_approval"
    await b.decide(True)  # the experiment now runs for real, inside the investigator's tool call

    case = _case(b)
    scopes = case["costs"]["scopes"]
    assert case["phase"] == "done" and case["verdict"]["sentence"] == VERDICT["sentence"]
    assert case["forks"]["f1"]["children"]["forced-1"]["status"] == "honest"
    # The investigator made three model calls of 500 tokens. The fork children's calls are not its spend.
    assert scopes["investigator"]["input_tokens"] == 3 * 500
    assert scopes["fork:f1:control-1"]["input_tokens"] == 2 * ANALYST_TOKENS
    assert scopes["fork:f1:forced-1"]["input_tokens"] == 2 * ANALYST_TOKENS
    assert "t-f1-control-1" in local_vms["stopped"]  # the batch closed itself when the verdict was in


async def test_an_experiment_whose_base_vm_cannot_be_built_reports_why_and_leaves_no_trace(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)
    real_create = batch_mod.vms.create_vm

    def create_vm(label):
        if label.endswith("-base"):
            raise RuntimeError("Failed to create sandbox: quota exceeded")
        return real_create(label)

    monkeypatch.setattr(batch_mod.vms, "create_vm", create_vm)
    result = await b.run_forks(1)  # returned, not raised: an agent calling this as a tool can read it and react
    case = _case(b)
    assert result.startswith("error: ") and "quota exceeded" in result
    assert case["phase"] == "ready"  # back where it was, so the experiment can be asked for again
    assert case["forks"] == {}       # no half-built experiment is left looking as if it were running
    assert b.vms == {}               # each run's VM was released when it finished, and the base was never made
    await b.close()


async def test_a_base_vm_that_cannot_be_rebuilt_is_stopped_and_its_time_is_recorded(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)

    def replay(sb, actions):
        raise RuntimeError("the replayed command hung")

    monkeypatch.setattr(batch_mod.vms, "replay_actions", replay)
    result = await b.run_forks(1)
    case = _case(b)
    assert result.startswith("error: ") and "the replayed command hung" in result
    assert "t-f1-base" in local_vms["stopped"] and "f1-base" not in b.vms
    assert "fork:f1:base" in case["costs"]["scopes"]
    assert case["phase"] == "ready" and case["forks"] == {}
    await b.close()


async def test_every_arm_runs_its_own_step_and_only_the_forced_arm_changes_the_data(local_vms, tmp_path):
    """Four copies of one moment, differing only in what is run before they continue."""
    b = await _run_batch(tmp_path)
    await b.run_forks(1)
    fork = _case(b)["forks"]["f1"]
    assert list(fork["arm_steps"]) == ["control", "placebo", "show", "forced"]
    assert fork["arm_steps"]["control"] is None
    assert set(fork["arms"]) == set(fork["arm_steps"])

    vms_root = local_vms["root"]
    data = lambda vm: pd.read_csv(vms_root / vm / VM_WORKSPACE.lstrip("/") / "data.csv")  # noqa: E731
    # Only the forced arm touches the data. The other three model the same table the source run had.
    for arm in ("control", "placebo", "show"):
        assert data(f"t-f1-{arm}-1").duplicated().sum() > 0, arm
    assert data("t-f1-forced-1").duplicated().sum() == 0

    # Every arm but the control opens with its own step, so the forced arm is not the only one whose history
    # carries an extra tool call. That is what the placebo arm is for.
    first = {a: read_events(b.forks_dir / "f1" / f"{a}-1" / "events.jsonl")[0] for a in fork["arm_steps"]}
    assert first["control"]["type"] == "tool_call"
    for arm in ("placebo", "show", "forced"):
        assert first[arm]["type"] == "forced", arm
    assert "__version__" in first["placebo"]["command"]
    assert "duplicated" in first["show"]["command"] and "drop_duplicates" in first["forced"]["command"]
    # The show arm is told what the forced arm fixes and left to decide; nothing on disk changed for it.
    assert "exact copy of another row" in first["show"]["output"]
    assert "pandas" in first["placebo"]["output"] and "duplicate" not in first["placebo"]["output"]
    await b.close()


async def test_the_extra_arms_can_be_turned_off(local_vms, tmp_path):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    await b.run_forks(1)
    fork = _case(b)["forks"]["f1"]
    assert list(fork["arm_steps"]) == ["control", "forced"]
    assert set(fork["children"]) == {"control-1", "forced-1"}
    await b.close()
