"""Datasets a batch can run on: the built-in Pima table and CSV files people upload.

An upload is saved under `datasets/<id>/` (git-ignored) as `data.csv` plus `info.json`.
The column to predict is chosen per batch (`BatchConfig.target`), not at upload.
"""

from __future__ import annotations

import io
from pathlib import Path
import json
import re
import uuid

import pandas as pd

from . import config

BUILTIN = "pima"
PIMA_COLUMNS = [
    "pregnancies",
    "glucose",
    "blood_pressure",
    "skin_thickness",
    "insulin",
    "bmi",
    "diabetes_pedigree",
    "age",
    "outcome",
]
PIMA_TARGET = "outcome"

ID_PATTERN = r"^(pima|ds-[0-9a-f]{8})$"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MIN_ROWS = 100
MAX_COLUMNS = 200
# The task is classification scored by accuracy, so the target needs a few classes with enough rows each.
MAX_CLASSES = 20
MIN_ROWS_PER_CLASS = 5


class DatasetError(ValueError):
    """The file or the chosen target cannot be used. The message is shown to the person."""


def _dir(dataset_id: str):
    return config.DATASETS_DIR / dataset_id


def _pima() -> pd.DataFrame:
    return pd.read_csv(config.DATA_DIR / "pima.csv", header=None, names=PIMA_COLUMNS)


def read_table(source: bytes | Path) -> pd.DataFrame:
    """Read a CSV, keeping words like NA, None and null as values in text columns.

    pandas reads those words as "missing". In a number column that is what they mean. In a text
    column they are usually real values (NA is North America, None is a plan), and reading them as
    missing would silently drop every row of that class. There, only an empty cell is missing.
    """
    def open_() -> io.BytesIO | Path:
        return io.BytesIO(source) if isinstance(source, bytes) else source

    df = pd.read_csv(open_())
    as_text = pd.read_csv(open_(), dtype=str, keep_default_na=False, na_values=[""])
    for c in df.columns:
        if not pd.api.types.is_numeric_dtype(df[c]) and as_text[c].notna().sum() > df[c].notna().sum():
            df[c] = as_text[c]
    return df


def target_problem(df: pd.DataFrame, column: str) -> str | None:
    """Why `column` cannot be the target, or None when it can."""
    if column not in df.columns:
        return f"there is no column named '{column}'"
    counts = df[column].dropna().value_counts()
    if len(counts) < 2:
        return "it has only one value"
    if len(counts) > MAX_CLASSES:
        return f"it has {len(counts)} different values; the task needs {MAX_CLASSES} classes or fewer"
    if counts.min() < MIN_ROWS_PER_CLASS:
        return f"the value '{counts.idxmin()}' appears in only {counts.min()} rows; each class needs {MIN_ROWS_PER_CLASS}"
    return None


def describe(df: pd.DataFrame, dataset_id: str, name: str, target: str | None = None) -> dict:
    columns = [
        {
            "name": str(c),
            "kind": "number" if pd.api.types.is_numeric_dtype(df[c]) else "text",
            "n_unique": int(df[c].nunique()),
            "missing": int(df[c].isna().sum()),
            "target_problem": target_problem(df, c),
        }
        for c in df.columns
    ]
    if target is None:
        # Most tables keep the label last, so suggest the last column that can be a target.
        usable = [c["name"] for c in columns if c["target_problem"] is None]
        target = usable[-1] if usable else None
    return {
        "id": dataset_id,
        "name": name,
        "builtin": dataset_id == BUILTIN,
        "rows": int(len(df)),
        "columns": columns,
        "target": target,
    }


def save_upload(name: str, raw: bytes) -> dict:
    """Check an uploaded CSV, save it, and return its description."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise DatasetError(f"the file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    try:
        df = read_table(raw)
    except Exception as e:  # noqa: BLE001 - pandas raises many types for a bad file
        raise DatasetError(f"could not read the file as CSV: {e}") from e
    df = df.dropna(axis=0, how="all").dropna(axis=1, how="all")
    df.columns = [str(c).strip() for c in df.columns]
    if len(set(df.columns)) != len(df.columns):
        raise DatasetError("two columns have the same name")
    if len(df.columns) < 2:
        raise DatasetError("the file needs at least two columns: one to predict and one to predict it from")
    if len(df.columns) > MAX_COLUMNS:
        raise DatasetError(f"the file has {len(df.columns)} columns; the limit is {MAX_COLUMNS}")
    if len(df) < MIN_ROWS:
        raise DatasetError(f"the file has {len(df)} rows; the task needs at least {MIN_ROWS}")

    dataset_id = "ds-" + uuid.uuid4().hex[:8]
    name = re.sub(r"[^\w.\- ]", "_", name.strip())[:80] or "dataset.csv"
    info = describe(df, dataset_id, name)
    if info["target"] is None:
        raise DatasetError(
            f"no column can be the target: the task needs a column with 2 to {MAX_CLASSES} different values "
            f"and at least {MIN_ROWS_PER_CLASS} rows of each"
        )
    d = _dir(dataset_id)
    d.mkdir(parents=True, exist_ok=True)
    df.to_csv(d / "data.csv", index=False)
    (d / "info.json").write_text(json.dumps(info, indent=2))
    return info


def list_datasets() -> list[dict]:
    out = [describe(_pima(), BUILTIN, "Pima diabetes (built in)", PIMA_TARGET)]
    if config.DATASETS_DIR.exists():
        for d in sorted(config.DATASETS_DIR.iterdir()):
            try:
                out.append(json.loads((d / "info.json").read_text()))
            except Exception:  # noqa: BLE001 - a half-written upload is skipped
                continue
    return out


def load(dataset_id: str, target: str | None = None) -> tuple[pd.DataFrame, str]:
    """The table and the column to predict. Rows with no target value are dropped."""
    if not re.match(ID_PATTERN, dataset_id):
        raise DatasetError(f"unknown dataset {dataset_id}")
    if dataset_id == BUILTIN:
        df, target = _pima(), target or PIMA_TARGET
    else:
        path = _dir(dataset_id) / "data.csv"
        if not path.is_file():
            raise DatasetError(f"unknown dataset {dataset_id}")
        df = read_table(path)
        if target is None:
            raise DatasetError("choose the column to predict")
    problem = target_problem(df, target)
    if problem:
        raise DatasetError(f"'{target}' cannot be the target: {problem}")
    return df.dropna(subset=[target]).reset_index(drop=True), target


def jitter_columns(df: pd.DataFrame, target: str) -> list[str]:
    """Columns that hold non-integer numbers: the ones `trap_noise` jitters. On Pima: bmi and diabetes_pedigree."""
    out = []
    for c in df.columns:
        if c == target or not pd.api.types.is_float_dtype(df[c]):
            continue
        vals = df[c].dropna()
        if len(vals) and not (vals == vals.round()).all():
            out.append(str(c))
    return out
