"""The investigator does the science (plan Phase 3, 5 and 6, 6.5 tools), offline with the scripted model: suspects,
a predicted paired experiment approved with an edited size, a verdict that cannot call a weak suspect supported, the
durable checkpointer across a restart, lessons, typed subagents and their names in the event log."""

from __future__ import annotations

import json

from deepagents.middleware.filesystem import FilesystemMiddleware
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.messages import ToolMessage

from deep_research.agents import investigator as inv_mod
from deep_research.batch import Batch
from deep_research.events import read_events
from tests.scripted import call, saved_messages, say, script_investigator
from tests.test_batch_offline import _case, _run_batch, local_vms  # noqa: F401 - the fixture is used by name

SUSPECTS = {"suspects": [
    {"target": "deduplicate", "kind": "omission", "rationale": "r01 removed repeated rows before splitting; r02 did not",
     "proposed_by": "lens-omission"},
    {"target": "inspect", "kind": "omission", "rationale": "r01 looked at the data first; r02 went straight to the split"},
]}
EXPERIMENT = {"suspect_id": "s1", "change": "force_step:deduplicate", "prediction": "smaller_gap", "pairs": 1,
              "reason": "honest runs did this step and inflated ones skipped it"}
# Two pairs (the person edits 1 to 2), both agreeing: control 2 of 2 inflated, forced 0 of 2. Score 1.9^2 = 3.61.
ARMS = {"control": {"inflated": 2, "total": 2}, "forced": {"inflated": 0, "total": 2}}
SPLIT = {"step_label": "deduplicate", "honest_rate": 1.0, "inflated_rate": 0.0, "n_honest": 1, "n_inflated": 1,
         "confidence": "low", "arms": ARMS}
OVERCLAIM = {**SPLIT, "sentence": "Skipping deduplicate is supported as the reason the claims were inflated (2 pairs).",
             "supported": ["s1"], "open": ["s2"]}
HONEST = {**SPLIT, "sentence": "Forcing deduplicate suggests why the claims were inflated: 0 of 2 forced copies "
          "inflated against 2 of 2 without (2 pairs, score 3.61 of the 20 needed).", "open": ["s1", "s2"],
          "limits": "Two pairs from one run."}
TODOS = {"todos": [{"content": "Propose suspects", "status": "completed"},
                   {"content": "Test s1", "status": "in_progress"}]}


def _tool_results(b: Batch, name: str) -> list[str]:
    return [e["content"] for e in read_events(b.dir / "investigator" / "events.jsonl")
            if e["type"] == "tool_result" and e["name"] == name]


