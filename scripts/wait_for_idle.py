"""Hold a deploy while the server runs a batch (.github/workflows/fly-deploy.yml).

A deploy restarts the machine, and a restart kills the batches it is running: their agents, their scoring and their
investigator stop mid-way (the server closes them as stopped when it starts again, batch.recover_interrupted). This
waits until no live batch is in a working phase, polling the server's public batch list, then exits 0 so the deploy
goes ahead. A live batch that waits on a person (`ready`, `awaiting_approval`) does not hold it: both survive a
restart. After `--max-wait` seconds it exits 1, naming the batches still working.

    python scripts/wait_for_idle.py --url https://orrolab.dev [--max-wait 5400] [--every 60]

A server that cannot be reached does not hold a deploy (exit 0 with a warning): a deploy may be what brings it back.
Standard library only: it runs before anything is installed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

# The phases in which a live batch has work running (batch.WORKING_PHASES without the two that wait on a person).
WORKING = ("config", "running", "analyzing", "investigating", "forking", "forked")


def working(batches: list[dict]) -> list[str]:
    """The live batches with work running, as "id (phase)"."""
    out = []
    for b in batches:
        phase = str((b.get("summary") or {}).get("phase") or "")
        if b.get("kind") == "live" and phase in WORKING:
            out.append(f"{b.get('id')} ({phase})")
    return out


def fetch(url: str, timeout: float = 30) -> list[dict]:
    req = urllib.request.Request(f"{url.rstrip('/')}/api/batches", headers={"User-Agent": "orro-deploy-hold"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - the URL is the workflow's own setting
        return json.loads(r.read())


def main(argv: list[str] | None = None, sleep=time.sleep, now=time.monotonic, get=fetch) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", required=True)
    p.add_argument("--max-wait", type=float, default=90 * 60, help="seconds to wait before giving up (default 90 min)")
    p.add_argument("--every", type=float, default=60, help="seconds between checks (default 60)")
    a = p.parse_args(argv)
    start = now()
    while True:
        try:
            busy = working(get(a.url))
        except Exception as e:  # noqa: BLE001 - unreachable, or not JSON: never hold a deploy on it
            print(f"::warning::could not read {a.url}/api/batches ({e}); deploying without waiting")
            return 0
        if not busy:
            print("no batch is running; deploying")
            return 0
        waited = now() - start
        if waited >= a.max_wait:
            print(f"::error::still running after {waited / 60:.0f} min: {', '.join(busy)}. A deploy now would stop "
                  "them. Run the workflow again when they finish, or by hand with force to deploy anyway.")
            return 1
        print(f"waiting for {len(busy)} running batch(es): {', '.join(busy)} ({waited / 60:.0f} min so far)")
        sys.stdout.flush()
        sleep(a.every)


if __name__ == "__main__":
    sys.exit(main())
