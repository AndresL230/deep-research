"""The trap registry and each trap: planting, the split finder, the evidence number, the intervention, calibration."""

import json
import re
import shutil
import subprocess

import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import GroupShuffleSplit, train_test_split

from deep_research import traps
from deep_research.analysis import LABELS, Action, _did_before_split, actions_from_events, find_split, label_text
from deep_research.calibration import measure, run_intervention
from deep_research.config import BatchConfig
from deep_research.forks import intervention_for
from deep_research.scoring import score_run
from deep_research.task import TARGET, build_task
from deep_research.traps import duplicates, leaky_column, repeat_rows

NAMES = traps.names()
LEAK, ID = leaky_column.COLUMN, repeat_rows.ID


def _task(tmp_path, name="task", **settings):
    cfg = BatchConfig(**{"seed": 1, **settings})
    return cfg, build_task(cfg, tmp_path / name)


def _meta(files) -> dict:
    return json.loads(files.meta.read_text())


# ---- the registry ----
def test_registry_finds_every_trap_module():
    assert {"duplicates", "leaky_column", "repeat_rows"} <= set(NAMES)
    assert [t.name for t in traps.registered()] == NAMES == sorted(NAMES)
    assert traps.get("duplicates").label == "deduplicate" and BatchConfig().trap == "duplicates"
    assert traps.for_label("group_split").name == "repeat_rows" and traps.for_label("train") is None
    with pytest.raises(ValueError, match="unknown trap 'nope'"):
        traps.get("nope")
    with pytest.raises(ValueError, match="unknown trap"):
        BatchConfig(trap="nope")
    with pytest.raises(ValueError, match="two traps are named"):
        traps.register(traps.get("duplicates"))
    assert NAMES == traps.names()


@pytest.mark.parametrize("name", NAMES)
def test_public_dict_is_plain_json_with_the_words_the_ui_needs(name):
    trap = traps.get(name)
    public = trap.public()
    assert json.loads(json.dumps(public)) == public
    assert set(public) == {
        "name", "title", "description", "planted", "strength_label", "label", "pattern", "at_split", "did",
        "missing", "intervention", "evidence_text",
    }
    for key in ("title", "description", "planted", "strength_label", "label", "did", "missing"):
        assert isinstance(public[key], str) and public[key].strip()
    assert set(public["intervention"]) == {"description", "command"}
    # The evidence sentence is there exactly when there is an evidence number.
    assert (public["evidence_text"] is None) == (trap.evidence is None)
    re.compile(public["pattern"])
    # No em dashes in anything a person reads.
    assert "\u2014" not in json.dumps(public, ensure_ascii=False)


