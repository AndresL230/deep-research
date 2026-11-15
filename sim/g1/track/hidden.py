"""The motions a controller is measured on, and the ones a failing controller is traced on.

Both sets are files under `sim/g1/track/motions/` that are never uploaded to an agent. They were chosen once, by
`scripts/make_track_motions.py`, from CMU clips no public motion is cut from where that was possible, and half of
each set is calm and half demanding (`sim/g1/track/motions.py`). SERVER ONLY: nothing here goes to a VM.
"""

from __future__ import annotations

from sim.g1.track.motions import load, names, spec


def _set(set_name: str, n: int | None) -> list[dict]:
    """A set's motions as {"set", "name", "kind"}, calm and demanding in turn, so any first `n` has both."""
    motions = [spec(load(name, set_name), set_name) for name in names(set_name)]
    calm = [m for m in motions if m["kind"] == "calm"]
    demanding = [m for m in motions if m["kind"] != "calm"]
    out: list[dict] = []
    while calm or demanding:
        if calm:
            out.append(calm.pop(0))
        if demanding:
            out.append(demanding.pop(0))
    return out if n is None else out[:n]


def hidden_motions(n: int | None = None) -> list[dict]:
    """The hidden test: 20 motions, 10 calm and 10 demanding."""
    return _set("hidden", n)


def diagnostic_motions(n: int | None = None) -> list[dict]:
    """What a controller is traced on to see where it fails: apart from the hidden motions, with both kinds."""
    return _set("diagnostic", n)


def public_motions(n: int | None = None) -> list[dict]:
    """What an agent is given."""
    return _set("public", n)
