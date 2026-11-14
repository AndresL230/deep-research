"""Write a SIMULATED batch to fixtures/ so the frontend can be built before real runs exist.

No model calls and no VMs. Each "run" is scripted Python that either removes
duplicates before splitting or does not, then really trains a random forest on
the real trapped data. Scores, overlap and charts are real; the agent's choices
and the event timing are simulated. The case file says `"simulated": true`.

Run from the repo root: python3 scripts/make_fixture.py
"""

from __future__ import annotations

import json
import random
import shutil
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.ensemble import RandomForestClassifier  # noqa: E402
from sklearn.metrics import confusion_matrix  # noqa: E402
from sklearn.model_selection import train_test_split  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deep_research.analysis import actions_from_events, find_split  # noqa: E402
from deep_research.batch import _arm_summary  # noqa: E402
from deep_research.case_file import CaseFile  # noqa: E402
from deep_research.config import BatchConfig  # noqa: E402
from deep_research.forks import intervention_for  # noqa: E402
from deep_research.scoring import score_run  # noqa: E402
from deep_research.task import TARGET, build_task, task_prompt  # noqa: E402

OUT = ROOT / "fixtures" / "demo-batch"
W = "/home/daytona/workspace"


def todos(items: list[str], active: int) -> list[dict]:
    return [
        {"content": c, "status": "completed" if i < active else "in_progress" if i == active else "pending"}
        for i, c in enumerate(items)
    ]