def test_patterns_are_valid_javascript_regular_expressions():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    patterns = {t.name: t.pattern for t in traps.registered()}
    script = "for (const [k, p] of Object.entries(JSON.parse(process.argv[1]))) { new RegExp(p); new RegExp(p, 'u'); }"
    done = subprocess.run([node, "-e", script, json.dumps(patterns)], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_the_web_app_reads_the_same_fields_and_tests_against_the_real_traps():
    from deep_research.config import ROOT_DIR

    # The web client's type for a trap has exactly the fields `public()` sends.
    source = (ROOT_DIR / "web" / "src" / "api.ts").read_text()
    body = source.split("export interface TrapInfo {", 1)[1].split("\n}\n", 1)[0]
    fields = set(re.findall(r"^  (\w+)\??:", body, flags=re.MULTILINE))
    assert fields == set(traps.get("duplicates").public())
    # web/test/traps.json is a copy of what the server sends, so the web tests run on real words and patterns.
    # Changed a trap's words? Write the file again from `[t.public() for t in traps.registered()]`.
    for saved in json.loads((ROOT_DIR / "web" / "test" / "traps.json").read_text()):
        assert saved == traps.get(saved["name"]).public()


def test_labels_are_the_base_steps_plus_each_traps_step():
    base = ["load", "inspect", "deduplicate", "deduplicate_near", "clean", "drop_column", "select_features", "split",
            "preprocess", "train", "evaluate", "plot", "predict", "report"]
    added = [t.label for t in traps.registered() if t.label not in base]
    assert {"drop_leak", "group_split"} <= set(added) and len(set(LABELS)) == len(LABELS)
    # The labels that were there before traps were pluggable keep their order.
    assert [label for label in LABELS if label not in added] == base
    assert all(t.label in LABELS for t in traps.registered())


def test_intervention_is_the_batch_traps_own_else_the_table():
    assert intervention_for("drop_leak", "leaky_column") is traps.get("leaky_column").intervention
    # A finding on another trap's step still has a fix.
    assert intervention_for("deduplicate", "leaky_column") is traps.get("duplicates").intervention
    assert intervention_for("deduplicate") is traps.get("duplicates").intervention
    assert intervention_for("train", "duplicates") is None and intervention_for("deduplicate", "gone") is not None
    assert intervention_for("deduplicate")["description"] == "Remove duplicate rows from data.csv before the split"
    # `deduplicate_near` is no trap's own step: its fix stays in the table, whatever the batch planted.
    near = intervention_for("deduplicate_near", "duplicates")
    assert near is intervention_for("deduplicate_near") and "near-duplicate" in near["description"]
    assert near["command"].startswith("cd /home/daytona/workspace && python3 -c \"import pandas as pd; ")


def test_the_duplicates_step_only_counts_outside_a_call():
    assert traps.get("duplicates").top_level is True
    assert "deduplicate" in label_text("df = df.drop_duplicates()")
    assert "deduplicate" in label_text("df = df[~df.duplicated()]")
    # Looking at duplicates is `inspect`, not the step.
    assert "deduplicate" not in label_text("print(df.drop_duplicates().shape)")
    assert label_text("print(df.duplicated().sum())") == ["inspect"]


# ---- planting ----
@pytest.mark.parametrize("name", NAMES)
def test_plant_never_sees_holdout_labels_and_keeps_the_holdout_rows(name, tmp_path, monkeypatch):
    trap = traps.get(name)
    seen = {}

    def spy(work, holdout_features, target, cfg, rng):
        seen.update(work=work.copy(), holdout=holdout_features.copy(), target=target)
        return trap.plant(work, holdout_features, target, cfg, rng)

    monkeypatch.setitem(traps._REGISTRY, name, traps.Trap(**{**vars(trap), "plant": spy}))
    cfg, files = _task(tmp_path, trap=name)
    assert seen["target"] == TARGET and TARGET in seen["work"].columns and TARGET not in seen["holdout"].columns

    holdout = pd.read_csv(files.holdout_features)
    labels = pd.read_csv(files.holdout_labels)
    assert TARGET not in holdout.columns and list(labels.columns) == [TARGET] and len(holdout) == len(labels)
    # Same rows in the same order as went in: predictions line up with the labels.
    original = list(seen["holdout"].columns)
    pd.testing.assert_frame_equal(holdout[original], seen["holdout"], check_dtype=False)
    meta = _meta(files)
    assert meta["trap"] == name and meta["columns"] == list(pd.read_csv(files.data).columns)
    assert meta["rows_given_to_agent"] == len(pd.read_csv(files.data)) and meta["holdout_rows"] == len(labels)


@pytest.mark.parametrize("name", NAMES)
def test_same_seed_gives_the_same_task(name, tmp_path):
    _, a = _task(tmp_path, "a", trap=name)
    _, b = _task(tmp_path, "b", trap=name)
    _, c = _task(tmp_path, "c", trap=name, seed=2)
    for f in ("data", "holdout_features", "holdout_labels", "meta"):
        assert getattr(a, f).read_bytes() == getattr(b, f).read_bytes()
    assert a.data.read_bytes() != c.data.read_bytes()


def test_leaky_column_tracks_the_target_in_data_and_says_nothing_in_the_holdout(tmp_path):
    _, files = _task(tmp_path, trap="leaky_column")
    data, holdout = pd.read_csv(files.data), pd.read_csv(files.holdout_features)
    labels = pd.read_csv(files.holdout_labels)[TARGET]
    meta = _meta(files)
    # One new numeric column in both files, no new rows, the target still last.
    assert len(data) == meta["unique_rows_before_trap"] and data.columns[-1] == TARGET
    assert list(data.columns[:-1]) == list(holdout.columns) and holdout.columns[-1] == LEAK
    assert pd.api.types.is_numeric_dtype(data[LEAK]) and pd.api.types.is_numeric_dtype(holdout[LEAK])

    # In data.csv the classes are clearly apart but overlap: a cut in the middle is right most of the time, not always.
    means = data.groupby(TARGET)[LEAK].mean()
    assert means[1] - means[0] == pytest.approx(30, abs=3)
    hit = ((data[LEAK] > means.mean()) == (data[TARGET] == 1)).mean()
    assert 0.88 < hit < 0.98
    # In the holdout the same cut is a coin flip, and the values come from the same pooled distribution.
    assert abs(np.corrcoef(holdout[LEAK], labels)[0, 1]) < 0.2
    assert 0.35 < ((holdout[LEAK] > means.mean()) == (labels == 1)).mean() < 0.65
    assert set(holdout[LEAK]) <= set(data[LEAK])


def test_leaky_column_strength_sets_the_separation(tmp_path):
    def gap(strength):
        _, files = _task(tmp_path, f"s{strength}", trap="leaky_column", trap_strength=strength)
        means = pd.read_csv(files.data).groupby(TARGET)[LEAK].mean()
        return means[1] - means[0]

    assert abs(gap(0.0)) < 3 and gap(0.25) == pytest.approx(15, abs=3) and gap(1.0) == pytest.approx(60, abs=3)


def test_repeat_rows_gives_each_subject_an_id_and_some_of_them_more_visits(tmp_path):
    _, files = _task(tmp_path, trap="repeat_rows")
    data, holdout = pd.read_csv(files.data), pd.read_csv(files.holdout_features)
    meta = _meta(files)
    n = meta["unique_rows_before_trap"]
    assert data.columns[0] == ID and holdout.columns[0] == ID and list(data.columns[:-1]) == list(holdout.columns)

    visits = data.groupby(ID).size()
    assert len(visits) == n == meta["subjects"]
    assert (visits > 1).sum() == round(n * 0.5) == meta["subjects_with_extra_visits"]
    assert visits.min() == 1 and visits.max() == 1 + repeat_rows.MAX_EXTRA and set(visits) == {1, 2, 3, 4}
    assert len(data) == n + meta["extra_visits"]
    # A subject keeps its target across visits.
    assert (data.groupby(ID)[TARGET].nunique() == 1).all()
    # The holdout is unseen subjects, one row each.
    assert holdout[ID].is_unique and not set(holdout[ID]) & set(data[ID]) and len(holdout) == meta["holdout_rows"]

    # Visits are near-copies, never exact ones: no two rows of a subject agree on every measurement.
    features = [c for c in data.columns if c not in (ID, TARGET)]
    assert not data.duplicated(subset=[ID, *features]).any()
    spread = data[features].std()
    within = data.groupby(ID)[features].agg(lambda s: s.max() - s.min())
    assert (within.max() <= 0.3 * spread + 1).all()
    assert (within[visits > 1].sum(axis=1) > 0).all()
    # Whole numbers stay whole and nothing leaves the column's range (no negative ages).
    assert all(pd.api.types.is_integer_dtype(data[c]) for c in ("glucose", "age", "pregnancies"))
    assert data["age"].min() >= 21 and data["bmi"].round(1).equals(data["bmi"])


def test_repeat_rows_noise_scales_the_jitter_and_strength_the_share(tmp_path):
    def within(noise):
        _, files = _task(tmp_path, f"n{noise}", trap="repeat_rows", trap_noise=noise)
        data = pd.read_csv(files.data)
        return data.groupby(ID)["glucose"].agg(lambda s: s.max() - s.min()).mean()

    assert within(0.5) > 2 * within(0.0) > 0
    _, none = _task(tmp_path, "none", trap="repeat_rows", trap_strength=0.0)
    assert pd.read_csv(none.data)[ID].is_unique
    _, every = _task(tmp_path, "all", trap="repeat_rows", trap_strength=1.0)
    assert (pd.read_csv(every.data).groupby(ID).size() > 1).all()


@pytest.mark.parametrize("name", ["leaky_column", "repeat_rows"])
def test_a_dataset_that_already_has_the_column_is_refused(name, tmp_path, monkeypatch):
    from deep_research import config, datasets

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    rng = np.random.default_rng(0)
    df = pd.DataFrame({LEAK: rng.normal(size=200), ID: range(200), "label": rng.choice(["a", "b"], 200)})
    info = datasets.save_upload("taken.csv", df.to_csv(index=False).encode())
    with pytest.raises(datasets.DatasetError, match="already has a column named"):
        build_task(BatchConfig(dataset=info["id"], target="label", trap=name), tmp_path / "task")


@pytest.mark.parametrize("name", NAMES)
def test_every_trap_plants_on_an_uploaded_dataset_with_text_columns(name, tmp_path, monkeypatch):
    from deep_research import config, datasets

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    rng = np.random.default_rng(0)
    n = 300
    df = pd.DataFrame({
        "length": rng.normal(5, 1, n).round(2), "count": rng.integers(0, 9, n),
        "site": rng.choice(["north", "south"], n), "species": rng.choice(["ant", "bee", "cat"], n),
    })
    info = datasets.save_upload("bugs.csv", df.to_csv(index=False).encode())
    files = build_task(BatchConfig(dataset=info["id"], target="species", trap=name, seed=3), tmp_path / "task")
    data, holdout = pd.read_csv(files.data), pd.read_csv(files.holdout_features)
    assert "species" not in holdout.columns and set(data["species"]) == {"ant", "bee", "cat"}
    assert [c for c in data.columns if c != "species"] == list(holdout.columns)
    assert set(data["site"]) == {"north", "south"} and len(holdout) == len(pd.read_csv(files.holdout_labels))
    if name == "leaky_column":
        # Three classes: three separated groups, in the order of the class names.
        assert data.groupby("species")[LEAK].mean().is_monotonic_increasing


# ---- the duplicates trap: decimals that follow each column's scale ----
def test_jitter_decimals_follow_the_columns_spread():
    pima = pd.read_csv("data/pima.csv", header=None)
    # Pima's two jittered columns keep the constants the code used to have.
    assert duplicates.jitter_decimals(pima[5]) == (3, 1) and duplicates.jitter_decimals(pima[6]) == (3, 1)
    rng = np.random.default_rng(0)
    assert duplicates.jitter_decimals(pd.Series(rng.uniform(1e-4, 9e-4, 500))) == (6, 4)
    assert duplicates.jitter_decimals(pd.Series(rng.normal(52_000, 20_000, 500))) == (3, -3)
    assert duplicates.jitter_decimals(pd.Series([2.5] * 10)) == (3, 1)


def test_jittered_copies_survive_and_match_on_tiny_and_large_columns(tmp_path, monkeypatch):
    from deep_research import config, datasets

    monkeypatch.setattr(config, "DATASETS_DIR", tmp_path / "datasets")
    rng = np.random.default_rng(0)
    n = 400
    df = pd.DataFrame({
        "rate": rng.uniform(1e-4, 9e-4, n).round(6), "income": rng.normal(52_000, 20_000, n).round(2),
        "visits": rng.integers(0, 30, n), "label": rng.choice(["yes", "no"], n),
    })
    info = datasets.save_upload("money.csv", df.to_csv(index=False).encode())
    cfg = BatchConfig(dataset=info["id"], target="label", trap_noise=0.05, seed=1)
    files = build_task(cfg, tmp_path / "task")
    meta, data = _meta(files), pd.read_csv(files.data)
    assert meta["noisy_columns"] == ["rate", "income"]
    assert meta["write_decimals"] == {"rate": 6, "income": 3} and meta["match_decimals"] == {"rate": 4, "income": -3}
    # Three decimals would have turned every copied rate into 0.0 or 0.001.
    assert data["rate"].between(0.9e-4, 9.1e-4).all()
    assert meta["planted_copies"] == 160 and len(data) == 320 + 160
    # The copies are jittered, so exact matching finds none of them...
    assert not data.duplicated().any()
    train, test = train_test_split(data, test_size=0.2, random_state=0)
    assert duplicates.overlap_share(train, test, meta["columns"], {}) == 0.0
    # ...and matching at each column's own scale finds most of the test rows whose twin is in training.
    assert duplicates.evidence(train, test, meta) > 0.35
    # One decimal for every jittered column, as before, never matched an income.
    assert duplicates.overlap_share(train, test, meta["columns"], meta["noisy_columns"]) < 0.05
    # Rows that are not copies of each other still do not match.
    unique = df.iloc[: n // 2], df.iloc[n // 2:]
    assert duplicates.evidence(unique[0], unique[1], meta) < 0.03


def test_evidence_for_batches_saved_before_meta_had_decimals():
    a = pd.DataFrame({"glucose": [100, 120], "bmi": [30.0, 25.0], "outcome": [1, 0]})
    b = pd.DataFrame({"glucose": [100, 140], "bmi": [30.02, 22.0], "outcome": [1, 0]})
    # No columns in meta: Pima, jittered columns matched at one decimal.
    assert duplicates.evidence(a, b, {"dataset": "pima", "trap": "duplicates"}) == 0.5
    cols = ["glucose", "bmi", "outcome"]
    assert duplicates.evidence(a, b, {"columns": cols, "noisy_columns": ["bmi"], "trap_noise": 0.1}) == 0.5
    assert duplicates.evidence(a, b, {"columns": cols, "noisy_columns": ["bmi"], "trap_noise": 0.0}) == 0.0


# ---- the split finder ----
def _run(*texts):
    acts = []
    for i, t in enumerate(texts):
        a = Action(index=i, tool="execute", args={"command": t})
        a.labels = label_text(t)
        acts.append(a)
    return acts


LOAD = "import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.head())"


@pytest.mark.parametrize("code", [
    "X = df.drop(columns=['outcome', 'followup_score'])",
    "X = df.drop(\n    columns=[\n        'outcome',\n        \"followup_score\",\n    ]\n)",
    "df = df.drop('followup_score', axis=1)",
    "del df['followup_score']",
    'leak = df.pop("followup_score")',
    "features = [c for c in df.columns if c != 'followup_score' and c != 'outcome']",
    "features = [c for c in df.columns if c not in ('outcome', 'followup_score')]",
    "drop_cols = ['followup_score']\nX = df.drop(columns=drop_cols + ['outcome'])",
])
def test_dropping_the_leaky_column_is_spotted(code):
    assert "drop_leak" in label_text(code)


@pytest.mark.parametrize("code", [
    "X = df.drop(columns=['outcome'])\ny = df['outcome']",
    "print(df['followup_score'].describe())",
    "print(df.groupby('outcome')['followup_score'].mean())",
    "df = df.drop_duplicates()\nprint(df.followup_score.corr(df.outcome))",
    "X = df.drop(columns=['outcome'])\nprint(sorted(zip(m.feature_importances_, X.columns)))  # followup_score on top",
])
def test_looking_at_the_leaky_column_is_not_dropping_it(code):
    assert "drop_leak" not in label_text(code)


def test_find_split_picks_the_dropped_leak():
    honest = _run(LOAD, "X = df.drop(columns=['outcome', 'followup_score'])", "train_test_split(X, y)", "m.fit(X, y)")
    # Dropped after the split, in the script that splits: the model still never sees the column.
    late = _run(LOAD, "tr, te = train_test_split(df)\nX = tr.drop(columns=['outcome', 'followup_score'])\nm.fit(X, tr.outcome)")
    inflated = _run(LOAD, "X = df.drop(columns=['outcome'])", "train_test_split(X, y)", "m.fit(X, y)")
    assert _did_before_split(late, "drop_leak") and not _did_before_split(inflated, "drop_leak")
    f = find_split({"r1": honest, "r2": late, "r3": inflated, "r4": inflated},
                   {"r1": "honest", "r2": "honest", "r3": "inflated", "r4": "inflated"})
    assert f.label == "drop_leak" and f.honest_rate == 1.0 and f.inflated_rate == 0.0
    assert f.fork_run_id == "r3" and f.fork_at == 2 and "followup_score" in f.honest_example


GROUPED = (
    "import pandas as pd\n"
    "from sklearn.model_selection import GroupShuffleSplit\n"
    "df = pd.read_csv('data.csv')\n"
    "gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=0)\n"
    "tr, te = next(gss.split(df, df.outcome, groups=df['subject_id']))\n"
    "m.fit(df.iloc[tr].drop(columns='outcome'), df.iloc[tr].outcome)\n"
)
BY_SUBJECT = (
    "import pandas as pd\n"
    "from sklearn.model_selection import train_test_split\n"
    "df = pd.read_csv('data.csv')\n"
    "train_ids, test_ids = train_test_split(df['subject_id'].unique(), test_size=0.2, random_state=0)\n"
    "train, test = df[df['subject_id'].isin(train_ids)], df[df.subject_id.isin(test_ids)]\n"
    "m.fit(train.drop(columns='outcome'), train.outcome)\n"
)
RANDOM = (
    "import pandas as pd\n"
    "from sklearn.model_selection import train_test_split\n"
    "df = pd.read_csv('data.csv')\n"
    "print(df.groupby('subject_id').size().describe(), df['subject_id'].nunique())\n"
    "train, test = train_test_split(df, test_size=0.2, random_state=0)\n"
    "m.fit(train.drop(columns='outcome'), train.outcome)\n"
)


def _script_run(script: str) -> list[Action]:
    return actions_from_events([
        {"type": "tool_call", "name": "execute", "args": {"command": "head -3 data.csv"}},
        {"type": "tool_call", "name": "write_file", "args": {"file_path": "/w/model.py", "content": script}},
        {"type": "tool_call", "name": "execute", "args": {"command": "cd /w && python3 model.py"}},
    ])


@pytest.mark.parametrize("code", [
    "cv = GroupKFold(n_splits=5)",
    "cv = StratifiedGroupKFold(n_splits=5)",
    "gss = GroupShuffleSplit(n_splits=1, test_size=0.2)",
    "scores = cross_val_score(m, X, y, cv=5, groups = df.subject_id)",
    "df = df.drop_duplicates(subset=['subject_id'], keep='first')",
    "one = df.groupby('subject_id', as_index=False).first()",
    'one = df.groupby("subject_id").mean()',
    "train = df[df['subject_id'].isin(train_ids)]",
])
def test_a_grouped_split_or_one_row_per_subject_is_spotted(code):
    assert "group_split" in label_text(code)


@pytest.mark.parametrize("code", [
    "print(df.groupby('subject_id').size().describe())",
    "print(df['subject_id'].nunique(), df.subject_id.value_counts().head())",
    "X = df.drop(columns=['outcome', 'subject_id'])\ntrain_test_split(X, y)",
    "df = df.drop_duplicates()",
    "cv = StratifiedKFold(n_splits=5)",
])
def test_looking_at_the_subject_id_is_not_a_grouped_split(code):
    assert "group_split" not in label_text(code)


def test_importing_a_grouped_splitter_is_not_using_it():
    unused = RANDOM.replace("import train_test_split", "import GroupShuffleSplit, train_test_split")
    assert "group_split" not in label_text(unused) and "split" in label_text(unused)
    run = _script_run(unused)
    assert "group_split" not in run[2].labels and _did_before_split(run, "group_split") is False
    block = "from sklearn.model_selection import (\n    GroupKFold,\n    train_test_split,\n)\ntrain_test_split(df)\n"
    assert "group_split" not in label_text(block)
    # In a one-liner the code after the import still counts, and an import alone still does not.
    one = "cd /w && python3 -c \"from sklearn.model_selection import GroupKFold; cv = GroupKFold(5)\""
    assert "group_split" in label_text(one)
    assert "group_split" not in label_text("cd /w && python3 -c \"from sklearn.model_selection import GroupKFold; print(1)\"")
    assert "group_split" in label_text("import pandas as pd; df = pd.read_csv('data.csv').drop_duplicates(subset='subject_id')")
    # The duplicates step is spotted where it always was.
    assert "deduplicate" in label_text("import pandas as pd; df = pd.read_csv('data.csv').drop_duplicates()")


def test_a_grouped_split_is_the_split_and_is_credited():
    grouped, by_subject, random = _script_run(GROUPED), _script_run(BY_SUBJECT), _script_run(RANDOM)
    # GroupShuffleSplit is both the split and the step, in one action.
    assert {"split", "group_split"} <= set(grouped[2].labels)
    assert _did_before_split(grouped, "group_split") is True
    # Split on the subject ids, then rows picked by id: the step comes after the split call in the text.
    assert {"split", "group_split"} <= set(by_subject[2].labels)
    assert by_subject[2].source.index("train_test_split(") < by_subject[2].source.index(".isin(")
    assert _did_before_split(by_subject, "group_split") is True
    assert "group_split" not in random[2].labels and _did_before_split(random, "group_split") is False
    # One row per subject first, then any split.
    deduped = _run(LOAD, "df = df.drop_duplicates(subset='subject_id')", "train_test_split(df)", "m.fit(X, y)")
    assert _did_before_split(deduped, "group_split") is True

    runs = {"r1": grouped, "r2": by_subject, "r3": deduped, "r4": random, "r5": random}
    f = find_split(runs, {"r1": "honest", "r2": "honest", "r3": "honest", "r4": "inflated", "r5": "inflated"})
    assert f.label == "group_split" and f.honest_rate == 1.0 and f.inflated_rate == 0.0
    assert f.fork_run_id == "r4" and f.fork_at == 2


def test_the_batch_traps_label_wins_a_tie():
    # One row per subject is `deduplicate` and `group_split` at once.
    honest = _run(LOAD, "df = df.drop_duplicates(subset='subject_id')", "train_test_split(df)")
    inflated = _run(LOAD, "train_test_split(df)")
    assert {"deduplicate", "group_split"} <= set(honest[1].labels)
    runs, statuses = {"r1": honest, "r2": inflated}, {"r1": "honest", "r2": "inflated"}
    assert find_split(runs, statuses).label == "deduplicate"
    assert find_split(runs, statuses, prefer="group_split").label == "group_split"
    # Only a tie: a label that separates the groups better still wins.
    mixed = {**runs, "r3": _run(LOAD, "df = df.drop_duplicates()", "train_test_split(df)")}
    assert find_split(mixed, {**statuses, "r3": "honest"}, prefer="group_split").label == "deduplicate"


def test_a_step_that_must_come_first_still_needs_to_come_first():
    # `deduplicate` is not a split step: removing duplicates after the split, in the same script, does not count.
    late = _run(LOAD, "tr, te = train_test_split(df)\ntr = tr.drop_duplicates()\nm.fit(X, y)")
    assert _did_before_split(late, "deduplicate") is False
    assert traps.get("duplicates").at_split is False and traps.get("repeat_rows").at_split is True


# ---- the evidence number ----
def _write_outputs(d, labels, reported, train, test):
    d.mkdir(parents=True)
    (d / "report.json").write_text(json.dumps({"test_accuracy": reported}))
    pd.DataFrame({"prediction": labels}).to_csv(d / "predictions.csv", index=False)
    train.to_csv(d / "train.csv", index=False)
    test.to_csv(d / "test.csv", index=False)


def test_repeat_rows_evidence_is_the_share_of_test_rows_from_subjects_in_training(tmp_path):
    cfg, files = _task(tmp_path, trap="repeat_rows")
    data, meta = pd.read_csv(files.data), _meta(files)
    labels = pd.read_csv(files.holdout_labels)[TARGET]

    train, test = train_test_split(data, test_size=0.2, random_state=0)
    share = repeat_rows.evidence(train, test, meta)
    assert share == pytest.approx(test[ID].isin(set(train[ID])).mean()) and 0.55 < share < 0.85
    _write_outputs(tmp_path / "random", labels, 0.95, train, test)
    s = score_run(tmp_path / "random", files, cfg.inflation_threshold)
    assert s.status == "honest" and s.overlap_share == round(share, 4)

    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=0).split(data, groups=data[ID]))
    assert repeat_rows.evidence(data.iloc[tr], data.iloc[te], meta) == 0.0
    one = data.drop_duplicates(subset=ID)
    assert repeat_rows.evidence(*train_test_split(one, test_size=0.2, random_state=0), meta) == 0.0
    # A run that did not keep the id column in its files has no evidence number.
    assert repeat_rows.evidence(train.drop(columns=ID), test, meta) is None
    _write_outputs(tmp_path / "no-id", labels, 0.8, train.drop(columns=ID), test.drop(columns=ID))
    assert score_run(tmp_path / "no-id", files, cfg.inflation_threshold).overlap_share is None


