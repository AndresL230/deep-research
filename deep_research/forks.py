"""The intervention: what we force at the fork point, and how to cut a run's history there."""

from __future__ import annotations

import uuid

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from .config import VM_WORKSPACE

# One forced action per label. "control" arms get nothing forced.
INTERVENTIONS: dict[str, dict] = {
    "deduplicate": {
        "description": "Remove duplicate rows from data.csv before the split",
        "command": (
            f"cd {VM_WORKSPACE} && python3 -c \""
            "import pandas as pd; d = pd.read_csv('data.csv'); n = len(d); "
            "d = d.drop_duplicates(); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} duplicate rows. {len(d)} rows remain.')\""
        ),
    },
    # Jittered copies differ only in their non-integer columns, so match rows on every other column.
    "deduplicate_near": {
        "description": "Remove near-duplicate rows from data.csv before the split, matching on the exact columns",
        "command": (
            f"cd {VM_WORKSPACE} && python3 -c \""
            "import pandas as pd; d = pd.read_csv('data.csv'); n = len(d); "
            "num = d.select_dtypes('number'); "
            "exact = [c for c in d.columns if c not in num.columns or (num[c].dropna() % 1 == 0).all()]; "
            "d = d.drop_duplicates(subset=exact or None); d.to_csv('data.csv', index=False); "
            "print(f'Removed {n - len(d)} near-duplicate rows, matching on {len(exact)} exact columns. {len(d)} rows remain.')\""
        ),
    },
}


def intervention_for(label: str) -> dict | None:
    return INTERVENTIONS.get(label)


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