def chart_balance(df: pd.DataFrame, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(4, 3))
    df[TARGET].value_counts().sort_index().plot.bar(ax=ax, color=["#6b8fd6", "#d68b6b"])
    ax.set_title("outcome counts")
    ax.set_xticklabels(["no diabetes", "diabetes"], rotation=0)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def chart_confusion(y, pred, acc: float, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(4, 3.4))
    ax.imshow(confusion_matrix(y, pred), cmap="Blues")
    cm = confusion_matrix(y, pred)
    for (i, j), v in pd.DataFrame(cm).stack().items():
        ax.text(j, i, str(v), ha="center", va="center", fontsize=14)
    ax.set_xticks([0, 1])
    ax.set_yticks([0, 1])
    ax.set_xlabel("predicted")
    ax.set_ylabel("actual")
    ax.set_title(f"test accuracy {acc:.2f}")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def simulate_run(run_dir: Path, task, dedupe: bool, seed: int, rng: random.Random, start: list | None = None) -> list[dict]:
    """Do the analysis for real and write the event log a real run would produce."""
    steps = ["Load and inspect the data", "Split into train and test", "Train a random forest",
             "Evaluate on the test set", "Predict the holdout and write outputs"]
    if dedupe:
        steps.insert(1, "Check for and remove duplicate rows")
    t = 0.0
    events: list[dict] = list(start or [])

    def ev(e: dict, dt: float) -> None:
        nonlocal t
        t += dt * rng.uniform(0.7, 1.4)
        events.append({"t": round(t, 2), **e})

    def call(cmd: str, result: str, dt: float = 6) -> None:
        i = len([e for e in events if e["type"] == "tool_call"])
        ev({"type": "tool_call", "id": f"c{i}", "name": "execute", "args": {"command": cmd}}, dt)
        ev({"type": "tool_result", "id": f"c{i}", "name": "execute", "content": result}, 2)

    out = run_dir / "outputs"
    live = run_dir / "live"
    out.mkdir(parents=True, exist_ok=True)
    live.mkdir(exist_ok=True)

    df = pd.read_csv(task.data)
    if not start:
        ev({"type": "todos", "todos": todos(steps, 0)}, 2)
        call(f"cd {W} && python3 -c \"import pandas as pd; df = pd.read_csv('data.csv'); print(df.shape); print(df.head()); print(df.describe())\"",
             f"({len(df)}, 9)\n...", 5)
        chart_balance(df, live / "01_outcome_counts.png")
        call(f"cd {W} && python3 -c \"import pandas as pd, matplotlib.pyplot as plt; df = pd.read_csv('data.csv'); df.outcome.value_counts().plot.bar(); plt.savefig('live/01_outcome_counts.png')\"",
             "", 5)
    if dedupe:
        ev({"type": "todos", "todos": todos(steps, 1)}, 3)
        n = int(df.duplicated().sum())
        call(f"cd {W} && python3 -c \"import pandas as pd; df = pd.read_csv('data.csv'); print(df.duplicated().sum()); df = df.drop_duplicates(); df.to_csv('clean.csv', index=False)\"",
             f"{n}", 6)
        df = df.drop_duplicates()
    src = "clean.csv" if dedupe else "data.csv"
    k = 2 if dedupe else 1
    ev({"type": "todos", "todos": todos(steps, k)}, 3)
    train, test = train_test_split(df, test_size=0.2, random_state=seed)
    train.to_csv(out / "train.csv", index=False)
    test.to_csv(out / "test.csv", index=False)
    script = (
        "import pandas as pd, json, matplotlib.pyplot as plt\n"
        "from sklearn.model_selection import train_test_split\n"
        "from sklearn.ensemble import RandomForestClassifier\n"
        "from sklearn.metrics import accuracy_score, ConfusionMatrixDisplay\n"
        f"df = pd.read_csv('{src}')\n"
        f"train, test = train_test_split(df, test_size=0.2, random_state={seed})\n"
        "train.to_csv('train.csv', index=False); test.to_csv('test.csv', index=False)\n"
        "m = RandomForestClassifier(n_estimators=300, random_state=0)\n"
        "m.fit(train.drop(columns='outcome'), train.outcome)\n"
        "acc = accuracy_score(test.outcome, m.predict(test.drop(columns='outcome')))\n"
        "ConfusionMatrixDisplay.from_estimator(m, test.drop(columns='outcome'), test.outcome); plt.savefig('live/02_confusion.png')\n"
        "h = pd.read_csv('holdout_features.csv')\n"
        "pd.DataFrame({'prediction': m.predict(h)}).to_csv('predictions.csv', index=False)\n"
        "json.dump({'test_accuracy': acc, 'model': 'random forest', 'notes': ''}, open('report.json', 'w'))\n"
        "print(acc)\n"
    )
    ev({"type": "tool_call", "id": "w", "name": "write_file", "args": {"file_path": f"{W}/model.py", "content": script}}, 8)
    ev({"type": "tool_result", "id": "w", "name": "write_file", "content": "Updated file"}, 1)

    m = RandomForestClassifier(n_estimators=300, random_state=0)
    m.fit(train.drop(columns=TARGET), train[TARGET])
    acc = float((m.predict(test.drop(columns=TARGET)) == test[TARGET]).mean())
    chart_confusion(test[TARGET], m.predict(test.drop(columns=TARGET)), acc, live / "02_confusion.png")
    hold = pd.read_csv(task.holdout_features)
    pd.DataFrame({"prediction": m.predict(hold)}).to_csv(out / "predictions.csv", index=False)
    (out / "report.json").write_text(json.dumps({"test_accuracy": acc, "model": "random forest", "notes": ""}))

    ev({"type": "todos", "todos": todos(steps, k + 1)}, 2)
    call(f"cd {W} && python3 model.py", f"{acc}", 14)
    ev({"type": "todos", "todos": todos(steps, len(steps))}, 3)
    ev({"type": "thought", "text": f"Trained a random forest. Test accuracy {acc:.3f}. Wrote the report and predictions."}, 3)

    with (run_dir / "events.jsonl").open("w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    return events


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    cfg = BatchConfig(analyst_model="anthropic:claude-haiku-5-5", n_runs=12, forks_per_choice=4, seed=7)
    task = build_task(cfg, OUT / "task")
    (OUT / "task" / "prompt.txt").write_text(task_prompt(cfg))
    case = CaseFile(OUT / "case" / "case.json")
    case.set_config({**cfg.model_dump(), "mode": "replay", "simulated": True})
    rng = random.Random(cfg.seed)

    runs, statuses = {}, {}
    for i in range(cfg.n_runs):
        rid = f"r{i + 1:02d}"
        rdir = OUT / "runs" / rid
        dedupe = rng.random() < 0.55
        events = simulate_run(rdir, task, dedupe, seed=100 + i, rng=rng)
        score = score_run(rdir / "outputs", task, cfg.inflation_threshold)
        (rdir / "score.json").write_text(json.dumps(score.to_dict(), indent=2))
        actions = actions_from_events(events)
        (rdir / "actions.json").write_text(json.dumps([vars(a) for a in actions], indent=2))
        tokens_in, tokens_out = rng.randint(30_000, 60_000), rng.randint(3_000, 7_000)
        case.update_run(
            rid, **score.to_dict(), n_actions=len(actions), labels=[a.labels for a in actions],
            step="done", duration_s=events[-1]["t"], lab_url=None, charts=[f"runs/{rid}/live/01_outcome_counts.png", f"runs/{rid}/live/02_confusion.png"],
            tokens={"input": tokens_in, "output": tokens_out},
        )
        runs[rid], statuses[rid] = actions, score.status

    finding = find_split(runs, statuses)
    split = finding.to_dict()
    split["intervention"] = intervention_for(finding.label)["description"]
    case.set_split(split)

    # Simulated fork experiment from the chosen inflated run.
    src = split["fork_run_id"]
    prefix = [e for e in (OUT / "runs" / src / "events.jsonl").read_text().splitlines()]
    prefix_events = [json.loads(line) for line in prefix]
    cut = next(i for i, e in enumerate(prefix_events) if e["type"] == "todos" and any("Split" in t["content"] and t["status"] == "in_progress" for t in e["todos"]))
    start = prefix_events[:cut]
    children, results = {}, []
    for arm in ("control", "forced"):
        for j in range(cfg.forks_per_choice):
            cid = f"{arm}-{j + 1}"
            cdir = OUT / "forks" / "f1" / cid
            dedupe = True if arm == "forced" else rng.random() < 0.2
            simulate_run(cdir, task, dedupe, seed=500 + j + (10 if arm == "forced" else 0), rng=rng, start=start)
            s = score_run(cdir / "outputs", task, cfg.inflation_threshold)
            row = {"arm": arm, **s.to_dict(), "how": "fork", "lab_url": None}
            children[cid] = row
            results.append(row)
    arms = {a: _arm_summary([r for r in results if r["arm"] == a]) for a in ("control", "forced")}
    case.update_fork("f1", status="done", source_run=src, fork_at=split["fork_at"], label=split["label"],
                     intervention=split["intervention"], n_per_arm=cfg.forks_per_choice, children=children, arms=arms)

    case.record_hypothesis(
        split["label"], split["honest_example"] or "", split["inflated_example"] or "",
        f"{split['honest_rate']:.0%} of honest runs removed duplicates before splitting; {split['inflated_rate']:.0%} of inflated runs did.",
    )
    c, f = arms["control"], arms["forced"]
    case.record_verdict(
        f"Skipping the duplicate check caused the inflated score: forcing it left {f['inflated']} of {f['scored']} runs inflated, against {c['inflated']} of {c['scored']} without it.",
        split["label"],
        {"control_inflated": c["inflated"], "control_total": c["scored"], "forced_inflated": f["inflated"], "forced_total": f["scored"]},
    )
    total_in = sum(r["tokens"]["input"] for r in case.data["runs"].values())
    total_out = sum(r["tokens"]["output"] for r in case.data["runs"].values())
    case.set_costs({"budget_usd": cfg.budget_usd, "spent_usd": None, "prices_missing": True,
                    "scopes": {"runs": {"input_tokens": total_in, "output_tokens": total_out}}, "simulated": True})
    case.set_phase("done")

    n_inf = sum(s == "inflated" for s in statuses.values())
    print(f"wrote {OUT.relative_to(ROOT)}: {n_inf} of {len(statuses)} runs inflated; split = {split['label']} "
          f"(honest {split['honest_rate']:.0%}, inflated {split['inflated_rate']:.0%}); "
          f"fork control {c['inflated']}/{c['scored']} inflated, forced {f['inflated']}/{f['scored']}")


if __name__ == "__main__":
    main()
