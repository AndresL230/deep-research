"""Check the master plan's invariants (docs/MASTER_PLAN.md sections 3 and 8.1) on every saved batch. No keys, no VMs.

    uv run python scripts/check_invariants.py [--batches DIR ...]

Checks the committed fixtures, the local `batches/` folder when there is one, and any `--batches` folder given. Exits
1 and lists every failure when:

- a banned key (MASTER_PLAN 6.2) is in what the investigator can read: its case file view, any file under `/runs/` it
  is not denied, the skills, its notebooks under `/memory/`, the casebook under `/memories/`, or any other route its
  backend mounts; or its read denies under `/runs/` no longer cover score.json and the hidden folders;
- `holdout_labels` is reachable through any API route (every GET route FastAPI has, each path parameter filled in and
  the file routes probed with every spelling) or any agent route (every route of the investigator's backend, found by
  building one, and every file given to the analyst's VM);
- a fork has a changed copy (any arm but control) and no control copy;
- something is `supported` with a running score under 20: a verdict, a method fork, or a method hypothesis whose
  experiment's score is under 20 (all read the way the server reads them, `case_file.with_evidence`);
- a suspect's status disagrees with `evidence.<id>` under the running-score rule (the ledger's level is not its
  score's, or the status is not the level), a `cleared` suspect has fewer than 5 counted pairs (pairs whose control
  copy reproduced the effect), or `verdict.supported` names a suspect whose ledger score is under 20;
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
from deep_research.evidence import NEEDED_PAIRS, SUPPORTED_SCORE, fork_pairs, score_level  # noqa: E402

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
    # 4b. a suspect's status follows its ledger, `evidence.<id>`, under the running-score rule (plan 6.4): the level is
    # the score's, and the status is the level (or `testing` while one of its experiments is still running).
    ledger = case.get("evidence") or {}
    for s in case.get("suspects") or []:
        if not isinstance(s, dict):
            continue
        sid, status = s.get("id"), s.get("status")
        ev = ledger.get(sid) if isinstance(ledger.get(sid), dict) else None
        if ev is None:
            if status in ("supported", "cleared"):
                fail(name, f"suspect {sid} is {status} with no evidence.{sid} behind it")
            continue
        score, n_pairs = float(ev.get("score") or 0), int(ev.get("pairs") or 0)
        level = score_level(score, n_pairs)
        # `inconclusive` is the open level of a ledger with no counted pair (no control copy reproduced the effect).
        if ev.get("level") != level and not (ev.get("level") == "inconclusive" and n_pairs == 0):
            fail(name, f"evidence.{sid} says {ev.get('level')}, but a score of {score:g} over {n_pairs} pairs is {level}")
        # A cleared suspect needs NEEDED_PAIRS counted pairs in its ledger (since the control-must-reproduce fix, only
        # pairs whose control copy reproduced the effect are counted). A recording saved before that fix keeps its
        # ledger; when today's rule (evidence.pair_up) would count fewer of its pairs, that is printed, not failed.
        if status == "cleared":
            if n_pairs < NEEDED_PAIRS:
                fail(name, f"suspect {sid} is cleared on {n_pairs} counted pairs (cleared needs {NEEDED_PAIRS})")
            recount = sum(len(fork_pairs(f) if fork_pairs(f) is not None else (f.get("pairs") or []))
                          for fid, f in forks.items() if fid != "pending" and isinstance(f, dict)
                          and f.get("suspect_id") == sid and f.get("status") == "done")
            if recount < NEEDED_PAIRS:
                print(f"check_invariants: note: {name}: suspect {sid} was cleared on {n_pairs} pairs; today's rule "
                      f"counts {recount} (a control copy did not reproduce the inflation). Recorded data, kept as is.")
        running = any(isinstance(f, dict) and f.get("suspect_id") == sid and f.get("status") not in ("done", "failed")
                      for fid, f in forks.items() if fid != "pending")
        if status != level and (status in ("supported", "cleared") or level != "open") \
                and not (status == "testing" and running):
            fail(name, f"suspect {sid} is {status}, but its evidence (score {score:g}, {n_pairs} pairs) is {level}")
    # 4c. a verdict names no suspect as supported whose ledger score is under 20
    if isinstance(v, dict):
        for sid in v.get("supported") or []:
            score = float((ledger.get(sid) or {}).get("score") or 0) if isinstance(ledger.get(sid), dict) else 0.0
            if score < SUPPORTED_SCORE:
                fail(name, f"verdict.supported names {sid}, whose ledger score is {score:g} (under {SUPPORTED_SCORE:g})")
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


def investigator_routes() -> list[tuple[str, str, Path]]:
    """Every route the investigator's backend mounts (`build_investigator`'s CompositeBackend), found by building one
    for a throwaway batch, so a route added later is checked without editing this script. Each as
    `(prefix, anchor, path)`: anchor `batch` (path under the batch folder), `root` (under the batches folder) or
    `abs`. Also the files the analyst's VM is given (`Domain.upload_files`), as the route `vm:`."""
    import os
    import tempfile

    from deep_research.agents import investigator as inv
    from deep_research.batch import Batch
    from deep_research.config import BatchConfig

    os.environ.setdefault("ANTHROPIC_API_KEY", "dummy")  # nothing calls a model: the agent is never built
    seen: dict = {}
    real = inv.create_deep_agent
    inv.create_deep_agent = lambda *a, **kw: seen.update(kw)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            b = Batch(BatchConfig(), batch_id="0000-000000-rout", root=root)
            inv.build_investigator(b, "unused")
            out = []
            for prefix, backend in seen["backend"].routes.items():
                path = Path(getattr(backend, "cwd")).resolve()
                if path.is_relative_to(b.dir.resolve()):
                    out.append((prefix, "batch", path.relative_to(b.dir.resolve())))
                elif path.is_relative_to(root):
                    out.append((prefix, "root", path.relative_to(root)))
                else:
                    out.append((prefix, "abs", path))
            for local, remote in b.domain.upload_files(b.task):
                out.append((f"vm:{remote}", "batch", Path(local).resolve().relative_to(b.dir.resolve())))
            return out
    finally:
        inv.create_deep_agent = real