def test_leaky_column_has_no_evidence_number_and_still_scores(tmp_path):
    cfg, files = _task(tmp_path, trap="leaky_column")
    assert traps.get("leaky_column").evidence is None
    data = pd.read_csv(files.data)
    labels = pd.read_csv(files.holdout_labels)[TARGET]
    wrong = labels.copy()
    wrong.iloc[: len(wrong) // 2] = 1 - wrong.iloc[: len(wrong) // 2]
    _write_outputs(tmp_path / "out", wrong, 0.94, *train_test_split(data, test_size=0.2, random_state=0))
    s = score_run(tmp_path / "out", files, cfg.inflation_threshold)
    assert s.status == "inflated" and s.overlap_share is None and s.true_accuracy == pytest.approx(0.5, abs=0.01)
    assert json.loads(json.dumps(s.to_dict()))["overlap_share"] is None


def test_duplicates_evidence_is_unchanged(tmp_path):
    cfg, files = _task(tmp_path)
    data = pd.read_csv(files.data)
    labels = pd.read_csv(files.holdout_labels)[TARGET]
    train, test = train_test_split(data, test_size=0.2, random_state=0)
    _write_outputs(tmp_path / "out", labels, 0.9, train, test)
    s = score_run(tmp_path / "out", files, cfg.inflation_threshold)
    keys = lambda d: set(d.astype(str).agg("|".join, axis=1))  # noqa: E731
    exact = test.astype(str).agg("|".join, axis=1).isin(keys(train)).mean()
    assert s.overlap_share == round(float(exact), 4) and 0.4 < s.overlap_share < 0.65


# ---- the interventions ----
def _workspace(tmp_path, files):
    ws = tmp_path / "work space"
    ws.mkdir()
    for f in (files.data, files.holdout_features):
        shutil.copy(f, ws / f.name)
    return ws


def test_duplicates_intervention_removes_the_copies(tmp_path):
    _, files = _task(tmp_path)
    ws = _workspace(tmp_path, files)
    assert pd.read_csv(ws / "data.csv").duplicated().sum() >= 300
    out = run_intervention(traps.get("duplicates"), ws)
    fixed = pd.read_csv(ws / "data.csv")
    assert not fixed.duplicated().any() and "duplicate rows" in out
    # A few rows of Pima are identical to begin with, so slightly fewer than the planted count remain.
    assert 0 <= _meta(files)["unique_rows_before_trap"] - len(fixed) < 5
    assert (ws / "holdout_features.csv").read_bytes() == files.holdout_features.read_bytes()


def test_leaky_column_intervention_drops_the_column_from_both_files(tmp_path):
    _, files = _task(tmp_path, trap="leaky_column")
    ws = _workspace(tmp_path, files)
    out = run_intervention(traps.get("leaky_column"), ws)
    assert LEAK in out
    for name, before in (("data.csv", files.data), ("holdout_features.csv", files.holdout_features)):
        was, now = pd.read_csv(before), pd.read_csv(ws / name)
        assert LEAK in was.columns and LEAK not in now.columns
        pd.testing.assert_frame_equal(now, was.drop(columns=LEAK))
    # Running it again on files that no longer have the column is harmless.
    run_intervention(traps.get("leaky_column"), ws)
    assert len(pd.read_csv(ws / "data.csv")) == _meta(files)["rows_given_to_agent"]


def test_repeat_rows_intervention_keeps_one_visit_per_subject(tmp_path):
    _, files = _task(tmp_path, trap="repeat_rows")
    ws = _workspace(tmp_path, files)
    was = pd.read_csv(files.data)
    out = run_intervention(traps.get("repeat_rows"), ws)
    now, meta = pd.read_csv(ws / "data.csv"), _meta(files)
    assert now[ID].is_unique and len(now) == meta["subjects"] and set(now[ID]) == set(was[ID])
    assert f"removed {meta['extra_visits']} rows" in out
    # The rows that stay are rows that were there, unchanged.
    pd.testing.assert_frame_equal(now, was.drop_duplicates(subset=ID).reset_index(drop=True))
    assert (ws / "holdout_features.csv").read_bytes() == files.holdout_features.read_bytes()
    train, test = train_test_split(now, test_size=0.2, random_state=0)
    assert repeat_rows.evidence(train, test, meta) == 0.0


def test_an_intervention_that_fails_says_so(tmp_path):
    with pytest.raises(RuntimeError, match="intervention failed"):
        run_intervention(traps.get("repeat_rows"), tmp_path)  # no data.csv there


# ---- calibration: a trap must inflate a naive run, and its fix must bring the score back ----
@pytest.mark.parametrize("name", NAMES)
def test_every_trap_inflates_a_naive_run_and_its_fix_does_not(name):
    threshold = BatchConfig().inflation_threshold
    result = measure(name, seeds=(0, 1), n_estimators=50)
    naive, honest = result["naive"], result["honest"]
    assert naive["gap"] > threshold + 0.02, f"{name}: a naive run is inflated by only {naive['gap']:.3f}"
    assert honest["gap"] < threshold, f"{name}: after the fix the gap is still {honest['gap']:.3f}"
    assert naive["reported"] > honest["reported"] + 0.05


# ---- the batch and the API ----
@pytest.mark.parametrize("name", NAMES)
def test_batch_writes_trap_info_and_uses_the_traps_intervention(name, tmp_path):
    from deep_research.batch import Batch
    from deep_research.events import EventLog

    trap = traps.get(name)
    b = Batch(BatchConfig(trap=name), batch_id="t", root=tmp_path)
    config = json.loads((b.dir / "case" / "case.json").read_text())["config"]
    assert config["trap"] == name and config["trap_info"] == trap.public()
    # The saved config still loads as a BatchConfig (the CLI reopens batches this way).
    assert BatchConfig(**config).trap == name

    honest_step = {
        "deduplicate": "df = df.drop_duplicates()", "drop_leak": "df = df.drop(columns=['followup_score'])",
        "group_split": "df = df.drop_duplicates(subset='subject_id')",
    }[trap.label]
    for run_id, status, steps in (("r01", "honest", [LOAD, honest_step, "train_test_split(df)"]),
                                  ("r02", "inflated", [LOAD, "train_test_split(df)"])):
        log = EventLog(b.runs_dir / run_id / "events.jsonl")
        for i, command in enumerate(steps):
            log.write({"type": "tool_call", "id": f"c{i}", "name": "execute", "args": {"command": command}})
        log.close()
        b.case.update_run(run_id, status=status)
    b.analyze()
    split = b.case.data["split"]
    assert b.case.data["phase"] == "ready" and split["label"] == trap.label
    assert split["intervention"] == trap.intervention["description"] and split["fork_run_id"] == "r02"
    assert b.case.record_hypothesis(trap.label, "a", "b", "c") == "hypothesis saved"


def test_defaults_list_the_traps_and_an_unknown_trap_is_refused(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from deep_research import api

    monkeypatch.setattr(api, "BATCHES_DIR", tmp_path / "batches")
    monkeypatch.setattr(api, "STATS_FILE", tmp_path / "batches" / "_stats.json")
    monkeypatch.setattr(api, "Batch", lambda cfg: pytest.fail("a batch was started"))
    with TestClient(api.app) as client:
        d = client.get("/api/defaults").json()
        assert d["config"]["trap"] == "duplicates"
        assert d["traps"] == [t.public() for t in traps.registered()]
        assert [t["name"] for t in d["traps"]] == NAMES
        bad = client.post("/api/batches", json={**d["config"], "trap": "nope"})
        assert bad.status_code == 422 and "unknown trap" in json.dumps(bad.json())
        assert client.post("/api/estimate", json={**d["config"], "trap": "repeat_rows"}).status_code == 200


def test_investigator_prompt_never_names_what_was_planted():
    """What a batch was built to go wrong is the evaluator's knowledge: no trap's words reach the investigator."""
    from deep_research.agents.investigator import MAIN_PROMPT, main_prompt

    for trap in traps.registered():
        prompt = main_prompt(trap.planted)
        assert trap.planted not in prompt and "planted" not in prompt and "group_split" in prompt
    assert "duplicate rows" not in MAIN_PROMPT