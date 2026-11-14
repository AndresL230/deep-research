"""More pairs for an open verdict (`Batch.run_more_pairs`, `/api/batches/{id}/more-pairs`), offline.

One test runs the whole thing on local folders in place of VMs and a scripted analyst, as test_batch_offline.py does:
the base is rebuilt at the fork point, the new copies really run their arm's step and model the data, and the
evidence flips to supported. The others build a decided batch directly and replace only the copies' runs, so the
numbers, the wording and the refusals are checked fast. No keys, no VMs, no model calls.
"""

import asyncio
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from deep_research import api
from deep_research.batch import Batch, Refused, _arm_summary, _ForkPoint, more_pairs_quote
from deep_research.config import BatchConfig
from deep_research.evidence import verdict_evidence, verdict_sentence, wording_error
from tests.local_vm import LOOK, install_local_vms, model_script
from tests.scripted import call, say, script_analysts

ANALYST_TOKENS = 1000
OPEN_SENTENCE = ("Skipping the duplicate check suggests why the scores were inflated: forcing it left 0 of 4 copies "
                 "inflated, against 4 of 4 without (4 pairs).")


# ---- a decided batch, built without running anything ----


def _decided(root, batch_id="b1", control=(4, 4), forced=(0, 4), extra=None, budget=5.0, verdict=True,
             phase="done", **cfg) -> Batch:
    """A batch with scored runs, a split, a finished fork f1 with `control` and `forced` as (inflated, scored), and the
    investigator's verdict on it. `extra`: more arms, {arm: (inflated, scored)}."""
    b = Batch(BatchConfig(n_runs=2, budget_usd=budget, placebo_arm=bool(extra and "placebo" in extra),
                          show_arm=bool(extra and "show" in extra), **cfg), batch_id=batch_id, root=root)
    b.case.update_run("r01", status="honest")
    b.case.update_run("r02", status="inflated")
    (b.runs_dir / "r02").mkdir(parents=True, exist_ok=True)
    (b.runs_dir / "r02" / "messages.json").write_text("[]")
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r02", "fork_at": 1})
    plan = b.arm_plan()
    counts = {"control": control, **(extra or {}), "forced": forced}
    children = {}
    for arm in plan:
        inflated, n = counts[arm]
        for i in range(n):
            children[f"{arm}-{i + 1}"] = {"arm": arm, "status": "inflated" if i < inflated else "honest",
                                          "reported_accuracy": 0.9, "true_accuracy": 0.7}
    arms = {arm: _arm_summary([c for c in children.values() if c["arm"] == arm]) for arm in plan}
    b.case.update_fork("f1", status="done", kind="method", source_run="r02", fork_at=1, label="deduplicate",
                       intervention=plan["forced"]["description"], n_per_arm=max(n for _, n in counts.values()),
                       arm_steps={a: (s or {}).get("description") for a, s in plan.items()}, children=children, arms=arms)
    if verdict:
        given = {a: {"inflated": s["inflated"], "total": s["scored"]} for a, s in arms.items() if s["scored"]}
        out = b.case.record_structured_verdict(OPEN_SENTENCE, "deduplicate", 1.0, 0.0, 1, 1, given, "low")
        assert out == "verdict saved", out
    b.case.set_phase(phase)
    return b


def _fake_copies(monkeypatch, outcomes: dict[str, str]) -> list:
    """The base VM and the copies' runs, replaced: each new copy of an arm ends with `outcomes[arm]`. Returns the
    jobs each round was asked to run."""
    rounds: list = []

    async def build_base(self, key, label, scope, actions):
        self.vms[key] = object()
        return self.vms[key]

    async def release(self, key, scope):
        return self.vms.pop(key, None) is not None

    async def run_children(self, fork_id, plan, jobs, base, point, model):
        rounds.append(list(jobs))
        out = {}
        for arm, number in jobs:
            cid = f"{arm}-{number}"
            out[cid] = {"arm": arm, "status": outcomes[arm], "reported_accuracy": 0.9, "true_accuracy": 0.7}
            self._set_child(fork_id, cid, **out[cid])
        return out

    monkeypatch.setattr(Batch, "_fork_point", lambda self, src, at: _ForkPoint([], at, [], ""))
    monkeypatch.setattr(Batch, "_build_base", build_base)
    monkeypatch.setattr(Batch, "_release", release)
    monkeypatch.setattr(Batch, "_run_children", run_children)
    return rounds


