"""The intervention: what we force at the fork point, and how to cut a run's history there."""

from __future__ import annotations

import uuid

import re
from dataclasses import dataclass, field
from typing import Callable

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from . import traps

# The forced near-duplicate removal keeps the file as it was under this name, in the VM workspace.
DEDUP_BACKUP = "data_before_dedup.csv"
# How far apart (relative) a non-integer value of a near-duplicate may be from the row it copies.
NEAR_RTOL = 0.05

# One forced action per label. "control" arms get nothing forced. Each trap brings the fix for its own
# step (`deduplicate` comes from the duplicates trap); a step that is no trap's own is listed here.
# `SHOW` holds the weaker version of a step for the `show` arm: tell the agent what the fix would fix, change nothing.
INTERVENTIONS: dict[str, dict] = {
    # A jittered copy (traps/duplicates.py) equals its original exactly in every integer or text column and is
    # within a small relative distance in each non-integer column (`trap_noise` scales a value by 1 + N(0, noise/20),
    # so at most 2.5% at the largest noise). Rows are sorted on every column, and a row that matches the one before
    # it that way is dropped: exact copies too. The file as it was is kept, and the output says what was done and
    # that it is the intended step, so the copy reads it as a fix and not as damage.
    "deduplicate_near": {
        "description": "Remove near-duplicate rows from data.csv before the split, keeping the original file",
        "command": traps.in_workspace(
            "import pandas as pd, numpy as np; d = pd.read_csv('data.csv'); n = len(d); "
            f"d.to_csv('{DEDUP_BACKUP}', index=False); d = d.drop_duplicates(); "
            "num = d.select_dtypes('number'); "
            "fz = [c for c in num.columns if not (num[c].dropna() % 1 == 0).all()]; "
            "ex = [c for c in d.columns if c not in fz]; "
            "s = d.sort_values(ex + fz, kind='stable'); p = s.shift(); "
            "same = s[ex].astype(object).fillna('<NA>').eq(p[ex].astype(object).fillna('<NA>')).all(axis=1).to_numpy(); "
            f"close = np.isclose(s[fz].to_numpy(float), p[fz].to_numpy(float), rtol={NEAR_RTOL}, atol=1e-9, "
            "equal_nan=True).all(axis=1); "
            "dup = same & close; dup[:1] = False; "
            "d = d.drop(index=s.index[dup]); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} near-duplicate rows (copies of other rows with small numeric jitter). '"
            "f'{len(d)} rows remain. This is the intended step. "
            f"The original is saved as {DEDUP_BACKUP}. Continue the task with data.csv.')"
        ),
    },
}
for _trap in traps.registered():
    INTERVENTIONS.setdefault(_trap.label, _trap.intervention)

SHOW: dict[str, dict] = {
    # The duplicate fix weakened to its first half: the agent is told what the forced arm would fix and left to
    # decide. Nothing on disk changes.
    "deduplicate": {
        "description": "Count the duplicate rows and show them, changing nothing",
        "command": traps.in_workspace(
            "import pandas as pd; d = pd.read_csv('data.csv'); n = int(d.duplicated().sum()); "
            "print(f'{n} of {len(d)} rows are an exact copy of another row ({n / len(d):.1%}).')"
        ),
    },
}

# The placebo arm's step. It reads nothing about the data, so it cannot change what the agent decides;
# it only gives that arm the same shape of history as the forced arm, one extra tool call and its output.
PLACEBO: dict = {
    "description": "Print the pandas version (changes nothing, says nothing about the data)",
    "command": traps.in_workspace("import pandas as pd; print('pandas', pd.__version__)"),
}


def intervention_for(label: str, trap: str | None = None) -> dict | None:
    """What to force for a split finding's label, in a batch that planted `trap`.

    The batch trap's own intervention when the finding is that trap's step. Otherwise the table: a
    finding can land on another label (a dataset can have real duplicates under any trap).
    """
    if trap is not None:
        try:
            own = traps.get(trap)
        except ValueError:
            own = None
        if own is not None and own.label == label:
            return own.intervention
    return INTERVENTIONS.get(label)


