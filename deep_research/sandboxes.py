"""Daytona helpers: create VMs, load the task, run the lab page, fork, and replay actions.

All functions here are blocking. Call them with `asyncio.to_thread` from async code.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from daytona import (
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    CreateSnapshotParams,
    Daytona,
    Image,
    Sandbox,
    SessionExecuteRequest,
)
from langchain_daytona import DaytonaSandbox

from .analysis import Action
from .config import ROOT_DIR, LAB_PAGE_PORT, VM_LIVE_DIR, VM_WORKSPACE
from .task import OUTPUT_FILES, TaskFiles

log = logging.getLogger(__name__)

LAB_PAGE_SRC = ROOT_DIR / "lab_page" / "server.py"
LAB_PAGE_VM = "/home/daytona/lab_page.py"
PY_PACKAGES = ["pandas", "scikit-learn", "matplotlib"]

# A batch deletes each VM as soon as its run is scored (`delete_vm`), so nothing keeps billing.
# These are the safety net for a VM that leaks anyway (a crash, a killed server): it stops after
# this many idle minutes, and a stopped VM is deleted right away (0), which also frees its disk.
AUTO_STOP_MINUTES = 30
AUTO_DELETE_MINUTES = 0

_client: Daytona | None = None


def client() -> Daytona:
    global _client
    if _client is None:
        _client = Daytona()  # reads DAYTONA_API_KEY from the environment
    return _client


def lab_image() -> Image:
    return Image.debian_slim("3.12").pip_install(PY_PACKAGES)


def build_snapshot(name: str) -> None:
    """One-time: bake the Python packages into a snapshot so VMs start fast."""
    client().snapshot.create(CreateSnapshotParams(name=name, image=lab_image()), on_logs=print)


def create_vm(label: str) -> Sandbox:
    snapshot = os.getenv("DAYTONA_SNAPSHOT")
    labels = {"app": "deep-research", "run": label}
    lifetimes = {"auto_stop_interval": AUTO_STOP_MINUTES, "auto_delete_interval": AUTO_DELETE_MINUTES}
    if snapshot:
        params = CreateSandboxFromSnapshotParams(snapshot=snapshot, labels=labels, **lifetimes)
    else:
        # Slower: builds the image on first use.
        params = CreateSandboxFromImageParams(image=lab_image(), labels=labels, **lifetimes)
    return client().create(params, timeout=300)


def load_task(sb: Sandbox, task: TaskFiles) -> None:
    """Copy the task files the agent may see. Never the holdout labels."""
    sb.process.exec(f"mkdir -p {VM_LIVE_DIR}")
    sb.fs.upload_file(task.data.read_bytes(), f"{VM_WORKSPACE}/data.csv")
    sb.fs.upload_file(task.holdout_features.read_bytes(), f"{VM_WORKSPACE}/holdout_features.csv")
    if task.script.is_file():
        sb.fs.upload_file(task.script.read_bytes(), f"{VM_WORKSPACE}/{task.script.name}")


def start_lab_page(sb: Sandbox) -> str:
    """Start the lab page server in the VM and return a signed URL for the UI."""
    sb.fs.upload_file(LAB_PAGE_SRC.read_bytes(), LAB_PAGE_VM)
    session = "lab-page"
    try:
        sb.process.create_session(session)
    except Exception:  # noqa: BLE001 - a fork may already have the session id
        pass
    sb.process.execute_session_command(
        session,
        SessionExecuteRequest(command=f"python3 {LAB_PAGE_VM} {VM_WORKSPACE} {LAB_PAGE_PORT}", run_async=True),
    )
    return sb.create_signed_preview_url(LAB_PAGE_PORT, expires_in_seconds=6 * 3600).url


def download_outputs(sb: Sandbox, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name in OUTPUT_FILES:
        try:
            data = sb.fs.download_file(f"{VM_WORKSPACE}/{name}")
        except Exception:  # noqa: BLE001 - a missing file is scored as a failed run
            continue
        if data:
            (dest / name).write_bytes(data)


CHART_SUFFIXES = (".png", ".jpg", ".jpeg", ".svg")
MAX_CHARTS = 30


def download_charts(sb: Sandbox, dest: Path) -> list[str]:
    """Save the charts the agent drew in the live folder, so a finished batch still has them once the VM is gone.

    Returns the file names saved, oldest first. Never raises: charts are a nicety, not part of the score.
    """
    try:
        entries = [e for e in sb.fs.list_files(VM_LIVE_DIR) if not e.is_dir and e.name.lower().endswith(CHART_SUFFIXES)]
    except Exception as e:  # noqa: BLE001 - no live folder
        log.warning("listing %s failed: %r", VM_LIVE_DIR, e)
        return []
    entries.sort(key=lambda e: str(getattr(e, "mod_time", "") or ""))
    saved: list[str] = []
    for e in entries[:MAX_CHARTS]:
        name = Path(e.name).name
        try:
            data = sb.fs.download_file(f"{VM_LIVE_DIR}/{name}")
        except Exception as e:  # noqa: BLE001
            log.warning("downloading chart %s failed: %r", name, e)
            continue
        if data:
            dest.mkdir(parents=True, exist_ok=True)
            (dest / name).write_bytes(data)
            saved.append(name)
    return saved


def replay_actions(sb: Sandbox, actions: list[Action]) -> None:
    """Rebuild a VM's files by re-running the agent's file and shell actions. No model calls."""
    backend = DaytonaSandbox(sandbox=sb)
    for a in actions:
        args = a.args
        if a.tool == "execute":
            backend.execute(args["command"])
        elif a.tool == "write_file":
            backend.write(args["file_path"], args.get("content", ""))
        elif a.tool == "edit_file":
            backend.edit(args["file_path"], args["old_string"], args["new_string"], args.get("replace_all", False))
        elif a.tool == "delete":
            backend.delete(args["file_path"])


def fork_vm(sb: Sandbox, name: str | None = None) -> Sandbox:
    """Copy-on-write clone of the VM's disk. Processes do not carry over."""
    vm = sb.fork(name=name, timeout=120)
    # The SDK does not say whether a fork keeps its source's lifetimes, so set them.
    try:
        vm.set_autostop_interval(AUTO_STOP_MINUTES)
        vm.set_auto_delete_interval(AUTO_DELETE_MINUTES)
    except Exception:  # noqa: BLE001 - the VM is still usable, and Batch.close() stops it
        pass
    return vm


