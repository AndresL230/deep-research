"""Track model and VM spend per scope, and refuse work that would go over budget."""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

from .config import load_prices


class OverBudget(Exception):
    pass


@dataclass
class ScopeCost:
    input_tokens: int = 0
    output_tokens: int = 0
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
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # ---- model usage ----
    def model_price(self, model: str) -> tuple[float | None, float | None]:
        p = self.prices.get("models", {}).get(model) or {}
        return p.get("input_per_mtok"), p.get("output_per_mtok")

    def record_tokens(self, scope: str, model: str, input_tokens: int, output_tokens: int) -> None:
        pin, pout = self.model_price(model)
        with self._lock:
            s = self.scopes[scope]
            s.input_tokens += input_tokens
            s.output_tokens += output_tokens
            if pin is None or pout is None or s.model_usd is None:
                s.model_usd = None
            else:
                s.model_usd += input_tokens / 1e6 * pin + output_tokens / 1e6 * pout

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

    # ---- totals and the guard ----
    def total_usd(self) -> float | None:
        totals = [s.total_usd for s in self.scopes.values()]
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
        vals = [s.total_usd for k, s in self.scopes.items() if k.startswith(prefix)]
        if not vals or any(v is None for v in vals):
            return None
        return sum(vals) / len(vals)  # type: ignore[arg-type]

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "budget_usd": self.budget_usd,
                "spent_usd": _r(self.total_usd()),
                "prices_missing": self.total_usd() is None,
                "scopes": {k: v.to_dict() for k, v in self.scopes.items()},
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
                    self.tracker.record_tokens(
                        self.scope, self.model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)
                    )
