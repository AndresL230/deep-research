"""The intervention: what we force at the fork point, and how to cut a run's history there."""

from __future__ import annotations

import uuid

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from . import traps

# One forced action per label: each trap's fix for its own step. "control" arms get nothing forced.
INTERVENTIONS: dict[str, dict] = {}
for _trap in traps.registered():
    INTERVENTIONS.setdefault(_trap.label, _trap.intervention)


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
