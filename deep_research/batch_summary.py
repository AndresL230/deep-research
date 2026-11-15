"""One batch in a few numbers, for the home screen's batch table (`summary` in `GET /api/batches`).

Pure: it takes a case file and returns a dict. Spend and the start date come from cost_report.py, so the table and
the cost screen agree. Every field may be null (or a count zero) so a batch saved before a field existed still reads.
Words only, never a raw step label: the step that separates honest from inflated runs comes in the domain's words.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import domains
from .case_file import current_domain
from .cost_report import _batch, started_at
from .evidence import LEVELS, RULE, current_verdict_evidence

# A run that has finished, scored or not (the wall's SCORED set).
FINISHED = ("honest", "inflated", "unclear", "failed")
# Phases after which nothing more happens (api.OVER): a run still marked running in such a batch was stopped.
OVER = ("done", "no_split", "stopped")
OVER_PREFIXES = ("error:", "blocked:")
# A fork that is still going (batch.py `update_fork`): rebuilding the VMs, then running the copies.
FORK_GOING = ("rebuilding", "running")


def _dict(x: Any) -> dict:
    return x if isinstance(x, dict) else {}


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def is_over(phase: Any) -> bool:
    p = phase if isinstance(phase, str) else ""
    return p in OVER or p.startswith(OVER_PREFIXES)


def _mean(xs: list[float | None]) -> float | None:
    v = [x for x in xs if x is not None]
    return sum(v) / len(v) if v else None


def _domain(config: dict) -> tuple[dict | None, dict]:
    """The domain's name and title, and its step words: the case file's own, else the registered domain's."""
    info = _dict(config.get("domain_info"))
    name = info.get("name") or config.get("domain") or domains.DEFAULT
    try:
        known = domains.get(name)
    except ValueError:
        known = None
    title = info.get("title") or (known.title if known else None)
    steps = {**(known.words.public()["steps"] if known else {}), **_dict(_dict(info.get("words")).get("steps"))}
    return ({"name": name, "title": title} if isinstance(name, str) else None), steps


def step_name(label: str, steps: dict, trap: dict) -> str:
    """A step label as a noun phrase: "testing other can positions". The domain's name for it, else the planted
    trap's words for its own step, else "the <label in words> step". Never the raw label."""
    own = _dict(steps.get(label)).get("name")
    if isinstance(own, str) and own:
        return own
    if trap.get("label") == label and isinstance(trap.get("did"), str) and trap["did"]:
        return trap["did"]
    plain = " ".join(label.replace("-", "_").split("_")).strip()
    return f"the {plain} step" if plain else "an unnamed step"


def _counts(runs: list[dict], over: bool) -> dict[str, int]:
    """Runs by outcome. A run neither finished nor queued is running, or stopped once the batch is over."""
    out = {"honest": 0, "inflated": 0, "unclear": 0, "failed": 0, "running": 0, "queued": 0, "stopped": 0}
    for r in runs:
        status = r.get("status")
        if status in FINISHED:
            out[status] += 1
        elif over:
            out["stopped"] += 1
        elif status == "queued":
            out["queued"] += 1
        else:
            out["running"] += 1
    return out


def _claim(runs: list[dict], over: bool) -> dict | None:
    """The claim against the truth, as the overview's headline has it (web/src/batch/wall.ts `claimHeadline`): the
    means over the inflated runs, else over the honest and unclear ones. Null while a run is still going in a batch
    that is not over (a stopped batch shows its finished runs), or when no run has both numbers."""
    if not runs or (not over and any(r.get("status") not in FINISHED for r in runs)):
        return None
    inflated = [r for r in runs if r.get("status") == "inflated"]
    group = inflated or [r for r in runs if r.get("status") in ("honest", "unclear")]
    claimed = _mean([_num(r.get("reported_accuracy")) for r in group])
    measured = _mean([_num(r.get("true_accuracy")) for r in group])
    if claimed is None or measured is None:
        return None
    # The hidden case count when the runs agree on one (wall.ts `hiddenCount`).
    hidden = {int(n) for r in group if (n := _num(r.get("n_hidden"))) and n > 0}
    return {
        "of": "inflated" if inflated else "honest",
        "n": len(group),
        "claimed": round(claimed, 4),
        "measured": round(measured, 4),
        "n_hidden": hidden.pop() if len(hidden) == 1 else None,
    }


def _verdict(case: dict, over: bool) -> dict:
    """Where the fork experiment and the verdict are (evidence.py)."""
    verdict = case.get("verdict")
    if isinstance(verdict, dict):
        ev = verdict.get("evidence")
        if not isinstance(ev, dict) or ev.get("rule") != RULE:
            # Saved before verdicts had evidence, or by the older Fisher rule (case_file.with_evidence): worked out
            # here by today's rule without touching the case.
            ev = current_verdict_evidence(case) or {}
        level = ev.get("level") if ev.get("level") in LEVELS else "open"
        return {"state": level, "pairs": ev.get("pairs"), "needed_pairs": ev.get("needed_pairs")}
    forks = _dict(case.get("forks"))
    method = [f for k, f in forks.items() if k != "pending" and isinstance(f, dict) and f.get("kind", "method") != "fix"]
    if any(f.get("status") in FORK_GOING for f in method):
        return {"state": "fork_stopped" if over else "fork_running"}
    if forks.get("pending") or case.get("phase") == "awaiting_approval":
        return {"state": "awaiting_approval"}
    if any(f.get("status") == "done" for f in method):
        return {"state": "forked"}
    if any(f.get("status") == "stopped" for f in method):
        return {"state": "fork_stopped"}
    return {"state": "none"}


