"""Spend across every batch, for the overall cost screen (`GET /api/costs`).

Pure: it takes case files and returns one report. It reads no files and prices nothing; the dollars are the
ones `costs.CostTracker.snapshot()` wrote into each case file's `costs` section.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

# Where the money went. A scope is `run:r01`, `fork:f1:base`, `fork:f1:control-1` or `investigator`;
# fixtures use the bare `runs` and `forks`. `commentary` is the live captions (commentary.py). Anything else lands in
# `other`.
GROUPS = ("runs", "forks", "investigator", "commentary", "other")
TOKENS = ("input", "output", "cache_read", "cache_write")
SCORED = ("honest", "inflated", "failed")

NOT_COUNTED = [
    "Simulated batches: listed with their token counts, left out of every total.",
    "Disk kept by stopped VMs. VM time is compute only, from when a VM is up until it is deleted.",
    "VMs still running when the server was killed, after their last saved cost.",
    "Anything started outside this app with the same keys.",
    "Batches deleted from the batches folder.",
]

_ID = re.compile(r"^(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-")


def started_at(batch_id: str, mtime: float | None, now: datetime | None = None) -> str | None:
    """When a batch started, as local time `YYYY-MM-DDTHH:MM:SS`, or None when nothing says.

    A batch id is `MMDD-HHMMSS-xxxx` (batch.py). It carries no year, so the year comes from the case file's
    last change (or today), stepping back one when that would put the start in the future. An id in another
    shape falls back to the case file's last change.
    """
    ref = datetime.fromtimestamp(mtime) if mtime is not None else None
    m = _ID.match(batch_id)
    if m:
        month, day, hour, minute, second = (int(x) for x in m.groups())
        anchor = ref or now or datetime.now()
        for year in (anchor.year, anchor.year - 1):
            try:
                when = datetime(year, month, day, hour, minute, second)
            except ValueError:
                continue  # not a date (or Feb 29 in the wrong year)
            if when <= anchor + timedelta(days=1):
                return when.isoformat(timespec="seconds")
    return ref.isoformat(timespec="seconds") if ref is not None else None


def _group(scope: str) -> str:
    if scope == "runs" or scope.startswith("run:"):
        return "runs"
    if scope == "forks" or scope.startswith("fork:"):
        return "forks"
    if scope.startswith("investigator"):
        return "investigator"
    if scope == "commentary":
        return "commentary"
    return "other"


def _num(x: Any) -> float:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else 0.0


def _dict(x: Any) -> dict:
    """A hand-edited or half-written case file must not break the report."""
    return x if isinstance(x, dict) else {}


def _tokens(scope: dict) -> dict[str, int]:
    return {k: int(_num(scope.get(f"{k}_tokens"))) for k in TOKENS}


def _add(into: dict, more: dict) -> None:
    for k, v in more.items():
        into[k] = into.get(k, 0) + v


def _zero_usd() -> dict[str, float]:
    return {"total": 0.0, **{g: 0.0 for g in GROUPS}, "model": 0.0, "vm": 0.0}


def _model_row() -> dict:
    # A model gets a `commentary` key only when it wrote captions: the analyst and investigator rows keep their shape.
    groups = {g: 0.0 for g in GROUPS if g not in ("other", "commentary")}
    return {"usd": 0.0, "groups": groups, "usd_partial": False, "tokens": {k: 0 for k in TOKENS}, "roles": set(), "batches": 0}


def _round_usd(usd: dict[str, float]) -> dict[str, float]:
    return {k: round(v, 4) for k, v in usd.items()}


def _scope_model(scope: str, case: dict) -> str | None:
    """The `model` a run (`run:r01`) or fork copy (`fork:f1:control-1`) recorded in the case file, or None."""
    parts = scope.split(":")
    if len(parts) == 2 and parts[0] == "run":
        rec = _dict(_dict(case.get("runs")).get(parts[1]))
    elif len(parts) == 3 and parts[0] == "fork":
        rec = _dict(_dict(_dict(_dict(case.get("forks")).get(parts[1])).get("children")).get(parts[2]))
    else:
        return None
    model = rec.get("model")
    return model if isinstance(model, str) and model else None


def _batch(entry: dict) -> tuple[dict, dict[str, dict]]:
    """One batch's row, and its model spend and tokens by model name."""
    case = _dict(entry.get("case"))
    config, costs, runs = _dict(case.get("config")), _dict(case.get("costs")), _dict(case.get("runs"))
    statuses = [r.get("status") for r in runs.values() if isinstance(r, dict)]
    fork_runs = sum(
        len(_dict(f.get("children"))) for f in _dict(case.get("forks")).values() if isinstance(f, dict)
    )

    usd = _zero_usd()
    tokens = {k: 0 for k in TOKENS}
    vm_seconds = 0.0
    partial = False
    models: dict[str, dict] = {}
    for name, scope in _dict(costs.get("scopes")).items():
        if not isinstance(scope, dict):
            continue
        group = _group(name)
        tok = _tokens(scope)
        seconds = _num(scope.get("vm_seconds"))
        _add(tokens, tok)
        vm_seconds += seconds
        # A null price means unknown, not free: add what is known and say that some is missing.
        model_usd, vm_usd = scope.get("model_usd"), scope.get("vm_usd")
        model_known = isinstance(model_usd, (int, float))
        vm_known = isinstance(vm_usd, (int, float))
        if (not model_known and any(tok.values())) or (not vm_known and seconds > 0):
            partial = True
        known = _num(model_usd) + _num(vm_usd)
        usd[group] += known
        usd["model"] += _num(model_usd)
        usd["vm"] += _num(vm_usd)
        usd["total"] += known

        # The commentary's tokens are its own model's (`commentary_model`).
        role = group if group in ("investigator", "commentary") else "analyst"
        # A run or fork copy names its own model when the batch had a lineup of analyst models.
        model = _scope_model(name, case) or config.get(f"{role}_model")
        if model and group != "other" and any(tok.values()):
            m = models.setdefault(model, _model_row())
            m["usd"] += _num(model_usd)
            m["groups"][group] = m["groups"].get(group, 0.0) + _num(model_usd)
            m["usd_partial"] = m["usd_partial"] or not model_known
            m["roles"].add(role)
            _add(m["tokens"], tok)

    simulated = bool(config.get("simulated") or costs.get("simulated"))
    row = {
        "id": entry["id"],
        "kind": entry.get("kind", "replay"),
        "started_at": started_at(entry["id"], entry.get("mtime")),
        "phase": case.get("phase"),
        "dataset": config.get("dataset"),
        "trap": config.get("trap"),
        # A lineup of analyst models (runs took them in turn) reads as the models joined.
        "analyst_model": ", ".join(lineup) if isinstance(lineup := config.get("analyst_models"), list) and lineup
        else config.get("analyst_model"),
        "investigator_model": config.get("investigator_model"),
        "simulated": simulated,
        "prices_missing": bool(costs.get("prices_missing")),
        "counts": {
            "runs": len(statuses),
            **{s: statuses.count(s) for s in SCORED},
            # Robot runs between the two thresholds, only when there are some: tabular rows keep their shape.
            **({"unclear": statuses.count("unclear")} if "unclear" in statuses else {}),
            "fork_runs": fork_runs,
        },
        # A simulated batch has no real dollars: tokens only.
        "usd": None if simulated else _round_usd(usd),
        "usd_partial": partial and not simulated,
        "tokens": tokens,
        "vm_seconds": round(vm_seconds, 1),
    }
    return row, models


