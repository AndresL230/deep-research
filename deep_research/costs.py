"""Track model and VM spend per scope, and refuse work that would go over budget."""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

from .config import load_prices


class OverBudget(Exception):
    pass


@dataclass
class ScopeCost:
    # input_tokens is the whole prompt, including the cached reads and writes below.
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    model_usd: float | None = 0.0
    vm_seconds: float = 0.0
    vm_usd: float | None = 0.0

    @property
    def total_usd(self) -> float | None:
        if self.model_usd is None or self.vm_usd is None:
            return None
        return self.model_usd + self.vm_usd

    def to_dict(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "model_usd": _r(self.model_usd),
            "vm_seconds": round(self.vm_seconds, 1),
            "vm_usd": _r(self.vm_usd),
            "total_usd": _r(self.total_usd),
        }


def _r(x: float | None) -> float | None:
    return None if x is None else round(x, 4)


@dataclass
class CostTracker:
    budget_usd: float
    prices: dict = field(default_factory=load_prices)
    scopes: dict[str, ScopeCost] = field(default_factory=lambda: defaultdict(ScopeCost))
    _vm_started: dict[str, float] = field(default_factory=dict)
    # Re-entrant: `snapshot` holds it while it asks for the total. Each run's usage callback writes
    # from a worker thread while the budget check reads the total on the event loop.
    _lock: threading.RLock = field(default_factory=threading.RLock)

    def restore(self, saved: dict) -> None:
        """Take over the spend a saved batch already recorded (its case file's `costs` section).

        A reopened batch then keeps counting from there: the budget guard sees the earlier
        spend, and the next save adds to the saved scopes instead of replacing them.
        A scope saved without a dollar figure stays unknown, never zero.
        """
        with self._lock:
            for name, s in (saved.get("scopes") or {}).items():
                if not isinstance(s, dict):
                    continue
                self.scopes[name] = ScopeCost(
                    input_tokens=int(s.get("input_tokens") or 0),
                    output_tokens=int(s.get("output_tokens") or 0),
                    cache_read_tokens=int(s.get("cache_read_tokens") or 0),
                    cache_write_tokens=int(s.get("cache_write_tokens") or 0),
                    model_usd=s.get("model_usd"),
                    vm_seconds=float(s.get("vm_seconds") or 0.0),
                    vm_usd=s.get("vm_usd"),
                )

    # ---- model usage ----
    def model_price(self, model: str, prompt_tokens: int = 0) -> dict:
        """Per-million-token rates for one response. Some models bill a long prompt at higher rates."""
        p = self.prices.get("models", {}).get(model) or {}
        long = p.get("long_prompt")
        if long and prompt_tokens > long.get("over_tokens", float("inf")):
            return long
        return p

    def record_tokens(
        self,
        scope: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cache_read: int = 0,
        cache_write: int = 0,
        cache_write_1h: int = 0,
    ) -> None:
        """One model response. `input_tokens` is the whole prompt, cached parts included."""
        p = self.model_price(model, input_tokens)
        uncached = max(0, input_tokens - cache_read - cache_write - cache_write_1h)
        parts = [
            (uncached, p.get("input_per_mtok")),
            (output_tokens, p.get("output_per_mtok")),
            (cache_read, p.get("cache_read_per_mtok")),
            (cache_write, p.get("cache_write_per_mtok")),
            (cache_write_1h, p.get("cache_write_1h_per_mtok")),
        ]
        # A missing rate only matters when there are tokens to price with it.
        known = all(rate is not None for n, rate in parts if n) and p.get("input_per_mtok") is not None
        with self._lock:
            s = self.scopes[scope]
            s.input_tokens += input_tokens
            s.output_tokens += output_tokens
            s.cache_read_tokens += cache_read
            s.cache_write_tokens += cache_write + cache_write_1h
            if not known or s.model_usd is None:
                s.model_usd = None
            else:
                s.model_usd += sum(n / 1e6 * rate for n, rate in parts if n)

    # ---- VM time ----
    def vm_started(self, scope: str) -> None:
        self._vm_started[scope] = time.monotonic()

    def vm_stopped(self, scope: str) -> None:
        start = self._vm_started.pop(scope, None)
        if start is not None:
            self.add_vm_seconds(scope, time.monotonic() - start)

    def add_vm_seconds(self, scope: str, seconds: float) -> None:
        rate = self.prices.get("daytona_vm_per_hour")
        with self._lock:
            s = self.scopes[scope]
            s.vm_seconds += seconds
            if rate is None or s.vm_usd is None:
                s.vm_usd = None
            else:
                s.vm_usd += seconds / 3600 * rate

    def _current(self) -> dict[str, ScopeCost]:
        """Every scope as of now: a VM that is still up is counted to this moment, not only once it is deleted."""
        now, rate = time.monotonic(), self.prices.get("daytona_vm_per_hour")
        out = {}
        for k in [*self.scopes, *(k for k in list(self._vm_started) if k not in self.scopes)]:
            s, start = self.scopes.get(k) or ScopeCost(), self._vm_started.get(k)
            if start is not None:
                seconds = max(0.0, now - start)
                usd = None if rate is None or s.vm_usd is None else s.vm_usd + seconds / 3600 * rate
                s = replace(s, vm_seconds=s.vm_seconds + seconds, vm_usd=usd)
            out[k] = s
        return out

    # ---- totals and the guard ----
    def total_usd(self) -> float | None:
        with self._lock:
            totals = [s.total_usd for s in self._current().values()]
        if any(t is None for t in totals):
            return None
        return sum(totals)  # type: ignore[arg-type]

    def check(self, estimate_usd: float | None, what: str) -> None:
        """Raise before starting work that would push spend past the budget."""
        spent = self.total_usd()
        if spent is None or estimate_usd is None:
            # Prices not filled in. Cannot enforce a dollar budget, so allow it;
            # the UI shows tokens and flags that prices are missing.
            return
        if spent + estimate_usd > self.budget_usd:
            raise OverBudget(
                f"{what} would cost about ${estimate_usd:.2f}; spent ${spent:.2f} of ${self.budget_usd:.2f}"
            )

    def average_run_usd(self, prefix: str = "run:") -> float | None:
        with self._lock:
            vals = [s.total_usd for k, s in self.scopes.items() if k.startswith(prefix)]
        if not vals or any(v is None for v in vals):
            return None
        return sum(vals) / len(vals)  # type: ignore[arg-type]

    def snapshot(self) -> dict:
        with self._lock:
            scopes = self._current()
            totals = [s.total_usd for s in scopes.values()]
            spent = None if any(t is None for t in totals) else sum(totals)  # type: ignore[arg-type]
            return {
                "budget_usd": self.budget_usd,
                "spent_usd": _r(spent),
                "prices_missing": spent is None,
                "scopes": {k: v.to_dict() for k, v in scopes.items()},
            }


