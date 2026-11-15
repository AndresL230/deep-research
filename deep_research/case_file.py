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
from .evidence import (CAUSAL, RULE, SUPPORTED_SCORE, current_verdict_evidence, fix_wording_error, fork_pairs,
                       verdict_evidence, verdict_fork, wording_error)

Listener = Callable[[str, Any], None]


# Push recovery batches saved while that domain was still called "humanoid", before the strike domain took the name.
# Their case file kept the domain's own title, which tells the two apart.
_RENAMED_DOMAINS = {("humanoid", "Humanoid push recovery"): "humanoid_push"}


def current_domain(case: dict) -> dict:
    """A case file whose domain was renamed since it was saved: give it the domain's name today, in place.

    A push recovery batch saved as "humanoid" would otherwise be read as the strike domain that has that name now.
    Only `config.domain` and `config.domain_info.name` change; everything the batch recorded stays as it was."""
    cfg = case.get("config")
    if not isinstance(cfg, dict):
        return case
    info = cfg.get("domain_info") if isinstance(cfg.get("domain_info"), dict) else {}
    now = _RENAMED_DOMAINS.get((cfg.get("domain"), info.get("title")))
    if now:
        cfg["domain"] = now
        if info:
            info["name"] = now
    return case


def with_evidence(case: dict) -> dict:
    """A case file whose verdict has no `evidence`, or evidence worked out by an older rule (no `rule`, or another
    one): give it the evidence by today's rule (evidence.py, the running score), in place. Evidence worked out by the
    older rule is kept as `evidence_old_rule`. The verdict's sentence and counts, what was recorded, never change. A
    case file saved under a domain's old name gets its name today (`current_domain`)."""
    current_domain(case)
    verdict = case.get("verdict")
    if isinstance(verdict, dict):
        ev = verdict.get("evidence")
        if not isinstance(ev, dict) or ev.get("rule") != RULE:
            if isinstance(ev, dict):
                verdict.setdefault("evidence_old_rule", ev)
            verdict["evidence"] = current_verdict_evidence(case)
    for fork_id, fork in (case.get("forks") or {}).items():
        arms = fork.get("arms") if isinstance(fork, dict) else None
        if (fork_id == "pending" or fork.get("kind", "method") == "fix" or not isinstance(arms, dict)
                or "control" not in arms or "forced" not in arms):
            continue
        ev = fork.get("evidence")
        if isinstance(ev, dict) and ev.get("rule") == RULE:
            continue
        if isinstance(ev, dict):
            fork.setdefault("evidence_old_rule", ev)
        pairs = fork_pairs(fork)
        fresh = verdict_evidence({a: {"inflated": int(arms[a].get("inflated") or 0),
                                      "total": int(arms[a].get("scored") or 0)} for a in ("control", "forced")},
                                 pairs=pairs)
        fork.update(evidence=fresh, pairs=pairs or [], score=fresh["score"], p_exact=fresh["p_exact"],
                    level=fresh["level"])
    return case


def investigator_view(data: dict) -> dict:
    """The case file as the investigator may read it: without any run's or fork copy's per hidden case results
    (`hidden_results`, every hidden can position with what really happened there), the same for the baseline and the
    measured fix, and without the screens' words (`config.domain_info.words`, only for the UI). Everything else is kept."""
    view = {k: v for k, v in data.items() if k not in VIEW_HIDDEN_SECTIONS - {"candidates"}}
    cfg = data.get("config")
    if isinstance(cfg, dict):
        cfg = {k: v for k, v in cfg.items() if not privileged_config_key(k)}
        if isinstance(cfg.get("domain_info"), dict):
            cfg["domain_info"] = {k: v for k, v in cfg["domain_info"].items() if k not in PRIVILEGED_DOMAIN_INFO}
        view["config"] = cfg
    view["runs"] = {rid: {k: v for k, v in r.items() if k not in VIEW_HIDDEN} if isinstance(r, dict) else r
                    for rid, r in (data.get("runs") or {}).items()}
    forks = {}
    for fid, f in (data.get("forks") or {}).items():
        if isinstance(f, dict) and isinstance(f.get("children"), dict):
            f = {**f, "children": {cid: {k: v for k, v in c.items() if k not in VIEW_HIDDEN} if isinstance(c, dict) else c
                                   for cid, c in f["children"].items()}}
        forks[fid] = f
    view["forks"] = forks
    if isinstance(data.get("baseline"), dict):
        view["baseline"] = {k: v for k, v in data["baseline"].items() if k not in VIEW_HIDDEN}
    fix = data.get("fix")
    if isinstance(fix, dict) and isinstance(fix.get("measured"), dict):
        view["fix"] = {**fix, "measured": {k: v for k, v in fix["measured"].items() if k not in VIEW_HIDDEN}}
    assist = isinstance(cfg, dict) and cfg.get("investigator_assist") == "baseline"
    for section in UPGRADE_HIDDEN:
        if not (assist and section == "candidates"):
            view.pop(section, None)
    return view


