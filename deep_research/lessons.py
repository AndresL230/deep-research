"""Approved lessons reaching new analysts (MASTER_PLAN Phase 5.2).

An approved `propose_lesson` is a skill on disk, `skills/learned/<name>/SKILL.md` (`investigator.write_lesson`). A
lesson is for one domain, the one it was learned in (its `domain:` line; a lesson written before that line is a
tabular one): a rule about splitting rows means nothing to a robot controller. A batch with `lessons="learned"` hands
every analyst the skills of its own domain:

- `skills`: through the Deep Agents `skills=` mechanism, on a read-only `/skills/learned/` route next to the VM
  (`analyst.build_analyst(learned_dir=...)`). Used when the analyst's backend is a sandbox, which a CompositeBackend
  can wrap without losing `execute`.
- `prompt`: each approved rule appended to the analyst's system prompt, when the backend cannot serve skills.

Which path was used is logged and saved on each run (`runs.<id>.lessons`).
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from deepagents.backends.protocol import SandboxBackendProtocol

logger = logging.getLogger(__name__)

PROMPT_HEADER = "Lessons from earlier batches, each approved by a person. Follow them:"
# The domain of a lesson whose SKILL.md names none: lessons were only learned in tabular batches before the line.
DEFAULT_DOMAIN = "tabular"


def learned_dir() -> Path:
    """Where approved lessons are saved: the investigator's `LEARNED_DIR` (tests point it elsewhere)."""
    from .agents import investigator

    return Path(investigator.LEARNED_DIR)


def approved(folder: Path | None = None, domain: str | None = None) -> list[dict]:
    """Every approved lesson on disk, by name: `[{name, rule, path, learned_from, domain}]` (`learned_from`: the batch
    it came from, from the SKILL.md's "Learned from batch" line, or None). A lesson exists only once a person approved
    it (`write_lesson` runs on approval), so every SKILL.md here is approved. With `domain`, only that domain's."""
    folder = learned_dir() if folder is None else folder
    out = []
    for path in sorted(folder.glob("*/SKILL.md")) if folder.is_dir() else []:
        text = path.read_text()
        body = text.split("---", 2)[2] if text.startswith("---") and text.count("---") >= 2 else text
        lines = [ln.strip() for ln in body.splitlines() if ln.strip() and not ln.startswith("#")
                 and not ln.startswith("Learned from batch")]
        m = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
        src = re.search(r"^Learned from batch ([A-Za-z0-9._-]+?)[,.\s]", text, re.MULTILINE)
        dom = re.search(r"^domain:\s*([A-Za-z0-9_-]+)\s*$", text.split("---", 2)[1] if text.startswith("---") else "", re.MULTILINE)
        lesson_domain = dom.group(1) if dom else DEFAULT_DOMAIN
        if domain is not None and lesson_domain != domain:
            continue
        out.append({"name": (m.group(1).strip() if m else path.parent.name), "rule": " ".join(lines)[:1000],
                    "path": str(path), "learned_from": src.group(1) if src else None, "domain": lesson_domain})
    return out


def only(rules: list[dict], folder: Path, into: Path) -> Path:
    """A skills folder holding just `rules`: `folder` itself when it holds no others, else `into`, refilled with
    copies of theirs (the Deep Agents skills route serves a whole folder)."""
    if len(rules) == len(list(folder.glob("*/SKILL.md"))):
        return folder
    if into.exists():
        shutil.rmtree(into)
    for r in rules:
        src = Path(r["path"]).parent
        shutil.copytree(src, into / src.name)
    return into


def with_prompt(system_prompt: str, rules: list[dict]) -> str:
    """The system prompt with each rule appended (the `prompt` path)."""
    if not rules:
        return system_prompt
    return system_prompt + "\n\n" + PROMPT_HEADER + "\n" + "\n".join(f"- {r['name']}: {r['rule']}" for r in rules)


def for_analyst(setting: str, backend, system_prompt: str, who: str, folder: Path | None = None,
                domain: str | None = None, scratch: Path | None = None) -> tuple[str, Path | None, dict | None]:
    """What one analyst gets for the batch's `lessons` setting: (system prompt, skills folder or None, record).

    Only the lessons of `domain` (the batch's), when given; `scratch` is where a skills folder of just those is made
    when the learned folder also holds other domains' lessons. `record` is None with lessons off; otherwise
    `{"setting", "path": "skills" | "prompt" | "none", "names"}`, saved on the run so the case file says how the
    lessons reached it.
    """
    if setting != "learned":
        return system_prompt, None, None
    folder = learned_dir() if folder is None else folder
    rules = approved(folder, domain)
    names = [r["name"] for r in rules]
    if not rules:
        logger.info("%s: lessons are on but no %slesson has been approved yet (%s)", who,
                    f"{domain} " if domain else "", folder)
        return system_prompt, None, {"setting": setting, "path": "none", "names": []}
    if isinstance(backend, SandboxBackendProtocol):
        served = only(rules, folder, scratch) if scratch is not None else folder
        logger.info("%s: %d learned lessons as Deep Agents skills from %s", who, len(rules), served)
        return system_prompt, served, {"setting": setting, "path": "skills", "names": names}
    logger.info("%s: the backend cannot serve skills, so %d learned lessons are appended to the system prompt",
                who, len(rules))
    return with_prompt(system_prompt, rules), None, {"setting": setting, "path": "prompt", "names": names}