def estimate_batch_usd(n_runs: int, avg_run_usd: float | None) -> float | None:
    return None if avg_run_usd is None else n_runs * avg_run_usd


class UsageCallback(BaseCallbackHandler):
    """Feeds token counts from every model response into the tracker."""

    def __init__(self, tracker: CostTracker, scope: str, model: str):
        self.tracker, self.scope, self.model = tracker, scope, model

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        for gens in response.generations:
            for g in gens:
                msg = getattr(g, "message", None)
                usage = getattr(msg, "usage_metadata", None) if msg is not None else None
                if usage:
                    self.tracker.record_tokens(self.scope, self.model, **token_counts(usage))


def token_counts(usage: dict) -> dict[str, int]:
    """Read a LangChain `usage_metadata` dict. For Anthropic, `input_tokens` already includes
    cache reads and writes, and `input_token_details` says how many of each."""
    details = usage.get("input_token_details") or {}
    write_5m = int(details.get("ephemeral_5m_input_tokens") or 0)
    write_1h = int(details.get("ephemeral_1h_input_tokens") or 0)
    if not write_5m and not write_1h:
        # langchain-anthropic zeroes the generic `cache_creation` when it reports per-TTL keys.
        write_5m = int(details.get("cache_creation") or 0)
    return {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read": int(details.get("cache_read") or 0),
        "cache_write": write_5m,
        "cache_write_1h": write_1h,
    }
