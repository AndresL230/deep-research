"""Build a domain's Daytona snapshot once.

    python -m deep_research.snapshot               # the tabular lab, named by DAYTONA_SNAPSHOT
    python -m deep_research.snapshot robot_arm     # another domain's lab, named by its `snapshot_env`
"""

import os
import sys

from dotenv import load_dotenv

from . import domains
from .sandboxes import build_snapshot

if __name__ == "__main__":
    load_dotenv()
    d = domains.get(sys.argv[1] if len(sys.argv) > 1 else None)
    default = "deep-research-lab" if d.name == domains.DEFAULT else f"deep-research-{d.name.replace('_', '-')}"
    build_snapshot(os.getenv(d.snapshot_env, default), d.name)
