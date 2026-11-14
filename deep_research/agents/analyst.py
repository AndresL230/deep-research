"""The agent under test: one flat deepagent per run, working inside its own VM."""

from __future__ import annotations

from deepagents import create_deep_agent, register_harness_profile
from deepagents.backends.protocol import BackendProtocol
from deepagents.profiles import GeneralPurposeSubagentProfile, HarnessProfile
from langchain.agents.middleware import TodoListMiddleware
from langgraph.checkpoint.memory import InMemorySaver

from ..domains import ANALYST_SYSTEM_PROMPT

# The tabular analyst's prompt. Each domain has its own (`Domain.analyst_system_prompt`).
SYSTEM_PROMPT = ANALYST_SYSTEM_PROMPT

_flat_models: set[str] = set()


def _make_flat(model: str) -> None:
    """Remove the `task` tool for this model, so the run has no subagents.

    A subagent counts as one step in the run's history, which would make the
    steps inside it impossible to fork. The profile is keyed by model, so an
    investigator on the same model loses only the default general-purpose
    subagent and keeps its own named ones.
    """
    if model in _flat_models:
        return
    register_harness_profile(
        model, HarnessProfile(general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False))
    )
    _flat_models.add(model)


def build_analyst(backend: BackendProtocol, model: str, system_prompt: str = SYSTEM_PROMPT):
    _make_flat(model)
    return create_deep_agent(
        model=model,
        system_prompt=system_prompt,
        backend=backend,
        middleware=[TodoListMiddleware()],
        checkpointer=InMemorySaver(),
        name="analyst",
    )
