"""Leaky column: a column that was derived from the target, such as a lab value only measured after the diagnosis.

In the agent's data.csv the column tracks the target. In holdout_features.csv it is there but says
nothing, because at prediction time that value does not exist yet. A model that uses it reports a
very high test accuracy and does badly on the holdout.
"""

from __future__ import annotations

import pandas as pd

from ..datasets import DatasetError
from . import Planted, Trap, in_workspace

COLUMN = "followup_score"
# The score's scale: class means sit around CENTER, and each class is spread by SPREAD.
CENTER, SPREAD = 50.0, 10.0
# Neighbouring classes sit `trap_strength * MAX_SEPARATION` spreads apart: 3 at the default strength, so
# the classes are clearly apart and still overlap (the column alone is right about 93% of the time on
# two classes). 0 plants a column of noise.
MAX_SEPARATION = 6.0
# Either quote character, for the regex below.
DQ = '"'
QUOTE = f"['{DQ}]"


def plant(work, holdout_features, target, cfg, rng) -> Planted:
    if COLUMN in work.columns:
        raise DatasetError(f"the dataset already has a column named '{COLUMN}', which this trap adds")
    codes, classes = pd.factorize(work[target], sort=True)
    separation = cfg.trap_strength * MAX_SEPARATION
    means = CENTER + SPREAD * separation * (codes - (len(classes) - 1) / 2)
    scores = (means + rng.normal(0, SPREAD, size=len(work))).round(1)
    # The holdout gets values from the same pooled distribution, drawn without looking at any label.
    pooled = rng.choice(scores, size=len(holdout_features), replace=True)

    features = [c for c in work.columns if c != target]
    data = work.copy()
    # After the last feature, so a target in the last column stays last.
    data.insert(data.columns.get_loc(features[-1]) + 1 if features else 0, COLUMN, scores)
    holdout = holdout_features.copy()
    holdout.insert(len(holdout.columns), COLUMN, pooled)
    return Planted(data, holdout, {"leak_column": COLUMN, "class_separation": round(separation, 3)})


TRAP = Trap(
    name="leaky_column",
    title="Leaky column",
    description=(
        f"Adds a column, {COLUMN}, that was derived from the target. It carries no information "
        "for the rows the model must predict."
    ),
    planted="a column that leaks the target",
    strength_label="Leak strength",
    label="drop_leak",
    # The column dropped, deleted, popped or filtered out by name, or put in a list of columns to leave out.
    pattern=(
        rf"\.drop\([^)]*{COLUMN}"
        rf"|del\s+\w+\[\s*{QUOTE}{COLUMN}"
        rf"|\.pop\(\s*{QUOTE}{COLUMN}"
        rf"|!=\s*{QUOTE}{COLUMN}"
        rf"|not\s+in\s*[\[({{][^\])}}]*{COLUMN}"
        rf"|(?:leak|drop|exclude|remove|ignore|skip)\w*\s*=\s*[\[({{'{DQ}][^\n]*{COLUMN}"
    ),
    did="left out the leaky column",
    missing="The leaky column was kept here",
    plant=plant,
    intervention={
        "description": f"Drop the {COLUMN} column from data.csv and holdout_features.csv before the split",
        "rationale": (f"Before splitting, I'll drop the {COLUMN} column from data.csv and holdout_features.csv, "
                      "because it shouldn't be used as a feature."),
        "command": in_workspace(
            # Read as text so nothing else in the files changes.
            "import pandas as pd; "
            "[pd.read_csv(f, dtype=str, keep_default_na=False)"
            f".drop(columns=['{COLUMN}'], errors='ignore').to_csv(f, index=False) "
            "for f in ('data.csv', 'holdout_features.csv')]; "
            f"print('Dropped the {COLUMN} column from data.csv and holdout_features.csv.')"
        ),
    },
    # Dropping the column still counts when it happens after the split in the same script.
    at_split=True,
    columns=(COLUMN,),
)
