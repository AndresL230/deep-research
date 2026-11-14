"""Turn run logs into labeled steps and find the step that separates honest and inflated runs.

This is the deterministic baseline. The investigator agent reads the same data,
can correct the labels, and explains the result, but the numbers come from here.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from . import traps

# The steps any run does, in the order they usually come, each with the regex that spots it in code.
_BASE_RULES: list[tuple[str, str]] = [
    ("load", r"read_csv"),
    ("inspect", r"\.describe\(|\.info\(|\.head\(|value_counts|\.isnull\(|\.isna\(|\.shape\b"),
    ("clean", r"fillna|dropna|replace\(\s*0|\.median\(\)"),
    ("split", r"train_test_split|KFold|StratifiedKFold|ShuffleSplit|\.sample\(\s*frac"),
    ("preprocess", r"StandardScaler|MinMaxScaler|fit_transform|SimpleImputer"),
    ("train", r"\.fit\("),
    ("evaluate", r"accuracy_score|\.score\(|classification_report|confusion_matrix|cross_val_score"),
    ("plot", r"savefig|plt\.|matplotlib"),
    ("predict", r"holdout_features|predictions\.csv"),
    ("report", r"report\.json"),
]


def _rules() -> list[tuple[str, str]]:
    """The base steps plus each registered trap's honest step (`deduplicate` for duplicates, and so on).

    The traps' steps are checks on the data, so they sit after `inspect`. A trap whose step is a base
    step brings its own pattern for it.
    """
    rules = dict(_BASE_RULES)
    own: dict[str, str] = {}
    for t in traps.registered():
        if t.label in rules:
            rules[t.label] = t.pattern
        else:
            own.setdefault(t.label, t.pattern)
    base = list(rules.items())
    return base[:2] + list(own.items()) + base[2:]


_RULES: list[tuple[str, re.Pattern]] = [(label, re.compile(pattern)) for label, pattern in _rules()]
# Every step label, in order. The case file and the investigator's prompt take the list from here.
LABELS = [label for label, _ in _RULES]
# Steps that can be part of the split itself (see `Trap.at_split`).
_AT_SPLIT = {t.label for t in traps.registered() if t.at_split}

# Tool calls that change the VM. These are what we replay to rebuild a VM.
VM_TOOLS = {"execute", "write_file", "edit_file", "delete"}


@dataclass
class Action:
    """One tool call by the analyst agent."""

    index: int
    tool: str
    args: dict
    labels: list[str] = field(default_factory=list)
    # For `python3 x.py`: the text of x.py as it stood when it ran. Not saved with the action.
    source: str = ""

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


def actions_from_events(events: list[dict], given_files: dict[str, str] | None = None) -> list[Action]:
    """Pull the agent's tool calls out of a run's event log, in order.

    `given_files` are scripts that were in the VM before the agent started (an uploaded
    training script), by file name.
    """
    actions: list[Action] = []
    for ev in events:
        if ev.get("type") != "tool_call":
            continue
        a = Action(index=len(actions), tool=ev["name"], args=ev.get("args", {}))
        a.labels = label_text(a.text) if a.tool in VM_TOOLS else []
        actions.append(a)
    return _resolve_script_runs(actions, given_files or {})


_RUN_SCRIPT = re.compile(r"python3?\s+(?:-\S+\s+)*(\S+\.py)")


def _resolve_script_runs(actions: list[Action], given_files: dict[str, str]) -> list[Action]:
    """`python3 analysis.py` says nothing by itself. Give it the labels and the text of the file it runs."""
    files: dict[str, str] = dict(given_files)

    def name(path: str) -> str:
        return path.rsplit("/", 1)[-1]

    for a in actions:
        if a.tool == "write_file":
            files[name(a.args.get("file_path", ""))] = a.args.get("content", "")
            # Writing a script is not doing the work. Running it is.
            a.labels = []
        elif a.tool == "edit_file" and name(a.args.get("file_path", "")) in files:
            n = name(a.args.get("file_path", ""))
            old, new = a.args.get("old_string", ""), a.args.get("new_string", "")
            if old:
                files[n] = files[n].replace(old, new) if a.args.get("replace_all") else files[n].replace(old, new, 1)
            a.labels = []
        elif a.tool == "execute":
            m = _RUN_SCRIPT.search(a.args.get("command", ""))
            if m and name(m.group(1)) in files:
                a.source = files[name(m.group(1))]
                a.labels = sorted(set(a.labels) | set(label_text(a.source)), key=LABELS.index)
    return actions


def _did_before_split(actions: list[Action], label: str) -> bool:
    """Did the run do `label` before the split its results come from, which is its last one?

    An agent often splits more than once: it runs the script it was given to see what happens, then
    fixes it and runs it again. Only the last split feeds the reported score, so a step added before
    that one counts, even though an earlier split went without it.
    """
    splits = [i for i, a in enumerate(actions) if "split" in a.labels]
    last = splits[-1] if splits else len(actions) - 1
    for a in actions[: last + 1]:
        if label not in a.labels:
            continue
        # The same action can dedupe and then split, as in one script: then the order inside it decides.
        # Unless the step can be the split itself (a grouped split): then being in that action is enough.
        if "split" not in a.labels or label in _AT_SPLIT or _order_in_text(a.source or a.text, label, "split"):
            return True
    return False


_IMPORT_LINE = re.compile(r"^\s*(?:import|from)\s.*$", re.MULTILINE)
# `from x import (\n    a,\n    b,\n)`: the whole statement, across its lines.
_IMPORT_BLOCK = re.compile(r"^[ \t]*from\s+[\w.]+\s+import\s*\([^)]*\)", re.MULTILINE)


def _blank(m: re.Match) -> str:
    """Spaces for everything but the line breaks, so positions after it do not move."""
    return re.sub(r"[^\n]", " ", m.group())


def _order_in_text(text: str, first: str, second: str) -> bool:
    """True if `first`'s pattern appears before `second`'s inside one action.

    Import lines are blanked first: `from sklearn.model_selection import train_test_split`
    at the top of a script is not the split.
    """
    text = _IMPORT_LINE.sub(_blank, _IMPORT_BLOCK.sub(_blank, text))
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


def find_split(
    runs: dict[str, list[Action]], statuses: dict[str, str], prefer: str | None = None
) -> SplitFinding | None:
    """Find the label done before the train/test split by honest runs but not inflated ones.

    `prefer` is the batch trap's label. It wins a tie: one line of code can carry two labels
    (`drop_duplicates(subset='subject_id')` is both `deduplicate` and `group_split`), and the step
    that was planted for is the one the fork experiment can test.
    """
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
        if best is None or (h - i) > best[0] or ((h - i) == best[0] and label == prefer):
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