def arm_plan(label: str, placebo: bool = True, show: bool = True, trap: str | None = None) -> dict[str, dict | None]:
    """The experiment's arms in order, each with the step forced on it before it continues (None: nothing).

    `control` and `forced` are the experiment itself. The two optional arms between them separate what the
    forced step does from how it is delivered:

    - `placebo` runs a harmless command. Without it, control and forced differ by the step *and* by having
      one more tool call in their history, and the step takes the credit for both.
    - `show` tells the agent what the forced arm fixes and leaves it to act. It separates a run that never
      noticed the problem from one that noticed and split the data anyway.

    Empty when no intervention is defined for `label`: there is nothing to force, so there is no experiment.
    """
    return arms(intervention_for(label, trap), SHOW.get(label), PLACEBO, placebo, show)


def arms(
    iv: dict | None, weak: dict | None, placebo_step: dict, placebo: bool = True, show: bool = True
) -> dict[str, dict | None]:
    """`arm_plan` for any domain: `iv` is the forced step, `weak` its `show` version (an `iv["show"]` wins) and
    `placebo_step` the harmless command. Empty when there is no `iv`."""
    if iv is None:
        return {}
    plan: dict[str, dict | None] = {"control": None}
    if placebo:
        plan["placebo"] = placebo_step
    weak = iv.get("show") or weak
    if show and weak:
        plan["show"] = weak
    plan["forced"] = {"description": iv["description"], "command": iv["command"]}
    return plan


def cut_history(messages: list[BaseMessage], fork_at: int) -> tuple[list[BaseMessage], int]:
    """Return the messages before the model turn that made action `fork_at`, and how many actions precede it.

    If that turn made several tool calls, the cut moves back to the start of the
    turn, so the prefix never contains a tool call without its result.
    """
    seen = 0
    for i, m in enumerate(messages):
        if isinstance(m, AIMessage) and m.tool_calls:
            if seen + len(m.tool_calls) > fork_at:
                return messages[:i], seen
            seen += len(m.tool_calls)
    return list(messages), seen


def fix_plan(fix: dict, placebo_step: dict, placebo: bool = True) -> dict[str, dict | None]:
    """The arms of the fix experiment: does the one change the investigator proposed make the code work?

    `control` continues unchanged, `fixed` continues after the patch is applied to the file in its copy of
    the VM, and `placebo` (optional) runs the harmless command, for the same reason as in `arm_plan`.
    `fix` is the case file's `fix` section: `file_path`, `old_string`, `new_string`, `description`.
    """
    plan: dict[str, dict | None] = {"control": None}
    if placebo:
        plan["placebo"] = placebo_step
    plan["fixed"] = {
        "kind": "edit",
        "description": fix.get("description") or f"Apply the proposed fix to {fix['file_path']}",
        "file_path": fix["file_path"],
        "old_string": fix["old_string"],
        "new_string": fix["new_string"],
    }
    return plan


def step_kind(step: dict) -> str:
    """"command" (a shell command, the default) or "edit" (replace a string in a file)."""
    return step.get("kind") or "command"


def step_text(step: dict) -> str:
    """The step as the event log and the UI show it: the command, or the edit in one line."""
    if step_kind(step) == "edit":
        return f"edit_file {step['file_path']}: replace {step['old_string']!r} with {step['new_string']!r}"
    return step["command"]


def apply_step(backend, step: dict) -> str:
    """Run `step` in a fork child's VM through its agent backend and return what the agent will see as the result.

    Raises RuntimeError when the step did not take: a failed command or an edit whose text was not found. The
    copy is then a failed child, never a result of its arm.
    """
    if step_kind(step) == "edit":
        res = backend.edit(step["file_path"], step["old_string"], step["new_string"], False)
        error = getattr(res, "error", None)
        if error:
            raise RuntimeError(f"the fix could not be applied: {error}"[:300])
        n = getattr(res, "occurrences", None)
        return f"Edited {step['file_path']}: replaced {n if n is not None else 1} occurrence of the old text with the new text."
    res = backend.execute(step["command"])
    # A sandbox result without an exit code (an older SDK) counts as having succeeded.
    exit_code = getattr(res, "exit_code", None)
    if exit_code not in (0, None):
        raise RuntimeError(f"exit code {exit_code}: {res.output[:200]}")
    return res.output


