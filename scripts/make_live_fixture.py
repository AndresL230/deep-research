"""Save a real, finished batch as a replayable fixture: the backup for a live demo.

    uv run python scripts/make_live_fixture.py <batch_id> <fixture_name> [--keep-motion 4] [--from DIR]

Unlike scripts/make_robot_fixture.py (a SIMULATED batch, `config.simulated = true`), nothing here is generated: every
file is copied from `batches/<batch_id>/`, as the real agents, VMs, evaluator and investigator left it. To keep the
fixture small enough for git, each run's and fork copy's own practice recordings (`outputs/live/*.motion.json`, which
can be hundreds of files) are cut to the newest `--keep-motion` the case lists. The cut is recorded in
`config.recording.trimmed`. Hidden-episode and trace recordings, events, messages, scores, code and reports are kept
whole. `config.recording` says the batch is a recording of a real run, where it came from and what was done to it
after it ran.

Never copied (MASTER_PLAN invariant 2, holdout labels never leave the server): the holdout labels and every domain's
secret files (`Domain.secret_files`), the investigator's LangGraph checkpoints (`checkpoints.sqlite`, its whole message
state, which the replay does not read), and any `.env`-like file. What was left out is listed in
`config.recording.excluded` (a secret file by its folder only). `--from` reads the batch from another `batches/` folder
(a worktree's own is empty).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import shutil
import time
from pathlib import Path

from deep_research import domains
from deep_research.config import BATCHES_DIR, ROOT_DIR

FIXTURES = ROOT_DIR / "fixtures"
# Never copied: the hidden truth, the investigator's checkpoints, and anything that could hold a key.
NEVER = ("checkpoints.sqlite*", ".env*", "*.env", "*secret*")


def is_secret(name: str) -> bool:
    return any(s.lower() in name.lower() for s in ("holdout_labels", *domains.secret_files()))


def never_copied(src: Path) -> list[str]:
    return sorted(p.relative_to(src).as_posix() for p in src.rglob("*") if p.is_file() and (
        is_secret(p.name) or any(fnmatch.fnmatch(p.name, pat) for pat in NEVER)))


def main(batch_id: str, name: str, keep: int, root: Path = BATCHES_DIR) -> None:
    src, dst = root / batch_id, FIXTURES / name
    if dst.exists():
        shutil.rmtree(dst)
    excluded = never_copied(src)
    skip = {src / e for e in excluded}
    shutil.copytree(src, dst, ignore=lambda d, names: {
        n for n in names if Path(d) / n in skip or n == "__pycache__" or n.endswith((".pyc", ".tmp"))})
    case_path = dst / "case" / "case.json"
    case = json.loads(case_path.read_text())
    assert not case["config"].get("simulated"), "this is for real batches only"
    trimmed = 0

    def trim(entry: dict) -> None:
        nonlocal trimmed
        files = entry.get("motion_files") or []
        keep_files = files[-keep:] if keep > 0 else []
        for rel in files:
            if rel not in keep_files:
                (dst / rel).unlink(missing_ok=True)
                trimmed += 1
        if files:
            entry["motion_files"] = keep_files
        # Practice recordings no case entry lists (the cap in batch.py) are not shown anywhere: drop them too.

    for r in case["runs"].values():
        trim(r)
    for f in case["forks"].values():
        for c in (f.get("children") or {}).values():
            trim(c)
    listed = {p for r in case["runs"].values() for p in r.get("motion_files") or []}
    listed |= {p for f in case["forks"].values() for c in (f.get("children") or {}).values() for p in c.get("motion_files") or []}
    for p in dst.glob("**/outputs/live/*.motion.json"):
        rel = p.relative_to(dst).as_posix()
        if rel not in listed:
            p.unlink()
            trimmed += 1
    case["config"]["recording"] = {
        "kind": "live",
        "source_batch": batch_id,
        "saved_at": time.strftime("%Y-%m-%d %H:%M %Z"),
        "note": "A recording of a real run: real agents in Daytona VMs, "
                + ("real MuJoCo scoring" if case["config"].get("domain") == "robot_arm" else "real scoring on the hidden holdout")
                + ", a real investigator. Nothing in it was generated or edited by hand.",
        "after_the_run": [s for s in (
            "fork copies whose server-side scoring failed were scored afterwards from their saved outputs "
            "(forks.<id>.rescored)" if any(f.get("rescored") for f in case["forks"].values()) else None,
            "a follow-up investigator session ran (sessions)" if case.get("sessions") else None,
        ) if s],
        "trimmed": f"{trimmed} practice recordings dropped to keep the fixture small; at most {keep} per run kept",
        # The secret files by folder only: their names must not appear in the case (scripts/check_invariants.py).
        "excluded": sorted({e if not is_secret(Path(e).name) else f"{Path(e).parent.as_posix()}/ (hidden truth)"
                            for e in excluded}),
    }
    case_path.write_text(json.dumps(case, indent=2, default=str))
    view = dst / "case" / "view" / "case.json"
    if view.exists():
        from deep_research.case_file import investigator_view

        view.write_text(json.dumps(investigator_view(case), indent=2, default=str))
    size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    print(f"fixtures/{name}: {size / 1e6:.1f} MB, {trimmed} practice recordings trimmed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("batch_id")
    ap.add_argument("name")
    ap.add_argument("--keep-motion", type=int, default=4)
    ap.add_argument("--from", dest="root", type=Path, default=BATCHES_DIR, help="the batches folder to read from")
    a = ap.parse_args()
    main(a.batch_id, a.name, a.keep_motion, a.root)