def check_agent_routes(name: str, batch_dir: Path, routes: list[tuple[str, str, Path]], fail) -> None:
    """No file under any investigator route, and no file given to the analyst's VM, is or names the holdout labels or
    holds a banned key written as a key. `/runs/` keeps its read denies (score.json); `/skills/` is checked once."""
    for prefix, anchor, rel in routes:
        if anchor == "abs" or prefix == "/runs/":
            continue  # the skills are checked once in main; /runs/ by check_runs_folder, with its denies
        base = (batch_dir / rel) if anchor == "batch" else (batch_dir.parent / rel)
        if prefix == "/memory/":
            base = base.parent  # the route mounts one domain's notebook; check every domain's
        files = [base] if base.is_file() else (sorted(p for p in base.rglob("*") if p.is_file()) if base.is_dir() else [])
        for f in files:
            where = f"{prefix} {f.name}"
            if "holdout_labels" in f.name.lower():
                fail(name, f"{where}: a holdout labels file on an agent route")
            if f.suffix not in TEXT_SUFFIXES or f.stat().st_size > MAX_BYTES or prefix.startswith("vm:"):
                continue
            text = f.read_text(errors="replace")
            m = QUOTED_KEY.search(text)
            if m:
                fail(name, f"{where}: banned key {m.group(1)} is readable by the investigator")
            if "holdout_labels" in text:
                fail(name, f"{where}: names holdout_labels on an agent route")


# A value for each path parameter of a GET route, by name. A new parameter makes the check fail until it is added.
def _route_values(param: str, case: dict) -> list[str] | None:
    runs = sorted(case.get("runs") or {}) or ["r01"]
    forks = [f for f in (case.get("forks") or {}) if f != "pending"] or ["f1"]
    children = sorted(((case.get("forks") or {}).get(forks[0]) or {}).get("children") or {}) or ["control-1"]
    probes = ["task/holdout_labels.csv", "task/HOLDOUT_LABELS.csv", "task/./holdout_labels.csv",
              "runs/../task/holdout_labels.csv", "holdout_labels.csv", "../task/holdout_labels.csv"]
    return {"run_id": runs[:1], "fork_id": forks[:1], "child": children[:1], "path": probes, "rest": probes,
            "domain": [(case.get("config") or {}).get("domain") or "tabular"]}.get(param)


def check_api(batch_ids: list[str], fail, app=None) -> None:
    """No GET route of the API (every one FastAPI has, enumerated) serves or names the holdout labels, for any batch
    the server lists, with each path parameter filled in, and the file routes probed with every spelling."""
    import itertools

    from fastapi.routing import APIRoute
    from fastapi.testclient import TestClient

    if app is None:
        from deep_research import api

        app = api.app
    routes = [r for r in app.routes if isinstance(r, APIRoute) and "GET" in r.methods]
    with TestClient(app) as client:
        for bid in batch_ids:
            case_path = FIXTURES_DIR / bid / "case" / "case.json"
            case = json.loads(case_path.read_text()) if case_path.is_file() else {}
            for route in routes:
                params = [p for p in route.param_convertors if p != "batch_id"]
                values = [_route_values(p, case) for p in params]
                if any(v is None for v in values):
                    fail("api", f"GET {route.path}: no probe for its parameter(s) {params}; add one to _route_values")
                    continue
                for combo in itertools.product(*values):
                    url = route.path.replace("{batch_id}", bid)
                    for p, val in zip(params, combo):
                        url = re.sub(r"\{%s(:[a-z]+)?\}" % p, val, url)
                    res = client.get(url)
                    if res.status_code != 200:
                        continue
                    # An API file route that answers a holdout-labels path has served it. (The web app's catch-all
                    # answers every path with its own page, which is checked like any other answer.)
                    served = "path" in params and route.path.startswith("/api/")
                    if served or "holdout_labels" in res.text:
                        fail(bid, f"GET {url} serves or names holdout_labels")


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
    routes = investigator_routes()
    prefixes = {p for p, _, _ in routes}
    for must in ("/case/", "/runs/", "/skills/", "/memory/", "/memories/"):
        if must not in prefixes:
            fail("investigator", f"route {must} was not found on the investigator's backend; the check is out of date")
    for folder, _ in folders:
        # The memories shared by every batch in the folder (the casebook, the notebooks), once per folder.
        check_agent_routes(folder.name, folder / "_routes_probe", [r for r in routes if r[1] == "root"], fail)
    for folder, is_fixture in folders:
        for case_path in sorted(folder.glob("*/case/case.json")):
            root = case_path.parent.parent
            if root.name.startswith("_"):
                continue
            n += 1
            if is_fixture:
                fixture_ids.append(root.name)
            check_case(root.name, root, json.loads(case_path.read_text()), sections, ev_fields, is_fixture, fail)
            check_agent_routes(root.name, root, [r for r in routes if r[1] == "batch"], fail)
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
