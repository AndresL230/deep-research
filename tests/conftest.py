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
