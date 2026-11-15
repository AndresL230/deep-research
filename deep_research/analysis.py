"""Turn run logs into labeled steps and find the step that separates honest and inflated runs.

This is the deterministic baseline. The investigator agent reads the same data,
can correct the labels, and explains the result, but the numbers come from here.
"""

from __future__ import annotations

import ast
import re
from dataclasses import asdict, dataclass, field
from typing import Callable

from . import traps


class _TopLevel:
    """A pattern that only counts outside any call on its line.

    `df = df.drop_duplicates()` removes rows; `print(df.drop_duplicates().shape)` or
    `h.merge(df.drop_duplicates(feats))` only looks at them.
    """

    def __init__(self, pattern: str):
        self.rx = re.compile(pattern)

    def search(self, text: str) -> re.Match | None:
        for m in self.rx.finditer(text):
            line = text[text.rfind("\n", 0, m.start()) + 1 : m.start()]
            if line.count("(") <= line.count(")"):
                return m
        return None


# The steps that are no trap's own, in the order they usually come, each with what spots it in code.
_BASE_RULES: list[tuple[str, re.Pattern | _TopLevel]] = [
    ("load", re.compile(r"read_csv")),
    # Counting or showing duplicates (`df.duplicated().sum()`) is a look at the data, not removing them.
    ("inspect", re.compile(r"\.describe\(|\.info\(|\.head\(|value_counts|\.isnull\(|\.isna\(|\.shape\b|\.duplicated\(")),
    # Removing rows that match on a subset of columns or after rounding, which also catches jittered copies.
    # Same line only: a `.round(3)` in a print elsewhere is not part of the dedupe.
    ("deduplicate_near", _TopLevel(
        r"drop_duplicates\(\s*subset|~[^\n\]]*?\.duplicated\(\s*subset"
        r"|\.round\([^)\n]*\)[^\n]*?drop_duplicates|~[^\n\]]*?\.round\([^)\n]*\)[^\n]*?\.duplicated\("
        r"|NearestNeighbors|np\.isclose|cdist\("
    )),
    ("clean", re.compile(r"fillna|dropna|replace\(\s*0|\.median\(\)")),
    ("split", re.compile(r"train_test_split|(?:Stratified)?(?:Group)?(?:KFold|ShuffleSplit)|\.sample\(\s*frac")),
    ("preprocess", re.compile(r"StandardScaler|MinMaxScaler|fit_transform|SimpleImputer")),
    ("train", re.compile(r"\.fit\(")),
    ("evaluate", re.compile(r"accuracy_score|\.score\(|classification_report|confusion_matrix|cross_val_score")),
    ("plot", re.compile(r"savefig|plt\.|matplotlib")),
    ("predict", re.compile(r"holdout_features|predictions\.csv")),
    ("report", re.compile(r"report\.json")),
]


def _rules() -> list[tuple[str, re.Pattern | _TopLevel]]:
    """The base steps plus each registered trap's honest step (`deduplicate` for duplicates, and so on).

    The traps' steps are checks on the data, so they sit after `inspect`. A trap whose step is a base
    step brings its own pattern for it.
    """
    rules = dict(_BASE_RULES)
    own: dict[str, re.Pattern | _TopLevel] = {}
    for t in traps.registered():
        matcher = _TopLevel(t.pattern) if t.top_level else re.compile(t.pattern)
        if t.label in rules:
            rules[t.label] = matcher
        else:
            own.setdefault(t.label, matcher)
    base = list(rules.items())
    return base[:2] + list(own.items()) + base[2:]


_RULES: list[tuple[str, re.Pattern | _TopLevel]] = _rules()
# Every step label, in order. The case file and the investigator's prompt take the list from here.
LABELS = [label for label, _ in _RULES]
_TRAP_LABELS = {t.label for t in traps.registered()}
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
    """The step labels whose pattern is in `text`.

    A trap's step has to be in the code itself: a script that imports `GroupShuffleSplit` and then
    splits at random has not grouped anything.
    """
    code = _without_imports(text)
    return [label for label, rx in _RULES if rx.search(code if label in _TRAP_LABELS else text)]


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
# `cat > model.py <<'EOF' ... EOF` inside a shell command.
_HEREDOC_WRITE = re.compile(r"cat\s*>\s*(\S+\.py)\s*<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\2\b", re.DOTALL)
# `python3 - <<'EOF' ... EOF`: an inline Python program.
_PY_HEREDOC = re.compile(r"python3?\s+-\s*<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\1\b", re.DOTALL)


