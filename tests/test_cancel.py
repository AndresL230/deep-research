"""Stopping a turn: client abort and DELETE both cancel the agent run and send nothing more."""

from __future__ import annotations

import asyncio

import pytest

from server.conversations import ConversationManager, Services
from tests.fakes import FakeSession, keys


class BlockingAgent:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.closed = False

    async def astream(self, input, config=None, *, stream_mode=None):
        try:
            yield ("tools", {"event": "tool-started", "tool_call_id": "c1", "tool_name": "execute",
                             "input": {"command": "python slow.py"}})
            self.started.set()
            await asyncio.Event().wait()  # a tool that never finishes
        finally:
            self.closed = True


def make_manager(tmp_path, agent: BlockingAgent) -> ConversationManager:
    FakeSession.deleted = []
    return ConversationManager(Services(
        sandbox_factory=FakeSession,
        agent_factory=lambda backend: agent,
        key_status=keys(),
        runs_dir=tmp_path,
    ))


async def collect(manager: ConversationManager, out: list) -> None:
    async for event in manager.run_turn("conv-1", "hi"):
        out.append(event)


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_client_abort_cancels_run(tmp_path):
    agent = BlockingAgent()
    manager = make_manager(tmp_path, agent)
    events: list = []
    consumer = asyncio.create_task(collect(manager, events))
    await asyncio.wait_for(agent.started.wait(), 5)
    await settle()
    consumer.cancel()  # what Starlette does when the client disconnects
    with pytest.raises(asyncio.CancelledError):
        await consumer
    await settle()
    assert agent.closed
    assert [n for n, _ in events] == ["thinking", "thinking", "activity"]
    conv = manager.conversations["conv-1"]
    assert conv.task is None and not conv.lock.locked()
    assert conv.session is not None  # the sandbox survives a Stop; only DELETE removes it


@pytest.mark.asyncio
async def test_delete_mid_run_cancels_and_deletes_sandbox(tmp_path):
    agent = BlockingAgent()
    manager = make_manager(tmp_path, agent)
    events: list = []
    consumer = asyncio.create_task(collect(manager, events))
    await asyncio.wait_for(agent.started.wait(), 5)
    await manager.delete("conv-1")
    await asyncio.wait_for(consumer, 5)  # stream ends quietly
    assert agent.closed
    assert [n for n, _ in events] == ["thinking", "thinking", "activity"]
    assert FakeSession.deleted and "conv-1" not in manager.conversations
