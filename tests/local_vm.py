"""A local folder in place of each Daytona VM, so the batch pipeline can run offline.

`install_local_vms` replaces every VM call the orchestrator makes. The agent's shell commands then run
for real in a temp folder, with `python3` resolving to the interpreter that has pandas and scikit-learn.
`replay_actions` is left as the real function: it rebuilds a VM by re-running recorded commands.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from deepagents.backends import LocalShellBackend

from deep_research import batch as batch_mod
from deep_research import sandboxes
from deep_research.config import VM_WORKSPACE
from deep_research.task import OUTPUT_FILES

VM_HOME = "/home/daytona"


class LocalVM:
    """A local folder standing in for one Daytona VM."""

    def __init__(self, label: str, root: Path, make: bool = True):
        self.id, self.label, self.dir = f"vm-{label}", label, root / label
        self.workspace = self.dir / VM_WORKSPACE.lstrip("/")
        if make:
            (self.workspace / "live").mkdir(parents=True)


class LocalVMBackend(LocalShellBackend):
    """What `DaytonaSandbox(sandbox=vm)` is in production, on the local folder."""

    def __init__(self, *, sandbox: LocalVM, **_):
        self.vm = sandbox
        venv_bin = str(Path(sys.executable).parent)
        super().__init__(root_dir=sandbox.dir, virtual_mode=True, inherit_env=True,
                         env={"PATH": f"{venv_bin}{os.pathsep}{os.environ.get('PATH', '')}"})

    def execute(self, command, *, timeout=None):
        return super().execute(command.replace(VM_HOME, f"{self.vm.dir}{VM_HOME}"), timeout=timeout)


def install_local_vms(monkeypatch, tmp_path: Path) -> dict:
    """Point every VM call at local folders. Returns a log of what was created, forked and stopped."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy")
    root = tmp_path / "vms"
    log: dict = {"root": root, "created": [], "stopped": [], "forked": []}

    def create_vm(label):
        log["created"].append(label)
        return LocalVM(label, root)

    def load_task(sb, task):
        # Only what production copies into a VM: the trapped data and the holdout features. Never the labels.
        shutil.copy(task.data, sb.workspace / "data.csv")
        shutil.copy(task.holdout_features, sb.workspace / "holdout_features.csv")

    def download_outputs(sb, dest):
        dest.mkdir(parents=True, exist_ok=True)
        for name in OUTPUT_FILES:
            if (sb.workspace / name).exists():
                shutil.copy(sb.workspace / name, dest / name)

    def fork_vm(sb, name=None):
        vm = LocalVM(name, root, make=False)
        shutil.copytree(sb.dir, vm.dir)
        log["forked"].append(name)
        return vm

    patches = {
        "create_vm": create_vm, "load_task": load_task, "download_outputs": download_outputs, "fork_vm": fork_vm,
        "start_lab_page": lambda sb: f"https://lab.invalid/{sb.label}",
        "download_charts": lambda sb, dest: [],
        "stop_vm": lambda sb: log["stopped"].append(sb.label),
        # A finished VM is deleted, which also ends its billing. Recorded the same way as a stop.
        "delete_vm": lambda sb: log["stopped"].append(sb.label),
    }
    for name, fn in patches.items():
        monkeypatch.setattr(batch_mod.vms, name, fn)
    monkeypatch.setattr(batch_mod, "DaytonaSandbox", LocalVMBackend)
    monkeypatch.setattr(sandboxes, "DaytonaSandbox", LocalVMBackend)
    return log


def model_script(dedupe: bool) -> str:
    """One shell command that writes and runs a script: split, train, and write every output file.
    `dedupe` is the only difference between the honest and the careless version."""
    dedupe_line = "df = df.drop_duplicates().reset_index(drop=True)\n" if dedupe else ""
    return f"""cd {VM_WORKSPACE} && cat > model.py <<'PY'
import json
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

df = pd.read_csv("data.csv")
{dedupe_line}train, test = train_test_split(df, test_size=0.2, random_state=0, stratify=df["outcome"])
train.to_csv("train.csv", index=False)
test.to_csv("test.csv", index=False)
feats = [c for c in df.columns if c != "outcome"]
model = RandomForestClassifier(n_estimators=60, random_state=0).fit(train[feats], train["outcome"])
acc = float((model.predict(test[feats]) == test["outcome"]).mean())
json.dump({{"test_accuracy": acc, "model": "random forest", "notes": "offline test"}}, open("report.json", "w"))
hold = pd.read_csv("holdout_features.csv")
pd.DataFrame({{"prediction": model.predict(hold[feats]).astype(int)}}).to_csv("predictions.csv", index=False)
print("test accuracy", round(acc, 4))
PY
python3 model.py"""


LOOK = f"cd {VM_WORKSPACE} && head -3 data.csv && wc -l data.csv"
COUNT_DUPLICATES = (f"cd {VM_WORKSPACE} && python3 -c \"import pandas as pd; "
                    "print('dups', pd.read_csv('data.csv').duplicated().sum())\"")
