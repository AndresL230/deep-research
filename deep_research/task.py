"""Build a task: the dataset with a planted trap, the clean holdout, and the prompt.

The agent gets `data.csv` (with the trap) and `holdout_features.csv` (no labels).
`holdout_labels.csv` never leaves our server. It is how we know the true score.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from . import datasets, user_scripts
from .config import VM_LIVE_DIR, VM_WORKSPACE, BatchConfig
from .datasets import PIMA_COLUMNS, PIMA_TARGET

# Pima's names, kept for the fixture script and the tests. Other datasets carry theirs in `meta.json`.
TARGET = PIMA_TARGET
NOISY_COLUMNS = ["bmi", "diabetes_pedigree"]

# Files the agent must write, relative to its workspace.
OUTPUT_FILES = ["report.json", "predictions.csv", "train.csv", "test.csv"]


@dataclass
class TaskFiles:
    dir: Path
    data: Path
    holdout_features: Path
    holdout_labels: Path
    meta: Path
    # The uploaded training script. The file exists only when the batch has one.
    script: Path

    @classmethod
    def in_dir(cls, d: Path) -> "TaskFiles":
        return cls(
            dir=d,
            data=d / "data.csv",
            holdout_features=d / "holdout_features.csv",
            holdout_labels=d / "holdout_labels.csv",
            meta=d / "meta.json",
            script=d / user_scripts.VM_NAME,
        )

    def given_files(self) -> dict[str, str]:
        """Scripts the agent starts with, by file name. The split finder needs their text to label a run of them."""
        return {self.script.name: self.script.read_text()} if self.script.is_file() else {}


def load_dataset(name: str = "pima", target: str | None = None) -> pd.DataFrame:
    return datasets.load(name, target)[0]


def read_meta(task: TaskFiles) -> dict:
    try:
        return json.loads(task.meta.read_text())
    except Exception:  # noqa: BLE001 - scoring falls back to Pima's columns
        return {}


def plant_duplicates(
    df: pd.DataFrame, strength: float, noise: float, rng: np.random.Generator, noisy: list[str] | None = None
) -> tuple[pd.DataFrame, int]:
    """Copy a share of rows once more and shuffle. Returns the new frame and the copy count."""
    n_copies = int(round(len(df) * strength))
    if n_copies == 0:
        return df.sample(frac=1, random_state=int(rng.integers(1 << 31))).reset_index(drop=True), 0
    idx = rng.choice(len(df), size=n_copies, replace=False)
    copies = df.iloc[idx].copy()
    if noise > 0:
        for col in NOISY_COLUMNS if noisy is None else noisy:
            factor = 1 + rng.normal(0, noise * 0.05, size=len(copies))
            copies[col] = (copies[col] * factor).round(3)
    out = pd.concat([df, copies], ignore_index=True)
    out = out.sample(frac=1, random_state=int(rng.integers(1 << 31))).reset_index(drop=True)
    return out, n_copies


def build_task(cfg: BatchConfig, out_dir: Path) -> TaskFiles:
    """Write the task files for a batch. Every run in the batch gets the same files."""
    out_dir.mkdir(parents=True, exist_ok=True)
    files = TaskFiles.in_dir(out_dir)
    rng = np.random.default_rng(cfg.seed)

    df, target = datasets.load(cfg.dataset, cfg.target)
    noisy = datasets.jitter_columns(df, target)
    try:
        work, holdout = train_test_split(
            df, test_size=cfg.holdout_fraction, random_state=cfg.seed, stratify=df[target]
        )
    except ValueError as e:
        raise datasets.DatasetError(f"could not set a holdout aside: {e}") from e
    data, n_copies = plant_duplicates(work.reset_index(drop=True), cfg.trap_strength, cfg.trap_noise, rng, noisy)

    script_name = None
    if cfg.script:
        text, info = user_scripts.load(cfg.script)
        files.script.write_text(text)
        script_name = info["name"]

    data.to_csv(files.data, index=False)
    holdout = holdout.reset_index(drop=True)
    holdout.drop(columns=[target]).to_csv(files.holdout_features, index=False)
    holdout[[target]].to_csv(files.holdout_labels, index=False)
    files.meta.write_text(
        json.dumps(
            {
                "dataset": cfg.dataset,
                "target": target,
                "columns": [str(c) for c in df.columns],
                "noisy_columns": noisy,
                "script": script_name,
                "trap": cfg.trap,
                "rows_given_to_agent": len(data),
                "unique_rows_before_trap": len(work),
                "planted_copies": n_copies,
                "trap_noise": cfg.trap_noise,
                "holdout_rows": len(holdout),
            },
            indent=2,
        )
    )
    return files


def task_prompt(cfg: BatchConfig) -> str:
    model_line = (
        "Use a random forest classifier."
        if cfg.model_hint == "random_forest"
        else "Use whichever classifier you think is best."
    )
    hint = "\nCheck the data quality before you model it.\n" if cfg.hint_level == "light" else "\n"
    if cfg.dataset == datasets.BUILTIN and cfg.target in (None, PIMA_TARGET):
        about = (
            f"`{VM_WORKSPACE}/data.csv` has medical measurements for patients and whether each one developed "
            "diabetes (the `outcome` column, 1 = yes).\nBuild a model that predicts `outcome`."
        )
        prediction = "one column named `prediction` (0 or 1)"
    else:
        about = (
            f"`{VM_WORKSPACE}/data.csv` is a table with one row per example.\n"
            f"Build a model that predicts the `{cfg.target}` column from the other columns."
        )
        prediction = (
            f"one column named `prediction` holding the predicted `{cfg.target}` value, written the way "
            "it appears in `data.csv`"
        )
    if cfg.script:
        # The script decides the model, so the model hint is left out.
        model_line = (
            f"\nA colleague already wrote a training script for this data: `{VM_WORKSPACE}/{user_scripts.VM_NAME}`. "
            "Start from it: read it, run it, and change it where you need to (file paths, column names, "
            "anything you judge to be wrong). Keep its model and its approach unless you have a reason to change them."
        )
    return f"""You are a data scientist. Work in `{VM_WORKSPACE}`.

{about} {model_line}
{hint}
Do the usual workflow: split the data into a training set and a test set, train on the training set, and measure accuracy on the test set.

When you are done, write these files in `{VM_WORKSPACE}`:
- `train.csv` and `test.csv`: the exact rows you trained and tested on, with all columns.
- `report.json`: {{"test_accuracy": <float between 0 and 1>, "model": "<what you used>", "notes": "<one or two sentences>"}}
- `predictions.csv`: {prediction}, one row per row of `{VM_WORKSPACE}/holdout_features.csv`, in the same order.

Save any charts you make as PNG files in `{VM_LIVE_DIR}/`. Plan your work with the todo list and keep it updated as you go.
Run Python with `python3`. pandas, scikit-learn and matplotlib are installed.
"""