def running_vms() -> list[Sandbox]:
    """Every started VM this app made on the account, from any machine sharing the key."""
    return [
        s for s in client().list()
        if (s.labels or {}).get("app") == "deep-research" and str(s.state).rsplit(".", 1)[-1].upper() == "STARTED"
    ]


def stop_all_vms() -> tuple[int, int]:
    """Stop every running deep-research VM on the account. Returns (stopped, failed)."""
    from concurrent.futures import ThreadPoolExecutor

    def stop(sb: Sandbox) -> bool:
        try:
            sb.stop()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("stopping %s failed: %r", sb.id, e)
            return False

    vms = running_vms()
    with ThreadPoolExecutor(16) as ex:
        results = list(ex.map(stop, vms))
    return sum(results), len(results) - sum(results)


def delete_vm(sb: Sandbox) -> None:
    """Delete the VM: it stops billing for compute and for disk. Falls back to stopping it."""
    for attempt in range(4):
        try:
            sb.delete(timeout=120)
            return
        except Exception as e:  # noqa: BLE001
            # "state change in progress": the VM is starting or stopping. Wait and try again.
            if "in progress" not in str(e) or attempt == 3:
                break
            time.sleep(5)
    stop_vm(sb)  # with AUTO_DELETE_MINUTES = 0 a stopped VM is deleted by Daytona


def stop_vm(sb: Sandbox) -> None:
    try:
        # By keyword: the SDK applies its stop timeout only when it is passed that way, and without
        # one a VM stuck in "stopping" would hang the whole batch.
        sb.stop(timeout=60)
    except Exception:  # noqa: BLE001
        pass