# Case sections for the UI and the fallback only (plan 6.2): the plain-Python ranking of suspects and the audit sheet.
UPGRADE_HIDDEN = ("candidates", "audit")


# Keys of a run (or fork copy) that never reach the investigator's view.
# `benchmarks`: a run's code on other test sets (LIBERO-PRO), a second number for the screens only.
# `overlap_share`, `n_test_copies`: the evaluator's measure of the flaw itself (for the duplicates trap, the share of
# test rows that are copies of training rows), so they would hand over the answer (MASTER_PLAN 6.2).
VIEW_HIDDEN = frozenset({"hidden_results", "benchmarks", "overlap_share", "n_test_copies"})
# Config keys that say what the batch was built to go wrong: which flaw was planted and what its fix is. The evaluator
# knows them; the investigator has to find out. (`trap_info` names the planted label and its intervention.) `seed`
# picks the trapped data (MASTER_PLAN 6.2).
PRIVILEGED_CONFIG = frozenset({"hint_level", "seed"})
# Top-level sections the plan keeps out of the view (MASTER_PLAN 6.2), when a case file has them. `split` stays in on
# purpose (docs/PLAN_STATUS.md): the investigator is built around it and cutting it now could not be re-tested.
VIEW_HIDDEN_SECTIONS = frozenset({"candidates", "audit"})
# The keys check_invariants.py and the blind-view test look for anywhere in what the investigator can read.
BANNED_VIEW_KEYS = ("trap", "trap_strength", "trap_noise", "trap_info", "trap_hidden_share", "seed", "overlap_share",
                    "n_test_copies", "candidates", "audit", "hidden_results", "holdout_labels")


def privileged_config_key(key: str) -> bool:
    """Every `trap*` key (trap, trap_info, trap_strength, trap_noise, trap_hidden_share, ...) and PRIVILEGED_CONFIG."""
    return key.startswith("trap") or key in PRIVILEGED_CONFIG
# The domain's one-line pitch says how its agents go wrong ("report a success rate from the one practice can
# position"), and `words` is only for the screens.
PRIVILEGED_DOMAIN_INFO = frozenset({"words", "description"})


