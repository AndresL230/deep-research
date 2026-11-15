"""Check the master plan's invariants (docs/MASTER_PLAN.md sections 3 and 8.1) on every saved batch. No keys, no VMs.

    uv run python scripts/check_invariants.py [--batches DIR ...]

Checks the committed fixtures, the local `batches/` folder when there is one, and any `--batches` folder given. Exits
1 and lists every failure when:

- a banned key (MASTER_PLAN 6.2) is in what the investigator can read: its case file view, any file under `/runs/` it
  is not denied, or the skills; or its read denies under `/runs/` no longer cover score.json and the hidden folders;
- `holdout_labels` is reachable through an API route (the files and case routes) or an agent route (a file or text
  under a folder the investigator mounts);
- a fork has a changed copy (any arm but control) and no control copy;
- something is `supported` with a running score under 20: a verdict, a method fork, or a method hypothesis whose
  experiment's score is under 20 (all read the way the server reads them, `case_file.with_evidence`);
- a case section or field `docs/api-contract.md` lists is missing from a batch's case file;
- a simulated batch lacks its flag: every fixture is either `config.simulated` or a recording
  (`config.recording.kind = "live"`), and a batch whose costs say simulated is flagged simulated.

Known exception, on purpose: `split` stays in the investigator's view (docs/PLAN_STATUS.md).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deep_research import domains  # noqa: E402
from deep_research.agents.investigator import RUNS_READ_DENY  # noqa: E402
from deep_research.case_file import BANNED_VIEW_KEYS, investigator_view, with_evidence  # noqa: E402
from deep_research.config import FIXTURES_DIR  # noqa: E402
from deep_research.evidence import SUPPORTED_SCORE  # noqa: E402

CONTRACT = ROOT / "docs" / "api-contract.md"
# The sections `CaseFile.__init__` sets to their default when an older case file lacks them.
LOADED_DEFAULTS = ("trace", "fix", "trace_comparison", "rubric", "feed", "baseline")
# Text files under /runs/ worth reading for a banned key; bigger ones are skipped (motion files, data).
TEXT_SUFFIXES = {".json", ".jsonl", ".txt", ".md", ".py", ".log", ".csv"}
MAX_BYTES = 2_000_000
# In files under /runs/ and in skills, the banned keys that only the evaluator writes. `seed`, `audit` and
# `candidates` are banned as case file keys (config.seed, the sections); an analyst's own files use those words for
# their own things (an episode's seed), so they are checked in the view only.
FILE_BANNED = tuple(k for k in BANNED_VIEW_KEYS if k not in ("seed", "audit", "candidates"))
# A banned key as it would appear in JSON or Python source: "overlap_share": or 'overlap_share'.
QUOTED_KEY = re.compile(r"""["'](%s)["']\s*[:=]""" % "|".join(re.escape(k) for k in FILE_BANNED))


def keys(x) -> set[str]:
    if isinstance(x, dict):
        return set(x) | {k for v in x.values() for k in keys(v)}
    if isinstance(x, list):
        return {k for v in x for k in keys(v)}
    return set()


def contract_sections() -> list[str]:
    """The top-level case sections `docs/api-contract.md` lists under "## The case file" (`- \\`name\\`:` bullets)."""
    text = CONTRACT.read_text()
    part = text.split("## The case file", 1)[1].split("\n## ", 1)[0]
    return [m.group(1) for m in re.finditer(r"^- `([a-z_]+)`:", part, re.MULTILINE)]


def contract_evidence_fields() -> list[str]:
    """The verdict evidence fields the contract lists (`evidence` ... `{level, pairs, ...}`)."""
    text = CONTRACT.read_text()
    m = re.search(r"`evidence` \(`deep_research/evidence.py`,\s*`VerdictEvidence` in `web/src/api.ts`\): `\{([^}]*)\}`", text)
    return [f.strip() for f in m.group(1).replace("\n", " ").split(",")] if m else []


def denied(virtual: str) -> bool:
    return any(fnmatch.fnmatch(virtual, pat) or fnmatch.fnmatch(virtual, pat.replace("/**/", "/*/"))
               for pat in RUNS_READ_DENY)


def check_runs_folder(name: str, runs: Path, fail) -> None:
    for f in runs.rglob("*"):
        if not f.is_file():
            continue
        virtual = "/runs/" + f.relative_to(runs).as_posix()
        if "holdout_labels" in f.name.lower():
            fail(name, f"{virtual}: a holdout labels file under a folder the investigator mounts")
        if denied(virtual) or f.suffix not in TEXT_SUFFIXES or f.stat().st_size > MAX_BYTES:
            continue
        m = QUOTED_KEY.search(f.read_text(errors="replace"))
        if m:
            fail(name, f"{virtual}: banned key {m.group(1)} is readable by the investigator")


def check_case(name: str, root: Path, raw: dict, sections: list[str], ev_fields: list[str], is_fixture: bool,
               fail) -> None:
    case = with_evidence(json.loads(json.dumps(raw)))
    cfg = case.get("config") or {}

    # 1. the blind view, and the view file a saved batch keeps beside its case
    view = investigator_view(case)
    for k in sorted(keys(view) & set(BANNED_VIEW_KEYS)):
        fail(name, f"banned key {k} in the investigator's view")
    view_file = root / "case" / "view" / "case.json"
    if view_file.is_file():
        for k in sorted(keys(json.loads(view_file.read_text())) & set(BANNED_VIEW_KEYS)):
            fail(name, f"banned key {k} in the saved view case/view/case.json")
    if (root / "runs").is_dir():
        check_runs_folder(name, root / "runs", fail)

    # 2. holdout labels through an agent route: the view's text
    if "holdout_labels" in json.dumps(view):
        fail(name, "holdout_labels named in the investigator's view")

    # 3. every changed copy has a control copy
    for fid, fork in (case.get("forks") or {}).items():
        if fid == "pending" or not isinstance(fork, dict):
            continue
        arms = {(c.get("arm") or cid.rsplit("-", 1)[0]) for cid, c in (fork.get("children") or {}).items()
                if isinstance(c, dict)}
        if arms - {"control"} and "control" not in arms:
            fail(name, f"fork {fid} has changed copies ({sorted(arms)}) and no control copy")

    # 4. nothing supported under a score of 20
    v = case.get("verdict")
    if isinstance(v, dict) and (v.get("evidence") or {}).get("level") == "supported" \
            and float(v["evidence"].get("score") or 0) < SUPPORTED_SCORE:
        fail(name, f"verdict supported at a score of {v['evidence'].get('score')}")
    forks = case.get("forks") or {}
    for fid, fork in forks.items():
        if fid != "pending" and isinstance(fork, dict) and fork.get("level") == "supported" \
                and float(fork.get("score") or 0) < SUPPORTED_SCORE:
            fail(name, f"fork {fid} supported at a score of {fork.get('score')}")
    for h in case.get("hypotheses") or []:
        if not isinstance(h, dict) or h.get("status") != "supported":
            continue
        fork = forks.get(h.get("tested_by") or "")
        if isinstance(fork, dict) and fork.get("kind", "method") != "fix" \
                and float(fork.get("score") or 0) < SUPPORTED_SCORE:
            fail(name, f"hypothesis {h.get('id')} supported by fork {h.get('tested_by')} at a score of {fork.get('score')}")

    # 5. the contract's sections and the verdict's evidence fields. Sections added later are absent from older case
    # files and read as empty; `CaseFile` gives them their default on load (the contract says so for each).
    for s in sections:
        if s not in raw and s not in LOADED_DEFAULTS:
            fail(name, f"case section {s} (docs/api-contract.md) is missing")
    if isinstance(raw.get("verdict"), dict) and isinstance(case["verdict"].get("evidence"), dict):
        for f in ev_fields:
            if f not in case["verdict"]["evidence"]:
                fail(name, f"verdict evidence field {f} (docs/api-contract.md) is missing")

    # 6. simulated batches say so
    recorded_live = (cfg.get("recording") or {}).get("kind") == "live"
    if is_fixture and not cfg.get("simulated") and not recorded_live:
        fail(name, "a fixture is neither config.simulated nor a live recording")
    if (case.get("costs") or {}).get("simulated") and not cfg.get("simulated"):
        fail(name, "costs say simulated but config.simulated is not set")


def check_api(batch_ids: list[str], fail) -> None:
    """The files and case routes never serve holdout labels, by any spelling, for any batch the server lists."""
    from fastapi.testclient import TestClient

    from deep_research import api

    with TestClient(api.app) as client:
        for bid in batch_ids:
            for path in ("task/holdout_labels.csv", "task/HOLDOUT_LABELS.csv", "task/./holdout_labels.csv",
                         "runs/../task/holdout_labels.csv"):
                res = client.get(f"/api/batches/{bid}/files/{path}")
                if res.status_code == 200:
                    fail(bid, f"GET /api/batches/{bid}/files/{path} served the holdout labels")
            res = client.get(f"/api/batches/{bid}/case")
            if res.status_code == 200 and "holdout_labels" in res.text:
                fail(bid, f"GET /api/batches/{bid}/case names holdout_labels")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--batches", action="append", type=Path, default=[], help="another folder of saved batches")
    ap.add_argument("--no-api", action="store_true", help="skip the API route checks")
    args = ap.parse_args(argv)

    failures: list[str] = []

    def fail(name: str, why: str) -> None:
        failures.append(f"{name}: {why}")

    # The investigator's read denies under /runs/ still cover what they must.
    for probe in ("/runs/r01/score.json", "/runs/r01/hidden/00-s0.motion.json"):
        if not denied(probe):
            fail("investigator", f"{probe} is not denied to the investigator (RUNS_READ_DENY)")
    # The skills it reads: no banned key written as a key, no holdout labels.
    for d in domains.registered():
        skill = d.skills_dir / d.investigator_words.skill / "SKILL.md"
        text = skill.read_text()
        if QUOTED_KEY.search(text) or "holdout_labels" in text or "trap_info" in text:
            fail("skills", f"{skill.relative_to(ROOT)} names a banned key or holdout_labels")
        if any("holdout_labels" in p.name.lower() for p in d.skills_dir.rglob("*")):
            fail("skills", f"a holdout labels file under {d.skills_dir.relative_to(ROOT)}")

    sections = contract_sections()
    ev_fields = contract_evidence_fields()
    if not sections or not ev_fields:
        fail("contract", "could not read the case sections or the evidence fields from docs/api-contract.md")

    folders = [(FIXTURES_DIR, True)]
    local = ROOT / "batches"
    if local.is_dir():
        folders.append((local, False))
    folders += [(p, False) for p in args.batches]
    n = 0
    fixture_ids = []
    for folder, is_fixture in folders:
        for case_path in sorted(folder.glob("*/case/case.json")):
            root = case_path.parent.parent
            if root.name.startswith("_"):
                continue
            n += 1
            if is_fixture:
                fixture_ids.append(root.name)
            check_case(root.name, root, json.loads(case_path.read_text()), sections, ev_fields, is_fixture, fail)
    if not args.no_api:
        check_api(fixture_ids, fail)

    if failures:
        print(f"check_invariants: {len(failures)} failure(s) over {n} batches")
        for f in failures:
            print(f"  FAIL {f}")
        return 1
    print(f"check_invariants: ok, {n} batches, {len(sections)} contract sections, {len(ev_fields)} evidence fields")
    return 0


if __name__ == "__main__":
    sys.exit(main())
