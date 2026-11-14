"""Measure a trap without agents: does it inflate a naive run, and does its fix bring the score back?

For each seed the trap's task is built, then a random forest is trained two ways:
- naive: a random row split of data.csv, every column used;
- honest: the trap's intervention is run on the files first (the same command the fork experiment
  forces), then the same split and model.
Reported accuracy is on the run's own test rows, true accuracy on the hidden holdout. A trap is
usable when the naive gap is well above the inflation threshold and the honest gap is below it.

Used by `scripts/calibrate_traps.py` and by the test that checks every registered trap.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

from . import datasets, traps
from .config import VM_WORKSPACE, BatchConfig
from .task import TaskFiles, build_task

ARMS = ("naive", "honest")


def run_intervention(trap: traps.Trap, workspace: Path) -> str:
    """Run a trap's intervention command with `workspace` standing in for the VM workspace. Returns its output."""
    command = trap.intervention["command"].replace(VM_WORKSPACE, shlex.quote(str(workspace)))
    # `python3` must be this interpreter, the one that has pandas.
    env = {**os.environ, "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    done = subprocess.run(command, shell=True, capture_output=True, text=True, env=env, timeout=120)
    if done.returncode != 0:
        raise RuntimeError(f"the '{trap.name}' intervention failed: {done.stderr.strip()[-500:]}")
    return done.stdout


def _numbers(train: pd.DataFrame, test: pd.DataFrame, holdout: pd.DataFrame) -> list[pd.DataFrame]:
    """The three frames with text columns as category codes and gaps filled, so a forest can read them."""
    whole = pd.concat([train, test, holdout], keys=["train", "test", "holdout"])
    for c in whole.columns:
        if not pd.api.types.is_numeric_dtype(whole[c]):
            whole[c] = pd.factorize(whole[c], sort=True)[0]
    whole = whole.fillna(whole.median())
    return [whole.loc[k] for k in ("train", "test", "holdout")]


def naive_run(workspace: Path, task: TaskFiles, target: str, seed: int, n_estimators: int) -> dict:
    """What an agent that checks nothing does: split the rows at random, use every column, report test accuracy."""
    # Read the way the task was: a class or a value spelled NA is a word, not a gap.
    data = datasets.read_table(workspace / "data.csv")
    holdout = datasets.read_table(workspace / "holdout_features.csv")
    labels = pd.read_csv(task.holdout_labels, keep_default_na=False, na_values=[""]).iloc[:, 0]
    train, test = train_test_split(data, test_size=0.2, random_state=seed)
    features = [c for c in data.columns if c != target]
    x_train, x_test, x_holdout = _numbers(train[features], test[features], holdout[features])
    model = RandomForestClassifier(n_estimators=n_estimators, random_state=seed)
    model.fit(x_train, train[target].astype(str))
    reported = float((model.predict(x_test) == test[target].astype(str)).mean())
    true = float((model.predict(x_holdout) == labels.astype(str).to_numpy()).mean())
    return {"reported": reported, "true": true, "gap": reported - true}


def measure(trap_name: str, seeds: tuple[int, ...] = (0, 1, 2, 3, 4), n_estimators: int = 300, **settings) -> dict:
    """Mean reported accuracy, true accuracy and gap for the naive and the honest run. `settings` override the config."""
    trap = traps.get(trap_name)
    rows: dict[str, list[dict]] = {arm: [] for arm in ARMS}
    for seed in seeds:
        cfg = BatchConfig(trap=trap_name, seed=seed, **settings)
        with tempfile.TemporaryDirectory() as tmp:
            task = build_task(cfg, Path(tmp) / "task")
            target = pd.read_csv(task.holdout_labels, nrows=0).columns[0]
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            for f in (task.data, task.holdout_features):
                shutil.copy(f, workspace / f.name)
            rows["naive"].append(naive_run(workspace, task, target, seed, n_estimators))
            run_intervention(trap, workspace)
            rows["honest"].append(naive_run(workspace, task, target, seed, n_estimators))
    return {
        arm: {k: sum(r[k] for r in rows[arm]) / len(rows[arm]) for k in ("reported", "true", "gap")}
        for arm in ARMS
    }
