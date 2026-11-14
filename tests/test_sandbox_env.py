"""Creating VMs at once must never wipe the server's environment (Daytona's ObjectStorage `isolated_env`)."""

import os
import threading

import daytona._async.object_storage as async_storage
import daytona._sync.object_storage as sync_storage

from deep_research import sandboxes


def test_daytona_object_storage_uses_our_env_guard():
    assert sync_storage.isolated_env is sandboxes._aws_free_env
    assert async_storage.isolated_env is sandboxes._aws_free_env


def test_overlapping_uploads_keep_the_environment(monkeypatch):
    """Two VM creates upload their image files at once. With Daytona's own `isolated_env` the second one saves
    the environment the first one cleared and restores it last, leaving the server with no ANTHROPIC_API_KEY."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("AWS_REGION", "mars-1")
    a_inside, b_inside, a_done = threading.Event(), threading.Event(), threading.Event()
    seen: dict[str, object] = {}

    def a() -> None:
        with sync_storage.isolated_env():
            seen["a_aws"] = os.environ.get("AWS_REGION")
            seen["a_key"] = os.environ.get("ANTHROPIC_API_KEY")
            a_inside.set()
            b_inside.wait(0.5)  # Daytona's version lets b in here; ours makes b wait
        a_done.set()

    def b() -> None:
        with sync_storage.isolated_env():
            b_inside.set()
            a_done.wait(2)

    ta = threading.Thread(target=a)
    ta.start()
    assert a_inside.wait(5)
    tb = threading.Thread(target=b)
    tb.start()
    ta.join(5)
    tb.join(5)

    assert seen == {"a_aws": None, "a_key": "sk-test"}  # AWS_* hidden from the S3 client, nothing else
    assert os.environ.get("ANTHROPIC_API_KEY") == "sk-test"
    assert os.environ.get("AWS_REGION") == "mars-1"
