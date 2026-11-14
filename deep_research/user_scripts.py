"""Training scripts people upload. A batch with `BatchConfig.script` gives the script to every analyst
as its starting point (`train.py` in the VM) instead of having it write one from nothing.

The script is only ever parsed here, never run: it runs inside the agents' VMs.
An upload is saved under `user_scripts/<id>/` (git-ignored) as `train.py` plus `info.json`.
"""

from __future__ import annotations

import ast
import json
import re
import sys
import uuid

from . import config

ID_PATTERN = r"^sc-[0-9a-f]{8}$"
MAX_UPLOAD_BYTES = 200 * 1024
# The name the script gets in the VM, whatever it was called when uploaded.
VM_NAME = "train.py"
# Import names available in the VM: sandboxes.PY_PACKAGES and what they bring along.
VM_IMPORTS = {"pandas", "sklearn", "matplotlib", "numpy", "scipy", "joblib"}


class ScriptError(ValueError):
    """The file cannot be used as a training script. The message is shown to the person."""


def _dir(script_id: str):
    return config.USER_SCRIPTS_DIR / script_id


def third_party_imports(tree: ast.AST) -> list[str]:
    """Top-level names the script imports that are not in Python's standard library."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return sorted(n for n in names if n not in sys.stdlib_module_names)


def save_upload(name: str, raw: bytes) -> dict:
    """Check an uploaded script, save it, and return its description."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ScriptError(f"the script is larger than {MAX_UPLOAD_BYTES // 1024} KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ScriptError("the file is not text, so it is not a Python script") from e
    if not text.strip():
        raise ScriptError("the script is empty")
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError) as e:
        where = f" (line {e.lineno})" if getattr(e, "lineno", None) else ""
        raise ScriptError(f"the file is not valid Python{where}: {getattr(e, 'msg', e)}") from e

    imports = third_party_imports(tree)
    script_id = "sc-" + uuid.uuid4().hex[:8]
    info = {
        "id": script_id,
        "name": re.sub(r"[^\w.\- ]", "_", name.strip())[:80] or VM_NAME,
        "lines": len(text.splitlines()),
        "imports": imports,
        # Not installed in the agents' VMs. The agents may try to install them or work around them.
        "missing_packages": [n for n in imports if n not in VM_IMPORTS],
    }
    d = _dir(script_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / VM_NAME).write_text(text)
    (d / "info.json").write_text(json.dumps(info, indent=2))
    return info


def load(script_id: str) -> tuple[str, dict]:
    """The script's text and its description."""
    d = _dir(script_id)
    if not re.match(ID_PATTERN, script_id) or not (d / VM_NAME).is_file():
        raise ScriptError(f"unknown script {script_id}")
    return (d / VM_NAME).read_text(), json.loads((d / "info.json").read_text())
