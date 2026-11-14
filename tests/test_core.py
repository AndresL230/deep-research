import json

import pandas as pd
import pytest

from deep_research.analysis import Action, actions_from_events, find_split, label_text
from deep_research.case_file import CaseFile
from deep_research.config import BatchConfig
from deep_research.costs import CostTracker, OverBudget
from deep_research.scoring import overlap_share, score_run
from deep_research.task import TARGET, build_task, task_prompt


@pytest.fixture
def task(tmp_path):
    cfg = BatchConfig(trap_strength=0.5, seed=1)
    return cfg, build_task(cfg, tmp_path / "task")


def test_task_plants_copies_and_hides_labels(task):
    cfg, files = task
    meta = json.loads(files.meta.read_text())
    data = pd.read_csv(files.data)
    assert meta["planted_copies"] == round(meta["unique_rows_before_trap"] * 0.5)
    assert len(data) == meta["unique_rows_before_trap"] + meta["planted_copies"]
    assert data.duplicated().sum() >= meta["planted_copies"] * 0.95
    assert TARGET not in pd.read_csv(files.holdout_features).columns
    assert "holdout_labels" not in task_prompt(cfg)


def _write_outputs(d, files, preds, reported, train, test):
    d.mkdir(parents=True)
    (d / "report.json").write_text(json.dumps({"test_accuracy": reported}))
    pd.DataFrame({"prediction": preds}).to_csv(d / "predictions.csv", index=False)
    train.to_csv(d / "train.csv", index=False)
    test.to_csv(d / "test.csv", index=False)


