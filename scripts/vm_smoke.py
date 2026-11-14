"""Check the Daytona side of a real run on one VM, with no model calls. About two minutes, under a cent.

    uv run python scripts/vm_smoke.py              # needs DAYTONA_API_KEY in .env
    uv run python scripts/vm_smoke.py --no-fork

It answers, before any tokens are spent: does the snapshot exist; where do commands start and can the
workspace be written; do the commands a real analyst sends (heredocs) work; are pandas, scikit-learn and
matplotlib there; does the forced dedupe step run; does the lab page answer through its signed URL; and
can a VM be forked: how fast, two at once, with which lifetimes, and with or without its processes.

It uses the same helpers a batch uses (`deep_research.sandboxes`). Every VM it creates is deleted at the
end, even when a check fails. It never prints a key or a signed URL.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import httpx  # noqa: E402
from langchain_daytona import DaytonaSandbox  # noqa: E402

from deep_research import sandboxes  # noqa: E402
from deep_research.config import VM_WORKSPACE, BatchConfig  # noqa: E402
from deep_research.forks import INTERVENTIONS  # noqa: E402
from deep_research.task import build_task  # noqa: E402

RESULTS: list[tuple[str, bool | None, str]] = []


def note(name: str, ok: bool | None, detail: str = "") -> None:
    """Record one check. `ok` None means information, not a pass or a fail."""
    RESULTS.append((name, ok, detail))
    mark = {True: " ok ", False: "FAIL", None: "info"}[ok]
    print(f"[{mark}] {name}: {detail}", flush=True)


def attempt(name: str, fn):
    """Run one check. A raised error is recorded as a failure and the rest still run."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - the point is to see what fails and keep going
        note(name, False, f"{type(e).__name__}: {str(e)[:300]}")
        return None


def run(backend: DaytonaSandbox, command: str, timeout: int | None = None) -> tuple[int | None, str]:
    res = backend.execute(command, timeout=timeout)
    return res.exit_code, (res.output or "").strip()


def state_of(obj) -> str:
    s = getattr(obj, "state", None)
    return str(getattr(s, "value", s)).lower()


def check_snapshot() -> bool:
    name = os.getenv("DAYTONA_SNAPSHOT")
    if not name:
        note("snapshot", None, "DAYTONA_SNAPSHOT is not set: VMs build the image on first use, which is slow")
        return True
    try:
        snap = sandboxes.client().snapshot.get(name)
    except Exception as e:  # noqa: BLE001
        note("snapshot", False, f"{name}: {type(e).__name__}: {str(e)[:200]}. "
                                "If it does not exist, build it once: uv run python -m deep_research.snapshot")
        return False
    ok = state_of(snap) == "active"
    note("snapshot", ok, f"{name} is {state_of(snap)}")
    return ok


def check_commands(sb, backend: DaytonaSandbox, tmp: Path) -> None:
    code, out = run(backend, "whoami; echo HOME=$HOME; pwd")
    note("where commands start", code == 0, out.replace("\n", ", "))

    task = build_task(BatchConfig(), tmp / "task")
    sandboxes.load_task(sb, task)
    code, out = run(backend, f"ls {VM_WORKSPACE}")
    files = set(out.split())
    note("task files in the workspace", {"data.csv", "holdout_features.csv", "live"} <= files, " ".join(sorted(files)))
    note("holdout labels are not in the VM", "holdout_labels.csv" not in files, "checked the workspace listing")

    _, first = run(backend, "cd /tmp && pwd")
    _, second = run(backend, "pwd")
    note("a cd does not carry to the next command", None, f"after `cd /tmp`: next command starts in {second!r}"
         + ("" if second != first else " (it DID carry over)"))

    script = (f"cd {VM_WORKSPACE} && cat > smoke.py <<'EOF'\n"
              "import pandas, sklearn, matplotlib\n"
              "print('packages ok', pandas.__version__, sklearn.__version__, matplotlib.__version__)\n"
              "EOF\npython3 smoke.py")
    t0 = time.monotonic()
    code, out = run(backend, script)
    note("a script written with a heredoc runs", code == 0 and "packages ok" in out,
         f"exit {code}, {time.monotonic() - t0:.1f}s, {out[-120:]!r}")

    code, out = run(backend, "python3 - <<'EOF'\nprint('heredoc end ok')\nEOF", timeout=30)
    note("a command that ends on a heredoc terminator returns", code == 0 and "heredoc end ok" in out,
         f"exit {code}, {out[-80:]!r}")

    fit = (f"cd {VM_WORKSPACE} && python3 -c \"import pandas as pd; "
           "from sklearn.ensemble import RandomForestClassifier as R; d = pd.read_csv('data.csv'); "
           "R(n_estimators=300, random_state=0).fit(d.drop(columns='outcome'), d['outcome']); print('fit ok', len(d))\"")
    t0 = time.monotonic()
    code, out = run(backend, fit)
    note("a 300-tree random forest trains", code == 0 and "fit ok" in out, f"exit {code}, {time.monotonic() - t0:.1f}s, {out[-60:]!r}")

    code, out = run(backend, INTERVENTIONS["deduplicate"]["command"])
    note("the forced dedupe step runs", code == 0 and "Removed" in out, f"exit {code}, {out[-120:]!r}")

    data = sb.fs.download_file(f"{VM_WORKSPACE}/data.csv")
    note("a file downloads", bool(data), f"data.csv, {len(data)} bytes")
    try:
        sb.fs.download_file(f"{VM_WORKSPACE}/no_such_file.json")
        note("a missing file raises", False, "no error for a file that does not exist")
    except Exception as e:  # noqa: BLE001
        note("a missing file raises", True, type(e).__name__)