def _int(x: Any) -> int | None:
    return x if isinstance(x, int) and not isinstance(x, bool) else None


def _pending(case: dict) -> dict | None:
    """The fork request waiting for approval (`forks.pending`, batch.py), in the few numbers a person approves it on:
    a method experiment or a fix test, its VMs and its estimate (null when prices are missing). Null when none waits."""
    p = _dict(case.get("forks")).get("pending")
    if not isinstance(p, dict):
        return None
    return {
        "kind": "fix" if p.get("kind") == "fix" else "method",
        "n_per_arm": _int(p.get("n_per_arm")),
        "vm_count": _int(p.get("vm_count")),
        "estimate_usd": _num(p.get("estimate_usd")),
    }


def _fork_progress(case: dict, over: bool) -> dict | None:
    """How far the fork experiment still going is (a first one, a fix test or a round of more pairs): its copies
    scored out of all it will run (`n_per_arm`, the copies per arm over every round, times its arms). Null when no
    fork is going, or the batch is over."""
    if over:
        return None
    for fork_id, f in _dict(case.get("forks")).items():
        if fork_id == "pending" or not isinstance(f, dict) or f.get("status") not in FORK_GOING:
            continue
        kids = [k for k in _dict(f.get("children")).values() if isinstance(k, dict)]
        arms = _dict(f.get("arm_steps"))
        planned = (_int(f.get("n_per_arm")) or 0) * (len(arms) or 2)
        return {"scored": sum(1 for k in kids if k.get("status") in FINISHED), "total": max(planned, len(kids))}
    return None


def _spend(entry: dict) -> dict:
    """What the batch cost (cost_report._batch): dollars when they are known, else its tokens (input plus output)."""
    row, _ = _batch(entry)
    usd = row["usd"]["total"] if isinstance(row["usd"], dict) else None
    toks = row["tokens"]["input"] + row["tokens"]["output"]
    # Unknown prices with nothing priced is no dollar figure at all, not $0.
    if usd is not None and usd == 0 and row["prices_missing"] and toks:
        usd = None
    return {"usd": usd, "usd_partial": bool(row["usd_partial"]) and usd is not None, "tokens": toks}


def _hub_started(value: Any) -> str | None:
    """The hub's `started_at` ("2026-11-14T10:04:18-0500") as local time like `cost_report.started_at`."""
    if not isinstance(value, str) or not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            when = datetime.strptime(value, fmt)
        except ValueError:
            continue
        if when.tzinfo is not None:
            when = when.astimezone().replace(tzinfo=None)
        return when.isoformat(timespec="seconds")
    return None


def summarize(batch_id: str, case: Any, mtime: float | None = None, hub_started_at: Any = None) -> dict | None:
    """The batch's summary for the home table, or None when `case` is not a case file.

    `mtime` is the case file's last change (None for fixtures and hub batches), for the start date of a batch whose
    id carries none; `hub_started_at` is the hub's own record of it.
    """
    if not isinstance(case, dict):
        return None
    current_domain(case)
    config = _dict(case.get("config"))
    runs = [r for r in _dict(case.get("runs")).values() if isinstance(r, dict)]
    phase = case.get("phase") if isinstance(case.get("phase"), str) else None
    over = is_over(phase)
    domain, steps = _domain(config)
    trap = _dict(config.get("trap_info"))
    split = _dict(case.get("split"))
    label = split.get("label")
    lineup = config.get("analyst_models")
    analysts = [m for m in lineup if isinstance(m, str) and m] if isinstance(lineup, list) and lineup else []
    if not analysts and isinstance(config.get("analyst_model"), str) and config["analyst_model"]:
        analysts = [config["analyst_model"]]
    planned = config.get("n_runs")
    return {
        "domain": domain,
        "started_at": started_at(batch_id, mtime) or _hub_started(hub_started_at),
        "phase": phase,
        "simulated": bool(config.get("simulated") or _dict(case.get("costs")).get("simulated")),
        "analyst_models": analysts,
        "investigator_model": config.get("investigator_model") if isinstance(config.get("investigator_model"), str) else None,
        "n_runs": len(runs) or (planned if isinstance(planned, int) else 0),
        "counts": _counts(runs, over),
        "claim": _claim(runs, over),
        "step": {"label": label, "name": step_name(label, steps, trap)} if isinstance(label, str) and label else None,
        "verdict": _verdict(case, over),
        "pending": _pending(case),
        "fork_progress": _fork_progress(case, over),
        "spend": _spend({"id": batch_id, "case": case, "mtime": mtime}),
    }