def _case(b: Batch) -> dict:
    return json.loads((b.dir / "case" / "case.json").read_text())


# ---- the sentence ----


def test_the_sentence_suggests_while_open_and_says_caused_only_when_supported():
    open_ev = verdict_evidence({"control": {"inflated": 4, "total": 6}, "forced": {"inflated": 1, "total": 6}})
    s = verdict_sentence("removing duplicate rows", open_ev)
    assert open_ev["level"] == "open"
    assert s.startswith("Skipping the step of removing duplicate rows suggests why the claims were inflated")
    assert "forcing it left 1 of 6 copies inflated, against 4 of 6 without" in s and "(6 pairs of the 8 needed, p = " in s
    assert wording_error(s, open_ev) is None  # the rule the investigator's verdict is held to

    sup = verdict_evidence({"control": {"inflated": 8, "total": 8}, "forced": {"inflated": 0, "total": 8}})
    s = verdict_sentence("removing duplicate rows", sup)
    assert sup["level"] == "supported"
    assert s.startswith("Skipping the step of removing duplicate rows caused the inflated claims")
    assert "0 of 8 copies inflated, against 8 of 8 without (8 pairs, one-sided Fisher p < 0.001)." in s


def test_the_sentence_names_the_placebo_and_show_arms_when_they_ran():
    arms = {"control": {"inflated": 3, "total": 4}, "placebo": {"inflated": 4, "total": 4},
            "show": {"inflated": 1, "total": 3}, "forced": {"inflated": 0, "total": 4}}
    s = verdict_sentence("removing duplicate rows", verdict_evidence(arms), arms)
    assert ("against 3 of 4 without, 4 of 4 after the placebo step, and 1 of 3 when only shown the problem "
            "(4 pairs of the 8 needed") in s
    one = {"control": arms["control"], "placebo": arms["placebo"], "forced": arms["forced"]}
    assert "against 3 of 4 without and 4 of 4 after the placebo step (4 pairs" in verdict_sentence("x", verdict_evidence(one), one)


# ---- the quote ----


def test_the_quote_defaults_to_the_pairs_still_needed(tmp_path):
    b = _decided(tmp_path, control=(4, 4), forced=(0, 4))
    q = more_pairs_quote(b.case.data, b.tracker)
    assert {k: q[k] for k in ("fork_id", "n_per_arm", "arms", "vm_count", "pairs_now", "pairs_after", "needed_pairs",
                              "level_now", "over_budget")} == {
        "fork_id": "f1", "n_per_arm": 4, "arms": ["control", "forced"], "vm_count": 9, "pairs_now": 4,
        "pairs_after": 8, "needed_pairs": 8, "level_now": "open", "over_budget": False}
    assert q["max_per_arm"] == 8 and q["budget_usd"] == 5.0
    # Asked for, held between 1 and 8.
    assert more_pairs_quote(b.case.data, b.tracker, 2)["vm_count"] == 5
    assert more_pairs_quote(b.case.data, b.tracker, 50)["n_per_arm"] == 8
    assert more_pairs_quote(b.case.data, b.tracker, 0)["n_per_arm"] == 1


def test_the_quote_counts_scored_pairs_every_arm_and_at_least_one_more(tmp_path):
    # A failed control copy: 3 scored control copies against 4 forced make 3 pairs.
    b = _decided(tmp_path, extra={"placebo": (3, 4)})
    children = dict(b.case.data["forks"]["f1"]["children"])
    children["control-4"] = {**children["control-4"], "status": "failed"}
    arms = {a: _arm_summary([c for c in children.values() if c["arm"] == a]) for a in ("control", "placebo", "forced")}
    b.case.update_fork("f1", children=children, arms=arms)
    q = more_pairs_quote(b.case.data, b.tracker)
    assert (q["pairs_now"], q["n_per_arm"], q["pairs_after"]) == (3, 5, 8)
    assert q["arms"] == ["control", "placebo", "forced"] and q["vm_count"] == 3 * 5 + 1
    # Enough pairs already but no clear difference: one more per arm by default.
    b2 = _decided(tmp_path, batch_id="b2", control=(5, 8), forced=(3, 8))
    q2 = more_pairs_quote(b2.case.data, b2.tracker)
    assert (q2["pairs_now"], q2["n_per_arm"], q2["level_now"]) == (8, 1, "open")