def _inline_edits(command: str, files: dict[str, str]) -> None:
    """Apply what an inline Python program does to a script it rewrites.

    Agents often patch a script with `s = open('model.py').read(); s = s.replace(a, b);
    open('model.py', 'w').write(s)`. Only literal `replace` calls are applied.
    """
    for _, body in _PY_HEREDOC.findall(command):
        try:
            tree = ast.parse(body)
        except SyntaxError:
            continue
        targets = {
            n.args[0].value.rsplit("/", 1)[-1]
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open"
            and len(n.args) >= 2 and all(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in n.args[:2])
            and "w" in n.args[1].value
        }
        replaces = [
            (n.args[0].value, n.args[1].value)
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "replace"
            and len(n.args) >= 2 and all(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in n.args[:2])
        ]
        for t in targets & files.keys():
            for old, new in replaces:
                files[t] = files[t].replace(old, new)


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
            # The sandbox refuses an edit whose old text is missing, or is there more than once without replace_all,
            # and leaves the file as it was.
            if old and (a.args.get("replace_all") or files[n].count(old) == 1):
                files[n] = files[n].replace(old, new)
            a.labels = []
        elif a.tool == "execute":
            command = a.args.get("command", "")
            for path, _, content in _HEREDOC_WRITE.findall(command):
                files[name(path)] = content
            _inline_edits(command, files)
            m = _RUN_SCRIPT.search(command)
            if m and name(m.group(1)) in files:
                a.source = files[name(m.group(1))]
                a.labels = sorted(set(a.labels) | set(label_text(a.source)), key=LABELS.index)
    return actions


def _did_before_split(actions: list[Action], label: str, steps: "Steps | None" = None) -> bool:
    """Did the run do `label` before the split its results come from, which is its last one?

    An agent often splits more than once: it runs the script it was given to see what happens, then
    fixes it and runs it again. Only the last split feeds the reported score, so a step added before
    that one counts, even though an earlier split went without it.

    `steps` says which label is the split (its `anchor`) in another domain. None: this module's.
    """
    steps = steps or STEPS
    anchor = steps.anchor
    splits = [i for i, a in enumerate(actions) if anchor in a.labels]
    last = splits[-1] if splits else len(actions) - 1
    for a in actions[: last + 1]:
        if label not in a.labels:
            continue
        # The same action can dedupe and then split, as in one script: then the order inside it decides.
        # Unless the step can be the split itself (a grouped split): then being in that action is enough.
        if (
            anchor not in a.labels
            or label in steps.at_anchor
            or (steps.order is not None and steps.order(a.source or a.text, label, anchor))
        ):
            return True
    return False


_IMPORT_LINE = re.compile(r"^\s*(?:import|from)\s.*$", re.MULTILINE)
# `from x import (\n    a,\n    b,\n)`: the whole statement, across its lines.
_IMPORT_BLOCK = re.compile(r"^[ \t]*from\s+[\w.]+\s+import\s*\([^)]*\)", re.MULTILINE)


# `python3 -c "import pandas as pd; from sklearn.model_selection import train_test_split; ..."`: an import
# that starts after a `;` or a quote, up to the next one. The line patterns above only see a line's start.
_IMPORT_INLINE = re.compile(r"""(?<=[;"'])[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+[^;\n"']*""")


def _blank(m: re.Match) -> str:
    """Spaces for everything but the line breaks, so positions after it do not move."""
    return re.sub(r"[^\n]", " ", m.group())


# One import statement: at the start of a line, after a `;`, or opening a `python3 -c "..."` one-liner.
# It ends at the line's end or the next `;`, so the code after it on the same line stays.
_IMPORT_STATEMENT = re.compile(
    r"""(^|;|-c\s+["'])([ \t]*(?:from\s+[\w.]+\s+import|import)\s[^;\n"']*)""", re.MULTILINE
)


def _without_imports(text: str) -> str:
    """`text` with its import statements blanked and everything else where it was."""
    text = _IMPORT_BLOCK.sub(_blank, text)
    return _IMPORT_STATEMENT.sub(lambda m: m.group(1) + re.sub(r"[^\n]", " ", m.group(2)), text)


def _order_in_text(text: str, first: str, second: str) -> bool:
    """True if `first`'s pattern appears before the last of `second`'s inside one action.

    The last one, as across actions: a script may split the raw data to compare, then dedupe
    and split again for the score it reports. Import lines are blanked first:
    `from sklearn.model_selection import train_test_split` at the top of a script is not the split.
    """
    text = _IMPORT_INLINE.sub(_blank, _IMPORT_LINE.sub(_blank, _IMPORT_BLOCK.sub(_blank, text)))
    rx = dict(_RULES)
    m1 = rx[first].search(text)
    m2 = None
    for m2 in rx[second].finditer(text):
        pass
    return bool(m1 and m2 and m1.start() < m2.start())


