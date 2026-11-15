"""Build fixtures/suspects-demo-batch: the demo batch with the suspect board's sections filled in. SIMULATED.

It copies fixtures/demo-batch (itself simulated, scripts/make_fixture.py) and adds what the experiments engine writes
(MASTER_PLAN 6.1) so every Phase 8 view shows up in a replay:

- `suspects`: three, from three proposers; one supported, one cleared, one untested.
- f1 grows to 8 pairs (one round of more pairs, its copies' logs and numbers copied from the first 4 with small
  changes) and gains the paired fields: `suspect_id`, `change`, `anchor`, `prediction`, `pairs`, `score`, `p_exact`,
  `level`.
- f2: a `swap_model` experiment on the analyst model, 5 pairs, cleared. Its copies reuse f1's control logs.
- `evidence`, `interaction`, `lessons`, `investigator` and a scripted investigator log with its subagents.

Every number is computed with the server's own functions (experiments.py, interaction.py, evidence.py) from the
copies' gaps. Nothing here was run: `config.simulated`, and `simulated: true` on every added record.

Run: uv run python scripts/make_suspects_fixture.py
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deep_research.evidence import verdict_evidence  # noqa: E402
from deep_research.experiments import pair_outcomes, score_pairs, suspect_evidence  # noqa: E402
from deep_research.interaction import effects  # noqa: E402

SRC = ROOT / "fixtures" / "demo-batch"
OUT = ROOT / "fixtures" / "suspects-demo-batch"
THRESHOLD = 0.08
AT = 1794637981.6498184  # the demo's fixed hypothesis time
SIM = {"simulated": True}


def arm_summary(rows: list[dict]) -> dict:
    scored = [r for r in rows if r["status"] in ("honest", "inflated")]
    mean = lambda k: round(sum(r[k] for r in scored) / len(scored), 4) if scored else None  # noqa: E731
    return {"total": len(rows), "scored": len(scored), "inflated": sum(r["status"] == "inflated" for r in scored),
            "honest": sum(r["status"] == "honest" for r in scored), "failed": sum(r["status"] == "failed" for r in rows),
            "mean_reported": mean("reported_accuracy"), "mean_true": mean("true_accuracy")}


def shifted(child: dict, d_gap: float, arm: str | None = None) -> dict:
    """A copy of a scored child whose true accuracy is moved so its gap changes by `d_gap`; status follows the gap."""
    out = {**child, **SIM}
    if arm:
        out["arm"] = arm
    out["true_accuracy"] = round(child["true_accuracy"] - d_gap, 4)
    out["gap"] = round(child["reported_accuracy"] - out["true_accuracy"], 4)
    out["status"] = "inflated" if out["gap"] > THRESHOLD else "honest"
    return out


def copy_log(src: str, dst_fork: str, dst: str) -> None:
    s, d = OUT / "forks" / "f1" / src, OUT / "forks" / dst_fork / dst
    if d.exists():
        shutil.rmtree(d)
    shutil.copytree(s, d)


def investigator_log() -> list[dict]:
    """A scripted investigator: its plan, three lenses proposing suspects, an experiment per suspect, the skeptic."""
    plan = ["Read the runs and their step labels", "Ask the lenses for suspects", "Test the strongest suspect",
            "Test the rival suspect", "Have the skeptic check the verdict", "Write the verdict"]

    def todos(active: int) -> dict:
        return {"type": "todos", "todos": [
            {"content": c, "status": "completed" if i < active else "in_progress" if i == active else "pending"}
            for i, c in enumerate(plan)]}

    evs: list[tuple[float, str, dict]] = [
        (0.5, "investigator", todos(0)),
        (1.0, "investigator", {"type": "thought", "text": "Twelve runs, six inflated. Labelling each run's steps first."}),
        (3.0, "step-tagger", {"type": "tool_call", "id": "s1", "name": "record_step_labels", "args": {"run_id": "r02"}}),
        (6.0, "investigator", todos(1)),
        (7.0, "lens-omission", {"type": "thought", "text": "Every honest run drops duplicate rows before splitting; no inflated run does."}),
        (9.0, "lens-data", {"type": "thought", "text": "All six inflated runs used the same analyst model. Worth ruling out."}),
        (11.0, "skeptic", {"type": "thought", "text": "Could the inflated runs be scoring on rows they trained on?"}),
        (13.0, "investigator", {"type": "tool_call", "id": "s2", "name": "record_suspects", "args": {"suspects": ["s1", "s2", "s3"]}}),
        (15.0, "investigator", todos(2)),
        (16.0, "investigator", {"type": "tool_call", "id": "s3", "name": "run_experiment",
                                "args": {"suspect_id": "s1", "change": "force_step:deduplicate", "prediction": "smaller_gap", "pairs": 4}}),
        (20.0, "investigator", todos(3)),
        (21.0, "investigator", {"type": "tool_call", "id": "s4", "name": "run_experiment",
                                "args": {"suspect_id": "s2", "change": "swap_model:claude-sonnet-5-5", "prediction": "smaller_gap", "pairs": 5}}),
        (25.0, "investigator", todos(4)),
        (26.0, "skeptic", {"type": "thought", "text": "Score 169.8 over 8 pairs clears the bar of 20. The model swap moved nothing."}),
        (28.0, "investigator", todos(5)),
        (30.0, "investigator", {"type": "tool_call", "id": "s5", "name": "record_verdict", "args": {"supported": ["s1"], "cleared": ["s2"], "open": ["s3"]}}),
        (31.0, "investigator", {"type": "todos", "todos": [{"content": c, "status": "completed"} for c in plan]}),
    ]
    return [{"t": t, **e, "agent": a, **SIM} for t, a, e in evs]


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SRC, OUT)
    path = OUT / "case" / "case.json"
    case = json.loads(path.read_text())
    case["config"]["simulated"] = True
    case["config"]["investigator_assist"] = "none"

    # ---- f1: 4 more pairs on s1 (copies of the first 4, gaps moved a little), then the paired fields ----
    f1 = case["forks"]["f1"]
    kids = f1["children"]
    moves = {"control": [0.012, -0.018, 0.031, -0.009], "forced": [0.004, -0.006, 0.011, -0.003]}
    for arm, ds in moves.items():
        for j, d in enumerate(ds, start=1):
            kids[f"{arm}-{j + 4}"] = shifted(kids[f"{arm}-{j}"], d)
            copy_log(f"{arm}-{j}", "f1", f"{arm}-{j + 4}")
    f1["n_per_arm"] = 8
    f1["arms"] = {a: arm_summary([k for k in kids.values() if k["arm"] == a]) for a in ("control", "forced")}
    pairs, _ = pair_outcomes(kids, 8, "smaller_gap")
    first = score_pairs(pairs[:4], "smaller_gap")
    s = score_pairs(pairs, "smaller_gap")
    f1.update(suspect_id="s1", change="force_step:deduplicate", change_kind="force_step", anchor="before_split",
              prediction="smaller_gap", pairs=pairs, score=s["score"], p_exact=s["p_exact"], level=s["level"],
              pairs_requested=4, cost_usd=None, preregistered_at=AT + 16,
              reason="Every honest run removed duplicates before splitting; no inflated run did.")
    f1["more_pairs"] = [{"at": AT + 19, "n_per_arm": 4, "children": [f"{a}-{j}" for a in ("control", "forced") for j in range(5, 9)],
                         "status": "done", "estimate_usd": None, "pairs_before": 4, "level_before": first["level"],
                         "n_per_arm_before": 4, "pairs_after": 8, "level_after": s["level"], **SIM}]

    # ---- f2: the analyst model, swapped. The changed copies come out as inflated as the controls ----
    ctrl = [kids[f"control-{j}"] for j in (1, 2, 3, 4, 5)]
    swap = [-0.004, 0.006, 0.002, -0.021, 0.003]  # the one negative-enough move is the single agreeing pair
    f2_kids: dict[str, dict] = {}
    for j, (c, d) in enumerate(zip(ctrl, swap), start=1):
        src = f"control-{(j - 1) % 4 + 1}"
        f2_kids[f"control-{j}"] = {**c, **SIM}
        f2_kids[f"forced-{j}"] = shifted(c, d, arm="forced") | {"model": "anthropic:claude-sonnet-5-5"}
        copy_log(src, "f2", f"control-{j}")
        copy_log(src, "f2", f"forced-{j}")
    p2, _ = pair_outcomes(f2_kids, 5, "smaller_gap")
    s2 = score_pairs(p2, "smaller_gap")
    case["forks"]["f2"] = {
        "id": "f2", "kind": "method", "status": "done", "source_run": f1["source_run"], "fork_at": f1["fork_at"],
        "label": "train", "intervention": "Continue on claude-sonnet-5-5 instead of the run's own model",
        "n_per_arm": 5, "arm_steps": {"control": None, "forced": "swap the analyst model to claude-sonnet-5-5"},
        "children": f2_kids, "arms": {a: arm_summary([k for k in f2_kids.values() if k["arm"] == a]) for a in ("control", "forced")},
        "built": {"fork": 10, "replay": 0, "none": 0},
        "suspect_id": "s2", "change": "swap_model:claude-sonnet-5-5", "change_kind": "swap_model", "anchor": "before_split",
        "prediction": "smaller_gap", "pairs": p2, "score": s2["score"], "p_exact": s2["p_exact"], "level": s2["level"],
        "pairs_requested": 5, "cost_usd": None, "preregistered_at": AT + 21,
        "reason": "All six inflated runs share one analyst model.", **SIM,
    }

    # ---- suspects, evidence, the grid, lessons, the investigator ----
    ev1 = suspect_evidence([f1])
    ev2 = suspect_evidence([case["forks"]["f2"]])
    case["suspects"] = [
        {"id": "s1", "target": "deduplicate", "kind": "omission", "proposed_by": "lens-omission", "status": ev1["level"],
         "rationale": "Every honest run removed duplicate rows before splitting; no inflated run did.", **SIM},
        {"id": "s2", "target": "analyst_model=claude-haiku-5-5", "kind": "attribute", "proposed_by": "lens-data", "status": ev2["level"],
         "rationale": "All six inflated runs used the same analyst model.", **SIM},
        {"id": "s3", "target": "evaluate", "kind": "commission", "proposed_by": "skeptic", "status": "proposed",
         "rationale": "Inflated runs may score on rows the model saw while training.", **SIM},
    ]
    case["evidence"] = {"s1": {**ev1, **SIM}, "s2": {**ev2, **SIM}}
    cells = {"neither": (0.1421, 3), "a": (0.0118, 3), "b": (0.1393, 3), "both": (0.0151, 3)}
    case["interaction"] = {
        "fork_id": "f3", "change_a": "force_step:deduplicate", "change_b": "swap_model:claude-sonnet-5-5",
        "suspects": ["s1", "s2"], "source_run": f1["source_run"], "fork_at": f1["fork_at"], "anchor": "before_split",
        "per_cell": 3, "cells": {k: {"mean_gap": g, "n": n} for k, (g, n) in cells.items()},
        **effects(cells["neither"][0], cells["a"][0], cells["b"][0], cells["both"][0]),
        "cost_usd": None, "budget_left_usd": None, **SIM,
    }
    case["lessons"] = [
        {"id": "l1", "name": "dedupe-before-split", "status": "proposed", "suspect_id": "s1", "at": AT + 31,
         "rule": "On tabular data, check that duplicate rows were removed before the train/test split before trusting a score.", **SIM},
        {"id": "l2", "name": "method-before-model", "status": "proposed", "suspect_id": "s2", "at": AT + 31,
         "rule": "When one model is behind every inflated run, test the method first: here a stronger model left the gap unchanged.", **SIM},
        {"id": "l0", "name": "predict-first", "status": "approved", "at": AT - 86400,
         "rule": "Save the prediction before any copy runs.", **SIM},
    ]
    log = investigator_log()
    case["investigator"] = {"todos": log[-1]["todos"], "subagent": None, **SIM}
    inv = OUT / "investigator"
    inv.mkdir(exist_ok=True)
    (inv / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in log))

    # ---- the verdict, worded by both rules ----
    c, f = f1["arms"]["control"], f1["arms"]["forced"]
    numbers = {"control_inflated": c["inflated"], "control_total": c["scored"], "forced_inflated": f["inflated"], "forced_total": f["scored"]}
    vev = verdict_evidence(numbers=numbers)
    case["verdict"] = {
        **case["verdict"], "numbers": numbers, "evidence": vev, **SIM,
        "sentence": (f"Skipping the duplicate check caused the inflated scores: forcing it shrank the gap in {ev1['agree']} of "
                     f"{ev1['pairs']} pairs (score {ev1['score']:.1f}). Swapping the analyst model did not "
                     f"({ev2['agree']} of {ev2['pairs']}, cleared)."),
    }
    case["hypotheses"][0]["tested_by"] = "f1"
    path.write_text(json.dumps(case, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: s1 {ev1['level']} {ev1['score']} over {ev1['pairs']}, "
          f"s2 {ev2['level']} {ev2['score']} over {ev2['pairs']}, verdict {vev['level']}")


if __name__ == "__main__":
    main()