def test_the_estimate_is_the_forks_own_copies_plus_a_base(tmp_path):
    b = _decided(tmp_path, budget=10.5)
    assert more_pairs_quote(b.case.data, b.tracker)["estimate_usd"] is None  # nothing priced yet
    scopes = {f"fork:f1:{a}-{i}": {"model_usd": 0.10, "vm_usd": 0.02} for a in ("control", "forced") for i in (1, 2, 3, 4)}
    scopes["fork:f1:base"] = {"model_usd": 0.0, "vm_usd": 0.05}
    scopes["run:r01"] = {"model_usd": 9.0, "vm_usd": 0.0}  # a run costs more: the copies' own spend is what counts
    b.tracker.restore({"scopes": scopes})
    q = more_pairs_quote(b.case.data, b.tracker, 3)
    assert q["estimate_usd"] == round(0.12 * 2 * 3 + 0.05, 2)
    assert q["spent_usd"] == round(9.0 + 8 * 0.12 + 0.05, 2) and q["over_budget"] is True
    assert "would cost about $0.77" in q["budget_problem"]


# ---- running them ----


async def test_more_pairs_append_children_and_update_the_verdict(tmp_path, monkeypatch):
    rounds = _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    b = _decided(tmp_path, control=(2, 4), forced=(1, 4))
    q = b.case.data
    assert q["verdict"]["evidence"]["level"] == "open"
    out = await b.run_more_pairs(2)

    case = _case(b)
    fork, verdict = case["forks"]["f1"], case["verdict"]
    assert rounds == [[("control", 5), ("control", 6), ("forced", 5), ("forced", 6)]]
    assert set(fork["children"]) == {f"{a}-{i}" for a in ("control", "forced") for i in range(1, 7)}
    assert fork["status"] == "done" and fork["n_per_arm"] == 6
    assert fork["arms"]["control"]["inflated"] == 4 and fork["arms"]["control"]["scored"] == 6
    assert fork["arms"]["forced"]["inflated"] == 1 and fork["arms"]["forced"]["scored"] == 6
    [r] = fork["more_pairs"]
    assert {k: r[k] for k in ("n_per_arm", "children", "status", "pairs_before", "pairs_after", "level_before",
                              "level_after", "n_per_arm_before")} == {
        "n_per_arm": 2, "children": ["control-5", "control-6", "forced-5", "forced-6"], "status": "done",
        "pairs_before": 4, "pairs_after": 6, "level_before": "open", "level_after": "open", "n_per_arm_before": 4}

    # Still open at 6 pairs: the verdict suggests, with the new score and pairs, and keeps what it said before.
    assert verdict["arms"] == {"control": {"inflated": 4, "total": 6}, "forced": {"inflated": 1, "total": 6}}
    assert verdict["numbers"] == {"control_inflated": 4, "control_total": 6, "forced_inflated": 1, "forced_total": 6}
    assert verdict["evidence"] == verdict_evidence(verdict["arms"]) and verdict["evidence"]["pairs"] == 6
    assert verdict["sentence"].startswith("Skipping the step of removing duplicate rows suggests why")
    assert "1 of 6 copies inflated, against 4 of 6 without (6 pairs of the 8 needed" in verdict["sentence"]
    assert wording_error(verdict["sentence"], verdict["evidence"]) is None
    assert verdict["revisions"][0]["sentence"] == OPEN_SENTENCE and verdict["revisions"][0]["by"] == "more_pairs"
    assert verdict["revisions"][0]["evidence"]["pairs"] == 4
    assert verdict["confidence"] == "low" and verdict["step_label"] == "deduplicate"  # the investigator's own fields
    assert case["phase"] == "done"
    assert "Control: 4 of 6 inflated" in out and "The verdict now reads: Skipping" in out

    # A second round carries on the numbering and flips the level once the numbers allow it.
    await b.run_more_pairs(2)
    case = _case(b)
    assert rounds[1] == [("control", 7), ("control", 8), ("forced", 7), ("forced", 8)]
    verdict = case["verdict"]
    assert verdict["evidence"]["level"] == "supported" and verdict["evidence"]["pairs"] == 8
    assert verdict["sentence"].startswith("Skipping the step of removing duplicate rows caused the inflated claims")
    assert "(8 pairs, one-sided Fisher p = " in verdict["sentence"]
    assert [r["sentence"][:40] for r in verdict["revisions"]] == [OPEN_SENTENCE[:40], "Skipping the step of removing duplicate "]
    assert case["forks"]["f1"]["more_pairs"][1]["level_after"] == "supported"
    # Supported now: nothing more to add.
    with pytest.raises(Refused, match="already supported"):
        b.reserve_more_pairs()


