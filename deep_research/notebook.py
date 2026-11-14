"""The investigator's notebook: what earlier investigations of the same domain found, one short entry per batch.

One file per domain, `<batches root>/_memory/<domain>/AGENTS.md`, so the tabular and robot notebooks never mix. The
investigator gets it in two ways (agents/investigator.py):

- `memory=["/memory/AGENTS.md"]`: deepagents' MemoryMiddleware loads it into the system prompt when the
  investigation starts.
- `/memory/` in its CompositeBackend is `NotebookBackend` on the domain's folder: the only place on disk the
  investigator may write, and only that one file. Subagents may not write there at all.

`NotebookBackend` keeps the file in shape whatever the model writes: the header stays, the `<!-- end -->` marker the
prompt appends before stays last, a batch has at most one entry (a later one replaces it), and past `MAX_LINES`
lines the oldest entries go. It also refuses a write that would put a run's hidden data in the notebook (`leak`):
the hidden can positions of a robot batch, or a holdout's labels.

An entry, as the prompt asks for it:

    ## 2026-11-14 batch 1114-091608-d825
    - split: tune_params, honest 0.80 of 10 vs inflated 0.00 of 1
    - forks: control 3/4, forced 0/4, placebo 3/4
    - surprising: ...
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from deepagents.backends import FilesystemBackend
from deepagents.backends.protocol import EditResult, FileUploadResponse, WriteResult
from deepagents.backends.utils import perform_string_replacement

FILE = "AGENTS.md"
# The path the investigator sees it at.
MOUNT = "/memory/"
PATH = MOUNT + FILE
MAX_LINES = 200
END = "<!-- end -->"
_DOMAIN = re.compile(r"^[a-z0-9_]{1,40}$")
_ENTRY = re.compile(r"^## ", re.MULTILINE)
_BATCH_ID = re.compile(r"batch\s+([0-9]{4}-[0-9]{6}-[0-9a-f]{4}|\S+)")
# One lock per notebook file: two batches of a domain can finish at once in one server.
_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


def memory_dir(batches_root: Path) -> Path:
    return batches_root / "_memory"


def notebook_path(batches_root: Path, domain: str) -> Path:
    """`<batches root>/_memory/<domain>/AGENTS.md`. Raises ValueError for a name that is not a plain domain name."""
    if not _DOMAIN.match(domain or ""):
        raise ValueError(f"not a domain name: {domain!r}")
    return memory_dir(batches_root) / domain / FILE


def header(domain: str) -> str:
    return (
        f"# Investigator notebook: {domain}\n\n"
        "What earlier investigations of this domain found, oldest first. One short entry per batch.\n\n"
    )


def ensure(path: Path, domain: str) -> None:
    """Create the notebook with its header and end marker if it does not exist yet."""
    with _lock(path):
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(header(domain) + END + "\n")


def tidy(text: str, domain: str, max_lines: int = MAX_LINES) -> str:
    """The notebook in shape: header, entries oldest first with one per batch, the end marker last, at most
    `max_lines` lines (the oldest entries go first; a single entry longer than that is cut)."""
    text = text.replace(END, "").rstrip() + "\n"
    first = _ENTRY.search(text)
    head = text[: first.start()] if first else text
    if not head.strip():
        head = header(domain)
    head = head.rstrip() + "\n\n"
    entries = [e.rstrip() for e in _ENTRY.split(text[first.start():])[1:]] if first else []
    entries = ["## " + e for e in entries if e.strip()]
    # One entry per batch: a later entry for the same batch (it was investigated again) replaces the earlier one.
    seen: dict[str, int] = {}
    kept: list[str | None] = []
    for e in entries:
        m = _BATCH_ID.search(e.splitlines()[0])
        key = m.group(1) if m else None
        if key is not None and key in seen:
            kept[seen[key]] = None
        if key is not None:
            seen[key] = len(kept)
        kept.append(e)
    entries = [e for e in kept if e is not None]

    def size() -> int:
        return len(head.splitlines()) + sum(len(e.splitlines()) + 1 for e in entries) + 1

    while len(entries) > 1 and size() > max_lines:
        entries.pop(0)
    if entries and size() > max_lines:
        room = max(1, max_lines - len(head.splitlines()) - 2)
        entries[0] = "\n".join(entries[0].splitlines()[:room])
    body = "".join(e + "\n\n" for e in entries)
    return head + body + END + "\n"


# ---- hidden data ----

_NUM = re.compile(r"-?\d*\.\d+|-?\d+")


def hidden_positions(task_dir: Path) -> list[tuple[float, float]]:
    """The hidden can positions of a robot batch's task, or [] (any other domain, or no file)."""
    out: list[tuple[float, float]] = []
    for f in sorted(task_dir.glob("*hidden_positions*.json")) if task_dir.is_dir() else []:
        try:
            for xy in json.loads(f.read_text()):
                out.append((float(xy[0]), float(xy[1])))
        except (OSError, ValueError, TypeError, IndexError, KeyError):
            continue
    return out


