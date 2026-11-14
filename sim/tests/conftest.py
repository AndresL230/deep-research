"""The sim tests need the panda assets, which are downloaded, not committed (sim/fetch_assets.py)."""

import pytest

from sim import fetch_assets


@pytest.fixture(autouse=True, scope="session")
def _panda_assets():
    missing = fetch_assets.missing_files()
    if missing:
        pytest.exit(
            f"{len(missing)} panda asset files are missing from sim/assets/: run `python -m sim.fetch_assets` first",
            returncode=1,
        )