def check_lab_page(sb) -> None:
    url = sandboxes.start_lab_page(sb)
    base, _, query = url.partition("?")
    target = f"{base.rstrip('/')}/state.json" + (f"?{query}" if query else "")
    last = "no answer"
    for _ in range(15):
        try:
            res = httpx.get(target, headers={"X-Daytona-Skip-Preview-Warning": "true"}, timeout=10)
            last = f"HTTP {res.status_code}"
            if res.status_code == 200 and "charts" in res.json():
                note("the lab page answers through its signed URL", True, f"{urlsplit(base).hostname}, {last}")
                return
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
        time.sleep(1)
    note("the lab page answers through its signed URL", False, last)


def check_fork(sb, label: str, created: list) -> None:
    t0 = time.monotonic()
    try:
        child = sandboxes.fork_vm(sb, f"{label}-fork-1")
    except Exception as e:  # noqa: BLE001
        note("a VM can be forked", False, f"{type(e).__name__}: {str(e)[:300]}. A batch would rebuild each copy by replay.")
        return
    created.append(child)
    note("a VM can be forked", True, f"{time.monotonic() - t0:.1f}s, state {state_of(child)}")

    attempt("fork lifetimes", lambda: (
        child.refresh_data(),
        note("fork lifetimes", None, f"auto-stop {getattr(child, 'auto_stop_interval', '?')} min, "
                                     f"auto-delete {getattr(child, 'auto_delete_interval', '?')} min"),
    ))
    fork_backend = DaytonaSandbox(sandbox=child, timeout=120)
    _, base_rows = run(DaytonaSandbox(sandbox=sb, timeout=120), f"wc -l < {VM_WORKSPACE}/data.csv")
    code, fork_rows = run(fork_backend, f"wc -l < {VM_WORKSPACE}/data.csv")
    note("the fork has the base VM's files as they were", code == 0 and fork_rows == base_rows,
         f"data.csv lines: base {base_rows}, fork {fork_rows}")
    probe = ("python3 -c \"import urllib.request as u; "
             "print('lab page up', u.urlopen('http://localhost:8080/state.json', timeout=3).status)\"")
    code, out = run(fork_backend, probe, timeout=30)
    note("processes carry over to a fork", None, "yes, the lab page is still serving" if "lab page up 200" in out
         else "no, only the disk is copied (the lab page is not running in the fork)")

    outcome: dict[str, str] = {}

    def fork_one(i: int) -> None:
        try:
            t = time.monotonic()
            vm = sandboxes.fork_vm(sb, f"{label}-fork-p{i}")
            created.append(vm)
            outcome[f"p{i}"] = f"ok in {time.monotonic() - t:.1f}s"
        except Exception as e:  # noqa: BLE001
            outcome[f"p{i}"] = f"{type(e).__name__}: {str(e)[:160]}"

    threads = [threading.Thread(target=fork_one, args=(i,)) for i in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    note("two forks of one VM at the same time", all(v.startswith("ok") for v in outcome.values()),
         "; ".join(f"{k}: {v}" for k, v in sorted(outcome.items())))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--no-fork", action="store_true", help="skip the fork checks")
    a = p.parse_args()
    if not os.environ.get("DAYTONA_API_KEY", "").strip():
        raise SystemExit("DAYTONA_API_KEY is not set. Add it to .env first.")

    if not check_snapshot():
        raise SystemExit(1)
    label = "smoke-" + time.strftime("%m%d-%H%M%S")
    created: list = []
    try:
        t0 = time.monotonic()
        sb = attempt("a VM starts", lambda: sandboxes.create_vm(label))
        if sb is None:
            raise SystemExit(1)
        created.append(sb)
        note("a VM starts", True, f"{time.monotonic() - t0:.1f}s, user {getattr(sb, 'user', '?')}, "
                                  f"{getattr(sb, 'cpu', '?')} vCPU, {getattr(sb, 'memory', '?')} GiB RAM, "
                                  f"{getattr(sb, 'disk', '?')} GiB disk, snapshot {getattr(sb, 'snapshot', '?')}")
        backend = DaytonaSandbox(sandbox=sb, timeout=120)
        with tempfile.TemporaryDirectory() as tmp:
            attempt("commands", lambda: check_commands(sb, backend, Path(tmp)))
        attempt("the lab page answers through its signed URL", lambda: check_lab_page(sb))
        if not a.no_fork:
            attempt("fork", lambda: check_fork(sb, label, created))
    finally:
        deleted = 0
        for vm in created:
            try:
                vm.delete(timeout=60)
                deleted += 1
            except Exception as e:  # noqa: BLE001
                print(f"could not delete VM {getattr(vm, 'id', '?')}: {type(e).__name__}: {str(e)[:200]}", flush=True)
        note("cleanup", deleted == len(created), f"deleted {deleted} of {len(created)} VMs")

    failed = [name for name, ok, _ in RESULTS if ok is False]
    print(f"\n{len(RESULTS) - len(failed)} of {len(RESULTS)} lines without a failure" + (f"; FAILED: {', '.join(failed)}" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
