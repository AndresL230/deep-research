"""The fool rate (MASTER_PLAN Phase 5.3): how often the analyst is fooled by the trap under each setting.

One batch of `n` runs per setting, all with the same trap and seed; each run is scored on the hidden holdout as
always, and the inflated runs are counted. The table gives, per setting, the inflated count, n (the runs that were
scored) and the rate with a 95% Wilson interval. Plain Python: the counting and the interval are code, never a model.

Settings: `none` (no hint, no lessons: the control), `light` (the light hint, `hint_level="light"`) and `learned`
(the approved lessons, `lessons="learned"`). Every table includes `none`, so every comparison has its control arm.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

SETTINGS = ("none", "light", "learned")
# What one tabular analyst run costs, when no saved batch has priced one yet: about $0.004 (Haiku 5.5 tokens and a
# few minutes of VM time, measured on the real tabular batches).
DEFAULT_RUN_USD = 0.004
Z95 = 1.959964


def config_for(setting: str) -> dict:
    """The BatchConfig fields a setting changes. Everything else stays the same across the settings."""
    if setting not in SETTINGS:
        raise ValueError(f"unknown setting '{setting}'; use some of {list(SETTINGS)}")
    return {"none": {"hint_level": "none", "lessons": "none"},
            "light": {"hint_level": "light", "lessons": "none"},
            "learned": {"hint_level": "none", "lessons": "learned"}}[setting]


def parse_settings(text: str) -> list[str]:
    """`none,learned` as a list, checked, with `none` (the control) always in it and first."""
    names = [s.strip() for s in (text or "").split(",") if s.strip()]
    for s in names:
        config_for(s)
    return ["none"] + [s for s in dict.fromkeys(names) if s != "none"]


def wilson(k: int, n: int, z: float = Z95) -> tuple[float, float] | None:
    """The Wilson score interval for k successes in n trials (95% by default). None when n is 0."""
    if n <= 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)


def row(setting: str, runs: dict, batch_id: str | None = None) -> dict:
    """One line of the table from a batch's `runs`: inflated count, n scored, rate and its Wilson interval. A failed
    run is left out of n (it fooled nobody and told nothing); `unclear` runs count in n as not inflated."""
    statuses = [r.get("status") for r in (runs or {}).values()]
    n = sum(s in ("honest", "inflated", "unclear") for s in statuses)
    k = sum(s == "inflated" for s in statuses)
    ci = wilson(k, n)
    return {"setting": setting, "batch_id": batch_id, "inflated": k, "n": n, "failed": statuses.count("failed"),
            "rate": None if n == 0 else round(k / n, 4), "ci95": None if ci is None else list(ci),
            "interval": "wilson"}


def estimate_usd(n: int, settings: list[str], per_run: float | None) -> float:
    return round(n * len(settings) * (DEFAULT_RUN_USD if per_run is None else per_run), 4)


def table(rows: list[dict], *, n: int, domain: str, trap: dict, estimate: float | None) -> dict:
    """The `foolrate` section: the settings, the rows, what was held fixed, and when."""
    return {"settings": [r["setting"] for r in rows], "rows": rows, "n_per_setting": n, "domain": domain,
            "trap": trap, "control": "none", "estimate_usd": estimate,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}


def lines(t: dict) -> list[str]:
    out = [f"fool rate, {t['domain']}, {t['n_per_setting']} runs per setting (control: none)"]
    for r in t["rows"]:
        rate = "n/a" if r["rate"] is None else f"{r['rate']:.0%}"
        ci = "" if r["ci95"] is None else f"  95% Wilson [{r['ci95'][0]:.0%}, {r['ci95'][1]:.0%}]"
        out.append(f"  {r['setting']:8} {r['inflated']}/{r['n']} inflated  {rate}{ci}"
                   + (f"  ({r['failed']} failed)" if r["failed"] else "") + f"  batch {r['batch_id']}")
    return out


def save_report(t: dict, root: Path) -> Path:
    """The table as its own report, `batches/_foolrate/<stamp>.json`, next to the `foolrate` section of each batch."""
    folder = root / "_foolrate"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{time.strftime('%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(t, indent=2))
    return path


# ---- reading the reports back (GET /api/foolrate) ----

# What a report may carry to the screen, and what each row may carry: the counts, never a run's files or labels. A
# key not listed here is dropped on the way out, so nothing the evaluator keeps back can ride along in a report.
REPORT_KEYS = ("settings", "rows", "n_per_setting", "domain", "trap", "control", "estimate_usd", "created_at",
               "lessons", "simulated", "recording", "note")
ROW_KEYS = ("setting", "batch_id", "inflated", "n", "failed", "rate", "ci95", "interval", "usd")
LESSON_KEYS = ("name", "rule", "learned_from")


def case_usd(case: dict | None) -> float | None:
    """What a batch cost in all (its case file's `costs`), or None when it has no price."""
    from .costs import CostTracker

    if not isinstance(case, dict) or not isinstance(case.get("costs"), dict):
        return None
    t = CostTracker(budget_usd=1.0)
    try:
        t.restore(case["costs"])
    except (TypeError, ValueError, KeyError, AttributeError):
        return None
    total = t.total_usd()
    return None if total is None else round(total, 4)


def lessons_for(names: list[str] | None, approved: list[dict]) -> list[dict]:
    """The lessons a `learned` arm was given, with their rules: the names its runs recorded (`runs.<id>.lessons`)
    matched to the approved SKILL.md files, or every approved lesson when the runs recorded none."""
    by_name = {a["name"]: a for a in approved}
    picked = [by_name.get(n, {"name": n, "rule": None}) for n in names] if names else approved
    return [{k: a.get(k) for k in LESSON_KEYS} for a in picked]


def _clean(report: dict) -> dict:
    out = {k: report[k] for k in REPORT_KEYS if k in report}
    out["rows"] = [{k: r[k] for k in ROW_KEYS if k in r} for r in report.get("rows") or [] if isinstance(r, dict)]
    if isinstance(out.get("lessons"), list):
        out["lessons"] = [{k: x.get(k) for k in LESSON_KEYS} for x in out["lessons"] if isinstance(x, dict)]
    return out


def _case(root: Path, batch_id) -> dict | None:
    if not isinstance(batch_id, str) or not batch_id or "/" in batch_id or "\\" in batch_id or batch_id.startswith("."):
        return None
    path = root / batch_id / "case" / "case.json"
    try:
        return json.loads(path.read_text()) if path.is_file() else None
    except (OSError, ValueError):
        return None


def reports(roots: list[tuple[Path, bool]], approved: list[dict] | None = None) -> list[dict]:
    """Every `<root>/_foolrate/*.json`, newest first, each `{id, fixture, ...the table}` with only the listed keys.

    `roots` is `[(folder, is_fixture)]`: the local batches folder, then the committed fixtures (a report there replays
    without keys). A report written before its rows carried `usd` or its table carried `lessons` gets them from its
    batches' case files when they are on disk, and the lessons' rules from the approved SKILL.md files (`approved`)."""
    if approved is None:
        from . import lessons as lessons_mod

        approved = lessons_mod.approved()
    out, seen = [], set()
    for root, is_fixture in roots:
        folder = root / "_foolrate"
        for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
            if path.stem in seen:
                continue
            try:
                raw = json.loads(path.read_text())
            except (OSError, ValueError):
                continue  # a report that cannot be read is left out
            if not isinstance(raw, dict) or not isinstance(raw.get("rows"), list):
                continue
            seen.add(path.stem)
            rep = _clean(raw)
            names: list[str] = []
            for r in rep["rows"]:
                case = _case(root, r.get("batch_id"))
                if "usd" not in r:
                    r["usd"] = case_usd(case)
                if r.get("setting") == "learned" and case:
                    for run in (case.get("runs") or {}).values():
                        for n in ((run or {}).get("lessons") or {}).get("names") or []:
                            if n not in names:
                                names.append(n)
            if "lessons" not in rep and "learned" in [r.get("setting") for r in rep["rows"]]:
                rep["lessons"] = lessons_for(names, approved)
            out.append({"id": path.stem, "fixture": is_fixture, **rep})
    out.sort(key=lambda r: (str(r.get("created_at") or ""), r["id"]), reverse=True)
    return out
