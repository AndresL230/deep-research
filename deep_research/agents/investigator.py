"""The investigator: reads the batch through the case file, names the suspect step,
asks for the fork experiment, and writes the verdict.

Write access is narrow on purpose:
- `/case/`, `/runs/` and `/skills/` are readable through the file tools but
  `write_file` and `edit_file` are denied there.
- The only way to change the case file is the `record_*` tools, and each one
  writes a single section and checks its input.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from deepagents import FilesystemPermission, SubAgent, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from ..analysis import LABELS
from ..config import SKILLS_DIR

if TYPE_CHECKING:
    from ..batch import Batch

MAIN_PROMPT = f"""You investigate why some runs of a data science agent reported inflated results.

Each run did the same task on the same data, with duplicate rows planted in it. `honest` runs reported a test accuracy close to the true accuracy on clean held-out data. `inflated` runs reported much more than they really got.

Read `/case/case.json` first. Then:
1. Ask the `step-tagger` subagent to check the step labels of a few honest and a few inflated runs.
2. Ask the `hypothesis` subagent to compare the groups and record the suspect step.
3. Call `request_forks` to run the experiment that tests it. A person approves the cost first.
4. Read the fork results, then call `record_verdict` with one plain sentence and the control and forced counts.
   When the experiment ran a `placebo` or a `show` arm, say in the sentence what they add: a `placebo` that inflates
   like `control` means the forced step did the work rather than the interruption, and a `show` arm that comes out
   honest means the runs could fix the problem once they saw it.

Step labels are always from this list: {LABELS}.
Use the `method-errors` skill. Do not claim a cause unless the fork results support it. If they do not, say what they show.
"""

TAGGER_PROMPT = f"""You label the steps of data science runs. For each run you are given, read `/runs/<id>/actions.json`.
Each action already has rule-based labels. Fix any that are wrong, using only these labels: {LABELS}.
Save each run's labels with `record_step_labels` (a list with one list of labels per action, in order). Reply with which runs you saved and any labels you changed."""

HYPOTHESIS_PROMPT = """You compare honest and inflated runs to find the step that separates them.
Read `/case/case.json` (the `runs`, `step_labels` and `split` sections) and the actions of a few runs in each group.
Look at what each run did right before its first train/test split.
Record exactly one hypothesis with `record_hypothesis`, quoting one honest action and one inflated action. Reply with the hypothesis in one sentence."""


def build_investigator(batch: "Batch", model: str):
    case = batch.case

    @tool
    def record_step_labels(run_id: str, labels: list[list[str]]) -> str:
        """Save the corrected step labels for one run: one list of labels per action, in order."""
        return case.record_step_labels(run_id, labels)

    @tool
    def record_hypothesis(step_label: str, honest_action: str, inflated_action: str, evidence: str) -> str:
        """Save the suspect step: its label, one honest and one inflated action quoted from the logs, and the evidence."""
        return case.record_hypothesis(step_label, honest_action, inflated_action, evidence)

    @tool
    async def request_forks(n_per_arm: int = 4) -> str:
        """Run the fork experiment on the suspect step. Rebuilds an inflated run just before its train/test split,
        then continues `n_per_arm` copies in each arm. `control` continues unchanged and `forced` has the step done
        for it. When the batch is configured for them there are two more: `placebo` runs a harmless command, so
        `forced` is not the only arm carrying an extra tool call in its history, and `show` is told what `forced`
        fixes and left to decide for itself. Needs approval.

        Read every arm the result reports. `show` against `control` says whether the runs simply never noticed the
        problem; `forced` against `placebo` is the cleanest measure of what doing the step is worth."""
        return await batch.run_forks(n_per_arm)

    @tool
    def record_verdict(sentence: str, step_label: str, control_inflated: int, control_total: int,
                       forced_inflated: int, forced_total: int) -> str:
        """Save the final verdict: one plain sentence plus the inflated counts from both arms of the fork experiment."""
        return case.record_verdict(
            sentence,
            step_label,
            {
                "control_inflated": control_inflated,
                "control_total": control_total,
                "forced_inflated": forced_inflated,
                "forced_total": forced_total,
            },
        )

    read_only = [FilesystemPermission(operations=["write"], paths=["/case/**", "/runs/**", "/skills/**"], mode="deny")]

    subagents: list[SubAgent] = [
        {
            "name": "step-tagger",
            "description": "Checks and corrects the step labels of given runs and saves them.",
            "system_prompt": TAGGER_PROMPT,
            "tools": [record_step_labels],
            "permissions": read_only,
        },
        {
            "name": "hypothesis",
            "description": "Compares honest and inflated runs and records the suspect step.",
            "system_prompt": HYPOTHESIS_PROMPT,
            "tools": [record_hypothesis],
            "permissions": read_only,
        },
    ]

    backend = CompositeBackend(
        default=StateBackend(),
        routes={
            "/case/": FilesystemBackend(root_dir=batch.dir / "case", virtual_mode=True),
            "/runs/": FilesystemBackend(root_dir=batch.runs_dir, virtual_mode=True),
            "/skills/": FilesystemBackend(root_dir=SKILLS_DIR, virtual_mode=True),
        },
    )

    return create_deep_agent(
        model=model,
        system_prompt=MAIN_PROMPT,
        tools=[request_forks, record_verdict],
        subagents=subagents,
        skills=["/skills/"],
        backend=backend,
        permissions=read_only,
        interrupt_on={"request_forks": {"allowed_decisions": ["approve", "reject"]}},
        checkpointer=InMemorySaver(),
        name="investigator",
    )