def forced_turn(step: dict | str, output: str) -> list[BaseMessage]:
    """A synthetic tool call plus its real result, appended to the history.

    `step` is an arm's step (`arm_plan`, `fix_plan`); a plain string is a shell command. A command becomes an
    `execute` call, an edit an `edit_file` call: the agent then sees exactly what it would have seen had it
    done the step itself.
    """
    call_id = f"forced-{uuid.uuid4().hex[:12]}"
    if isinstance(step, str):
        step = {"command": step}
    if step_kind(step) == "edit":
        name = "edit_file"
        args = {"file_path": step["file_path"], "old_string": step["old_string"], "new_string": step["new_string"]}
    else:
        name, args = "execute", {"command": step["command"]}
    return [
        AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}]),
        ToolMessage(content=output, tool_call_id=call_id, name=name),
    ]


# ---- the change registry (plan 6.3): what one experiment changes in its changed copies ----
#
# A change is named `<kind>:<name>`, for example `force_step:deduplicate`, `force_step:drop_column:followup_score`,
# `fake_result:no_duplicates`, `edit_context:hint_quality`, `edit_context:<free text>` or
# `swap_model:anthropic:claude-sonnet-5-5`. `control` changes nothing: it is the other half of every pair.
# `INTERVENTIONS` above stays as it was: it is the tabular domain's `force_step` table, read through `parse_change`.

CHANGE_KINDS = ("control", "force_step", "fake_result", "edit_context", "swap_model")
MAX_CONTEXT_CHARS = 300
# A column name a `drop_column` change may name: it goes into a shell command, so no quotes or shell characters.
_COLUMN_NAME = re.compile(r"^[A-Za-z0-9_. -]{1,64}$")

FAKE_RESULTS: dict[str, dict] = {
    # The duplicate check, answered "none found" without running it. Its fork point is the run's own look at the data
    # before it deduplicated: the copy then decides what to do on a made-up all-clear.
    "no_duplicates": {
        "description": "Answer the duplicate check with a made-up '0 duplicate rows' without running it",
        "command": traps.in_workspace(
            "import pandas as pd; d = pd.read_csv('data.csv'); print('duplicates:', int(d.duplicated().sum()))"),
        "output": "duplicates: 0",
        # The step the made-up result is about, and the fork point it needs.
        "about": "deduplicate",
        "anchor": "before_check:deduplicate",
    },
}

CONTEXT_EDITS: dict[str, str] = {
    "hint_quality": ("Before you go on: check the data for problems that would make a test score look better than "
                     "it is, such as rows that appear in both train and test, columns that would not exist when "
                     "predicting, and rows that belong to the same subject."),
    "use_logistic": "Use a logistic regression model for the rest of this task.",
}


def swap_models() -> tuple[str, ...]:
    """The models a `swap_model` change may name: every model with a price in prices.json, so its spend is counted."""
    from .config import load_prices

    return tuple(sorted((load_prices().get("models") or {}).keys()))


@dataclass(frozen=True)
class Change:
    """One parsed change. `step` is what `change_messages` applies to a changed copy; None for `control`."""

    kind: str
    name: str
    description: str
    step: dict | None = None
    # The step label this change is about (the fix it forces, the check it fakes), or None.
    about: str | None = None
    # The fork point the change needs when none is given (`fake_result` forks at the run's own check).
    default_anchor: str | None = None
    extra: dict = field(default_factory=dict)

    @property
    def spec(self) -> str:
        return self.kind if self.kind == "control" else f"{self.kind}:{self.name}"

    def to_dict(self) -> dict:
        return {"kind": self.kind, "name": self.name, "spec": self.spec, "description": self.description,
                "about": self.about}


class ChangeError(ValueError):
    """A change that cannot be built, with the reason in words for the caller."""


def drop_column_step(column: str) -> dict:
    """The forced step that drops `column` from data.csv and holdout_features.csv, before the split."""
    if not _COLUMN_NAME.match(column or ""):
        raise ChangeError(f"'{column}' is not a column name a change can drop (letters, digits, _ . - and spaces)")
    return {
        "description": f"Drop the {column} column from data.csv and holdout_features.csv before the split",
        "command": traps.in_workspace(
            "import pandas as pd; "
            "[pd.read_csv(f, dtype=str, keep_default_na=False)"
            f".drop(columns=['{column}'], errors='ignore').to_csv(f, index=False) "
            "for f in ('data.csv', 'holdout_features.csv')]; "
            f"print('Dropped the {column} column from data.csv and holdout_features.csv.')"
        ),
    }


