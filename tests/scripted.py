"""Scripted stand-ins for the model, shared by the offline tests. No keys, no network."""

from __future__ import annotations

import itertools

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from deep_research.agents import analyst as analyst_mod
from deep_research.agents import investigator as inv_mod


class ScriptedModel(GenericFakeChatModel):
    """Returns the given messages in order and ignores tools."""

    def bind_tools(self, tools, **kwargs):
        return self


def usage(input_tokens: int) -> dict:
    return {"input_tokens": input_tokens, "output_tokens": 10, "total_tokens": input_tokens + 10}


def call(name: str, args: dict, call_id: str, input_tokens: int = 0) -> AIMessage:
    """One tool call. `input_tokens` > 0 makes the response report token usage, as a real model does."""
    extra = {"usage_metadata": usage(input_tokens)} if input_tokens else {}
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}], **extra)


def say(text: str, input_tokens: int = 0) -> AIMessage:
    extra = {"usage_metadata": usage(input_tokens)} if input_tokens else {}
    return AIMessage(content=text, **extra)


def grade(result: str = "satisfied", n: int = 5, call_id: str = "g") -> AIMessage:
    """The rubric grader's answer (deepagents' GraderResponse, as the tool call its structured output is read from):
    `n` criteria, all passing when `result` is "satisfied", the first one failing otherwise."""
    criteria = [{"name": f"criterion {i + 1}", "passed": True} for i in range(n)]
    if result == "needs_revision":
        criteria[0] = {"name": "criterion 1", "passed": False, "gap": "cite the placebo arm's counts"}
    args = {"result": result, "explanation": f"grader says {result}", "criteria": criteria}
    return AIMessage(content="", tool_calls=[{"name": "GraderResponse", "args": args, "id": call_id}])


def grader(messages: list[AIMessage] | None = None) -> ScriptedModel:
    """A scripted rubric grader: `messages` in order, or "satisfied" every time."""
    return ScriptedModel(messages=iter(messages) if messages is not None else itertools.repeat(grade()))


def script_investigator(monkeypatch, messages: list[AIMessage], grader_model=None) -> None:
    """The next investigator built (and its subagents) answers with `messages`, in order. Its rubric grader is
    `grader_model`, by default one that is always satisfied."""
    model = ScriptedModel(messages=iter(messages))
    monkeypatch.setattr(inv_mod, "GRADER_MODEL", grader_model if grader_model is not None else grader())
    # Scripting it again (a restarted server) replaces the first script instead of wrapping it.
    real = getattr(inv_mod, "_unscripted", None) or inv_mod.create_deep_agent
    monkeypatch.setattr(inv_mod, "_unscripted", real, raising=False)

    def with_model(*args, **kwargs):
        kwargs["model"] = model
        for sa in kwargs.get("subagents") or []:
            sa["model"] = model
        return real(*args, **kwargs)

    monkeypatch.setattr(inv_mod, "create_deep_agent", with_model)


def script_analysts(monkeypatch, script_for) -> None:
    """Every analyst built gets `script_for(vm_label)`: its own messages, chosen by the VM it runs in."""
    real = analyst_mod.create_deep_agent

    def scripted(*args, **kwargs):
        kwargs["model"] = ScriptedModel(messages=iter(script_for(kwargs["backend"].vm.label)))
        return real(*args, **kwargs)

    monkeypatch.setattr(analyst_mod, "create_deep_agent", scripted)


def seed_hypotheses(case, label: str = "deduplicate") -> None:
    """Two competing hypotheses, h1 (the method step `label`) and h2 (a code defect), as the investigator records them
    before any experiment."""
    assert case.record_competing_hypothesis(
        "method", f"Skipping {label} inflates the claims.", "honest runs did it, inflated runs did not",
        "forced copies come out inflated less often than control copies",
        "forced copies inflate as often as control with 8 or more pairs", "low", step_label=label) == "h1"
    assert case.record_competing_hypothesis(
        "code", "The code is wrong where it was never tried.", "the measured rate is low in every run",
        "a patch raises the measured rate", "the patched code does no better", "low") == "h2"


async def saved_messages(batch) -> list:
    """The investigator's messages as its durable checkpointer saved them (`batches/<id>/checkpoints.sqlite`), read
    back through a freshly built investigator, the way a restarted server would."""
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    async with AsyncSqliteSaver.from_conn_string(str(batch.checkpoints_path)) as saver:
        agent = inv_mod.build_investigator(batch, ScriptedModel(messages=iter([])), checkpointer=saver)
        thread = (batch.case.data.get("investigator") or {}).get("thread_id") or f"{batch.id}-investigator"
        state = await agent.aget_state({"configurable": {"thread_id": thread}})
    return list(state.values.get("messages") or [])