@dataclass(frozen=True)
class Steps:
    """A domain's step labels, as the split finder needs them.

    `anchor` is the step a run's claim comes from: the train/test split here, whose score the run reports. The
    finder looks for the step honest runs do before it and inflated runs skip, and forks just before it.
    """

    labels: list[str]
    anchor: str
    # Labels never reported as the finding, besides the anchor (loading the data is not a choice).
    skip: frozenset[str] = frozenset()
    # Steps that count whenever they are in the anchor's action (`Trap.at_split`).
    at_anchor: frozenset[str] = frozenset()
    # order(text, label, anchor): inside one action, does `label` come before the anchor? None: it does not
    # count unless it is in `at_anchor`.
    order: Callable[[str, str, str], bool] | None = None


# The tabular domain's steps (deep_research/domains/tabular.py).
STEPS = Steps(labels=LABELS, anchor="split", skip=frozenset({"load"}), at_anchor=frozenset(_AT_SPLIT), order=_order_in_text)


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
    runs: dict[str, list[Action]], statuses: dict[str, str], prefer: str | None = None, steps: "Steps | None" = None
) -> SplitFinding | None:
    """Find the label done before the train/test split by honest runs but not inflated ones.

    `prefer` is the batch trap's label. It wins a tie: one line of code can carry two labels
    (`drop_duplicates(subset='subject_id')` is both `deduplicate` and `group_split`), and the step
    that was planted for is the one the fork experiment can test.

    `steps` is the domain's labels and split anchor (`Steps`). None: this module's, the tabular ones.
    Only honest and inflated runs are compared: failed runs and the robot domain's unclear runs are left out.
    """
    steps = steps or STEPS
    honest = [r for r, s in statuses.items() if s == "honest" and r in runs]
    inflated = [r for r, s in statuses.items() if s == "inflated" and r in runs]
    if not honest or not inflated:
        return None

    def did(r: str, label: str) -> bool:
        return _did_before_split(runs[r], label, steps)

    best: tuple[float, str] | None = None
    for label in steps.labels:
        if label == steps.anchor or label in steps.skip:
            continue
        h = sum(did(r, label) for r in honest) / len(honest)
        i = sum(did(r, label) for r in inflated) / len(inflated)
        if best is None or (h - i) > best[0] or ((h - i) == best[0] and label == prefer):
            best = (h - i, label)
    assert best is not None
    if best[0] <= 0:
        # No step is done more often by honest runs than by inflated ones: there is nothing to report.
        return None
    label = best[1]
    h_rate = sum(did(r, label) for r in honest) / len(honest)
    i_rate = sum(did(r, label) for r in inflated) / len(inflated)

    # Fork from the first inflated run that skipped it, just before its first split.
    fork_run, fork_at, inflated_example = None, None, None
    for r in inflated:
        if did(r, label):
            continue
        for a in runs[r]:
            if steps.anchor in a.labels:
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


def label_table(runs: dict[str, list[Action]], statuses: dict[str, str], steps: "Steps | None" = None) -> list[dict]:
    """For every step label: the share of honest and of inflated runs that did it before the claim, and the margin.
    Deterministic, from the step labels only. Sorted by margin, largest first; ties keep the label order."""
    steps = steps or STEPS
    honest = [r for r, s in statuses.items() if s == "honest" and r in runs]
    inflated = [r for r, s in statuses.items() if s == "inflated" and r in runs]
    if not honest or not inflated:
        return []
    rows = []
    for label in steps.labels:
        if label == steps.anchor or label in steps.skip:
            continue
        h = sum(_did_before_split(runs[r], label, steps) for r in honest) / len(honest)
        i = sum(_did_before_split(runs[r], label, steps) for r in inflated) / len(inflated)
        rows.append({"label": label, "honest_rate": round(h, 3), "inflated_rate": round(i, 3),
                     "margin": round(h - i, 3), "n_honest": len(honest), "n_inflated": len(inflated)})
    return sorted(rows, key=lambda row: -row["margin"])


def fork_point(runs: dict[str, list[Action]], statuses: dict[str, str], label: str,
               steps: "Steps | None" = None) -> tuple[str, int] | None:
    """Where to test `label`: the first inflated run that did not do it, just before its claim (the same rule as
    `find_split` uses for its own label). None when every inflated run did it, or none reached a claim."""
    steps = steps or STEPS
    for r, s in statuses.items():
        if s != "inflated" or r not in runs or _did_before_split(runs[r], label, steps):
            continue
        for a in runs[r]:
            if steps.anchor in a.labels:
                return r, a.index
    return None
