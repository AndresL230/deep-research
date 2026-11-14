"""The command line paths used for real runs, driven offline: a scripted fake model, no keys, no VMs."""

import json

import pytest

from deep_research import batch as batch_mod
from deep_research import cli
from deep_research.batch import Batch
from deep_research.config import BatchConfig
from tests.scripted import call, say, script_investigator, seed_hypotheses

HAIKU = "anthropic:claude-haiku-5-5"


def _call(name, args, i):
    return call(name, args, f"c{i}")


def AIMessage(content):  # noqa: N802 - keeps the scripts below reading like a conversation
    return say(content)


@pytest.fixture
def offline(tmp_path, monkeypatch):
    """Batches live in a temp folder, and anything that would start or stop a real VM is replaced."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    monkeypatch.setattr(cli, "BATCHES_DIR", tmp_path)
    stopped = []
    monkeypatch.setattr(batch_mod.vms, "stop_vm", stopped.append)
    monkeypatch.setattr(batch_mod.vms, "delete_vm", stopped.append)

    def no_vm(*args, **kwargs):
        raise AssertionError("an offline test tried to create a VM")

    monkeypatch.setattr(batch_mod.vms, "create_vm", no_vm)
    return stopped


def _saved_batch(tmp_path, budget_usd=3.0) -> Batch:
    """A finished batch on disk: one honest and one inflated run, a split finding, and real spend."""
    b = Batch(BatchConfig(n_runs=2, budget_usd=budget_usd, analyst_model=HAIKU), batch_id="t", root=tmp_path)
    b.case.update_run("r01", status="honest", reported_accuracy=0.75, true_accuracy=0.76, gap=-0.01)
    b.case.update_run("r02", status="inflated", reported_accuracy=0.91, true_accuracy=0.78, gap=0.13)
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r02", "fork_at": 2})
    seed_hypotheses(b.case)
    b.case.set_phase("ready")
    for scope in ("run:r01", "run:r02"):
        b.tracker.record_tokens(scope, HAIKU, 1_000_000, 100_000)
        b.tracker.add_vm_seconds(scope, 120)
    b.push_costs(force=True)
    return b


def _script_investigator(monkeypatch, messages):
    script_investigator(monkeypatch, messages)


def _fake_forks(monkeypatch):
    calls = []

    async def run_forks(self, n_per_arm, hypothesis_id=None):
        calls.append(n_per_arm)
        self.vms["f1-control-1"] = "vm-child"
        # What a finished experiment leaves in the case file: the verdict's arms are checked against it.
        self.case.update_fork("f1", kind="method", status="done", label="deduplicate", arms={
            "control": {"total": 2, "scored": 2, "inflated": 2, "honest": 0, "failed": 0},
            "forced": {"total": 2, "scored": 2, "inflated": 0, "honest": 2, "failed": 0},
        })
        return "Fork f1 from run r02. Control: 2 of 2 inflated. Forced: 0 of 2 inflated."

    monkeypatch.setattr(Batch, "run_forks", run_forks)
    return calls


VERDICT = {"sentence": "Skipping the duplicate check suggests why the scores were inflated.", "step_label": "deduplicate",
           "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1, "confidence": "low",
           "arms": {"control": {"inflated": 2, "total": 2}, "forced": {"inflated": 0, "total": 2}}}


# ---- reopening a saved batch ----

def test_reopening_a_batch_keeps_its_spend_so_the_budget_guard_still_works(tmp_path):
    first = _saved_batch(tmp_path, budget_usd=0.5)
    spent = first.tracker.total_usd()
    assert spent is not None and spent > 0

    again = Batch(first.cfg, batch_id="t", root=tmp_path)
    assert again.tracker.total_usd() == pytest.approx(spent, abs=1e-3)
    assert again.tracker.average_run_usd() == pytest.approx(spent / 2, abs=1e-3)
    # The fork estimate comes from the saved runs, one average run per copy, and the guard refuses what the
    # budget cannot cover. Two runs per arm, over however many arms the experiment would have.
    assert again.estimate_forks_usd(2) == pytest.approx(spent / 2 * len(again.arm_plan()) * 2, abs=1e-2)
    with pytest.raises(batch_mod.OverBudget):
        again.tracker.check(again.estimate_forks_usd(2), "4 fork runs")

    # New spend is added to the saved spend, never written over it.
    again.tracker.record_tokens("fork:f1:control-1", HAIKU, 1_000_000, 0)
    again.push_costs(force=True)
    scopes = json.loads((tmp_path / "t" / "case" / "case.json").read_text())["costs"]["scopes"]
    assert set(scopes) == {"run:r01", "run:r02", "fork:f1:control-1"}
    assert scopes["run:r01"]["input_tokens"] == 1_000_000 and scopes["run:r01"]["vm_seconds"] == 120.0


def test_reopening_keeps_an_unknown_price_unknown(tmp_path):
    b = Batch(BatchConfig(n_runs=1, analyst_model="no-such-model"), batch_id="t", root=tmp_path)
    b.tracker.record_tokens("run:r01", "no-such-model", 10, 10)
    b.push_costs(force=True)
    again = Batch(b.cfg, batch_id="t", root=tmp_path)
    assert again.tracker.total_usd() is None  # not zero: an unknown spend must not look free


# ---- cli runs / forks ----

def test_cli_parses_the_budget_and_the_new_commands(monkeypatch):
    seen = {}

    async def runs(n, strength, hint, noise, hidden, budget):
        seen["runs"] = (n, strength, hint, budget)

    async def investigate(batch_id, auto_approve):
        seen["investigate"] = (batch_id, auto_approve)

    monkeypatch.setattr(cli, "runs", runs)
    monkeypatch.setattr(cli, "investigate", investigate)
    cli.main(["runs", "--n", "6", "--budget", "3"])
    cli.main(["investigate", "0101-000000-abcd", "--auto-approve"])
    assert seen == {"runs": (6, 0.5, "none", 3.0), "investigate": ("0101-000000-abcd", True)}


async def test_cli_runs_gives_the_batch_its_budget(offline, tmp_path, monkeypatch):
    async def run_all(self):
        self.case.set_phase("no_split")

    monkeypatch.setattr(Batch, "run_all", run_all)
    await cli.runs(1, 0.5, "none", 0.0, 1.0, 3.0)
    (case_file,) = tmp_path.glob("*/case/case.json")
    assert json.loads(case_file.read_text())["config"]["budget_usd"] == 3.0


async def test_cli_forks_stops_the_fork_vms_when_it_is_done(offline, tmp_path, monkeypatch):
    _saved_batch(tmp_path)
    calls = _fake_forks(monkeypatch)
    await cli.forks("t", 2)
    assert calls == [2]
    assert offline == ["vm-child"]


# ---- cli investigate ----

async def test_cli_investigate_auto_approves_the_fork_request_and_saves_the_verdict(offline, tmp_path, monkeypatch):
    _saved_batch(tmp_path)
    calls = _fake_forks(monkeypatch)
    _script_investigator(monkeypatch, [
        _call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 2}, 1),
        _call("record_verdict", VERDICT, 2),
        AIMessage(content="The verdict is saved."),
    ])
    await cli.investigate("t", auto_approve=True)

    case = json.loads((tmp_path / "t" / "case" / "case.json").read_text())
    assert calls == [2]  # the experiment ran once, with the size the investigator asked for
    assert case["phase"] == "done"
    assert case["verdict"]["sentence"] == VERDICT["sentence"]
    assert case["verdict"]["numbers"]["forced_inflated"] == 0
    assert "pending" not in case["forks"]
    assert offline == ["vm-child"]  # nothing is left running
    # The investigator's spend lands beside the saved runs, not instead of them.
    assert {"run:r01", "run:r02"} <= set(case["costs"]["scopes"])


async def test_cli_investigate_asks_a_person_without_auto_approve(offline, tmp_path, monkeypatch):
    _saved_batch(tmp_path)
    calls = _fake_forks(monkeypatch)
    _script_investigator(monkeypatch, [
        _call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 3}, 1),
        AIMessage(content="The person declined the experiment, so no cause is claimed."),
    ])
    asked = []
    monkeypatch.setattr("builtins.input", lambda prompt="": asked.append(prompt) or "n")
    await cli.investigate("t", auto_approve=False)

    case = json.loads((tmp_path / "t" / "case" / "case.json").read_text())
    # The question carries what the investigator really asked for, read from the interrupt, and what it would cost.
    assert len(asked) == 1 and "3 runs in each of 4 arms (control, placebo, show, forced), 13 VMs" in asked[0]
    assert "$9.03" in asked[0]  # 12 fork runs at the saved runs' average cost
    assert calls == []  # declined: nothing ran, nothing was spent
    assert case["verdict"] is None and "pending" not in case["forks"]


async def test_cli_investigate_refuses_auto_approve_over_a_small_budget(offline, tmp_path, monkeypatch):
    _saved_batch(tmp_path, budget_usd=10.0)
    calls = _fake_forks(monkeypatch)
    _script_investigator(monkeypatch, [_call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 8}, 1)])
    with pytest.raises(SystemExit) as e:
        await cli.investigate("t", auto_approve=True)
    assert "3" in str(e.value)
    assert calls == []
    assert json.loads((tmp_path / "t" / "case" / "case.json").read_text())["phase"] == "ready"  # never started


async def test_cli_investigate_stops_approving_when_the_requests_do_not_end(offline, tmp_path, monkeypatch):
    _saved_batch(tmp_path)
    calls = _fake_forks(monkeypatch)
    _script_investigator(monkeypatch, [_call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 2}, i) for i in range(1, 12)])
    await cli.investigate("t", auto_approve=True)
    assert len(calls) == cli.MAX_AUTO_APPROVALS
    case = json.loads((tmp_path / "t" / "case" / "case.json").read_text())
    assert case["verdict"] is None and "pending" not in case["forks"]
    assert offline  # the VMs were still stopped


async def test_two_fork_requests_in_one_turn_get_one_approval(offline, tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage as Message

    _saved_batch(tmp_path)
    calls = _fake_forks(monkeypatch)
    twice = Message(content="", tool_calls=[{"name": "request_forks", "args": {"hypothesis_id": "h1", "n_per_arm": 2}, "id": "a"},
                                            {"name": "request_forks", "args": {"hypothesis_id": "h1", "n_per_arm": 2}, "id": "b"}])
    _script_investigator(monkeypatch, [twice, _call("record_verdict", VERDICT, 3), AIMessage("The verdict is saved.")])
    await cli.investigate("t", auto_approve=True)
    case = json.loads((tmp_path / "t" / "case" / "case.json").read_text())
    assert calls == [2]  # one experiment ran; the second request was declined, not run twice and not a crash
    assert case["phase"] == "done" and case["verdict"]["sentence"] == VERDICT["sentence"]


async def test_cli_investigate_refuses_a_batch_with_nothing_to_fork(offline, tmp_path, monkeypatch):
    b = _saved_batch(tmp_path)
    b.case.set_split(None)
    b.case.set_phase("no_split")
    calls = _fake_forks(monkeypatch)
    _script_investigator(monkeypatch, [_call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 2}, 1)])
    with pytest.raises(SystemExit) as e:
        await cli.investigate("t", auto_approve=True)
    assert "no split finding" in str(e.value)
    assert calls == []
    assert json.loads((tmp_path / "t" / "case" / "case.json").read_text())["phase"] == "no_split"  # never started


async def test_the_investigator_stops_when_the_batch_is_over_budget(offline, tmp_path, monkeypatch):
    b = _saved_batch(tmp_path, budget_usd=1.6)  # the saved runs already cost about $1.50
    b.vms["r01"] = "vm-run"
    calls = _fake_forks(monkeypatch)
    # One investigator response of 100,000 prompt tokens costs $0.20 at the shipped Sonnet price: over the budget.
    _script_investigator(monkeypatch, [
        call("read_file", {"file_path": "/case/case.json"}, "c1", 100_000),
        _call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 2}, 2),
    ])
    monkeypatch.setattr(cli, "_reopen", lambda batch_id: b)
    await cli.investigate("t", auto_approve=True)
    case = json.loads((tmp_path / "t" / "case" / "case.json").read_text())
    assert case["phase"].startswith("blocked: ") and "1.60" in case["phase"]
    assert calls == [] and case["verdict"] is None
    assert offline == ["vm-run"]  # the VMs were stopped


def test_stopping_a_vm_is_bounded(monkeypatch):
    from deep_research import sandboxes

    seen = []

    class VM:
        def stop(self, *args, **kwargs):
            seen.append((args, kwargs))

    sandboxes.stop_vm(VM())
    # The SDK applies its stop timeout only when it is passed by keyword; without it a stuck VM hangs the batch.
    assert seen == [((), {"timeout": 60})]


async def test_the_vms_stop_when_the_investigation_crashes(offline, tmp_path, monkeypatch):
    b = _saved_batch(tmp_path)
    b.vms["r01"] = "vm-run"

    async def run_forks(self, n_per_arm, hypothesis_id=None):
        raise RuntimeError("the tool blew up")

    monkeypatch.setattr(Batch, "run_forks", run_forks)
    _script_investigator(monkeypatch, [_call("request_forks", {"hypothesis_id": "h1", "n_per_arm": 2}, 1)])
    await b.investigate()
    with pytest.raises(RuntimeError, match="the tool blew up"):
        await b.decide(True)
    # Whatever went wrong, nothing is left running and billing.
    assert offline == ["vm-run"] and b.vms == {}


async def test_the_investigator_can_take_many_small_steps(offline, tmp_path, monkeypatch):
    """Reading the case file 100 lines at a time is a turn per read. That must not exhaust the investigator."""
    b = _saved_batch(tmp_path)
    reads = [_call("read_file", {"file_path": "/case/case.json", "offset": i * 100, "limit": 100}, i) for i in range(80)]
    _script_investigator(monkeypatch, reads + [AIMessage("I have read the whole case file.")])
    await b.investigate()
    assert b.case.read()["phase"] == "done"