async def test_more_pairs_keep_every_arm_with_its_step(tmp_path, monkeypatch):
    rounds = _fake_copies(monkeypatch, {"control": "inflated", "placebo": "inflated", "show": "honest", "forced": "honest"})
    b = _decided(tmp_path, extra={"placebo": (4, 4), "show": (2, 4)})
    await b.run_more_pairs(1)
    assert rounds == [[("control", 5), ("placebo", 5), ("show", 5), ("forced", 5)]]
    verdict = _case(b)["verdict"]
    assert set(verdict["arms"]) == {"control", "placebo", "show", "forced"}
    assert "5 of 5 after the placebo step, and 2 of 5 when only shown the problem" in verdict["sentence"]


async def test_the_live_page_sees_the_new_copies_arrive(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    b = _decided(tmp_path)
    q = b.subscribe()
    # What each pushed section held when it was pushed (the queue holds the live sections, sent as they are then).
    seen: list = []
    b.case.subscribe(lambda section, value: seen.append((section, json.loads(json.dumps(value)))))
    await b.run_more_pairs(1)
    for _ in range(3):  # pushes from a running loop arrive on its next turns
        await asyncio.sleep(0)
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    assert [m["section"] for m in msgs if m["kind"] == "case"] == [s for s, _ in seen]
    assert seen[0] == ("phase", "forking") and seen[-1] == ("phase", "done")
    forks = [v["f1"] for s, v in seen if s == "forks"]
    assert forks[0]["status"] == "rebuilding" and forks[0]["more_pairs"][-1]["status"] == "rebuilding"
    assert [f["status"] for f in forks].count("running") >= 1
    first_seen = next(i for i, f in enumerate(forks) if "control-5" in f["children"])
    assert forks[first_seen]["status"] == "running" and forks[-1]["status"] == "done"
    assert "verdict" in [s for s, _ in seen]


async def test_a_base_vm_that_cannot_be_rebuilt_fails_the_round_and_changes_nothing(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})

    calls = []

    async def broken(self, key, label, scope, actions):
        calls.append(key)
        if len(calls) == 1:
            raise RuntimeError("Failed to create sandbox: quota exceeded")
        return object()

    monkeypatch.setattr(Batch, "_build_base", broken)
    b = _decided(tmp_path)
    before = _case(b)
    out = await b.run_more_pairs(2)
    case = _case(b)
    assert out.startswith("error: could not build the fork's base VM") and "quota exceeded" in out
    fork = case["forks"]["f1"]
    assert fork["status"] == "done" and fork["n_per_arm"] == 4 and set(fork["children"]) == set(before["forks"]["f1"]["children"])
    assert fork["more_pairs"][0]["status"] == "failed" and "quota exceeded" in fork["more_pairs"][0]["reason"]
    assert case["verdict"] == before["verdict"] and case["phase"] == "done"
    await b.run_more_pairs(1)  # and it can be asked for again
    assert "control-5" in _case(b)["forks"]["f1"]["children"]
    assert calls == ["f1-base-2", "f1-base-3"]  # each round its own base VM and cost scope


