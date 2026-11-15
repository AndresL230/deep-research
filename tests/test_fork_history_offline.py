"""What a fork child sends to the model, checked against what the source run sent. No keys, no network.

Claude 5.5 models tie each thinking block to the conversation that produced it: the system prompt, the
tool set and every earlier message must come back unchanged, or the request is rejected (accounts created
after August 2026) or loses its reasoning. A fork child is a new agent replaying a cut history, so these
tests capture the real request bodies and require the child's to be an exact prefix of the source run's,
with only new turns appended.

The request bodies are built by the installed `ChatAnthropic`; only the HTTP call is replaced.
"""

import copy
import itertools
import json

import pytest
from anthropic.types import Message, TextBlock, ThinkingBlock, ToolUseBlock, Usage
from langchain_anthropic import ChatAnthropic

from deep_research.batch import Batch
from deep_research.config import BatchConfig
from tests.local_vm import LOOK, install_local_vms, model_script

MODEL = "anthropic:claude-haiku-5-5"


class FakeMessagesAPI:
    """Records every request body and answers like an analyst that thinks before each step."""

    def __init__(self):
        self.requests: list[dict] = []
        self._n = itertools.count(1)

    def answer(self, payload: dict) -> Message:
        n = next(self._n)
        seen = json.dumps(payload["messages"])
        assistant_turns = sum(m["role"] == "assistant" for m in payload["messages"])
        blocks: list = [ThinkingBlock(type="thinking", thinking="", signature=f"signature-{n}")]
        if assistant_turns == 0:
            command = LOOK
        elif "model.py" not in seen:
            command = model_script(dedupe=False)
        else:
            command = None
        if command is None:
            blocks.append(TextBlock(type="text", text="Done."))
        else:
            blocks.append(ToolUseBlock(type="tool_use", id=f"toolu_{n:04d}", name="execute", input={"command": command}))
        return Message(id=f"msg_{n:04d}", type="message", role="assistant", model="claude-haiku-5-5", content=blocks,
                       stop_reason="end_turn" if command is None else "tool_use", stop_sequence=None,
                       usage=Usage(input_tokens=1000, output_tokens=50))


class _Raw:
    def __init__(self, message):
        self._message = message

    def parse(self):
        return self._message


@pytest.fixture
def api(tmp_path, monkeypatch):
    install_local_vms(monkeypatch, tmp_path)
    fake = FakeMessagesAPI()

    async def _acreate(self, payload):
        fake.requests.append(copy.deepcopy(payload))
        return _Raw(fake.answer(payload))

    monkeypatch.setattr(ChatAnthropic, "_acreate", _acreate)
    return fake


def _without_cache_marks(x):
    """Cache markers may move between requests without affecting a thinking block's validity."""
    if isinstance(x, dict):
        return {k: _without_cache_marks(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [_without_cache_marks(v) for v in x]
    return x


def _prefix(req: dict) -> dict:
    """The parts of a request a thinking block is tied to."""
    return _without_cache_marks({"system": req.get("system"), "tools": req.get("tools"), "messages": req["messages"]})


def _thinking_signatures(req: dict) -> list[str]:
    return [b["signature"] for m in req["messages"] if isinstance(m["content"], list)
            for b in m["content"] if isinstance(b, dict) and b.get("type") == "thinking"]


async def _source_run_and_fork(tmp_path, api) -> tuple[list[dict], list[dict]]:
    """One careless source run, then a fork before its second action. Returns (source requests, child requests)."""
    b = Batch(BatchConfig(n_runs=1, analyst_model=MODEL), batch_id="t", root=tmp_path / "batches")
    await b.run_one("r01")
    source = list(api.requests)
    b.case.set_split({"label": "deduplicate", "fork_run_id": "r01", "fork_at": 1})
    await b.run_forks(1)
    children = api.requests[len(source):]
    await b.close()
    return source, children


async def test_the_source_run_only_ever_appends_to_its_history(tmp_path, api):
    source, _ = await _source_run_and_fork(tmp_path, api)
    assert len(source) == 3  # look, model, done
    for earlier, later in zip(source, source[1:]):
        a, b = _prefix(earlier), _prefix(later)
        assert a["system"] == b["system"] and a["tools"] == b["tools"]
        assert b["messages"][: len(a["messages"])] == a["messages"]
        assert len(b["messages"]) == len(a["messages"]) + 2  # the assistant turn and its tool result
    # Thinking blocks go back to the model unchanged, in order.
    assert _thinking_signatures(source[2]) == ["signature-1", "signature-2"]


async def test_a_control_copy_replays_exactly_what_the_source_run_sent_at_the_fork_point(tmp_path, api):
    source, children = await _source_run_and_fork(tmp_path, api)
    at_fork = _prefix(source[1])  # the request that produced the source run's second action
    control = next(r for r in children if "forced-" not in json.dumps(r["messages"]))
    first = _prefix(control)
    assert first["system"] == at_fork["system"]
    assert first["tools"] == at_fork["tools"]
    assert first["messages"] == at_fork["messages"]
    assert _thinking_signatures(control) == ["signature-1"]
    # Everything else about the request matches too, so the copy differs from the source run in nothing.
    assert {k: v for k, v in control.items() if k not in ("messages", "system", "tools")} == \
           {k: v for k, v in source[1].items() if k not in ("messages", "system", "tools")}


async def test_a_forced_copy_appends_the_forced_step_and_changes_nothing_before_it(tmp_path, api):
    source, children = await _source_run_and_fork(tmp_path, api)
    at_fork = _prefix(source[1])
    # Every arm but the control appends a step, so the forced copy is the one that ran the real fix.
    forced = _prefix(next(r for r in children if "drop_duplicates" in json.dumps(r["messages"])))
    n = len(at_fork["messages"])
    assert forced["system"] == at_fork["system"] and forced["tools"] == at_fork["tools"]
    assert forced["messages"][:n] == at_fork["messages"]
    call, result = forced["messages"][n:]
    # The forced call reads as the agent's own reasoned step: a one-line rationale, then the call.
    assert call["role"] == "assistant" and [b["type"] for b in call["content"]] == ["text", "tool_use"]
    assert call["content"][0]["text"].startswith("Before splitting, I'll remove exact duplicate rows")
    call = {**call, "content": call["content"][1:]}
    assert "drop_duplicates" in call["content"][0]["input"]["command"]
    assert result["role"] == "user" and result["content"][0]["type"] == "tool_result"
    assert result["content"][0]["tool_use_id"] == call["content"][0]["id"]
    assert "Removed" in json.dumps(result["content"][0]["content"])
