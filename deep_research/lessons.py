"""Approved lessons reaching new analysts (MASTER_PLAN Phase 5.2).

An approved `propose_lesson` is a skill on disk, `skills/learned/<name>/SKILL.md` (`investigator.write_lesson`). A
batch with `lessons="learned"` hands every analyst those skills:

- `skills`: through the Deep Agents `skills=` mechanism, on a read-only `/skills/learned/` route next to the VM
  (`analyst.build_analyst(learned_dir=...)`). Used when the analyst's backend is a sandbox, which a CompositeBackend
  can wrap without losing `execute`.
- `prompt`: each approved rule appended to the analyst's system prompt, when the backend cannot serve skills.

Which path was used is logged and saved on each run (`runs.<id>.lessons`).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from deepagents.backends.protocol import SandboxBackendProtocol

logger = logging.getLogger(__name__)

PROMPT_HEADER = "Lessons from earlier batches, each approved by a person. Follow them:"


def learned_dir() -> Path:
    """Where approved lessons are saved: the investigator's `LEARNED_DIR` (tests point it elsewhere)."""
    from .agents import investigator

    return Path(investigator.LEARNED_DIR)


def approved(folder: Path | None = None) -> list[dict]:
    """Every approved lesson on disk, by name: `[{name, rule, path}]`. A lesson exists only once a person approved it
    (`write_lesson` runs on approval), so every SKILL.md here is approved."""
    folder = learned_dir() if folder is None else folder
    out = []
    for path in sorted(folder.glob("*/SKILL.md")) if folder.is_dir() else []:
        text = path.read_text()
        body = text.split("---", 2)[2] if text.startswith("---") and text.count("---") >= 2 else text
        lines = [ln.strip() for ln in body.splitlines() if ln.strip() and not ln.startswith("#")
                 and not ln.startswith("Learned from batch")]
        m = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
        out.append({"name": (m.group(1).strip() if m else path.parent.name), "rule": " ".join(lines)[:1000],
                    "path": str(path)})
    return out


def with_prompt(system_prompt: str, rules: list[dict]) -> str:
    """The system prompt with each rule appended (the `prompt` path)."""
    if not rules:
        return system_prompt
    return system_prompt + "\n\n" + PROMPT_HEADER + "\n" + "\n".join(f"- {r['name']}: {r['rule']}" for r in rules)


def for_analyst(setting: str, backend, system_prompt: str, who: str,
                folder: Path | None = None) -> tuple[str, Path | None, dict | None]:
    """What one analyst gets for the batch's `lessons` setting: (system prompt, skills folder or None, record).

    `record` is None with lessons off; otherwise `{"setting", "path": "skills" | "prompt" | "none", "names"}`, saved on
    the run so the case file says how the lessons reached it.
    """
    if setting != "learned":
        return system_prompt, None, None
    folder = learned_dir() if folder is None else folder
    rules = approved(folder)
    names = [r["name"] for r in rules]
    if not rules:
        logger.info("%s: lessons are on but no lesson has been approved yet (%s is empty)", who, folder)
        return system_prompt, None, {"setting": setting, "path": "none", "names": []}
    if isinstance(backend, SandboxBackendProtocol):
        logger.info("%s: %d learned lessons as Deep Agents skills from %s", who, len(rules), folder)
        return system_prompt, folder, {"setting": setting, "path": "skills", "names": names}
    logger.info("%s: the backend cannot serve skills, so %d learned lessons are appended to the system prompt",
                who, len(rules))
    return with_prompt(system_prompt, rules), None, {"setting": setting, "path": "prompt", "names": names}
