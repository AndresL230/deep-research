"""The agent under test: one flat deepagent per run, working inside its own VM."""

from __future__ import annotations

from pathlib import Path

from deepagents import FilesystemPermission, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from deepagents.backends.protocol import BackendProtocol
from langchain.agents.middleware import AgentMiddleware, TodoListMiddleware
from langgraph.checkpoint.memory import InMemorySaver

from ..domains import ANALYST_SYSTEM_PROMPT

# The tabular analyst's prompt. Each domain has its own (`Domain.analyst_system_prompt`).
SYSTEM_PROMPT = ANALYST_SYSTEM_PROMPT


class NoSubagents(AgentMiddleware):
    """Takes the subagent middleware's place in the analyst's stack and does nothing, so the run has no `task` tool
    and no subagents (MASTER_PLAN 3.3: analysts stay flat).

    A subagent counts as one step in the run's history, which would make the steps inside it impossible to fork.
    `create_deep_agent` always adds a default general-purpose subagent, and with it `SubAgentMiddleware` and its
    `task` tool, unless the model's harness profile disables it. Profiles are registered per model for the whole
    process, so disabling it there would also take it from any other deep agent built on the same model. A passed
    middleware with the same `name` replaces the stack's one in place, and only in this agent (deepagents 0.7.38,
    `graph._apply_custom_middleware`), the same way `NoCompaction` drops summarization.
    """

    @property
    def name(self) -> str:
        return "SubAgentMiddleware"


class NoCompaction(AgentMiddleware):
    """Takes the summarization middleware's place in the analyst's stack and does nothing.

    `create_deep_agent` adds summarization by default: once the context passes 85% of the model's window (850k
    tokens for Haiku and Sonnet 5.5, whose window is 1M) it replaces the older history with a summary, and on a
    context-overflow error it summarizes and retries. A fork rebuilds a run by replaying its exact message history
    up to a step (forks.cut_history), so a run whose model had seen a summary instead would be forked from a history
    it never saw. The analyst therefore never compacts. The investigator keeps summarization.

    `HarnessProfile.excluded_middleware` would also drop it, but profiles are keyed by model and the investigator
    can run on the same model as an analyst. `create_deep_agent` replaces a stack middleware with a passed one of
    the same `name`, which is per agent. Prompt caching is a separate middleware and stays.
    """

    @property
    def name(self) -> str:
        return "SummarizationMiddleware"


# Where an analyst with lessons on (`BatchConfig.lessons = "learned"`) reads the approved lessons: a read-only route to
# the server's `skills/learned/` folder, next to its VM. The lessons are rules a person approved, never a run's data.
LEARNED_MOUNT = "/skills/learned/"


def build_analyst(backend: BackendProtocol, model: str, system_prompt: str = SYSTEM_PROMPT, *, checkpointer=None,
                  learned_dir: Path | None = None):
    """One flat analyst on `backend` (its VM).

    `checkpointer` keeps its graph state: the batch's durable SQLite saver (`Batch._analyst_saver`), which a
    checkpoint-mode fork reads the source run's state history from. None: an in-memory one, as before.

    `learned_dir` (lessons on) gives it the approved lessons as Deep Agents skills: the VM backend is wrapped in a
    CompositeBackend whose `/skills/learned/` route reads that folder, read only (writes there are denied; every other
    path, and `execute`, still go to the VM). The analyst sees the skills' names and descriptions in its prompt and
    reads a SKILL.md with read_file, like any skill.
    """
    extra: dict = {}
    if learned_dir is not None:
        backend = CompositeBackend(
            default=backend, routes={LEARNED_MOUNT: FilesystemBackend(root_dir=learned_dir, virtual_mode=True)})
        extra = {"skills": [LEARNED_MOUNT],
                 "permissions": [FilesystemPermission(operations=["write"], paths=[f"{LEARNED_MOUNT}**"], mode="deny")]}
    return create_deep_agent(
        model=model,
        system_prompt=system_prompt,
        backend=backend,
        middleware=[TodoListMiddleware(), NoCompaction(), NoSubagents()],
        checkpointer=checkpointer if checkpointer is not None else InMemorySaver(),
        name="analyst",
        **extra,
    )