def _trap_column(t) -> str | None:
    m = re.search(r"drop\(columns=\['([^']+)'\]", t.intervention.get("command", ""))
    return m.group(1) if m else None


def _label_of_column(column: str) -> str:
    """The step label a dropped column counts as: a trap's own (`drop_leak` for its leak column) or `drop_column`."""
    for t in traps.registered():
        if _trap_column(t) == column:
            return t.label
    return "drop_column"


def parse_change(spec: str, force: Callable[[str], dict | None] | None = None,
                 models: tuple[str, ...] | None = None) -> Change:
    """The change named by `spec`. Raises ChangeError with the reason and the choices.

    `force(label)` gives the domain's forced step for a label (`Domain.intervention_for`); None: this module's
    tabular table. `models` is the `swap_model` allowlist; None: `swap_models()`.
    """
    spec = (spec or "").strip()
    kind, _, name = spec.partition(":")
    name = name.strip()
    if kind not in CHANGE_KINDS:
        raise ChangeError(f"unknown change kind '{kind}'; use one of {list(CHANGE_KINDS)} as '<kind>:<name>'")
    if kind == "control":
        return Change("control", "", "Nothing: the copy continues unchanged")
    if not name:
        raise ChangeError(f"name the change: '{kind}:<name>'")
    if kind == "force_step":
        if name.startswith("drop_column:"):
            column = name.partition(":")[2]
            return Change(kind, name, f"Drop the {column} column", drop_column_step(column),
                          about=_label_of_column(column))
        label = "deduplicate_near" if name == "deduplicate_fuzzy" else name
        iv = force(label) if force is not None else intervention_for(label)
        if iv is None:
            raise ChangeError(f"no forced step exists for '{name}'; choose one of {force_steps(force)} "
                              "or 'drop_column:<name>'")
        return Change(kind, name, iv["description"], {"description": iv["description"], "command": iv["command"]},
                      about=label)
    if kind == "fake_result":
        fake = FAKE_RESULTS.get(name)
        if fake is None:
            raise ChangeError(f"no made-up result is defined for '{name}'; choose one of {sorted(FAKE_RESULTS)}")
        step = {"kind": "fake", "description": fake["description"], "command": fake["command"],
                "output": fake["output"]}
        return Change(kind, name, fake["description"], step, about=fake["about"], default_anchor=fake["anchor"])
    if kind == "edit_context":
        preset = name in CONTEXT_EDITS
        text = (CONTEXT_EDITS[name] if preset else name).strip()
        if len(text) > MAX_CONTEXT_CHARS:
            raise ChangeError(f"the message is {len(text)} characters; at most {MAX_CONTEXT_CHARS}")
        return Change(kind, name, f"Tell the agent: {text}",
                      {"kind": "message", "description": f"Message to the agent: {text}", "text": text},
                      extra={"preset": name if preset else None})
    # swap_model
    allowed = swap_models() if models is None else models
    if name not in allowed:
        raise ChangeError(f"'{name}' is not on the swap_model allowlist {list(allowed)}")
    return Change(kind, name, f"Continue with the model {name}",
                  {"kind": "model", "description": f"Continue with the model {name}", "model": name})


def force_steps(force: Callable[[str], dict | None] | None = None, labels: list[str] | None = None) -> list[str]:
    """The `force_step` names that exist: every label with a forced step, and `deduplicate_fuzzy` with its near twin."""
    from .analysis import LABELS

    names = [lb for lb in (labels or LABELS) if (force(lb) if force is not None else intervention_for(lb)) is not None]
    if "deduplicate_near" in names:
        names.append("deduplicate_fuzzy")
    return names


def registry(force: Callable[[str], dict | None] | None = None, labels: list[str] | None = None) -> dict[str, list[str]]:
    """Every change by kind, as the names an experiment takes (`<kind>:<name>`), for the investigator and the UI."""
    return {
        "control": ["control"],
        "force_step": [f"force_step:{n}" for n in force_steps(force, labels)] + ["force_step:drop_column:<name>"],
        "fake_result": [f"fake_result:{n}" for n in FAKE_RESULTS],
        "edit_context": [f"edit_context:{n}" for n in CONTEXT_EDITS]
        + [f"edit_context:<text, at most {MAX_CONTEXT_CHARS} characters>"],
        "swap_model": [f"swap_model:{m}" for m in swap_models()],
    }