async def test_two_suspects_a_predicted_experiment_and_no_supported_suspect_under_20(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    script_investigator(monkeypatch, [
        call("write_todos", TODOS, "t1"),
        call("record_suspects", SUSPECTS, "s"),
        call("run_experiment", EXPERIMENT, "x1"),
        call("record_verdict", OVERCLAIM, "v1"),
        call("record_verdict", HONEST, "v2"),
        say("The verdict is saved."),
    ])
    await b.investigate()
    case = _case(b)
    assert [(s["id"], s["target"], s["status"]) for s in case["suspects"]] == [("s1", "deduplicate", "proposed"),
                                                                              ("s2", "inspect", "proposed")]
    assert case["suspects"][0]["proposed_by"] == "lens-omission"
    # The person sees what they approve: the suspect, the change, the prediction, the pairs and the cost.
    pending = case["forks"]["pending"]
    assert case["phase"] == "awaiting_approval" and pending["kind"] == "experiment"
    assert (pending["suspect_id"], pending["change"], pending["prediction"], pending["pairs"]) == (
        "s1", "force_step:deduplicate", "smaller_gap", 1)
    assert pending["suspect"]["target"] == "deduplicate" and pending["vm_count"] == 3 and "estimate_usd" in pending
    assert case["investigator"]["todos"][1]["status"] == "in_progress"

    await b.decide(True, pairs=2)  # the edit path: approved with two pairs instead of one
    case = _case(b)
    fork = next(f for k, f in case["forks"].items() if k != "pending" and f.get("suspect_id") == "s1")
    assert fork["prediction"] == "smaller_gap" and len(fork["pairs"]) == 2 and fork["evidence"]["rule"] == "running_score"
    assert case["evidence"]["s1"]["score"] < 20 and case["evidence"]["s1"]["level"] == "open"
    # record_verdict refused the supported suspect under 20, then saved the honest verdict.
    refused = _tool_results(b, "record_verdict")[0]
    assert "under the 20 a supported suspect needs" in refused
    v = case["verdict"]
    assert v["open"] == ["s1", "s2"] and v["supported"] == [] and v["limits"] == "Two pairs from one run."
    assert v["evidence"]["level"] == "open" and case["phase"] == "done"


async def test_a_supported_suspect_needs_its_own_experiments(local_vms, tmp_path):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    assert b.case.record_suspects(SUSPECTS["suspects"]).startswith("suspects saved: s1, s2")
    assert "never tested" in b.case.suspect_claim_error(["s1"], [])
    # Evidence that claims a score of 30 over an experiment that tested another suspect does not count.
    b.case.update_fork("f9", status="done", suspect_id="s2", pairs=[])
    b.case.set_suspect_evidence("s1", {"pairs": 6, "agree": 6, "score": 30.0, "level": "supported", "experiments": ["f9"]})
    assert "not tied to finished experiments" in b.case.suspect_claim_error(["s1"], [])
    assert "not cleared" in b.case.suspect_claim_error([], ["s2"])
    assert "kind must be" in b.case.record_suspects([{"target": "x", "kind": "vibes", "rationale": "r"}])
    assert "step label" in b.case.record_suspects([{"target": "nope", "kind": "omission", "rationale": "r"}])
    await b.close()


async def test_a_pending_experiment_survives_a_restart(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    script_investigator(monkeypatch, [call("record_suspects", SUSPECTS, "s"), call("run_experiment", EXPERIMENT, "x1")])
    await b.investigate()
    assert _case(b)["phase"] == "awaiting_approval"
    await b.close()  # the server stops: the investigator and its connection are gone
    assert b.checkpoints_path.is_file()

    again = Batch.resume(b.id, b.root)
    assert again.case.data["phase"] == "awaiting_approval" and "pending" in again.case.data["forks"]
    script_investigator(monkeypatch, [call("record_verdict", {**HONEST, "arms": {}, "open": ["s1", "s2"],
                                                              "sentence": "No experiment ran: it was declined."}, "v"),
                                      say("Done.")])
    await again.decide(False)
    case = _case(again)
    assert case["verdict"]["sentence"] == "No experiment ran: it was declined." and case["phase"] == "done"
    # The same thread went on: the decline answered the run_experiment call the first process made.
    msgs = await saved_messages(again)
    answer = [m for m in msgs if isinstance(m, ToolMessage) and m.tool_call_id == "x1"]
    assert answer and "declined" in str(answer[0].content)


async def test_a_lesson_waits_for_approval_and_becomes_a_skill(local_vms, tmp_path, monkeypatch):
    monkeypatch.setattr(inv_mod, "LEARNED_DIR", tmp_path / "learned")
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    rule = "Remove repeated rows before the split, then check the test rows are not in training."
    script_investigator(monkeypatch, [call("propose_lesson", {"name": "dedupe-before-split", "rule": rule}, "l1"),
                                      say("Done.")])
    await b.investigate()
    case = _case(b)
    assert case["forks"]["pending"]["kind"] == "lesson" and case["forks"]["pending"]["lesson_id"] == "l1"
    assert case["lessons"] == [{**case["lessons"][0], "id": "l1", "name": "dedupe-before-split", "status": "proposed"}]
    await b.decide(True)
    lesson = _case(b)["lessons"][0]
    assert lesson["status"] == "approved" and lesson["path"] == "skills/learned/dedupe-before-split/SKILL.md"
    skill = (tmp_path / "learned" / "dedupe-before-split" / "SKILL.md").read_text()
    assert skill.startswith("---\nname: dedupe-before-split\n") and rule in skill


async def test_subagents_are_typed_read_only_and_named_in_the_log(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path, placebo_arm=False, show_arm=False)
    seen = {}
    real = inv_mod.create_deep_agent

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", spy)
    report = {"lens": "omission", "notes": "one step differs",
              "suspects": [{"target": "deduplicate", "kind": "omission", "rationale": "r01 did it, r02 did not"}]}
    script_investigator(monkeypatch, [
        call("task", {"subagent_type": "lens-omission", "description": "Look at r01 and r02."}, "k1"),
        call("LensReport", report, "lr"),
        say("Nothing more."),
    ])
    await b.investigate()
    subs = {s["name"]: s for s in seen["subagents"]}
    assert {"general-purpose", "step-tagger", "lens-omission", "lens-commission", "lens-data", "skeptic"} <= set(subs)
    assert subs["general-purpose"]["tools"] == [] and subs["lens-data"]["tools"] == []
    assert subs["step-tagger"]["response_format"] is inv_mod.StepTags and subs["skeptic"]["response_format"] is inv_mod.SkepticReport
    spending = {"run_experiment", "request_forks", "record_verdict", "propose_lesson", "request_fix_test"}
    for s in subs.values():
        assert not spending & {t.name for t in s["tools"]}, s["name"]
        assert s["skills"] == ["/skills/"]
        fs = [m for m in s["middleware"] if isinstance(m, FilesystemMiddleware)]
        assert fs and not {"execute", "write_file", "edit_file"} & {t.name for t in fs[0].tools}
    mw = seen["middleware"]
    assert any(isinstance(m, TodoListMiddleware) for m in mw)
    main_fs = next(m for m in mw if isinstance(m, FilesystemMiddleware))
    assert "execute" not in {t.name for t in main_fs.tools} and "edit_file" in {t.name for t in main_fs.tools}
    assert seen["interrupt_on"]["run_experiment"]["allowed_decisions"] == ["approve", "edit", "reject"]
    assert inv_mod.CASEBOOK_PATH in seen["memory"]
    # The typed report came back to the investigator as JSON, and the log names the subagent, not "tools".
    events = read_events(b.dir / "investigator" / "events.jsonl")
    back = next(e for e in events if e["type"] == "tool_result" and e["name"] == "task")
    assert json.loads(back["content"])["suspects"][0]["target"] == "deduplicate"
    assert {e["agent"] for e in events} - {"rubric_grader"} == {"investigator", "lens-omission"}
    assert _case(b)["investigator"]["subagent"] is None
