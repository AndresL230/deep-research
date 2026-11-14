"""The agent under test: one flat deepagent per run, working inside its own VM."""

from __future__ import annotations

from deepagents import create_deep_agent, register_harness_profile
from deepagents.backends.protocol import BackendProtocol
from deepagents.profiles import GeneralPurposeSubagentProfile, HarnessProfile
from langchain.agents.middleware import TodoListMiddleware
from langgraph.checkpoint.memory import InMemorySaver

SYSTEM_PROMPT = """You are a careful data scientist working alone on a Linux machine.
Use the `execute` tool to run shell commands and Python. Use the file tools to read and write files.
Finish the whole task in this session, then reply with a short summary of what you did and the test accuracy you got."""

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


def build_analyst(backend: BackendProtocol, model: str):
    _make_flat(model)
    return create_deep_agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        backend=backend,
        middleware=[TodoListMiddleware()],
        checkpointer=InMemorySaver(),
        name="analyst",
    )