async def test_a_stopped_round_keeps_its_scored_copies(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    started = asyncio.Event()

    async def hangs(self, fork_id, plan, jobs, base, point, model):
        self._set_child(fork_id, "control-5", arm="control", status="inflated")
        self._set_child(fork_id, "forced-5", arm="forced", status="honest")
        self._set_child(fork_id, "control-6", arm="control", status="running")
        started.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(Batch, "_run_children", hangs)
    b = _decided(tmp_path, control=(3, 4), forced=(0, 4))
    task = asyncio.create_task(b.run_more_pairs(2))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    fork = _case(b)["forks"]["f1"]
    assert fork["status"] == "done" and fork["more_pairs"][0]["status"] == "stopped"
    assert fork["children"]["control-6"]["status"] == "failed" and "stopped" in fork["children"]["control-6"]["reason"]
    assert fork["arms"]["control"]["scored"] == 5 and fork["arms"]["forced"]["scored"] == 5
    assert _case(b)["verdict"]["evidence"]["pairs"] == 5


def test_a_round_the_old_server_left_running_is_closed_when_reopened(tmp_path):
    b = _decided(tmp_path)
    fork = b.case.data["forks"]["f1"]
    children = {**fork["children"], "control-5": {"arm": "control", "status": "inflated"},
                "forced-5": {"arm": "forced", "status": "running"}}
    b.case.update_fork("f1", status="running", children=children, n_per_arm=5,
                       more_pairs=[{"n_per_arm": 1, "children": ["control-5", "forced-5"], "status": "running",
                                    "n_per_arm_before": 4}])
    b.case.set_phase("forking")
    again = Batch.reopen(b.id, tmp_path)
    fork = again.case.data["forks"]["f1"]
    assert fork["status"] == "done" and fork["more_pairs"][0]["status"] == "stopped"
    assert fork["children"]["forced-5"]["status"] == "failed" and "server stopped" in fork["children"]["forced-5"]["reason"]
    assert fork["arms"]["control"]["scored"] == 5 and fork["arms"]["forced"]["scored"] == 4
    assert again.case.data["verdict"]["arms"]["control"] == {"inflated": 5, "total": 5}
    assert again.case.data["phase"] == "done"


# ---- refusals ----


def test_refusals_say_why(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    with pytest.raises(Refused, match="no verdict"):
        _decided(tmp_path, batch_id="a", verdict=False).reserve_more_pairs()
    sim = _decided(tmp_path, batch_id="b")
    sim.case.set_config({**sim.case.data["config"], "simulated": True})
    with pytest.raises(Refused, match="simulated"):
        sim.reserve_more_pairs()
    with pytest.raises(Refused, match="already supported"):
        _decided(tmp_path, batch_id="c", control=(8, 8), forced=(0, 8)).reserve_more_pairs()
    nofork = _decided(tmp_path, batch_id="d")
    nofork.case.remove_fork("f1")
    with pytest.raises(Refused, match="no fork experiment finished"):
        nofork.reserve_more_pairs()
    with pytest.raises(Refused, match="rests on fork f1, not f2"):
        _decided(tmp_path, batch_id="e").reserve_more_pairs(fork_id="f2")
    missing = _decided(tmp_path, batch_id="f")
    (missing.runs_dir / "r02" / "messages.json").unlink()
    with pytest.raises(Refused, match="files needed to fork are missing"):
        missing.reserve_more_pairs()


def test_one_experiment_at_a_time(tmp_path, monkeypatch):
    _fake_copies(monkeypatch, {"control": "inflated", "forced": "honest"})
    b = _decided(tmp_path)
    b.reserve_more_pairs(1)
    with pytest.raises(Refused, match="another experiment is running on this batch"):
        b.reserve_more_pairs(1)
    pending = _decided(tmp_path, batch_id="p")
    pending.case.update_fork("pending", status="awaiting_approval", n_per_arm=4)
    with pytest.raises(Refused, match=r"running on this batch \(pending\)"):
        pending.reserve_more_pairs()
    fix = _decided(tmp_path, batch_id="x", phase="investigating")  # the investigator is still at work after its verdict
    with pytest.raises(Refused, match="investigating"):
        fix.reserve_more_pairs()


def test_the_budget_must_cover_it(tmp_path):
    b = _decided(tmp_path, budget=1.0)
    b.tracker.restore({"scopes": {"run:r01": {"model_usd": 1.0, "vm_usd": 0.0}}})
    with pytest.raises(Refused, match=r"spent \$1.00 of its \$1.00 budget"):
        b.reserve_more_pairs()
    b2 = _decided(tmp_path, batch_id="b2", budget=0.9)
    b2.tracker.restore({"scopes": {f"fork:f1:{a}-1": {"model_usd": 0.1, "vm_usd": 0.0} for a in ("control", "forced")}})
    with pytest.raises(Refused, match=r"8 more fork runs would cost about \$0.80; spent \$0.20 of the \$0.90 budget"):
        b2.reserve_more_pairs()
    assert b2.reserve_more_pairs(2)["estimate_usd"] == 0.4  # fewer copies fit
    assert _case(b2)["phase"] == "forking"


# ---- the whole thing on local folders in place of VMs ----


def _script_for(label: str) -> list:
    if label.endswith("-r01"):
        return [call("execute", {"command": LOOK}, "c1", ANALYST_TOKENS),
                call("execute", {"command": model_script(dedupe=True)}, "c2", ANALYST_TOKENS), say("Done.", ANALYST_TOKENS)]
    if label.endswith("-r02"):
        return [call("execute", {"command": LOOK}, "c1", ANALYST_TOKENS),
                call("execute", {"command": model_script(dedupe=False)}, "c2", ANALYST_TOKENS), say("Done.", ANALYST_TOKENS)]
    return [call("execute", {"command": model_script(dedupe=False)}, "c9", ANALYST_TOKENS), say("Done.", ANALYST_TOKENS)]


async def test_more_pairs_end_to_end_on_local_vms(tmp_path, monkeypatch):
    log = install_local_vms(monkeypatch, tmp_path)
    script_analysts(monkeypatch, _script_for)
    b = Batch(BatchConfig(n_runs=2, placebo_arm=False, show_arm=False), batch_id="t", root=tmp_path / "batches")
    await b.run_all()
    await b.run_forks(4)
    arms = b.case.data["forks"]["f1"]["arms"]
    given = {a: {"inflated": arms[a]["inflated"], "total": arms[a]["scored"]} for a in ("control", "forced")}
    assert given == {"control": {"inflated": 4, "total": 4}, "forced": {"inflated": 0, "total": 4}}
    assert b.case.record_structured_verdict(OPEN_SENTENCE, "deduplicate", 1.0, 0.0, 1, 1, given, "low") == "verdict saved"
    b.case.set_phase("done")
    await b.close()

    q = b.subscribe()
    out = await b.run_more_pairs()  # 4 more per arm: the pairs still needed
    await asyncio.sleep(0)
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    # The live page gets the new copies' own events, as it gets a first experiment's.
    followed = {(m["fork"], m["child"]) for m in events if m["kind"] == "fork_event"}
    assert {("f1", c) for c in ("control-5", "forced-8")} <= followed and ("f1", "control-1") not in followed
    case = _case(b)
    fork = case["forks"]["f1"]
    # The base was rebuilt at the fork point, and every new copy forked from it, numbered after the first four.
    assert "t-f1-base-2" in log["created"] and "t-f1-base-2" in log["stopped"]
    new = [f"{a}-{i}" for a in ("control", "forced") for i in (5, 6, 7, 8)]
    assert sorted(n for n in log["forked"] if n.split("-", 2)[-1] in new) == sorted(f"t-f1-{c}" for c in new)
    for c in new:
        child = fork["children"][c]
        assert child["how"] == "fork" and child["status"] == ("inflated" if c.startswith("control") else "honest"), c
    # The forced step really ran first in each new forced copy, as in the first round.
    forced_events = [json.loads(line) for line in (b.forks_dir / "f1" / "forced-7" / "events.jsonl").read_text().splitlines()]
    assert forced_events[0]["type"] == "forced" and "Removed" in forced_events[0]["output"]
    assert fork["arms"]["control"]["inflated"] == 8 and fork["arms"]["forced"]["scored"] == 8
    assert {"fork:f1:base-2", "fork:f1:control-8", "fork:f1:forced-5"} <= set(case["costs"]["scopes"])

    verdict = case["verdict"]
    assert verdict["evidence"]["level"] == "supported" and verdict["evidence"]["pairs"] == 8
    assert verdict["sentence"].startswith("Skipping the step of removing duplicate rows caused the inflated claims")
    assert case["phase"] == "done" and b.vms == {}
    assert "Evidence level: supported" in out


# ---- the endpoints ----


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    monkeypatch.setattr(api, "BATCHES", {})
    monkeypatch.setattr(api, "TASKS", {})
    with TestClient(api.app) as c:
        yield c


def _saved(tmp_path, name="saved", **over) -> Batch:
    b = _decided(tmp_path / "batches", batch_id=name, **over)
    b.case.set_costs(b.tracker.snapshot())
    return b


def test_the_estimate_endpoint_gives_the_numbers_for_the_confirmation(client, tmp_path):
    _saved(tmp_path)
    res = client.get("/api/batches/saved/more-pairs")
    assert res.status_code == 200, res.text
    q = res.json()
    assert (q["n_per_arm"], q["vm_count"], q["pairs_now"], q["pairs_after"], q["needed_pairs"]) == (4, 9, 4, 8, 8)
    assert q["arms"] == ["control", "forced"] and q["fork_id"] == "f1" and q["over_budget"] is False
    assert client.get("/api/batches/saved/more-pairs?n=2").json()["vm_count"] == 5
    assert client.get("/api/batches/saved/more-pairs?n=0").status_code == 422
    # Nothing was loaded or started.
    assert "saved" not in api.BATCHES and _case_on_disk(tmp_path, "saved")["phase"] == "done"


def _case_on_disk(tmp_path, name):
    return json.loads((tmp_path / "batches" / name / "case" / "case.json").read_text())


def test_the_endpoints_refuse_with_409_and_the_reason(client, tmp_path):
    res = client.get("/api/batches/demo-batch/more-pairs")
    assert res.status_code == 409 and "fixture" in res.json()["detail"]
    assert client.post("/api/batches/demo-batch/more-pairs").status_code == 409
    assert client.get("/api/batches/nope/more-pairs").status_code == 404
    _saved(tmp_path, name="sup", control=(8, 8), forced=(0, 8))
    res = client.post("/api/batches/sup/more-pairs")
    assert res.status_code == 409 and "already supported" in res.json()["detail"]
    _saved(tmp_path, name="noverdict", verdict=False)
    assert "no verdict" in client.get("/api/batches/noverdict/more-pairs").json()["detail"]
    # A copy of the demo batch made to look like one of ours, still simulated.
    shutil.copytree(api.FIXTURES_DIR / "demo-batch", tmp_path / "batches" / "sim")
    res = client.get("/api/batches/sim/more-pairs")
    assert res.status_code == 409 and "simulated" in res.json()["detail"]


def test_the_budget_is_refused_by_the_post_and_flagged_by_the_get(client, tmp_path):
    b = _saved(tmp_path, budget=0.9)
    b.tracker.restore({"scopes": {f"fork:f1:{a}-1": {"model_usd": 0.1, "vm_usd": 0.0} for a in ("control", "forced")}})
    b.case.set_costs(b.tracker.snapshot())
    q = client.get("/api/batches/saved/more-pairs").json()
    assert q["over_budget"] is True and q["estimate_usd"] == 0.8 and "budget" in q["budget_problem"]
    res = client.post("/api/batches/saved/more-pairs")
    assert res.status_code == 409 and "would cost about $0.80" in res.json()["detail"]
    assert "saved" not in api.BATCHES


def test_the_post_loads_the_batch_and_starts_the_copies(client, tmp_path, monkeypatch):
    _saved(tmp_path)
    started = []

    async def run(self, n_per_arm=None, fork_id=None, reserved=None):
        started.append(reserved)
        await asyncio.sleep(30)  # still running when the second request arrives

    monkeypatch.setattr(Batch, "run_more_pairs", run)
    res = client.post("/api/batches/saved/more-pairs?n=3")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == "saved" and body["phase"] == "forking" and body["n_per_arm"] == 3 and body["vm_count"] == 7
    assert body["children"] == ["control-5", "control-6", "control-7", "forced-5", "forced-6", "forced-7"]
    assert started and started[0]["children"] == body["children"]
    listed = {b["id"]: b for b in client.get("/api/batches").json()}
    assert listed["saved"]["kind"] == "live"
    with client.websocket_connect("/api/batches/saved/ws") as ws:
        snap = ws.receive_json()
    assert snap["live"] is True and snap["case"]["forks"]["f1"]["status"] == "rebuilding"
    assert snap["case"]["forks"]["f1"]["more_pairs"][0]["children"] == body["children"]
    # One experiment at a time.
    res = client.post("/api/batches/saved/more-pairs")
    assert res.status_code == 409 and "running something else" in res.json()["detail"]
    assert client.get("/api/batches/saved/more-pairs").status_code == 409
    client.post("/api/batches/saved/stop")
