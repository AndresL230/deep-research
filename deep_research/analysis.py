"""Turn run logs into labeled steps and find the step that separates honest and inflated runs.

This is the deterministic baseline. The investigator agent reads the same data,
can correct the labels, and explains the result, but the numbers come from here.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

# Fixed label list. The UI colours lanes by these.
LABELS = [
    "load",
    "inspect",
    "deduplicate",
    "clean",
    "split",
    "preprocess",
    "train",
    "evaluate",
    "plot",
    "predict",
    "report",
]

_RULES: list[tuple[str, re.Pattern]] = [
    ("load", re.compile(r"read_csv")),
    ("inspect", re.compile(r"\.describe\(|\.info\(|\.head\(|value_counts|\.isnull\(|\.isna\(|\.shape\b")),
    ("deduplicate", re.compile(r"drop_duplicates|\.duplicated\(")),
    ("clean", re.compile(r"fillna|dropna|replace\(\s*0|\.median\(\)")),
    ("split", re.compile(r"train_test_split|KFold|StratifiedKFold|\.sample\(\s*frac")),
    ("preprocess", re.compile(r"StandardScaler|MinMaxScaler|fit_transform|SimpleImputer")),
    ("train", re.compile(r"\.fit\(")),
    ("evaluate", re.compile(r"accuracy_score|\.score\(|classification_report|confusion_matrix|cross_val_score")),
    ("plot", re.compile(r"savefig|plt\.|matplotlib")),
    ("predict", re.compile(r"holdout_features|predictions\.csv")),
    ("report", re.compile(r"report\.json")),
]

# Tool calls that change the VM. These are what we replay to rebuild a VM.
VM_TOOLS = {"execute", "write_file", "edit_file", "delete"}


@dataclass
class Action:
    """One tool call by the analyst agent."""

    index: int
    tool: str
    args: dict
    labels: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        a = self.args
        if self.tool == "execute":
            return a.get("command", "")
        if self.tool == "write_file":
            return f"# write {a.get('file_path', '')}\n{a.get('content', '')}"
        if self.tool == "edit_file":
            return f"# edit {a.get('file_path', '')}\n{a.get('new_string', '')}"
        return f"{self.tool} {a}"


def label_text(text: str) -> list[str]:
    return [label for label, rx in _RULES if rx.search(text)]


def actions_from_events(events: list[dict]) -> list[Action]:
    """Pull the agent's tool calls out of a run's event log, in order."""
    actions: list[Action] = []
    for ev in events:
        if ev.get("type") != "tool_call":
            continue
        a = Action(index=len(actions), tool=ev["name"], args=ev.get("args", {}))
        a.labels = label_text(a.text) if a.tool in VM_TOOLS else []
        actions.append(a)
    return _resolve_script_runs(actions)


def _resolve_script_runs(actions: list[Action]) -> list[Action]:
    """`python3 analysis.py` says nothing by itself. Give it the labels of the file it runs."""
    written: dict[str, list[str]] = {}
    for a in actions:
        if a.tool == "write_file":
            written[a.args.get("file_path", "").rsplit("/", 1)[-1]] = a.labels
            # Writing a script is not doing the work. Running it is.
            a.labels = []
        elif a.tool == "execute":
            m = re.search(r"python3?\s+(\S+\.py)", a.args.get("command", ""))
            if m and m.group(1).rsplit("/", 1)[-1] in written:
                a.labels = sorted(set(a.labels) | set(written[m.group(1).rsplit("/", 1)[-1]]), key=LABELS.index)
    return actions


def _did_before_split(actions: list[Action], label: str) -> bool:
    for a in actions:
        if label in a.labels and "split" not in a.labels:
            return True
        if "split" in a.labels:
            # Same action can dedupe and then split, as in one script.
            return label in a.labels and _order_in_text(a.text, label, "split")
    return False


def _order_in_text(text: str, first: str, second: str) -> bool:
    """True if `first`'s pattern appears before `second`'s inside one action."""
    rx = dict(_RULES)
    m1, m2 = rx[first].search(text), rx[second].search(text)
    return bool(m1 and m2 and m1.start() < m2.start())


@dataclass
class SplitFinding:
    label: str
    honest_rate: float
    inflated_rate: float
    n_honest: int
    n_inflated: int
    # Where to fork: in this inflated run, just before this action.
    fork_run_id: str | None
    fork_at: int | None
    honest_example: str | None
    inflated_example: str | None

    def to_dict(self) -> dict:
        return asdict(self)


def find_split(runs: dict[str, list[Action]], statuses: dict[str, str]) -> SplitFinding | None:
    """Find the label done before the train/test split by honest runs but not inflated ones."""
    honest = [r for r, s in statuses.items() if s == "honest" and r in runs]
    inflated = [r for r, s in statuses.items() if s == "inflated" and r in runs]
    if not honest or not inflated:
        return None

    best: tuple[float, str] | None = None
    for label in LABELS:
        if label in ("split", "load"):
            continue
        h = sum(_did_before_split(runs[r], label) for r in honest) / len(honest)
        i = sum(_did_before_split(runs[r], label) for r in inflated) / len(inflated)
        if best is None or (h - i) > best[0]:
            best = (h - i, label)
    assert best is not None
    label = best[1]
    h_rate = sum(_did_before_split(runs[r], label) for r in honest) / len(honest)
    i_rate = sum(_did_before_split(runs[r], label) for r in inflated) / len(inflated)

    # Fork from the first inflated run that skipped it, just before its first split.
    fork_run, fork_at, inflated_example = None, None, None
    for r in inflated:
        if _did_before_split(runs[r], label):
            continue
        for a in runs[r]:
            if "split" in a.labels:
                fork_run, fork_at, inflated_example = r, a.index, a.text
                break
        if fork_run:
            break

    honest_example = None
    for r in honest:
        for a in runs[r]:
            if label in a.labels:
                honest_example = a.text
                break
        if honest_example:
            break

    return SplitFinding(
        label=label,
        honest_rate=round(h_rate, 3),
        inflated_rate=round(i_rate, 3),
        n_honest=len(honest),
        n_inflated=len(inflated),
        fork_run_id=fork_run,
        fork_at=fork_at,
        honest_example=honest_example,
        inflated_example=inflated_example,
    )