def cost_report(entries: list[dict]) -> dict:
    """The report for the cost screen.

    Each entry is `{"id", "kind": "live" | "replay", "case": <case file>, "mtime": <case file's mtime or None>}`.
    Rows come back newest first with simulated batches last. `totals` and `by_model` cover the real batches
    only. Dollars are the sum of what is known; `usd_partial` says that some price was unknown, so the true
    figure is higher.
    """
    rows: list[dict] = []
    usd = _zero_usd()
    tokens = {k: 0 for k in TOKENS}
    counts = {"batches": 0, "runs": 0, **{s: 0 for s in SCORED}, "fork_runs": 0}
    sim = {"batches": 0, "runs": 0, "tokens": {k: 0 for k in TOKENS}}
    by_model: dict[str, dict] = {}
    vm_seconds = 0.0
    partial = False

    for entry in entries:
        row, models = _batch(entry)
        rows.append(row)
        if row["simulated"]:
            sim["batches"] += 1
            sim["runs"] += row["counts"]["runs"]
            _add(sim["tokens"], row["tokens"])
            continue
        counts["batches"] += 1
        _add(counts, row["counts"])
        _add(usd, row["usd"])
        _add(tokens, row["tokens"])
        vm_seconds += row["vm_seconds"]
        partial = partial or row["usd_partial"]
        for name, m in models.items():
            t = by_model.setdefault(name, _model_row())
            t["usd"] += m["usd"]
            _add(t["groups"], m["groups"])
            t["usd_partial"] = t["usd_partial"] or m["usd_partial"]
            t["roles"] |= m["roles"]
            t["batches"] += 1
            _add(t["tokens"], m["tokens"])

    # Newest first; a batch with no date goes after the dated ones; simulated batches go last.
    rows.sort(key=lambda r: r["id"])
    rows.sort(key=lambda r: r["started_at"] or "", reverse=True)
    rows.sort(key=lambda r: r["simulated"])

    return {
        "totals": {
            **counts,
            "usd": _round_usd(usd),
            "usd_partial": partial,
            "tokens": tokens,
            "vm_seconds": round(vm_seconds, 1),
            "excludes_simulated": True,
        },
        "simulated": sim,
        # Model spend only: VM time belongs to no model.
        "by_model": sorted(
            (
                {
                    "model": name,
                    "roles": sorted(m["roles"]),
                    "batches": m["batches"],
                    "usd": round(m["usd"], 4),
                    "usd_by_group": _round_usd(m["groups"]),
                    "usd_partial": m["usd_partial"],
                    "tokens": m["tokens"],
                }
                for name, m in by_model.items()
            ),
            key=lambda m: (-m["usd"], m["model"]),
        ),
        "batches": rows,
        "not_counted": NOT_COUNTED,
    }