def leak(text: str, positions: list[tuple[float, float]]) -> str | None:
    """Why `text` must not go in the notebook, or None.

    A pair of numbers in a row that is one of the hidden can positions (to 2 mm), or a long run of 0/1 values (a
    holdout's labels).
    """
    nums = []
    for m in _NUM.finditer(text):
        try:
            nums.append(float(m.group()))
        except ValueError:
            continue
    for a, b in zip(nums, nums[1:]):
        for x, y in positions:
            if abs(a - x) <= 0.002 and abs(b - y) <= 0.002:
                return "it names a hidden can position; write what failed, not where"
    if re.search(r"(?:\b[01]\b[\s,;]+){15,}\b[01]\b", text):
        return "it looks like a list of labels; never copy holdout labels"
    return None


class NotebookBackend(FilesystemBackend):
    """`/memory/` for the investigator: one domain's notebook folder, where only `AGENTS.md` can be written.

    Every write and edit is checked for hidden data before it lands, and the file is tidied after (`tidy`).
    Deleting and uploading are refused.
    """

    def __init__(self, path: Path, domain: str, positions: list[tuple[float, float]] | None = None):
        ensure(path, domain)
        super().__init__(root_dir=path.parent, virtual_mode=True)
        self.path, self.domain, self.positions = path, domain, list(positions or [])

    def _refuse(self, file_path: str) -> str | None:
        if file_path.lstrip("/") != FILE:
            return f"Error: only {PATH} can be written here"
        return None

    def write(self, file_path: str, content: str) -> WriteResult:
        if (err := self._refuse(file_path)) or (err := _leak_error(content, self.positions)):
            return WriteResult(error=err)
        with _lock(self.path):
            self.path.write_text(tidy(content, self.domain))
        return WriteResult(path=file_path)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:  # noqa: FBT001, FBT002
        if (err := self._refuse(file_path)) or (err := _leak_error(new_string, self.positions)):
            return EditResult(error=err)
        with _lock(self.path):
            current = self.path.read_text() if self.path.is_file() else ""
            result = perform_string_replacement(current, old_string, new_string, replace_all)
            if isinstance(result, str):
                return EditResult(error=result)
            content, n = result
            self.path.write_text(tidy(content, self.domain))
        return EditResult(path=file_path, occurrences=int(n))

    def delete(self, file_path: str):
        from deepagents.backends.protocol import DeleteResult

        return DeleteResult(error="Error: the notebook cannot be deleted")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=p, error="permission_denied") for p, _ in files]


def _leak_error(text: str, positions: list[tuple[float, float]]) -> str | None:
    why = leak(text, positions)
    return None if why is None else f"Error: not saved to the notebook: {why}"


def _lock(path: Path) -> threading.Lock:
    with _LOCKS_LOCK:
        return _LOCKS.setdefault(path.resolve(), threading.Lock())


def read(batches_root: Path, domain: str) -> str | None:
    """The notebook's text, or None when the domain has none yet."""
    path = notebook_path(batches_root, domain)
    return path.read_text() if path.is_file() else None
