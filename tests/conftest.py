"""Settings every test shares.

The tests never call a model, a VM or the team hub, but `api.py` and `cli.py` load the repo's `.env` when imported.
On a machine whose `.env` turns LangSmith tracing on, that tracing then wraps the scripted agents in the offline
tests and makes their runs fail. `load_dotenv` never overrides a variable that is already set, so setting these here,
before any test module is imported, keeps tracing off for the whole session.
"""

import os

import pytest

os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"


# The sim meshes are downloaded (`sim/assets/` is gitignored), so a fresh clone has none. A test that needs them is
# marked `needs_panda` or `needs_g1` and is skipped, with the command that fetches them, when they are absent.
MESH_SKIPS = {
    "needs_panda": ("franka_emika_panda", "the panda meshes are not downloaded: uv run python -m sim.fetch_assets"),
    "needs_g1": ("unitree_g1", "the G1 meshes are not downloaded: uv run python -m sim.fetch_assets --model unitree_g1"),
}


def mesh_missing(folder: str) -> bool:
    """Whether the sim model `folder` is not on disk (any of its files absent). Only presence is checked."""
    from sim.fetch_assets import DEFAULT_DEST, MODELS

    return any(not (DEFAULT_DEST / folder / rel).is_file() for rel in MODELS[folder])


def pytest_configure(config):
    for name, (_, why) in MESH_SKIPS.items():
        config.addinivalue_line("markers", f"{name}: skipped when {why.split(':')[0].removeprefix('the ')}")


def pytest_collection_modifyitems(config, items):
    for item in items:
        for name, (folder, why) in MESH_SKIPS.items():
            if item.get_closest_marker(name) and mesh_missing(folder):
                item.add_marker(pytest.mark.skip(reason=why))


@pytest.fixture(autouse=True)
def no_real_hub(monkeypatch):
    """Tests never talk to the team hub, even when this machine's .env points at it.

    Tests that need a hub set their own fake one after this runs.
    """
    from deep_research import hub

    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("HUB_TOKEN", raising=False)
    monkeypatch.setattr(hub, "_pusher", None)
    yield


@pytest.fixture(autouse=True)
def no_real_commentary(monkeypatch):
    """The live commentary never calls a real model in tests: a test that wants captions passes a fake one."""
    from deep_research import commentary

    def offline(model: str):
        raise RuntimeError("no model calls in tests")

    monkeypatch.setattr(commentary, "make_llm", offline)
