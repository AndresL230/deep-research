"""Robot controllers people upload. A robot batch with `BatchConfig.robot_start == "uploaded"` gives the
controller to every analyst as its `controller.py`, so the agents start from the person's own code and the
investigator traces and fixes that code rather than the built-in one.

The file is only ever parsed here, never run: it runs inside the agents' VMs and, for scoring, on this
server inside the simulator. An upload is saved under `controllers/<id>/` (git-ignored) as
`controller.py` plus `info.json`. Mirrors user_scripts.py.
"""

from __future__ import annotations

import ast
import json
import re
import sys
import uuid

from . import config

ID_PATTERN = r"^ct-[0-9a-f]{8}$"
MAX_UPLOAD_BYTES = 200 * 1024
# The name the file gets in the VM, whatever it was called when uploaded (sim/domain.py FIX_OUTPUT).
VM_NAME = "controller.py"
# Import names available in the robot VMs: the sim image's packages and the uploaded sim package itself.
VM_IMPORTS = {"numpy", "mujoco", "sim", "scipy"}
# What the simulator calls (sim/controllers/template.py).
CLASS_NAME = "Controller"
METHODS = ("reset", "act")


class ControllerError(ValueError):
    """The file cannot be used as a controller. The message is shown to the person."""


def _dir(controller_id: str):
    return config.CONTROLLERS_DIR / controller_id


def third_party_imports(tree: ast.AST) -> list[str]:
    """Top-level names the file imports that are not in Python's standard library."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return sorted(n for n in names if n not in sys.stdlib_module_names)


def interface_problem(tree: ast.AST) -> str | None:
    """Why the file is not a controller the simulator can call, or None when it is.

    A `Controller` class with `reset` and `act` methods, defined directly or inherited: a subclass of another
    controller (`class Controller(_Baseline)`) counts, since the methods may come from the base.
    """
    classes = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == CLASS_NAME]
    if not classes:
        return f"it has no `class {CLASS_NAME}`; see sim/controllers/template.py for the interface"
    cls = classes[-1]
    if cls.bases:
        return None  # the methods may be inherited
    methods = {n.name for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    missing = [m for m in METHODS if m not in methods]
    if missing:
        return f"`class {CLASS_NAME}` is missing the method{'s' if len(missing) > 1 else ''} {', '.join(missing)}"
    return None


def save_upload(name: str, raw: bytes) -> dict:
    """Check an uploaded controller, save it, and return its description."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ControllerError(f"the controller is larger than {MAX_UPLOAD_BYTES // 1024} KB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ControllerError("the file is not text, so it is not a Python controller") from e
    if not text.strip():
        raise ControllerError("the controller is empty")
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError) as e:
        where = f" (line {e.lineno})" if getattr(e, "lineno", None) else ""
        raise ControllerError(f"the file is not valid Python{where}: {getattr(e, 'msg', e)}") from e
    problem = interface_problem(tree)
    if problem:
        raise ControllerError(f"the file is not a controller: {problem}")

    imports = third_party_imports(tree)
    controller_id = "ct-" + uuid.uuid4().hex[:8]
    info = {
        "id": controller_id,
        "name": re.sub(r"[^\w.\- ]", "_", name.strip())[:80] or VM_NAME,
        "lines": len(text.splitlines()),
        "imports": imports,
        # Not installed in the robot VMs. The agents may try to install them or work around them.
        "missing_packages": [n for n in imports if n not in VM_IMPORTS],
    }
    d = _dir(controller_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / VM_NAME).write_text(text)
    (d / "info.json").write_text(json.dumps(info, indent=2))
    return info


def load(controller_id: str) -> tuple[str, dict]:
    """The controller's text and its description."""
    if not controller_id or not re.match(ID_PATTERN, controller_id):
        raise ControllerError(f"unknown controller {controller_id}")
    d = _dir(controller_id)
    if not (d / VM_NAME).is_file():
        raise ControllerError(f"unknown controller {controller_id}")
    return (d / VM_NAME).read_text(), json.loads((d / "info.json").read_text())


def list_controllers() -> list[dict]:
    out = []
    if config.CONTROLLERS_DIR.exists():
        for d in sorted(config.CONTROLLERS_DIR.iterdir()):
            try:
                out.append(json.loads((d / "info.json").read_text()))
            except Exception:  # noqa: BLE001 - a half-written upload is skipped
                continue
    return out
