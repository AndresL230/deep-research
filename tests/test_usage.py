from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk

from server import usage
from server.translator import TurnTranslator
from tests.test_app import CONV, META, Harness


def test_cost_splits_cached_and_uncached_input():
    # 1M uncached in ($2) + 1M cache read ($0.10) + 1M cache write 5m ($2.50) + 1M out ($10)
    tokens = {"in": 3_000_000, "cached": 1_000_000, "cache_write": 1_000_000, "out": 1_000_000}
    assert usage.cost_usd("anthropic:claude-sonnet-5-5", tokens) == pytest.approx(14.60)


def test_cost_one_hour_cache_writes_are_double_input():
    tokens = {"in": 1_000_000, "cache_write_1h": 1_000_000, "out": 0}
    assert usage.cost_usd("claude-sonnet-5-5", tokens) == pytest.approx(4.00)


def test_unknown_model_has_no_cost():
    assert usage.cost_usd("anthropic:some-other-model", {"in": 10, "out": 10}) is None


def test_translator_counts_cache_writes_from_per_ttl_keys():
    t = TurnTranslator()
    t.start()
    chunk = AIMessageChunk(content="x", id="a", usage_metadata={
        "input_tokens": 1000, "output_tokens": 10, "total_tokens": 1010,
        "input_token_details": {"cache_read": 200, "cache_creation": 0,
                                "ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 0},
    })
    t.on_message(chunk, META)
    assert t.tokens == {"in": 1000, "out": 10, "cached": 200, "cache_write": 300, "cache_write_1h": 0}
    done = t.finish(1)[-1][1]
    assert done["tokens"] == {"in": 1000, "out": 10, "cached": 200}  # contract shape unchanged


def test_record_skips_runs_without_tokens(tmp_path):
    path = tmp_path / "usage.jsonl"
    entry = usage.record(path, conversation=CONV, question="q", status="error",
                         started_at=datetime.now(timezone.utc), seconds=1.0,
                         model="anthropic:claude-sonnet-5-5", tokens={"in": 0, "out": 0})
    assert entry is None and not path.exists()


def test_each_turn_is_logged_and_summarised(tmp_path):
    h = Harness(tmp_path)
    with TestClient(h.app) as client:
        assert client.get("/api/usage").json() == {
            "runs": [], "totalCost": 0, "totalRuns": 0, "totalTokens": {"in": 0, "out": 0}}
        h.ask(client, message="What sells best?")
        h.ask(client, message="And   by\nchannel?")
        data = client.get("/api/usage").json()
    assert data["totalRuns"] == 2
    newest, oldest = data["runs"]
    assert newest["question"] == "And by channel?" and oldest["question"] == "What sells best?"
    assert newest["status"] == "done" and newest["conversation"] == CONV
    assert newest["model"] == "claude-sonnet-5-5"
    assert newest["tokens"] == {"in": 50, "out": 5, "cache_read": 0, "cache_write": 0}
    assert newest["cost"] == pytest.approx((50 * 2 + 5 * 10) / 1_000_000)
    assert data["totalCost"] == pytest.approx(2 * newest["cost"])
    datetime.fromisoformat(newest["at"])  # parseable timestamp
    assert newest["seconds"] >= 0


def test_no_key_turn_is_not_logged(tmp_path):
    h = Harness(tmp_path, anthropic=False)
    with TestClient(h.app) as client:
        h.ask(client)
        assert client.get("/api/usage").json()["totalRuns"] == 0
