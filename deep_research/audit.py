"""The audit sheet (plan Phase 4.3): after the verdict, plain code answers three questions about every scored run, each
with the evidence it rests on.

1. Did test data touch training? Rows of the run's own test.csv that are also in its train.csv (exactly, or once the
   numbers are rounded), subjects in both when the data has an id column, and preprocessing or feature selection
   fitted before the split.
2. Is every column fair to use? A feature the rows to predict do not have, a name that says it was recorded after the
   outcome, or a single column that tracks the target far more closely than any honest feature does.
3. Does the test set match the claim? The run's reported score against its true score on the hidden rows, and how
   much of its test set is new to it.

Answers are `yes`, `no` or `unknown`. Read from the run's own files and the case file, never from the holdout labels.
For the UI only: the investigator never sees the `audit` section (case_file.UPGRADE_HIDDEN).
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pandas as pd

# A single feature whose correlation with the target is at least this strong is flagged as too good to be fair.
STRONG_CORRELATION = 0.6
# A test set with more than this share of its rows also in training has touched training.
OVERLAP_SHARE = 0.01
ROUND_DECIMALS = 1
_AFTER_WORDS = re.compile(r"follow.?up|after|post_|_post\b|outcome|result|future|discharge|final", re.IGNORECASE)
_ID_COLUMN = re.compile(r"(?:^|_)(?:id|subject|patient)(?:$|_)", re.IGNORECASE)
FIT_BEFORE_SPLIT = ("preprocess", "select_features")

QUESTIONS = {
    "test_touched_training": "Did test data touch training?",
    "columns_fair": "Is every column fair to use?",
    "test_matches_claim": "Does the test set match the claim?",
}


def _read_csv(p: Path) -> pd.DataFrame | None:
    try:
        return pd.read_csv(p) if p.is_file() else None
    except Exception:  # noqa: BLE001 - an unreadable file is an unknown answer, not a crash
        return None


def _row_keys(df: pd.DataFrame, cols: list[str], decimals: int | None = None) -> pd.Series:
    part = df[cols]
    if decimals is not None:
        part = part.apply(lambda s: s.round(decimals) if pd.api.types.is_numeric_dtype(s) else s)
    return part.astype(str).agg("|".join, axis=1)


def _share_in(test: pd.DataFrame, train: pd.DataFrame, cols: list[str], decimals: int | None = None) -> float:
    if not cols or len(test) == 0:
        return 0.0
    seen = set(_row_keys(train, cols, decimals))
    return float(_row_keys(test, cols, decimals).isin(seen).mean())


def _fit_before_split(labels: list[list[str]] | None, anchor: str = "split") -> list[str]:
    """Steps fitted on the data before its last split, in their own action (a scaler or a selector seeing test rows)."""
    labels = labels or []
    splits = [i for i, ls in enumerate(labels) if anchor in ls]
    if not splits:
        return []
    found = []
    for ls in labels[: splits[-1]]:
        for step in FIT_BEFORE_SPLIT:
            if step in ls and anchor not in ls and step not in found:
                found.append(step)
    return found


def _q1(train: pd.DataFrame | None, test: pd.DataFrame | None, labels, id_column: str | None) -> dict:
    if train is None or test is None:
        return {"answer": "unknown", "evidence": ["the run saved no train.csv and test.csv to compare"], "numbers": {}}
    cols = [c for c in test.columns if c in train.columns]
    exact = _share_in(test, train, cols)
    near = _share_in(test, train, cols, ROUND_DECIMALS)
    numbers = {"n_test": len(test), "n_train": len(train), "exact_overlap": round(exact, 4),
               "near_overlap": round(near, 4)}
    evidence = [f"{exact:.0%} of test rows are an exact copy of a training row",
                f"{near:.0%} match a training row once numbers are rounded to {ROUND_DECIMALS} decimal"]
    ids = id_column if id_column and id_column in cols else next((c for c in cols if _ID_COLUMN.search(c)), None)
    subject = None
    if ids:
        subject = float(test[ids].isin(set(train[ids])).mean()) if len(test) else 0.0
        numbers.update(id_column=ids, subject_overlap=round(subject, 4))
        evidence.append(f"{subject:.0%} of test rows share a {ids} with a training row")
    fitted = _fit_before_split(labels)
    if fitted:
        numbers["fitted_before_split"] = fitted
        evidence.append(f"{' and '.join(fitted)} ran on the data before the split")
    touched = exact > OVERLAP_SHARE or near > OVERLAP_SHARE or (subject or 0) > OVERLAP_SHARE or bool(fitted)
    return {"answer": "yes" if touched else "no", "evidence": evidence, "numbers": numbers}


def _q2(train: pd.DataFrame | None, holdout: pd.DataFrame | None, target: str | None) -> dict:
    if train is None:
        return {"answer": "unknown", "evidence": ["the run saved no train.csv"], "numbers": {}}
    feats = [c for c in train.columns if c != target]
    flagged: dict[str, list[str]] = {}
    corr: dict[str, float] = {}
    y = pd.to_numeric(train[target], errors="coerce") if target in train.columns else None
    for c in feats:
        why = []
        if holdout is not None and c not in holdout.columns:
            why.append("the rows to predict do not have it")
        if _AFTER_WORDS.search(c):
            why.append("its name says it was recorded after the outcome")
        x = pd.to_numeric(train[c], errors="coerce")
        if y is not None and x.notna().sum() > 2 and x.std() > 0 and y.std() > 0:
            r = float(x.corr(y))
            if r == r:  # not NaN
                corr[c] = round(r, 3)
                if abs(r) >= STRONG_CORRELATION:
                    why.append(f"it alone tracks {target} (correlation {r:+.2f})")
        if why:
            flagged[c] = why
    evidence = [f"{c}: {'; '.join(w)}" for c, w in flagged.items()] or [
        f"none of the {len(feats)} features is missing from the rows to predict, named as recorded after the "
        f"outcome, or correlated with {target} at {STRONG_CORRELATION} or more"]
    top = max(corr.items(), key=lambda kv: abs(kv[1]), default=None)
    numbers = {"n_features": len(feats), "flagged": sorted(flagged)}
    if top:
        numbers["strongest"] = {"column": top[0], "correlation": top[1]}
    return {"answer": "no" if flagged else "yes", "evidence": evidence, "numbers": numbers}


def _q3(run: dict, test: pd.DataFrame | None, threshold: float, exact_overlap: float | None) -> dict:
    rep, true, gap = run.get("reported_accuracy"), run.get("true_accuracy"), run.get("gap")
    if rep is None or true is None:
        return {"answer": "unknown", "evidence": ["the run has no reported and true score to compare"], "numbers": {}}
    gap = gap if gap is not None else rep - true
    evidence = [f"reported {rep:.1%} on its own test set, {true:.1%} on the hidden rows (gap {gap:+.1%}, "
                f"{threshold:.0%} allowed)"]
    numbers = {"reported": rep, "true": true, "gap": round(gap, 4), "threshold": threshold}
    if test is not None:
        numbers["n_test"] = len(test)
        evidence.append(f"its test set has {len(test)} rows")
    if exact_overlap is not None:
        evidence.append(f"{1 - exact_overlap:.0%} of them are new to the model")
    return {"answer": "yes" if gap <= threshold else "no", "evidence": evidence, "numbers": numbers}


def run_sheet(run_id: str, run: dict, run_dir: Path, task_dir: Path, threshold: float) -> dict:
    """The three answers for one scored run, read from `run_dir/outputs` and the task's public files."""
    out = run_dir / "outputs"
    train, test = _read_csv(out / "train.csv"), _read_csv(out / "test.csv")
    holdout = _read_csv(task_dir / "holdout_features.csv")
    try:
        meta = json.loads((task_dir / "meta.json").read_text())
    except (OSError, ValueError):
        meta = {}
    target = meta.get("target") or "outcome"
    q1 = _q1(train, test, run.get("labels"), meta.get("id_column"))
    q2 = _q2(train, holdout, target)
    q3 = _q3(run, test, threshold, q1["numbers"].get("exact_overlap"))
    answers = {"test_touched_training": q1, "columns_fair": q2, "test_matches_claim": q3}
    return {"run_id": run_id, "status": run.get("status"),
            "questions": [{"id": k, "question": QUESTIONS[k], **v} for k, v in answers.items()]}


def build_audit(case: dict, batch_dir: Path, threshold: float) -> dict:
    """`{at, runs: {run_id: sheet}}` for every honest or inflated run of the batch."""
    runs = {}
    for rid, run in sorted((case.get("runs") or {}).items()):
        if isinstance(run, dict) and run.get("status") in ("honest", "inflated"):
            runs[rid] = run_sheet(rid, run, batch_dir / "runs" / rid, batch_dir / "task", threshold)
    return {"at": time.time(), "runs": runs}
