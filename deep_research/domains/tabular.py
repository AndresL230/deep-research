"""The tabular data science domain: train a classifier on a CSV with a flaw planted in it.

The agent gets `data.csv`, with a trap planted in it (deep_research/traps/), and `holdout_features.csv`,
and reports a test accuracy. We score its predictions on the holdout labels it never sees. The pieces
live where they always have: task.py, traps/, scoring.py, analysis.py and forks.py. This module only
points the engine at them.
"""

from __future__ import annotations

from pathlib import Path

from .. import analysis, datasets, forks, scoring, traps, user_scripts
from ..config import SKILLS_DIR, VM_WORKSPACE, BatchConfig
from ..task import OUTPUT_FILES, TaskFiles, build_task, task_prompt
from . import Domain, DomainWords, InvestigatorWords, StepWords

# Step words that are no trap's own, as the web app's lane view has said them. Each trap's step takes the trap's own
# `did` and `missing` (deep_research/traps/). `steps` covers every label of analysis.LABELS (a test checks).
_BASE_STEPS = {
    "load": StepWords("loading the data", "loaded the data", "No data loaded here"),
    "inspect": StepWords("looking at the data", "looked at the data", "No look at the data here"),
    "deduplicate_near": StepWords("removing near-duplicate rows", "removed near-duplicate rows", "No near-duplicate removal here"),
    "clean": StepWords("cleaning up missing values", "cleaned up missing values", "No cleaning here"),
    "drop_column": StepWords("leaving out a column", "dropped a column", "No column dropped here"),
    "select_features": StepWords("choosing features", "chose features by their link to the target", "No feature selection here"),
    "split": StepWords("splitting into train and test", "split the data", "No split here"),
    "preprocess": StepWords("scaling the features", "scaled or imputed the features", "No preprocessing here"),
    "train": StepWords("training a model", "trained a model", "No model trained here"),
    "evaluate": StepWords("scoring the model", "scored a model", "No scoring here"),
    "plot": StepWords("drawing charts", "drew a chart", "No chart here"),
    "predict": StepWords("predicting the holdout rows", "read the holdout rows", "No holdout rows read here"),
    "report": StepWords("writing the report", "wrote the report", "No report written here"),
}
# Each trap's step as a name, next to the trap's own "removed duplicate rows".
_TRAP_STEP_NAMES = {
    "deduplicate": "removing duplicate rows",
    "drop_leak": "leaving out the leaky column",
    "group_split": "grouping the rows by subject",
}


def _steps() -> dict[str, StepWords]:
    own = {t.label: StepWords(_TRAP_STEP_NAMES.get(t.label, t.label.replace("_", " ")), t.did, t.missing)
           for t in traps.registered()}
    return {label: own.get(label) or _BASE_STEPS[label] for label in analysis.LABELS}


# How the screens talk about a tabular batch.
WORDS = DomainWords(
    subject="model",
    judged_on="on {n} rows they never saw",
    checked="test set",
    claim_label="Claimed",
    truth_label="Measured",
    step_when="before splitting into train and test",
    skipped="This run went straight to splitting the data",
    evidence_text="of test rows were also in training",
    steps=_steps(),
)


def upload_files(task: TaskFiles) -> list[tuple[Path, str]]:
    """The trapped data, the holdout features and the uploaded script, if any. Never the holdout labels."""
    files = [(task.data, f"{VM_WORKSPACE}/data.csv"), (task.holdout_features, f"{VM_WORKSPACE}/holdout_features.csv")]
    if task.script.is_file():
        files.append((task.script, f"{VM_WORKSPACE}/{task.script.name}"))
    return files


def lab_image():
    from .. import sandboxes  # here: sandboxes imports the domains

    return sandboxes.lab_image()


def check_config(cfg: BatchConfig) -> None:
    """The dataset, its target and the script must load. Raises DatasetError or ScriptError."""
    datasets.load(cfg.dataset, cfg.target)
    if cfg.script:
        user_scripts.load(cfg.script)


DOMAIN = Domain(
    name="tabular",
    title="Tabular data science",
    description="Agents train a classifier on a CSV with a flaw planted in it and report a test accuracy; "
    "we score their predictions on held-out rows they never see.",
    visual="charts",
    build_task=build_task,
    open_task=TaskFiles.in_dir,
    owns_task=lambda task: isinstance(task, TaskFiles),
    task_marker="data.csv",
    upload_files=upload_files,
    task_prompt=task_prompt,
    given_files=lambda task: task.given_files(),
    output_files=OUTPUT_FILES,
    score_run=scoring.score_run,
    steps=lambda: analysis.STEPS,
    label_text=analysis.label_text,
    actions_from_events=analysis.actions_from_events,
    prefer_label=lambda cfg: traps.get(cfg.trap).label,
    intervention_for=lambda label, cfg: forks.intervention_for(label, cfg.trap),
    show_for=forks.SHOW.get,
    placebo=lambda: forks.PLACEBO,
    skills_dir=SKILLS_DIR,
    investigator_words=InvestigatorWords(),
    planted=lambda cfg: traps.get(cfg.trap).planted,
    words=WORDS,
    lab_image=lab_image,
    snapshot_env="DAYTONA_SNAPSHOT",
    secret_files=("holdout_labels",),
    # `trap_info` is the trap in words and patterns, so the UI and the investigator need no list of traps.
    case_config=lambda cfg: {"trap_info": traps.get(cfg.trap).public()},
    check_config=check_config,
)
