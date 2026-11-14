"""Duplicate rows: a share of the rows is copied once more, so copies land on both sides of a random split."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import datasets
from ..datasets import PIMA_COLUMNS
from . import Planted, Trap, in_workspace

# Pima's jittered columns, for batches saved before the task's meta listed them.
PIMA_NOISY = ["bmi", "diabetes_pedigree"]
# What those batches were written and matched with.
WRITE_DECIMALS, MATCH_DECIMALS = 3, 1


def jitter_decimals(values: pd.Series) -> tuple[int, int]:
    """How many decimals to write a jittered copy with, and how many to match it at, from the column's own spread.

    Written: three decimals, more when the column's values are small enough to need them (a column
    around 0.0003 keeps six). Matched: two decimals fewer than written, so a jittered copy still reads
    as the same row, and coarser still when the spread is large (an income column matches to the
    thousand). Pima's two columns come out at 3 and 1.
    """
    spread = float(pd.to_numeric(values, errors="coerce").std())
    if not math.isfinite(spread) or spread <= 0:
        return WRITE_DECIMALS, MATCH_DECIMALS
    magnitude = math.floor(math.log10(spread))
    write = max(WRITE_DECIMALS, 2 - magnitude)
    return write, min(write - 2, 1 - magnitude)


def plant_duplicates(
    df: pd.DataFrame,
    strength: float,
    noise: float,
    rng: np.random.Generator,
    noisy: list[str] | None = None,
    decimals: dict[str, int] | None = None,
) -> tuple[pd.DataFrame, int]:
    """Copy a share of rows once more and shuffle. Returns the new frame and the copy count."""
    n_copies = int(round(len(df) * strength))
    if n_copies == 0:
        return df.sample(frac=1, random_state=int(rng.integers(1 << 31))).reset_index(drop=True), 0
    idx = rng.choice(len(df), size=n_copies, replace=False)
    copies = df.iloc[idx].copy()
    if noise > 0:
        for col in PIMA_NOISY if noisy is None else noisy:
            factor = 1 + rng.normal(0, noise * 0.05, size=len(copies))
            copies[col] = (copies[col] * factor).round((decimals or {}).get(col, WRITE_DECIMALS))
    out = pd.concat([df, copies], ignore_index=True)
    out = out.sample(frac=1, random_state=int(rng.integers(1 << 31))).reset_index(drop=True)
    return out, n_copies


def plant(work, holdout_features, target, cfg, rng) -> Planted:
    # Judged on every row, the holdout's included, as it was before traps were pluggable.
    noisy = datasets.jitter_columns(pd.concat([work, holdout_features], ignore_index=True), target)
    decimals = {c: jitter_decimals(work[c]) for c in noisy}
    data, n_copies = plant_duplicates(
        work, cfg.trap_strength, cfg.trap_noise, rng, noisy, {c: d[0] for c, d in decimals.items()}
    )
    meta = {
        "noisy_columns": noisy,
        "planted_copies": n_copies,
        # The scorer matches a jittered copy to its original with the same numbers the copies were made with.
        "write_decimals": {c: d[0] for c, d in decimals.items()},
        "match_decimals": {c: d[1] for c, d in decimals.items()},
    }
    return Planted(data, holdout_features, meta)


def _row_keys(df: pd.DataFrame, columns: list[str], rounded: dict[str, int]) -> pd.Series:
    """A key per row. Columns in `rounded` are rounded to that many decimals, so jittered copies still match."""
    cols = [c for c in columns if c in df.columns]
    if not cols:
        raise ValueError("none of the dataset's columns are in this file")
    parts = {}
    for c in cols:
        # Decided cell by cell, never per file: a cell that is a number compares as a number (148 in
        # one file matches 148.0 in the other), anything else as text. Deciding per column would key
        # the same value differently in train.csv and test.csv when only one of them has a stray
        # non-numeric cell in that column, and every overlapping row would be missed.
        num = pd.to_numeric(df[c], errors="coerce").astype(float)
        # Adding 0.0 turns -0.0 into 0.0: rounding to the thousand must not split one bucket in two.
        as_number = (num.round(rounded.get(c, 6)) + 0.0).astype(str)
        parts[c] = as_number.where(num.notna(), df[c].astype(str).str.strip())
    return pd.DataFrame(parts).agg("|".join, axis=1)


def overlap_share(
    train: pd.DataFrame,
    test: pd.DataFrame,
    columns: list[str] | None = None,
    rounded: list[str] | dict[str, int] | None = None,
) -> float:
    """Share of test rows that also appear in training. The defaults are Pima's columns.

    `rounded` names the jittered columns: a dict gives each one's decimals, a list means one decimal.
    """
    if len(test) == 0:
        return 0.0
    columns = PIMA_COLUMNS if columns is None else columns
    rounded = PIMA_NOISY if rounded is None else rounded
    if not isinstance(rounded, dict):
        rounded = {c: MATCH_DECIMALS for c in rounded}
    train_keys = set(_row_keys(train, columns, rounded))
    return float(_row_keys(test, columns, rounded).isin(train_keys).mean())


def evidence(train: pd.DataFrame, test: pd.DataFrame, meta: dict) -> float | None:
    if "columns" in meta and not meta.get("trap_noise", 0) > 0:
        # Exact copies: exact matching.
        rounded: list[str] | dict[str, int] | None = {}
    else:
        # Batches saved before meta had columns are Pima; ones saved before it had decimals match at one.
        rounded = meta.get("match_decimals", meta.get("noisy_columns"))
    return overlap_share(train, test, meta.get("columns"), rounded)


TRAP = Trap(
    name="duplicates",
    title="Duplicate rows",
    description="A share of the rows is copied once more. A random split puts copies in both train and test.",
    planted="duplicate rows",
    strength_label="Duplicated rows",
    label="deduplicate",
    # Removing rows: `drop_duplicates`, or keeping `~df.duplicated()`. Counting them is only a look.
    pattern=r"drop_duplicates|~[^\n\]]*?\.duplicated\(",
    top_level=True,
    did="removed duplicate rows",
    missing="No duplicate removal here",
    plant=plant,
    intervention={
        "description": "Remove duplicate rows from data.csv before the split",
        "command": in_workspace(
            "import pandas as pd; d = pd.read_csv('data.csv'); n = len(d); "
            "d = d.drop_duplicates(); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} duplicate rows. {len(d)} rows remain.')"
        ),
    },
    evidence=evidence,
    evidence_text="of test rows were also in training",
)
