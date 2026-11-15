"""Traps: the flaw planted in the data, and everything the rest of the app needs to know about it.

One module per trap in this folder. Each defines `TRAP = Trap(...)` and is picked up here by itself:
adding a trap needs no edit anywhere else, in Python or in the web app. `scripts/calibrate_traps.py`
measures whether a trap inflates a naive run enough to be found.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

import numpy as np
import pandas as pd

from ..config import VM_WORKSPACE

if TYPE_CHECKING:
    from ..config import BatchConfig


@dataclass(frozen=True)
class Planted:
    """What a trap's `plant` returns."""

    # The labelled rows the agent gets as data.csv, with the flaw in them.
    data: pd.DataFrame
    # The rows the agent must predict, in the order they came in. Never any labels.
    holdout_features: pd.DataFrame
    # Facts about what was planted, saved in the task's meta.json. The trap's `evidence` reads them back.
    meta: dict = field(default_factory=dict)


Plant = Callable[[pd.DataFrame, pd.DataFrame, str, "BatchConfig", np.random.Generator], Planted]
Evidence = Callable[[pd.DataFrame, pd.DataFrame, dict], "float | None"]


@dataclass(frozen=True)
class Trap:
    # The value of `BatchConfig.trap`.
    name: str
    # For the picker: a short name and one line saying what is planted and why it inflates the score.
    title: str
    description: str
    # After "planted": "duplicate rows". Used in the panel's summary and the investigator's prompt.
    planted: str
    # What `trap_strength` means for this trap, as the slider's label.
    strength_label: str
    # The step an honest run does, as a step label, and the regex that spots it in code. The web app
    # highlights lines with the same regex, so it must be valid in both Python `re` and JavaScript `RegExp`.
    label: str
    pattern: str
    # After "Honest runs": "removed duplicate rows". And the empty slot on the side that skipped the step.
    did: str
    missing: str
    # plant(work, holdout_features, target, cfg, rng): `work` is the labelled rows the agent will get and
    # `holdout_features` the unlabelled rows it must predict. A trap may add columns to both. It never sees
    # the holdout labels and must keep the holdout rows and their order.
    plant: Plant
    # The forced step of the fork experiment: {"description", "command"}. The command runs in the VM
    # workspace before the split and fixes the data in place.
    intervention: dict
    # evidence(train, test, meta): a number from the run's own train.csv and test.csv that shows the flaw,
    # or None. `meta` is the task's meta.json. None here when the trap has no such number.
    evidence: Evidence | None = None
    # How the UI finishes the sentence "52% ...". None when there is no evidence number.
    evidence_text: str | None = None
    # The step can be part of the split itself, or come after it in the same script (a grouped split is
    # the split). It then counts whenever it is in the action that splits, not only before the split there.
    at_split: bool = False
    # The pattern only counts outside any call on its line: `df = df.drop_duplicates()` removes rows,
    # `print(df.drop_duplicates().shape)` only looks at them. The web app's highlight does not make
    # this difference.
    top_level: bool = False
    # The columns the trap itself adds or keys on (`followup_score`, `subject_id`). Plain code uses them to keep the
    # investigator's view generic: no change it is offered names one (forks.blind_changes).
    columns: tuple[str, ...] = ()

    def public(self) -> dict:
        """Everything but the callables, as JSON, for the API and the case file."""
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "planted": self.planted,
            "strength_label": self.strength_label,
            "label": self.label,
            "pattern": self.pattern,
            "at_split": self.at_split,
            "did": self.did,
            "missing": self.missing,
            # The step the UI shows; the rationale is only the forced call's text in the agent's history.
            "intervention": {k: self.intervention[k] for k in ("description", "command")},
            "evidence_text": self.evidence_text if self.evidence is not None else None,
        }


def in_workspace(python: str) -> str:
    """A shell command that runs a line of Python in the VM workspace. No double quotes in `python`."""
    if '"' in python or "$" in python or "`" in python:
        raise ValueError("the Python line must not contain double quotes, dollar signs or backticks")
    return f'cd {VM_WORKSPACE} && python3 -c "{python}"'


_REGISTRY: dict[str, Trap] = {}


def register(trap: Trap) -> Trap:
    if trap.name in _REGISTRY:
        raise ValueError(f"two traps are named '{trap.name}'")
    re.compile(trap.pattern)
    # `rationale` (optional): the forced call's text, why the agent takes the step, in its own voice (forks.forced_turn).
    keys = set(trap.intervention)
    if not {"description", "command"} <= keys <= {"description", "command", "rationale"}:
        raise ValueError(f"trap '{trap.name}': the intervention needs a description and a command, and may have a "
                         "rationale")
    _REGISTRY[trap.name] = trap
    return trap


def registered() -> list[Trap]:
    """Every trap, in name order."""
    return [_REGISTRY[name] for name in sorted(_REGISTRY)]


def names() -> list[str]:
    return sorted(_REGISTRY)


def get(name: str) -> Trap:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise ValueError(f"unknown trap '{name}'; choose one of {names()}") from None


def for_label(label: str) -> Trap | None:
    """The trap whose honest step is `label`, if any."""
    return next((t for t in registered() if t.label == label), None)


def _discover() -> None:
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        trap = getattr(importlib.import_module(f"{__name__}.{info.name}"), "TRAP", None)
        if isinstance(trap, Trap):
            register(trap)


_discover()
