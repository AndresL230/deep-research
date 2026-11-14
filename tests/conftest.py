"""Shared test setup."""

import pytest


@pytest.fixture(autouse=True)
def no_real_hub(monkeypatch):
    """Tests never talk to the team hub, even when this machine's .env points at it.

    The app loads .env when it is imported, so HUB_URL and HUB_TOKEN may be set. Tests that need a hub set their own
    fake one after this runs.
    """
    from deep_research import hub

    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("HUB_TOKEN", raising=False)
    monkeypatch.setattr(hub, "_pusher", None)
    yield
