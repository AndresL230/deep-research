"""Daytona helpers: create VMs, load the task, run the lab page, fork, and replay actions.

All functions here are blocking. Call them with `asyncio.to_thread` from async code.
"""

from __future__ import annotations

import os
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

LAB_PAGE_SRC = ROOT_DIR / "lab_page" / "server.py"
LAB_PAGE_VM = "/home/daytona/lab_page.py"
PY_PACKAGES = ["pandas", "scikit-learn", "matplotlib"]

# Safety net for leaked VMs. A VM stops after this many idle minutes, and a
# stopped VM is deleted this many minutes later. A batch starts 12+ VMs plus
# forks, so one that is never cleaned up would otherwise keep billing for disk.
AUTO_STOP_MINUTES = 60
AUTO_DELETE_MINUTES = 60

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
    except Exception:  # noqa: BLE001 - no live folder
        return []
    entries.sort(key=lambda e: str(getattr(e, "mod_time", "") or ""))
    saved: list[str] = []
    for e in entries[:MAX_CHARTS]:
        name = Path(e.name).name
        try:
            data = sb.fs.download_file(f"{VM_LIVE_DIR}/{name}")
        except Exception:  # noqa: BLE001
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


def stop_vm(sb: Sandbox) -> None:
    try:
        sb.stop()
    except Exception:  # noqa: BLE001
        pass
