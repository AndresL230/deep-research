"""Check the robot sim in a Daytona VM: build the image, run one practice episode, fetch its motion file.

    python -m sim.daytona_check [--out PATH]

Reads DAYTONA_API_KEY from the environment or `.env`; without it, prints why it skipped and exits 0.
Builds the image (which downloads the panda assets, see `sim/fetch_assets.py`), uploads the whitelisted
sim package (as `sim.domain.build_task` would) and `sim/controllers/baseline.py` as `baseline.py`, links
the image's assets in, runs `python3 -m sim.run` at the practice setup, downloads the motion file and prints
the result. The VM is deleted at the end, whatever happens.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from sim.domain import (
    SIM_DIR,
    VM_SETUP_COMMANDS,
    VM_WORKSPACE,
    lab_image,
    practice_setup,
    sim_package_files,
)

ROOT_DIR = SIM_DIR.parent
# The same lifetimes as `deep_research/sandboxes.py`: a leaked VM stops after 30 idle minutes and is
# then deleted.
AUTO_STOP_MINUTES = 30
AUTO_DELETE_MINUTES = 0
REMOTE_MOTION = "live/check.motion.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="daytona_check.motion.json", help="where to save the motion file locally")
    args = ap.parse_args(argv)

    load_dotenv(ROOT_DIR / ".env")
    if not os.getenv("DAYTONA_API_KEY"):
        print("Skipped: DAYTONA_API_KEY is not set (in the environment or .env), so no VM was created.")
        return 0

    from daytona import CreateSandboxFromImageParams, Daytona, FileUpload

    client = Daytona()
    params = CreateSandboxFromImageParams(
        image=lab_image(),
        labels={"app": "deep-research", "run": "sim-check"},
        auto_stop_interval=AUTO_STOP_MINUTES,
        auto_delete_interval=AUTO_DELETE_MINUTES,
    )
    t0 = time.time()
    print("Creating a VM from the robot lab image (the first build can take several minutes)...")
    sb = client.create(params, timeout=900, on_snapshot_create_logs=lambda line: print("  " + line.rstrip()))
    try:
        print(f"VM {sb.id} ready after {time.time() - t0:.0f}s")

        files = sim_package_files()
        files.append((SIM_DIR / "controllers" / "baseline.py", "baseline.py"))
        sb.process.exec(f"mkdir -p {VM_WORKSPACE}/live")
        for cmd in VM_SETUP_COMMANDS:
            r = sb.process.exec(cmd)
            if r.exit_code != 0:
                print(f"VM setup failed ({cmd}): {r.result}")
                return 1
        t1 = time.time()
        sb.fs.upload_files([FileUpload(source=p.read_bytes(), destination=f"{VM_WORKSPACE}/{rel}") for p, rel in files])
        print(f"Uploaded {len(files)} files in {time.time() - t1:.0f}s")

        practice = practice_setup()
        can = ",".join(str(v) for v in practice["can_xy"])
        place = ",".join(str(v) for v in practice["place_xy"])
        cmd = f"python3 -m sim.run --controller baseline.py --can {can} --place {place} --out {REMOTE_MOTION}"
        print(f"$ {cmd}")
        t2 = time.time()
        r = sb.process.exec(cmd, cwd=VM_WORKSPACE, timeout=600)
        print(f"exit code {r.exit_code} after {time.time() - t2:.0f}s")
        print(r.result)
        if r.exit_code != 0:
            return 1

        data = sb.fs.download_file(f"{VM_WORKSPACE}/{REMOTE_MOTION}")
        if not data:
            print("The motion file is missing or empty.")
            return 1
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"Saved the motion file ({len(data)} bytes) to {out.resolve()}")
        try:
            # The result is the JSON object at the end of the output (stderr may come before it).
            result = json.loads(r.result[r.result.index("{"):])
            print(f"success: {result.get('success')}, place error: {result.get('place_error_cm')} cm")
        except Exception:  # noqa: BLE001 - the raw output is printed above
            pass
        return 0
    finally:
        try:
            sb.delete(timeout=120)
            print(f"Deleted VM {sb.id}")
        except Exception as e:  # noqa: BLE001
            print(f"Deleting VM {sb.id} failed ({e!r}); stopping it instead. It is deleted once stopped.")
            try:
                sb.stop(timeout=60)
            except Exception:  # noqa: BLE001
                print("Stopping failed too: delete it from the Daytona dashboard.")


if __name__ == "__main__":
    sys.exit(main())