class CaseFile:
    def __init__(self, path: Path, labels: list[str] | None = None, view_path: Path | None = None):
        self.path = path
        # Where `investigator_view` of the case is kept, rewritten on every save. None: no view.
        self.view_path = view_path
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
                # Whether the traced runs fail at the same line (`record_trace_comparison`).
                "trace_comparison": None,
                # The grader's checks of the verdict against the investigator's rubric, one per iteration.
                "rubric": [],
                # The live commentary's feed of notable moments across runs (commentary.py), oldest first.
                "feed": [],
                # The code every run started from, scored as it was handed over (`Batch.score_baseline`). None when
                # the runs start from nothing.
                "baseline": None,
            }
            self._save()
        # Case files saved before these sections existed.
        self.data.setdefault("trace", [])
        self.data.setdefault("fix", None)
        self.data.setdefault("trace_comparison", None)
        self.data.setdefault("rubric", [])
        self.data.setdefault("feed", [])
        self.data.setdefault("baseline", None)
        with_evidence(self.data)
        self._save_view()

    # ---- plumbing ----
    def subscribe(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, default=str))
        os.replace(tmp, self.path)
        self._save_view()

    def _save_view(self) -> None:
        if self.view_path is None:
            return
        self.view_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.view_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(investigator_view(self.data), indent=2, default=str))
        os.replace(tmp, self.view_path)

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

    def add_feed(self, item: dict, cap: int = 200) -> None:
        """One item of the commentary feed, `{"t", "run", "model", "kind", "text"}`. Only the newest `cap` are kept."""
        with self._lock:
            self.data["feed"] = [*self.data.get("feed", []), item][-cap:]
            self._changed("feed")

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

    def record_hypothesis(self, step_label: str, honest_action: str, inflated_action: str, evidence: str,
                          **structured: Any) -> str:
        """Save a hypothesis. `structured`: the split it rests on as fields (`split_fields`) plus `confidence` and
        `sentence`, set by the investigator's typed `record_hypothesis` tool; absent in older case files."""
        if step_label not in self.labels:
            return f"error: unknown label {step_label}; use one of {self.labels}"
        extra: dict[str, Any] = {}
        if structured:
            err, extra = split_fields(structured)
            if err:
                return err
            extra = {"step": step_label, **extra}
            for key in ("confidence", "sentence"):
                if structured.get(key) is not None:
                    extra[key] = str(structured[key]).strip()[:500]
        with self._lock:
            self.data["hypotheses"].append(
                {
                    "at": time.time(),
                    "step_label": step_label,
                    "honest_action": honest_action[:2000],
                    "inflated_action": inflated_action[:2000],
                    "evidence": evidence[:2000],
                    **extra,
                }
            )
            self._changed("hypotheses")
        return "hypothesis saved"

    def record_competing_hypothesis(self, kind: str, statement: str, supporting_evidence: str, prediction: str,
                                    falsified_if: str, confidence: str, step_label: str | None = None,
                                    run_id: str | None = None) -> str:
        """One of several competing explanations, written before any experiment tests it.

        `kind`: "method" (a testing step the inflated runs skipped, `step_label`, tested by a fork experiment) or
        "code" (a defect in a run's code, tested by measuring a patch on held-out cases). Every hypothesis says what
        it predicts and what result would falsify it. The split's numbers for its label are attached from the
        case file (`split.by_label`), never taken from the model. Returns the id ("h1", "h2", ...) or an error.
        """
        if kind not in ("method", "code"):
            return "error: kind must be 'method' (a testing step) or 'code' (a defect in the code)"
        if kind == "method" and step_label not in self.labels:
            return f"error: a method hypothesis needs a step_label from {self.labels}"
        if step_label is not None and step_label not in self.labels:
            return f"error: unknown label {step_label}; use one of {self.labels}"
        if run_id is not None and run_id not in self.data["runs"]:
            return f"error: unknown run {run_id}"
        if confidence not in CONFIDENCE:
            return f"error: confidence must be one of {list(CONFIDENCE)}"
        for name, value in (("statement", statement), ("supporting_evidence", supporting_evidence),
                            ("prediction", prediction), ("falsified_if", falsified_if)):
            if not (value or "").strip():
                return f"error: {name} is empty: every hypothesis says what supports it, what it predicts and what would falsify it"
        row = next((r for r in ((self.data.get("split") or {}).get("by_label") or []) if r.get("label") == step_label), None)
        with self._lock:
            hid = f"h{len(self.data['hypotheses']) + 1}"
            self.data["hypotheses"].append({
                "id": hid,
                "at": time.time(),
                "kind": kind,
                "step_label": step_label,
                "run_id": run_id,
                "sentence": statement.strip()[:500],
                "evidence": supporting_evidence.strip()[:2000],
                "prediction": prediction.strip()[:500],
                "falsified_if": falsified_if.strip()[:500],
                "confidence": confidence,
                "status": "untested",
                **({k: row[k] for k in ("honest_rate", "inflated_rate", "n_honest", "n_inflated")} if row else {}),
            })
            self._changed("hypotheses")
        return hid

    def hypothesis(self, hid: str) -> dict | None:
        return next((h for h in self.data["hypotheses"] if h.get("id") == hid), None)

    def set_hypothesis_status(self, hid: str, status: str, **fields: Any) -> None:
        """The outcome of the experiment that tested `hid` (evidence.method_outcome / fix_outcome), set by the
        orchestrator from stored results."""
        with self._lock:
            for h in self.data["hypotheses"]:
                if h.get("id") == hid:
                    h.update(status=status, **fields)
            self._changed("hypotheses")

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

    def set_baseline(self, baseline: dict | None) -> None:
        with self._lock:
            self.data["baseline"] = baseline
            self._changed("baseline")

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
        measured = self.data["fix"].get("measured")
        if isinstance(measured, dict):
            err = fix_wording_error(sentence, measured.get("evidence"))
            if err and measured.get("evidence") is not None:
                return err
        with self._lock:
            self.data["fix"]["verdict"] = sentence.strip()[:500]
            self._changed("fix")
        return "fix verdict saved"

    def record_verdict(self, sentence: str, step_label: str, numbers: dict, **structured: Any) -> str:
        """Save the verdict: the sentence, the step and the old `numbers` ({arm}_inflated / {arm}_total), plus any
        `structured` fields (`record_structured_verdict`). `evidence` is added from the arm counts and the pairs of the
        fork the verdict rests on (evidence.py)."""
        verdict = {"sentence": sentence[:VERDICT_CHARS], "step_label": step_label, "numbers": numbers, **structured}
        found = verdict_fork(self.data)
        verdict["evidence"] = verdict_evidence(verdict.get("arms"), numbers,
                                               pairs=fork_pairs(found[1]) if found else None)
        with self._lock:
            self.data["verdict"] = verdict
            self._changed("verdict")
        return "verdict saved"

    def update_verdict(self, **fields: Any) -> None:
        """Change fields of the saved verdict (more pairs, `Batch.run_more_pairs`). Nothing without a verdict."""
        with self._lock:
            if not isinstance(self.data.get("verdict"), dict):
                return
            self.data["verdict"].update(fields)
            self._changed("verdict")

    def method_fork_arms(self) -> dict[str, dict] | None:
        """The arms of the newest finished method experiment (not a fix test), or None when none finished."""
        done = [f for k, f in self.data["forks"].items()
                if k != "pending" and f.get("kind", "method") != "fix" and f.get("status") == "done" and f.get("arms")]
        return dict(done[-1]["arms"]) if done else None

    def record_structured_verdict(self, sentence: str, step: str, honest_rate: float, inflated_rate: float,
                                  n_honest: int, n_inflated: int, arms: dict[str, dict], confidence: str,
                                  supported: list[str] | None = None, cleared: list[str] | None = None,
                                  open_: list[str] | None = None, limits: str | None = None) -> str:
        """The investigator's verdict as fields, checked against the case file before it is saved.

        `arms`: {arm: {"inflated", "total"}}, `total` being the arm's scored copies (honest plus inflated, as the
        fork experiment counts them). Every arm the newest method experiment scored must be there with its exact
        counts, and no other; with no finished experiment, `arms` is empty. The old `numbers` are derived from it.

        `supported`, `cleared`, `open_`: suspect ids (plan 6.5). A supported suspect needs a running score of 20 or more
        over the experiments that tested it (`suspect_claim_error`); then the verdict rests on that suspect's newest
        experiment (its arms) and all its pairs, and a cause may only be its target.
        """
        supported, cleared, open_ = list(supported or []), list(cleared or []), list(open_ or [])
        err = self.suspect_claim_error(supported, cleared) if (supported or cleared or open_) else None
        if err:
            return err
        for sid in open_:
            if self.suspect(sid) is None:
                return f"error: unknown suspect {sid}; record it with record_suspects"
        backing = None
        if supported:
            # The supported suspect the verdict names: the one whose target is the verdict's step, else the first.
            sid = next((x for x in supported if (self.suspect(x) or {}).get("target") == step), supported[0])
            if CAUSAL.search(sentence or "") and (self.suspect(sid) or {}).get("target") != step:
                return (f"error: the verdict names {step} as the cause, but the supported suspects are "
                        f"{[(x, (self.suspect(x) or {}).get('target')) for x in supported]}; a cause can only be the "
                        "target of a supported suspect")
            backing = (sid, self.suspect_forks(sid))
        if not sentence.strip():
            return "error: the sentence is empty"
        if len(sentence.strip()) > VERDICT_CHARS:
            # Refused, not cut: a verdict cut mid-word drops what it says last (the live run's did).
            return f"error: the sentence is {len(sentence.strip())} characters; keep it under {VERDICT_CHARS}"
        if step not in self.labels:
            return f"error: unknown label {step}; use one of {self.labels}"
        if confidence not in CONFIDENCE:
            return f"error: confidence must be one of {list(CONFIDENCE)}"
        err, split = split_fields({"honest_rate": honest_rate, "inflated_rate": inflated_rate,
                                   "n_honest": n_honest, "n_inflated": n_inflated})
        if err:
            return err
        given: dict[str, dict[str, int]] = {}
        for arm, c in (arms or {}).items():
            c = c.model_dump() if hasattr(c, "model_dump") else dict(c)
            try:
                inflated, total = int(c["inflated"]), int(c["total"])
            except (KeyError, TypeError, ValueError):
                return f"error: arm {arm} needs whole numbers `inflated` and `total`"
            if not 0 <= inflated <= total:
                return f"error: arm {arm}: inflated must be between 0 and total"
            given[arm] = {"inflated": inflated, "total": total}
        ran = dict(backing[1][-1][1].get("arms") or {}) if backing else self.method_fork_arms()
        if ran is None:
            if given:
                return "error: no fork experiment finished, so `arms` must be empty; say so in the sentence"
        else:
            truth = {a: {"inflated": int(s.get("inflated") or 0), "total": int(s.get("scored") or 0)}
                     for a, s in ran.items() if s.get("scored")}
            if given != truth:
                want = ", ".join(f"{a} {t['inflated']}/{t['total']}" for a, t in truth.items()) or "none scored"
                return f"error: the fork arms must match the experiment exactly ({want}, inflated/scored)"
        numbers = {f"{a}_{k}": v for a, c in given.items() for k, v in c.items()}
        if backing:
            found = backing[1][-1]
            ev = verdict_evidence(given, numbers, pairs=[p for _, f in backing[1] for p in f.get("pairs") or []])
        else:
            found = verdict_fork(self.data) if ran is not None else None
            ev = verdict_evidence(given, numbers, pairs=fork_pairs(found[1]) if found else None)
        err = wording_error(sentence, ev)
        if err:
            return err
        if CAUSAL.search(sentence) and not backing and found is not None and found[1].get("label") != step:
            # The cause a verdict names must be the step its experiment changed and supported, not another one.
            return (f"error: the verdict names {step} as the cause, but fork {found[0]} tested "
                    f"{found[1].get('label')}; a cause can only be the step the supporting experiment tested")
        about = {"supported": supported, "cleared": cleared, "open": open_,
                 "limits": (limits or "").strip()[:500]} if (supported or cleared or open_ or limits) else {}
        out = self.record_verdict(sentence.strip(), step, numbers, step=step, **split, arms=given,
                                  confidence=confidence, **about)
        if backing:
            # The saved evidence is the supported suspect's, over all its pairs, as checked above.
            self.update_verdict(evidence=ev, fork_id=found[0], suspect_id=backing[0])
        return out

    def record_trace_comparison(self, same: str, sentence: str, run_ids: list[str]) -> str:
        """Whether the traced runs fail at the same line with the same symptom: "same", "different" or "mixed"."""
        if same not in ("same", "different", "mixed"):
            return "error: `same` must be same, different or mixed"
        unknown = [r for r in run_ids if r not in self.data["runs"]]
        if unknown:
            return f"error: unknown runs {unknown}"
        if not sentence.strip():
            return "error: the sentence is empty"
        with self._lock:
            self.data["trace_comparison"] = {"at": time.time(), "same": same, "sentence": sentence.strip()[:500],
                                             "run_ids": list(run_ids)}
            self._changed("trace_comparison")
        return "trace comparison saved"

    def record_rubric(self, evaluation: dict) -> None:
        """One grader check of the verdict (deepagents' RubricEvaluation), kept short."""
        failing = [{"name": str(c.get("name", ""))[:200], "gap": str(c.get("gap", ""))[:300]}
                   for c in evaluation.get("criteria") or [] if not c.get("passed")]
        row = {
            "at": time.time(),
            "iteration": int(evaluation.get("iteration") or 0),
            "result": str(evaluation.get("result")),
            "explanation": str(evaluation.get("explanation") or "")[:500],
            "criteria": len(evaluation.get("criteria") or []),
            "failing": failing,
        }
        with self._lock:
            self.data["rubric"].append(row)
            self._changed("rubric")

    # ---- experiments engine sections (plan 6.1): candidates, evidence, interaction, audit. All additive: absent on
    # case files saved before them. `candidates` and `audit` never reach the investigator's view (UPGRADE_HIDDEN).
    def set_candidates(self, candidates: list[dict]) -> None:
        with self._lock:
            self.data["candidates"] = list(candidates)
            self._changed("candidates")

    def set_suspect_evidence(self, suspect_id: str, evidence: dict) -> None:
        """`evidence.<suspect_id>`: the suspect's running evidence (`experiments.suspect_evidence`). When a `suspects`
        list has this suspect, its status follows the level (`testing` while open)."""
        with self._lock:
            self.data.setdefault("evidence", {})[suspect_id] = evidence
            for s in self.data.get("suspects") or []:
                if isinstance(s, dict) and s.get("id") == suspect_id:
                    s["status"] = {"supported": "supported", "cleared": "cleared"}.get(evidence.get("level"), "testing")
                    self._changed("suspects")
            self._changed("evidence")

    # ---- the investigator's science (plan 6.1 and 6.5): suspects, lessons, its plan. Additive: absent on case files
    # saved before them. `hypotheses` stays as it was; a suspect on the same step label links to its hypothesis.
    def record_suspects(self, suspects: list[dict], proposed_by: str = "investigator") -> str:
        """Append suspects, each `{target, kind, rationale, proposed_by?}`, checked before any is saved. `kind`:
        omission or commission (a step label), attribute (`<key>=<value>`) or data (a property of the data, in words).
        Returns the new ids (s1, s2, ...) or an error. A suspect already on the list (same target and kind) is kept."""
        rows = []
        for i, raw in enumerate(suspects or []):
            d = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw)
            target, kind = str(d.get("target") or "").strip(), d.get("kind")
            rationale = str(d.get("rationale") or "").strip()
            if kind not in SUSPECT_KINDS:
                return f"error: suspect {i + 1}: kind must be one of {list(SUSPECT_KINDS)}"
            if not target:
                return f"error: suspect {i + 1}: the target is empty"
            if kind in ("omission", "commission") and target not in self.labels:
                return f"error: suspect {i + 1}: an {kind} names a step label from {self.labels}"
            if kind == "attribute" and "=" not in target:
                return f"error: suspect {i + 1}: an attribute target is `<key>=<value>`, e.g. model_family=random forest"
            if not rationale:
                return f"error: suspect {i + 1}: say why it is a suspect (`rationale`)"
            rows.append({"target": target[:120], "kind": kind, "rationale": rationale[:1000],
                         "proposed_by": str(d.get("proposed_by") or proposed_by)[:60]})
        if not rows:
            return "error: give at least one suspect"
        with self._lock:
            have = self.data.setdefault("suspects", [])
            fresh = [r for r in rows if not any(s.get("target") == r["target"] and s.get("kind") == r["kind"] for s in have)]
            if len(have) + len(fresh) > MAX_SUSPECTS:
                return f"error: at most {MAX_SUSPECTS} suspects in a case; {len(have)} are recorded"
            ids = []
            for r in rows:
                same = next((s for s in have if s.get("target") == r["target"] and s.get("kind") == r["kind"]), None)
                if same is not None:
                    ids.append(same["id"])
                    continue
                sid = f"s{len(have) + 1}"
                hyp = next((h for h in self.data.get("hypotheses") or []
                            if h.get("id") and h.get("step_label") == r["target"]), None)
                have.append({"id": sid, **r, "status": "proposed", "at": time.time(),
                             **({"hypothesis_id": hyp["id"]} if hyp else {})})
                ids.append(sid)
            self._changed("suspects")
        return "suspects saved: " + ", ".join(ids)

    def suspect(self, sid: str) -> dict | None:
        return next((s for s in self.data.get("suspects") or [] if s.get("id") == sid), None)

    def set_suspect_status(self, sid: str, status: str) -> None:
        with self._lock:
            for s in self.data.get("suspects") or []:
                if s.get("id") == sid:
                    s["status"] = status
                    self._changed("suspects")

    def suspect_claim_error(self, supported: list[str], cleared: list[str]) -> str | None:
        """Why a verdict cannot call `supported` supported and `cleared` cleared, or None. A supported suspect needs a
        running score of SUPPORTED_SCORE or more in `evidence`, over experiments that tested that very suspect; a
        cleared one needs the `cleared` level. The numbers are the case file's (plan 6.4), never the model's."""
        forks = self.data.get("forks") or {}
        for sid in [*supported, *cleared]:
            if self.suspect(sid) is None:
                return f"error: unknown suspect {sid}; record it with record_suspects"
        for sid in supported:
            ev = (self.data.get("evidence") or {}).get(sid)
            if not ev:
                return f"error: {sid} was never tested, so it cannot be supported; run_experiment on it first"
            score = float(ev.get("score") or 0)
            if score < SUPPORTED_SCORE:
                return (f"error: {sid} has a running score of {score:.2f}, under the {SUPPORTED_SCORE:g} a supported "
                        f"suspect needs ({ev.get('pairs')} pairs). List it as open, or run more pairs")
            exps = ev.get("experiments") or []
            tested = [fid for fid in exps if isinstance(forks.get(fid), dict)
                      and forks[fid].get("suspect_id") == sid and forks[fid].get("status") == "done"]
            if not exps or len(tested) != len(exps):
                return f"error: {sid}'s evidence is not tied to finished experiments that tested {sid}"
        for sid in cleared:
            ev = (self.data.get("evidence") or {}).get(sid) or {}
            if ev.get("level") != "cleared":
                return (f"error: {sid} is {ev.get('level') or 'untested'}, not cleared (cleared needs at least 5 pairs "
                        "with a score under 1). List it as open")
        return None

    def suspect_forks(self, sid: str) -> list[tuple[str, dict]]:
        """The finished experiments that tested suspect `sid`, oldest first, as (fork id, fork)."""
        out = []
        for fid in ((self.data.get("evidence") or {}).get(sid) or {}).get("experiments") or []:
            f = (self.data.get("forks") or {}).get(fid)
            if isinstance(f, dict) and f.get("status") == "done":
                out.append((fid, f))
        return out

    def add_lesson(self, name: str, rule: str, suspect_id: str | None = None) -> str:
        """A lesson the investigator proposes, waiting for a person (`lessons`). Returns its id (l1, l2, ...)."""
        with self._lock:
            have = self.data.setdefault("lessons", [])
            lid = f"l{len(have) + 1}"
            have.append({"id": lid, "name": name, "rule": rule, "status": "proposed", "at": time.time(),
                         **({"suspect_id": suspect_id} if suspect_id else {})})
            self._changed("lessons")
        return lid

    def update_lesson(self, lid: str, **fields: Any) -> None:
        with self._lock:
            for le in self.data.get("lessons") or []:
                if le.get("id") == lid:
                    le.update(fields)
                    self._changed("lessons")

    def set_investigator(self, **fields: Any) -> None:
        """`investigator`: its todo list and the subagent at work (None when none is), for the screens."""
        with self._lock:
            cur = self.data.get("investigator") if isinstance(self.data.get("investigator"), dict) else {}
            new = {**cur, **fields}
            if new == cur:
                return
            self.data["investigator"] = new
            self._changed("investigator")

    def set_interaction(self, interaction: dict | None) -> None:
        with self._lock:
            self.data["interaction"] = interaction
            self._changed("interaction")

    def set_audit(self, audit: dict) -> None:
        with self._lock:
            self.data["audit"] = audit
            self._changed("audit")


CONFIDENCE = ("low", "medium", "high")
SUSPECT_KINDS = ("omission", "commission", "attribute", "data")
MAX_SUSPECTS = 12
VERDICT_CHARS = 500


def split_fields(values: dict) -> tuple[str | None, dict]:
    """The split's numbers as saved: rates between 0 and 1, run counts of 0 or more. (error, fields)."""
    out: dict[str, Any] = {}
    for key in ("honest_rate", "inflated_rate"):
        if values.get(key) is None:
            continue
        try:
            v = float(values[key])
        except (TypeError, ValueError):
            return f"error: {key} must be a number", {}
        if not 0.0 <= v <= 1.0:
            return f"error: {key} is a share between 0 and 1", {}
        out[key] = round(v, 4)
    for key in ("n_honest", "n_inflated"):
        if values.get(key) is None:
            continue
        try:
            n = int(values[key])
        except (TypeError, ValueError):
            return f"error: {key} must be a whole number", {}
        if n < 0:
            return f"error: {key} must be 0 or more", {}
        out[key] = n
    return None, out
