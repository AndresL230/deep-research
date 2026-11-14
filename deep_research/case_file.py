"""The shared case file: everything the investigator knows, and the UI's data source.

Written only through the methods below. The investigator's tools call the
`record_*` methods; the orchestrator calls the rest. The agents can read the
file through `/case/case.json`, but the built-in write tools are denied there.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .analysis import LABELS

Listener = Callable[[str, Any], None]


class CaseFile:
    def __init__(self, path: Path, labels: list[str] | None = None):
        self.path = path
        # The step labels the investigator's tools accept: the batch domain's (`Domain.labels()`).
        self.labels = list(labels) if labels is not None else LABELS
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._listeners: list[Listener] = []
        if path.exists():
            self.data = json.loads(path.read_text())
        else:
            self.data = {
                "config": {},
                "phase": "config",
                "runs": {},
                "step_labels": {},
                "split": None,
                "hypotheses": [],
                "forks": {},
                "verdict": None,
                "costs": {},
                # The diagnosis: symptoms traced to lines of the agent's code, and the fix proposed and tested.
                "trace": [],
                "fix": None,
            }
            self._save()
        # Case files saved before these sections existed.
        self.data.setdefault("trace", [])
        self.data.setdefault("fix", None)

    # ---- plumbing ----
    def subscribe(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, default=str))
        os.replace(tmp, self.path)

    def _changed(self, section: str) -> None:
        self._save()
        for fn in self._listeners:
            fn(section, self.data[section])

    def read(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self.data, default=str))

    # ---- orchestrator writes ----
    def set_config(self, cfg: dict) -> None:
        with self._lock:
            self.data["config"] = cfg
            self._changed("config")

    def set_phase(self, phase: str) -> None:
        with self._lock:
            self.data["phase"] = phase
            self._changed("phase")

    def update_run(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            self.data["runs"].setdefault(run_id, {"id": run_id}).update(fields)
            self._changed("runs")

    def set_split(self, split: dict | None) -> None:
        with self._lock:
            self.data["split"] = split
            self._changed("split")

    def update_fork(self, fork_id: str, **fields: Any) -> None:
        with self._lock:
            self.data["forks"].setdefault(fork_id, {"id": fork_id}).update(fields)
            self._changed("forks")

    def remove_fork(self, fork_id: str) -> None:
        with self._lock:
            self.data["forks"].pop(fork_id, None)
            self._changed("forks")

    def set_costs(self, costs: dict) -> None:
        with self._lock:
            self.data["costs"] = costs
            self._changed("costs")

    # ---- tool writes (investigator) ----
    def record_step_labels(self, run_id: str, labels: list[list[str]]) -> str:
        if run_id not in self.data["runs"]:
            return f"error: unknown run {run_id}"
        bad = sorted({l for step in labels for l in step if l not in self.labels})
        if bad:
            return f"error: unknown labels {bad}; use only {self.labels}"
        with self._lock:
            self.data["step_labels"][run_id] = labels
            self._changed("step_labels")
        return f"saved {len(labels)} step labels for {run_id}"

    def record_hypothesis(self, step_label: str, honest_action: str, inflated_action: str, evidence: str) -> str:
        if step_label not in self.labels:
            return f"error: unknown label {step_label}; use one of {self.labels}"
        with self._lock:
            self.data["hypotheses"].append(
                {
                    "at": time.time(),
                    "step_label": step_label,
                    "honest_action": honest_action[:2000],
                    "inflated_action": inflated_action[:2000],
                    "evidence": evidence[:2000],
                }
            )
            self._changed("hypotheses")
        return "hypothesis saved"

    def record_trace(self, run_id: str, symptom: str, line: int, excerpt: str, why: str, motion_file: str = "") -> str:
        """Save one traced failure: a symptom from a recording, and the line of the run's code it points at."""
        if run_id not in self.data["runs"]:
            return f"error: unknown run {run_id}"
        try:
            line = int(line)
        except (TypeError, ValueError):
            return "error: line must be a line number"
        if line < 1:
            return "error: line must be 1 or more"
        if not symptom.strip() or not why.strip():
            return "error: give the symptom and why that line causes it"
        with self._lock:
            self.data["trace"].append(
                {
                    "at": time.time(),
                    "run_id": run_id,
                    "symptom": symptom.strip()[:500],
                    "line": line,
                    "excerpt": excerpt.strip()[:300],
                    "why": why.strip()[:1000],
                    # The recording the symptom was read from, as a path for the files route, when known.
                    "motion_file": (motion_file or "").strip()[:300] or None,
                }
            )
            self._changed("trace")
        return f"trace saved: {run_id} line {line}"

    def set_fix(self, fix: dict | None) -> None:
        with self._lock:
            self.data["fix"] = fix
            self._changed("fix")

    def update_fix(self, **fields: Any) -> None:
        with self._lock:
            if self.data.get("fix") is None:
                self.data["fix"] = {}
            self.data["fix"].update(fields)
            self._changed("fix")

    def record_fix_verdict(self, sentence: str) -> str:
        """The investigator's one sentence on what the fix experiment showed."""
        if self.data.get("fix") is None:
            return "error: no fix has been proposed"
        if not sentence.strip():
            return "error: the sentence is empty"
        with self._lock:
            self.data["fix"]["verdict"] = sentence.strip()[:500]
            self._changed("fix")
        return "fix verdict saved"

    def record_verdict(self, sentence: str, step_label: str, numbers: dict) -> str:
        with self._lock:
            self.data["verdict"] = {"sentence": sentence[:500], "step_label": step_label, "numbers": numbers}
            self._changed("verdict")
        return "verdict saved"
