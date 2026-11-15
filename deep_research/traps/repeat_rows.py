"""Repeat subjects: each row becomes one subject, and some subjects come back for more visits.

A visit is a near-copy of the subject's row with the same target. A random row split puts visits of
one subject on both sides, so the model is tested on people it has already seen. The holdout is
unseen subjects, one row each.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..datasets import DatasetError
from . import Planted, Trap, in_workspace

ID = "subject_id"
# A subject with extra visits gets 1 to MAX_EXTRA of them.
MAX_EXTRA = 3
# A visit moves each number by about this share of the column's spread. The floor keeps visits from being
# exact copies when `trap_noise` is 0; `trap_noise` adds to it.
JITTER_FLOOR = 0.02
JITTER_PER_NOISE = 0.2
FIRST_ID = 1001
DQ = '"'
QUOTE = f"['{DQ}]"


def _decimals(values: pd.Series) -> int:
    """How many decimals the column's values are written with, up to 6."""
    v = values.dropna().to_numpy(dtype=float)
    for d in range(6):
        if np.allclose(v, v.round(d), rtol=0, atol=10.0 ** -(d + 3)):
            return d
    return 6


def _numeric_features(df: pd.DataFrame, target: str) -> list[str]:
    return [
        c for c in df.columns
        if c != target and pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c])
    ]


def _row_key(row: np.ndarray) -> tuple:
    return tuple(None if np.isnan(x) else float(x) for x in row)


def jitter_visits(visits: pd.DataFrame, work: pd.DataFrame, columns: list[str], share: float, rng) -> pd.DataFrame:
    """Move each number in `visits` a little, staying inside the column's range and its number of decimals.

    `visits` are copies of rows of `work`, each with its subject's id.
    """
    out = visits.copy()
    decimals: dict[str, int] = {}
    for c in columns:
        spread = float(work[c].std())
        if not np.isfinite(spread) or spread <= 0:
            continue
        decimals[c] = _decimals(work[c])
        moved = (visits[c] + rng.normal(0, share * spread, size=len(visits))).round(decimals[c])
        out[c] = moved.clip(work[c].min(), work[c].max()).astype(work[c].dtype)
    if not decimals:
        return out

    # A visit is never an exact copy of its subject's row or of another of its visits. One that came out
    # the same moves to the nearest free value, in the column with the most different values that has a
    # number for it.
    cols = sorted(decimals, key=lambda k: -work[k].nunique())
    low, high = work[cols].min().to_numpy(dtype=float), work[cols].max().to_numpy(dtype=float)
    before, after = visits[cols].to_numpy(dtype=float), out[cols].to_numpy(dtype=float)
    rows_of: dict[object, set[tuple]] = {}
    for i, subject in enumerate(visits[ID].to_numpy()):
        rows = rows_of.setdefault(subject, {_row_key(before[i])})
        if _row_key(after[i]) in rows:
            for j, c in enumerate(cols):
                if np.isnan(before[i, j]):
                    continue
                used = {r[j] for r in rows}
                step = 10.0 ** -decimals[c]
                # One step up, one down, two up, two down: more tries than a subject has rows.
                tries = [sign * k * step for k in range(1, 2 * MAX_EXTRA + 2) for sign in (1, -1)]
                near = (round(float(before[i, j] + t), decimals[c]) for t in tries)
                free = next((v for v in near if low[j] <= v <= high[j] and v not in used), None)
                if free is not None:
                    after[i, j] = free
                    break
        rows.add(_row_key(after[i]))
    for j, c in enumerate(cols):
        out[c] = pd.Series(after[:, j], index=out.index).astype(work[c].dtype)
    return out


def plant(work, holdout_features, target, cfg, rng) -> Planted:
    if ID in work.columns:
        raise DatasetError(f"the dataset already has a column named '{ID}', which this trap adds")
    n = len(work)
    # Shuffled, so the holdout's subjects are not the highest ids.
    ids = rng.permutation(n + len(holdout_features)) + FIRST_ID
    data = work.copy()
    data.insert(0, ID, ids[:n])
    holdout = holdout_features.copy()
    holdout.insert(0, ID, ids[n:])

    n_repeat = int(round(n * cfg.trap_strength))
    n_visits = 0
    if n_repeat:
        who = rng.choice(n, size=n_repeat, replace=False)
        extra = rng.integers(1, MAX_EXTRA + 1, size=n_repeat)
        visits = data.iloc[np.repeat(who, extra)].reset_index(drop=True)
        share = JITTER_FLOOR + JITTER_PER_NOISE * cfg.trap_noise
        visits = jitter_visits(visits, work, _numeric_features(work, target), share, rng)
        n_visits = len(visits)
        data = pd.concat([data, visits], ignore_index=True)
    data = data.sample(frac=1, random_state=int(rng.integers(1 << 31))).reset_index(drop=True)
    meta = {"id_column": ID, "subjects": n, "subjects_with_extra_visits": n_repeat, "extra_visits": n_visits}
    return Planted(data, holdout, meta)


def evidence(train: pd.DataFrame, test: pd.DataFrame, meta: dict) -> float | None:
    """Share of test rows whose subject also has a row in training."""
    col = meta.get("id_column", ID)
    if col not in train.columns or col not in test.columns or len(test) == 0:
        return None
    seen = set(pd.to_numeric(train[col], errors="coerce").dropna())
    return float(pd.to_numeric(test[col], errors="coerce").isin(seen).mean())


TRAP = Trap(
    name="repeat_rows",
    title="Repeat subjects",
    description=(
        f"Some subjects have several visits, near-copies that share a {ID}. A random row split puts "
        "the same subject in both train and test."
    ),
    planted="repeat visits of the same subjects",
    strength_label="Subjects with repeat visits",
    label="group_split",
    # A grouped splitter, groups passed to a splitter, one row kept per subject, or rows picked by subject id.
    pattern=(
        r"Group(?:KFold|ShuffleSplit)|Leave(?:One|P)Groups?Out"
        r"|\bgroups\s*="
        rf"|drop_duplicates\([^)]*{ID}"
        rf"|groupby\(\s*{QUOTE}{ID}{QUOTE}[^)]*\)\s*\.\s*(?:first|last|head|nth|sample|mean|median|agg|aggregate)\("
        rf"|{ID}{QUOTE}?\s*\]?\s*\.isin\("
    ),
    did="grouped the rows by subject",
    missing="No grouping by subject here",
    plant=plant,
    intervention={
        "description": "Keep one visit per subject in data.csv before the split",
        "rationale": ("Before splitting, I'll keep one visit per subject, so visits from the same subject can't land "
                      "in both train and test."),
        "command": in_workspace(
            # Read as text so the rows that stay are written back exactly as they were.
            "import pandas as pd; d = pd.read_csv('data.csv', dtype=str, keep_default_na=False); n = len(d); "
            f"d = d.drop_duplicates(subset='{ID}'); d.to_csv('data.csv', index=False); "
            "print(f'Kept one visit per subject: removed {n - len(d)} rows. {len(d)} rows remain.')"
        ),
    },
    evidence=evidence,
    evidence_text="of test rows came from subjects also in training",
    # A grouped split is the split, so the step counts when it is in the action that splits.
    at_split=True,
    columns=(ID,),
)
