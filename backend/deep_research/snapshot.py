"""Build the Daytona snapshot once: `python -m deep_research.snapshot`."""

import os

from dotenv import load_dotenv

from .sandboxes import build_snapshot

if __name__ == "__main__":
    load_dotenv()
    build_snapshot(os.getenv("DAYTONA_SNAPSHOT", "deep-research-lab"))
