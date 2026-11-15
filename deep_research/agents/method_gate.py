"""A soft gate on the investigator's method (plan Phase 3): plain code, no model call.

- `record_suspects` is refused once when the investigator has written no plan (`write_todos`) or asked none of the
  lens subagents (`task` with lens-omission, lens-commission or lens-data).
- `run_experiment` is refused once per suspect when the skeptic has not been asked since that suspect was recorded.

Each gate refuses at most once (per tool, and per suspect for experiments). The next attempt goes through and the
case file records the step that was skipped (`investigator.skipped_steps`), so the gate can slow the investigator
down but never stop it. `BatchConfig.investigator_strict = False` turns it off.

What it reads is what the batch's stream of the investigator writes to the case file's `investigator` section: the
plan (`todos`) and the subagent calls (`subagent_calls`, counted from the same `task` events the panel shows). Its own
state (`method_gate`) is in that section too, so all of it is on disk and holds after a restart from the SQLite
checkpoint.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..case_file import CaseFile

LENSES = ("lens-omission", "lens-commission", "lens-data")
SKEPTIC = "skeptic"


def _section(case: "CaseFile") -> dict:
    inv = case.data.get("investigator")
    return inv if isinstance(inv, dict) else {}


def _state(case: "CaseFile") -> dict:
    gate = _section(case).get("method_gate")
    return {"refused": [], "skeptic_mark": {}, **(gate if isinstance(gate, dict) else {})}


def _calls(case: "CaseFile") -> dict:
    return dict(_section(case).get("subagent_calls") or {})


def _refuse_once(case: "CaseFile", key: str, steps: list[str], suspect_id: str | None = None) -> bool:
    """True when `key` has not been refused before (and marks it refused). Otherwise records the skipped steps,
    once per key, and returns False: the call goes through."""
    gate = _state(case)
    if key not in gate["refused"]:
        case.set_investigator(method_gate={**gate, "refused": [*gate["refused"], key]})
        return True
    skipped = list(_section(case).get("skipped_steps") or [])
    if not any(s.get("key") == key for s in skipped):
        skipped.append({"key": key, "tool": key.split(":")[0], "skipped": steps, "at": time.time(),
                        **({"suspect_id": suspect_id} if suspect_id else {})})
        case.set_investigator(skipped_steps=skipped)
    return False


def suspects_refusal(case: "CaseFile", strict: bool = True) -> str | None:
    """Why `record_suspects` is refused this time, or None to let it through."""
    if not strict:
        return None
    missing = []
    if not _section(case).get("todos"):
        missing.append("write_todos")
    calls = _calls(case)
    if not any(calls.get(lens) for lens in LENSES):
        missing.append("lenses")
    if not missing or not _refuse_once(case, "record_suspects", missing):
        return None
    if missing == ["write_todos"]:
        do = "First write your plan with write_todos, then record the suspects."
    elif missing == ["lenses"]:
        do = ("First ask the lens subagents for suspects (task tool: lens-omission, lens-commission and lens-data, "
              "all three in one turn), then record them, saying which lens proposed each.")
    else:
        do = ("First write your plan with write_todos and ask the lens subagents for suspects (task tool: "
              "lens-omission, lens-commission and lens-data, all three in one turn), then record them.")
    return f"refused by the method check, nothing was saved: {do}"


def mark_recorded(case: "CaseFile", suspect_ids: list[str]) -> None:
    """Remember how often the skeptic had been asked when these suspects were recorded."""
    if not suspect_ids:
        return
    gate = _state(case)
    n = int(_calls(case).get(SKEPTIC) or 0)
    marks = {**gate["skeptic_mark"], **{sid: n for sid in suspect_ids if sid not in gate["skeptic_mark"]}}
    case.set_investigator(method_gate={**gate, "skeptic_mark": marks})


def experiment_refusal(case: "CaseFile", suspect_id: str, strict: bool = True) -> str | None:
    """Why `run_experiment` on `suspect_id` is refused this time, or None to let it through."""
    if not strict or not suspect_id:
        return None
    asked = int(_calls(case).get(SKEPTIC) or 0)
    if asked > int(_state(case)["skeptic_mark"].get(suspect_id) or 0):
        return None
    if not _refuse_once(case, f"run_experiment:{suspect_id}", ["skeptic"], suspect_id):
        return None
    return (f"refused by the method check (plain code, not a person), nothing was run or spent: first ask the "
            f"skeptic (task tool, subagent_type `skeptic`) for the cheapest experiment that could prove {suspect_id} "
            f"wrong and what could fool you, then design the experiment from its answer and call run_experiment again.")
