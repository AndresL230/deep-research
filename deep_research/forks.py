"""The intervention: what we force at the fork point, and how to cut a run's history there."""

from __future__ import annotations

import uuid

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from . import traps

# One forced action per label. "control" arms get nothing forced. Each trap brings the fix for its own
# step (`deduplicate` comes from the duplicates trap); a step that is no trap's own is listed here.
# `SHOW` holds the weaker version of a step for the `show` arm: tell the agent what the fix would fix, change nothing.
INTERVENTIONS: dict[str, dict] = {
    # Jittered copies differ only in their non-integer columns, so match rows on every other column.
    "deduplicate_near": {
        "description": "Remove near-duplicate rows from data.csv before the split, matching on the exact columns",
        "command": traps.in_workspace(
            "import pandas as pd; d = pd.read_csv('data.csv'); n = len(d); "
            "num = d.select_dtypes('number'); "
            "exact = [c for c in d.columns if c not in num.columns or (num[c].dropna() % 1 == 0).all()]; "
            "d = d.drop_duplicates(subset=exact or None); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} near-duplicate rows, matching on {len(exact)} exact columns. {len(d)} rows remain.')"
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
    iv = intervention_for(label, trap)
    if iv is None:
        return {}
    plan: dict[str, dict | None] = {"control": None}
    if placebo:
        plan["placebo"] = PLACEBO
    weak = iv.get("show") or SHOW.get(label)
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


def forced_turn(command: str, output: str) -> list[BaseMessage]:
    """A synthetic tool call plus its real result, appended to the history."""
    call_id = f"forced-{uuid.uuid4().hex[:12]}"
    return [
        AIMessage(content="", tool_calls=[{"name": "execute", "args": {"command": command}, "id": call_id}]),
        ToolMessage(content=output, tool_call_id=call_id, name="execute"),
    ]