def test_score_marks_inflated_and_honest(task, tmp_path):
    cfg, files = task
    labels = pd.read_csv(files.holdout_labels)[TARGET]
    data = pd.read_csv(files.data)
    half = len(data) // 2
    # Predictions that are right 75% of the time.
    preds = labels.copy()
    preds.iloc[: len(preds) // 4] = 1 - preds.iloc[: len(preds) // 4]

    _write_outputs(tmp_path / "a", files, preds, 0.90, data, data.iloc[:50])
    s = score_run(tmp_path / "a", files, cfg.inflation_threshold)
    assert s.status == "inflated" and s.overlap_share == 1.0
    assert abs(s.true_accuracy - 0.75) < 0.02

    _write_outputs(tmp_path / "b", files, preds, 0.76, data.iloc[:half], data.iloc[half:])
    assert score_run(tmp_path / "b", files, cfg.inflation_threshold).status == "honest"


def test_score_fails_cleanly(task, tmp_path):
    cfg, files = task
    (tmp_path / "c").mkdir()
    s = score_run(tmp_path / "c", files, cfg.inflation_threshold)
    assert s.status == "failed" and "report.json" in s.reason


def test_overlap_catches_jittered_copies():
    a = pd.DataFrame({"glucose": [100, 120], "bmi": [30.0, 25.0], "outcome": [1, 0]})
    b = pd.DataFrame({"glucose": [100, 140], "bmi": [30.02, 22.0], "outcome": [1, 0]})
    assert overlap_share(a, b) == 0.5


def test_labels_and_script_resolution():
    assert "deduplicate" in label_text("df = df.drop_duplicates()")
    events = [
        {"type": "tool_call", "name": "write_file", "args": {"file_path": "/w/a.py", "content": "import pandas as pd\ndf=pd.read_csv('data.csv')\nfrom sklearn.model_selection import train_test_split\nm.fit(X,y)"}},
        {"type": "tool_call", "name": "execute", "args": {"command": "cd /w && python3 a.py"}},
    ]
    acts = actions_from_events(events)
    assert acts[0].labels == []
    assert {"load", "split", "train"} <= set(acts[1].labels)


def _run(*texts):
    acts = []
    for i, t in enumerate(texts):
        a = Action(index=i, tool="execute", args={"command": t})
        a.labels = label_text(t)
        acts.append(a)
    return acts


def test_find_split_picks_dedupe():
    honest = _run("pd.read_csv('data.csv').head()", "df=df.drop_duplicates()", "train_test_split(df)", "m.fit(X,y)")
    inflated = _run("pd.read_csv('data.csv').head()", "train_test_split(df)", "m.fit(X,y)")
    runs = {"r1": honest, "r2": honest, "r3": inflated, "r4": inflated}
    f = find_split(runs, {"r1": "honest", "r2": "honest", "r3": "inflated", "r4": "inflated"})
    assert f.label == "deduplicate"
    assert f.honest_rate == 1.0 and f.inflated_rate == 0.0
    assert f.fork_run_id == "r3" and f.fork_at == 1


def test_find_split_needs_both_groups():
    assert find_split({"r1": _run("x")}, {"r1": "honest"}) is None


def test_costs_and_budget():
    prices = {"models": {"m": {"input_per_mtok": 1.0, "output_per_mtok": 5.0}}, "daytona_vm_per_hour": 0.36}
    t = CostTracker(budget_usd=1.0, prices=prices)
    t.record_tokens("run:a", "m", 1_000_000, 100_000)
    t.add_vm_seconds("run:a", 3600)
    assert t.total_usd() == pytest.approx(1.0 + 0.5 + 0.36)
    with pytest.raises(OverBudget):
        t.check(0.5, "forks")


def test_costs_without_prices_never_block():
    t = CostTracker(budget_usd=0.01, prices={"models": {}, "daytona_vm_per_hour": None})
    t.record_tokens("run:a", "m", 10, 10)
    assert t.total_usd() is None
    t.check(100.0, "anything")
    assert t.snapshot()["prices_missing"] is True


def test_case_file_tools_validate(tmp_path):
    cf = CaseFile(tmp_path / "case" / "case.json")
    seen = []
    cf.subscribe(lambda section, value: seen.append(section))
    cf.update_run("r1", status="running")
    assert cf.record_step_labels("nope", [["load"]]).startswith("error")
    assert cf.record_step_labels("r1", [["load"], ["bogus"]]).startswith("error")
    assert cf.record_step_labels("r1", [["load"], ["split"]]).startswith("saved")
    assert cf.record_hypothesis("deduplicate", "a", "b", "c") == "hypothesis saved"
    assert json.loads((tmp_path / "case" / "case.json").read_text())["step_labels"]["r1"] == [["load"], ["split"]]
    assert seen == ["runs", "step_labels", "hypotheses"]


def test_costs_price_cache_reads_and_writes():
    prices = {"models": {"m": {"input_per_mtok": 2.0, "output_per_mtok": 10.0, "cache_read_per_mtok": 0.1,
                               "cache_write_per_mtok": 2.5, "cache_write_1h_per_mtok": 4.0}}}
    t = CostTracker(budget_usd=100.0, prices={**prices, "daytona_vm_per_hour": 0.0})
    # 1M uncached ($2) + 1M read ($0.10) + 1M 5m write ($2.50) + 1M 1h write ($4) + 1M out ($10)
    t.record_tokens("run:a", "m", 4_000_000, 1_000_000, cache_read=1_000_000, cache_write=1_000_000,
                    cache_write_1h=1_000_000)
    assert t.total_usd() == pytest.approx(18.60)
    s = t.snapshot()["scopes"]["run:a"]
    assert s["cache_read_tokens"] == 1_000_000 and s["cache_write_tokens"] == 2_000_000


def test_costs_use_long_prompt_rates_over_the_threshold():
    prices = {"models": {"m": {"input_per_mtok": 0.1, "output_per_mtok": 0.5,
                               "long_prompt": {"over_tokens": 100_000, "input_per_mtok": 0.5, "output_per_mtok": 2.5}}},
              "daytona_vm_per_hour": 0.0}
    t = CostTracker(budget_usd=100.0, prices=prices)
    t.record_tokens("short", "m", 100_000, 0)
    t.record_tokens("long", "m", 100_001, 0)
    assert t.scopes["short"].model_usd == pytest.approx(0.01)
    assert t.scopes["long"].model_usd == pytest.approx(100_001 / 1e6 * 0.5)


def test_costs_missing_cache_rate_means_unknown():
    t = CostTracker(budget_usd=1.0, prices={"models": {"m": {"input_per_mtok": 1.0, "output_per_mtok": 5.0}},
                                            "daytona_vm_per_hour": 0.0})
    t.record_tokens("a", "m", 10, 10)
    assert t.total_usd() is not None
    t.record_tokens("a", "m", 10, 10, cache_read=5)
    assert t.total_usd() is None


def test_token_counts_reads_anthropic_usage_metadata():
    from deep_research.costs import token_counts

    per_ttl = {"input_tokens": 100, "output_tokens": 7, "input_token_details": {
        "cache_read": 40, "cache_creation": 0, "ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 5}}
    assert token_counts(per_ttl) == {"input_tokens": 100, "output_tokens": 7, "cache_read": 40,
                                     "cache_write": 20, "cache_write_1h": 5}
    generic = {"input_tokens": 100, "output_tokens": 7, "input_token_details": {"cache_creation": 30}}
    assert token_counts(generic)["cache_write"] == 30
    assert token_counts({"input_tokens": 3, "output_tokens": 1})["cache_read"] == 0


def test_shipped_prices_cover_the_default_models():
    from deep_research.config import load_prices

    prices = load_prices()
    for model in ("anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"):
        assert prices["models"][model]["input_per_mtok"] is not None
    assert prices["daytona_vm_per_hour"] is not None


# ---- uploaded datasets ----
@pytest.fixture
def uploaded(tmp_path, monkeypatch):
    """A three-class CSV with text labels, a float column and a text column, saved as an upload."""
    import numpy as np

    from deep_research import config, datasets

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    rng = np.random.default_rng(0)
    n = 300
    df = pd.DataFrame(
        {
            "length": rng.normal(5, 1, n).round(2),
            "count": rng.integers(0, 9, n),
            "site": rng.choice(["north", "south"], n),
            "species": rng.choice(["ant", "bee", "cat"], n),
        }
    )
    return datasets.save_upload("bugs.csv", df.to_csv(index=False).encode())


def test_upload_describes_columns_and_suggests_a_target(uploaded):
    from deep_research import datasets

    assert uploaded["id"].startswith("ds-") and uploaded["rows"] == 300 and uploaded["target"] == "species"
    by_name = {c["name"]: c for c in uploaded["columns"]}
    assert by_name["length"]["kind"] == "number" and by_name["site"]["kind"] == "text"
    assert "different values" in by_name["length"]["target_problem"]
    assert [d["id"] for d in datasets.list_datasets()] == ["pima", uploaded["id"]]


def test_upload_rejects_unusable_files(uploaded):
    from deep_research.datasets import DatasetError, load, save_upload

    with pytest.raises(DatasetError, match="rows"):
        save_upload("small.csv", b"a,b\n1,2\n3,4\n")
    with pytest.raises(DatasetError, match="two columns"):
        save_upload("one.csv", ("a\n" + "1\n" * 200).encode())
    with pytest.raises(DatasetError, match="choose the column"):
        load(uploaded["id"])
    with pytest.raises(DatasetError, match="cannot be the target"):
        load(uploaded["id"], "length")
    with pytest.raises(DatasetError, match="unknown dataset"):
        load("ds-00000000", "x")


def test_task_and_scoring_work_on_an_uploaded_dataset(uploaded, tmp_path):
    cfg = BatchConfig(dataset=uploaded["id"], target="species", trap_strength=0.5, seed=1)
    files = build_task(cfg, tmp_path / "task")
    meta = json.loads(files.meta.read_text())
    data = pd.read_csv(files.data)
    assert meta["target"] == "species" and meta["noisy_columns"] == ["length"]
    assert len(data) == meta["unique_rows_before_trap"] + meta["planted_copies"]
    assert "species" not in pd.read_csv(files.holdout_features).columns
    prompt = task_prompt(cfg)
    assert "`species`" in prompt and "diabetes" not in prompt and "holdout_labels" not in prompt

    labels = pd.read_csv(files.holdout_labels)["species"]
    preds = labels.copy()
    preds.iloc[: len(preds) // 4] = "wrong"
    half = len(data) // 2
    _write_outputs(tmp_path / "a", files, preds, 0.95, data, data.iloc[:50])
    s = score_run(tmp_path / "a", files, cfg.inflation_threshold)
    assert s.status == "inflated" and s.overlap_share == 1.0 and abs(s.true_accuracy - 0.75) < 0.02
    # Distinct rows on both sides: no overlap, even though the float column has close values.
    unique = data.drop_duplicates()
    _write_outputs(tmp_path / "b", files, preds, 0.76, unique.iloc[:half], unique.iloc[half:])
    s = score_run(tmp_path / "b", files, cfg.inflation_threshold)
    assert s.status == "honest" and s.overlap_share == 0.0


def test_pima_prompt_is_unchanged_by_the_dataset_option():
    prompt = task_prompt(BatchConfig())
    assert "whether each one developed diabetes" in prompt and "one column named `prediction` (0 or 1)" in prompt


# ---- uploaded training scripts ----
SCRIPT = """import pandas as pd
import torch
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

df = pd.read_csv("data.csv")
train, test = train_test_split(df, test_size=0.2)
m = RandomForestClassifier().fit(train.drop(columns="outcome"), train.outcome)
print(m.score(test.drop(columns="outcome"), test.outcome))
"""


@pytest.fixture
def script(tmp_path, monkeypatch):
    from deep_research import config, user_scripts

    monkeypatch.setattr(config, "USER_SCRIPTS_DIR", tmp_path / "user_scripts")
    return user_scripts.save_upload("my model.py", SCRIPT.encode())


def test_script_upload_lists_imports_the_vm_lacks(script):
    assert script["id"].startswith("sc-") and script["name"] == "my model.py" and script["lines"] == 9
    assert script["imports"] == ["pandas", "sklearn", "torch"] and script["missing_packages"] == ["torch"]


def test_script_upload_rejects_what_is_not_python(script):
    from deep_research.user_scripts import ScriptError, load, save_upload

    with pytest.raises(ScriptError, match=r"not valid Python \(line 1\)"):
        save_upload("bad.py", b"def broken(:\n")
    with pytest.raises(ScriptError, match="not text"):
        save_upload("weights.py", bytes([0x80, 0x02, 0xFF, 0xFE]))
    with pytest.raises(ScriptError, match="empty"):
        save_upload("empty.py", b"  \n")
    with pytest.raises(ScriptError, match="unknown script"):
        load("sc-00000000")


def test_task_carries_the_script_and_the_prompt_points_at_it(script, tmp_path):
    cfg = BatchConfig(script=script["id"], seed=1)
    files = build_task(cfg, tmp_path / "task")
    assert files.script.read_text() == SCRIPT and files.given_files() == {"train.py": SCRIPT}
    assert json.loads(files.meta.read_text())["script"] == "my model.py"
    prompt = task_prompt(cfg)
    assert "workspace/train.py" in prompt and "random forest" not in prompt
    # Without a script nothing is written and the prompt is the usual one.
    plain = build_task(BatchConfig(seed=1), tmp_path / "plain")
    assert not plain.script.exists() and plain.given_files() == {}
    assert "train.py" not in task_prompt(BatchConfig())


def test_split_finder_reads_a_given_script_and_its_edits():
    run = {"type": "tool_call", "name": "execute", "args": {"command": "cd /w && python3 -u train.py"}}
    # Run as uploaded: it splits without removing duplicates.
    as_is = actions_from_events([run], {"train.py": SCRIPT})
    assert {"load", "split", "train"} <= set(as_is[0].labels) and "deduplicate" not in as_is[0].labels
    # Without the script's text the same command says nothing.
    assert actions_from_events([run])[0].labels == []
    # The agent adds deduplication before the split, then runs it.
    edit = {"type": "tool_call", "name": "edit_file", "args": {
        "file_path": "/w/train.py", "old_string": 'df = pd.read_csv("data.csv")',
        "new_string": 'df = pd.read_csv("data.csv").drop_duplicates()'}}
    fixed = actions_from_events([edit, run], {"train.py": SCRIPT})
    assert fixed[0].labels == [] and "deduplicate" in fixed[1].labels
    statuses = {"a": "inflated", "b": "honest"}
    finding = find_split({"a": as_is, "b": fixed}, statuses)
    assert finding.label == "deduplicate" and finding.honest_rate == 1.0 and finding.inflated_rate == 0.0
    assert finding.fork_run_id == "a" and finding.fork_at == 0
