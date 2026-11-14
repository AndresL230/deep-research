"""The intervention: what we force at the fork point, and how to cut a run's history there."""

from __future__ import annotations

import uuid

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from .config import VM_WORKSPACE

# One forced action per label, plus the weaker `show` version of the same step. "control" arms get nothing forced.
INTERVENTIONS: dict[str, dict] = {
    "deduplicate": {
        "description": "Remove duplicate rows from data.csv before the split",
        "command": (
            f"cd {VM_WORKSPACE} && python3 -c \""
            "import pandas as pd; d = pd.read_csv('data.csv'); n = len(d); "
            "d = d.drop_duplicates(); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} duplicate rows. {len(d)} rows remain.')\""
        ),
        # The same step weakened to its first half: the agent is told what the forced arm would fix and
        # left to decide. Nothing on disk changes.
        "show": {
            "description": "Count the duplicate rows and show them, changing nothing",
            "command": (
                f"cd {VM_WORKSPACE} && python3 -c \""
                "import pandas as pd; d = pd.read_csv('data.csv'); n = int(d.duplicated().sum()); "
                "print(f'{n} of {len(d)} rows are an exact copy of another row ({n / len(d):.1%}).')\""
            ),
        },
    },
}

# The placebo arm's step. It reads nothing about the data, so it cannot change what the agent decides;
# it only gives that arm the same shape of history as the forced arm, one extra tool call and its output.
PLACEBO: dict = {
    "description": "Print the pandas version (changes nothing, says nothing about the data)",
    "command": f"cd {VM_WORKSPACE} && python3 -c \"import pandas as pd; print('pandas', pd.__version__)\"",
}


def intervention_for(label: str) -> dict | None:
    return INTERVENTIONS.get(label)


def arm_plan(label: str, placebo: bool = True, show: bool = True) -> dict[str, dict | None]:
    """The experiment's arms in order, each with the step forced on it before it continues (None: nothing).

    `control` and `forced` are the experiment itself. The two optional arms between them separate what the
    forced step does from how it is delivered:

    - `placebo` runs a harmless command. Without it, control and forced differ by the step *and* by having
      one more tool call in their history, and the step takes the credit for both.
    - `show` tells the agent what the forced arm fixes and leaves it to act. It separates a run that never
      noticed the problem from one that noticed and split the data anyway.

    Empty when no intervention is defined for `label`: there is nothing to force, so there is no experiment.
    """
    iv = INTERVENTIONS.get(label)
    if iv is None:
        return {}
    plan: dict[str, dict | None] = {"control": None}
    if placebo:
        plan["placebo"] = PLACEBO
    if show and iv.get("show"):
        plan["show"] = iv["show"]
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