def trap_fixes() -> dict[str, list[str]]:
    """For each registered trap, the changes in the registry that fix it (a test checks every trap has one)."""
    out: dict[str, list[str]] = {}
    for t in traps.registered():
        fixes = [f"force_step:{t.label}"]
        if _trap_column(t):
            fixes.append(f"force_step:drop_column:{_trap_column(t)}")
        if t.label == "deduplicate":
            fixes.append("force_step:deduplicate_fuzzy")
        out[t.name] = fixes
    return out


def _steps_of(step: dict | list | None) -> list[dict]:
    if step is None:
        return []
    return list(step) if isinstance(step, list) else [step]


def step_model(step: dict | list | None, default: str) -> str:
    """The model a changed copy runs on: a `swap_model` step's, else `default`."""
    for s in _steps_of(step):
        if step_kind(s) == "model":
            return s["model"]
    return default


def change_messages(backend, step: dict | list | None) -> tuple[list[BaseMessage], list[dict]]:
    """What a copy's history gains from its arm's step (or list of steps, for a two-factor cell), and its log events.

    - a command or an edit (`force_step`): run in the copy's VM and appended as a tool call with its real output
      (`apply_step`, `forced_turn`). Raises RuntimeError when it did not take.
    - `fake` (`fake_result`): appended as a tool call with the made-up output. Nothing runs.
    - `message` (`edit_context`): appended as a message to the agent.
    - `model` (`swap_model`): nothing appended; `step_model` picks the copy's model.
    """
    msgs: list[BaseMessage] = []
    events: list[dict] = []
    for s in _steps_of(step):
        kind = step_kind(s)
        if kind == "model":
            events.append({"type": "forced", "command": f"swap_model {s['model']}", "output": "", "change": "swap_model"})
        elif kind == "message":
            msgs.append(HumanMessage(content=s["text"]))
            events.append({"type": "forced", "command": f"message: {s['text']}", "output": "", "change": "edit_context"})
        elif kind == "fake":
            msgs += forced_turn({"command": s["command"]}, s["output"])
            events.append({"type": "forced", "command": s["command"], "output": s["output"], "change": "fake_result"})
        else:
            output = apply_step(backend, s)
            msgs += forced_turn(s, output)
            events.append({"type": "forced", "command": step_text(s), "output": output[:2000]})
    return msgs, events


# ---- fork points (plan 6.3) ----

ANCHOR_FORMS = ("before_split", "before_label:<label>", "index:<n>")


def anchor_error(anchor: str) -> str | None:
    """Why `anchor` is not a fork point, or None."""
    anchor = (anchor or "").strip()
    form, _, arg = anchor.partition(":")
    if anchor == "before_split" or (form in ("before_label", "before_check") and arg):
        return None
    if form == "index" and arg.isdigit():
        return None
    return f"unknown fork point '{anchor}'; use one of {list(ANCHOR_FORMS)}"


def resolve_anchor(actions: list, anchor: str, split_label: str = "split") -> int | None:
    """The action index a fork point names in one run's labelled actions, or None when the run has no such moment.

    `before_split`: the run's first action that splits (its domain's anchor label). `before_label:<label>`: its first
    action with that label. `index:<n>`: action n. `before_check:<label>` (what `fake_result` needs): the run's last
    look at the data (`inspect`) before its first `label` action, in its own action, not the split's.
    """
    anchor = (anchor or "before_split").strip()
    if anchor == "before_split":
        return next((a.index for a in actions if split_label in a.labels), None)
    form, _, arg = anchor.partition(":")
    if form == "before_label" and arg:
        return next((a.index for a in actions if arg in a.labels), None)
    if form == "index":
        try:
            n = int(arg)
        except ValueError:
            return None
        return n if 0 <= n < len(actions) else None
    if form == "before_check" and arg:
        did = next((a.index for a in actions if arg in a.labels), None)
        if did is None:
            return None
        looks = [a.index for a in actions[:did]
                 if "inspect" in a.labels and split_label not in a.labels and arg not in a.labels]
        return looks[-1] if looks else None
    return None
