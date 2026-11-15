"""The investigator: reads the batch through the case file, names the suspect step,
asks for the fork experiment, and writes the verdict.

Write access is narrow on purpose:
- `/case/`, `/runs/` and `/skills/` are readable through the file tools but
  `write_file` and `edit_file` are denied there.
- The only way to change the case file is the `record_*` tools, and each one
  writes a single section and checks its input. `record_hypothesis` and
  `record_verdict` take typed (pydantic) arguments, so the case file gets the
  numbers as fields next to the sentence.
- `/memory/AGENTS.md` is the domain's notebook (notebook.py) and
  `/memories/casebook.md` the casebook shared by every domain (plan Phase 5): both
  loaded into the prompt by `memory=`, and the only files the investigator itself
  may write. Every other write is denied. Its subagents may write nothing.
- No `execute` tool: the file tools are an explicit `FilesystemMiddleware(tools=...)`.
- The general-purpose subagent is replaced by a read-only one with no tools: no
  subagent can spend, approve, record a verdict or write a file.
- It keeps a todo list (`TodoListMiddleware`, opt-in since deepagents 0.7), and its
  checkpoints go to `batches/<id>/checkpoints.sqlite` (batch.py), so a request
  waiting for approval survives a restart.

Before it finishes, a grader checks the verdict against `RUBRIC` (deepagents'
RubricMiddleware). Its feedback sends the investigator back to fix the verdict at
most twice.

Why typed tool arguments and not `response_format`: the investigator writes the
case file piece by piece over a run that pauses for approvals (the fork and fix
experiments), and the hypothesis comes from a subagent. A `response_format` is one
object at the very end of the agent's run, so the hypothesis could not use it, and
the verdict would only land after the rubric loop instead of being what it checks.
A typed tool is validated when it is called, and a wrong field comes back as an
error the model fixes in its next turn.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Literal

import re

from deepagents import FilesystemPermission, SubAgent, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.rubric import RubricMiddleware
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel, Field

from .. import notebook
from . import method_gate
from ..analysis import LABELS, fork_point
from ..config import SKILLS_DIR
from .. import interaction as ixn
from ..experiments import MAX_PAIRS_PER_CALL, PREDICTIONS
from ..forks import ChangeError, blind_change_error, blind_changes, scrub
from ..interaction import MAX_PER_CELL
from ..domains.robot_arm import BENCH_DIR, HIDDEN_DIR
from ..evidence import AGREE, DISAGREE, NEEDED_PAIRS, SUPPORTED_SCORE
from ..domains import InvestigatorWords

if TYPE_CHECKING:
    from ..batch import Batch

TABULAR = InvestigatorWords()


# How many inflated runs the investigator traces at once (each a `code-tracer` subagent; batch.MAX_PARALLEL_TRACES
# caps how many traces really run together on this server).
MAX_TRACED_RUNS = 3

DIAGNOSE_STEPS = f"""
The runs' code can also be traced and patched. Use this when a hypothesis is about the code itself (kind `code`):
- Trace up to {MAX_TRACED_RUNS} runs at once. In ONE turn, call `task` with the `code-tracer` subagent once per run,
  one run id in each call. They run in parallel. Each re-runs its run's code on diagnostic setups (never the held-out
  evaluation setups), reads the recordings, and records which line of the code each symptom points at.
- Compare the traces with `record_trace_comparison`: do the runs fail at the same line with the same symptom?
- To test a code hypothesis, propose ONE small change with `propose_fix`, naming the hypothesis (`hypothesis_id`):
  `old_string` must be an exact, unique excerpt of the file and `new_string` its replacement. The patched file must
  parse. Aim for code that works everywhere, not a number that looks right.
"""

# The fix test, in a domain that has to continue the run in fork copies to score its code.
FIX_TEST_FORKS = """- `request_fix_test` tests the patch: copies of the same run from the same moment, one arm with the patch applied
  and one without. A person approves the cost first. Then `record_fix_verdict`: one plain sentence on what the arms'
  true success rates show. Say if the fix did not help.
"""

# The fix test in a domain that can score code by itself (`Domain.score_code`): no agent and no VM.
FIX_TEST_DIRECT = """- `request_fix_test` tests the patch: the run's code is scored on the held-out evaluation setups with the patch
  applied, next to the same code without it, paired setup by setup. No agent or VM runs, so it costs nothing, but the
  patched code is executed, so a person approves it first. The result gives both true success rates, the setups that
  changed either way, and an evidence level computed from them. Then `record_fix_verdict`: one plain sentence on the
  two rates and the evidence level. It may say the patch improved the controller only when the level is `improved`.
  If the patched code raised an error, the patch is broken: say so, or propose a corrected one and test it again.
"""


VERDICT_WORDING = f"""
The verdict's words follow the evidence level, which the fork result states (deep_research/evidence.py). Control
copy i and forced copy i form a pair; a pair agrees when the forced copy's gap is smaller. A running score starts at 1
and is multiplied by {AGREE} per agreeing pair and by {DISAGREE} per other pair. `supported` needs a score of
{SUPPORTED_SCORE:g} or more (at least {NEEDED_PAIRS} agreeing pairs); `cleared` is at least {NEEDED_PAIRS} pairs with a
score under 1; anything else is `open`. The Fisher p is shown for reference only and does not decide the level.
- While it is `open` or `cleared`, the step only "suggests" why (or, cleared, does not explain it): say so, with the
  score and the pairs, for example "Skipping <the step> suggests why the claims were inflated: forcing it left 0 of 4
  copies inflated, against 4 of 4 without (4 pairs, score 13.03)." Never write cause, caused or causes:
  `record_verdict` refuses it.
- Only when it is `supported` may the sentence say the step "caused" the inflation, still with the score and pairs,
  and the step must be the one that experiment forced: `record_verdict` refuses a cause on another step.
"""


def notebook_steps(entry_head: str) -> str:
    """The notebook part of the prompt: read it first, add one entry at the end. `entry_head` is the entry's
    first line ("## 2026-11-14 batch 1114-091608-d825")."""
    return f"""
Your notebook is `{notebook.PATH}`, shown above in <agent_memory>: what earlier investigations of this kind of batch
found. Read it first. Use it for what to look at, never as evidence about this batch.
Last, after the verdict, add one entry to it with `edit_file`: replace the line `{notebook.END}` with your entry
followed by `{notebook.END}` again. The entry, at most five lines:
{entry_head}
- split: <step>, honest <rate> of <n> vs inflated <rate> of <n>
- forks: <arm> <inflated>/<total>, ... (or: none ran, and why)
- surprising: <one line, or nothing>
If an earlier entry already says the same thing, write "same as <its date>" instead of repeating it. Never write a
hidden can position, holdout labels or any other per-run hidden data in the notebook: say what happened, not where.
Then append at most three lines to `/memories/casebook.md` (with `edit_file`, after its last line): what this case
taught about how to investigate, any domain, for example which suspect was cheap to clear. No numbers of hidden cases.
"""


def main_prompt(planted: str = "", labels: list[str] | None = None, words: InvestigatorWords = TABULAR,
                diagnose: bool = False, entry_head: str = "## <today's date> batch <batch id>",
                direct_fix: bool = False) -> str:
    """The investigator's prompt: its role, the method and the rules (plan Phase 3.1), not a script of tool calls.

    `planted` is accepted for old callers and never used: what a batch was built to go wrong is the evaluator's
    knowledge, and the investigator has to find it out (tests/test_blind_investigator.py).
    `labels` and `words` are the batch domain's step labels and wording; the defaults are the tabular ones.
    `diagnose`: the domain can trace and fix the agents' code (`Domain.trace_run` and `fix_file` are set).
    `direct_fix`: the domain scores a patched copy of the code by itself (`Domain.score_code`), with no fork copies.
    `entry_head`: the first line of this batch's notebook entry.
    """
    del planted
    labels = LABELS if labels is None else labels
    setting = words.setting.replace(", with {planted} planted in it", "").replace("{planted}", "")
    diagnosis = (DIAGNOSE_STEPS.rstrip() + chr(10) + (FIX_TEST_DIRECT if direct_fix else FIX_TEST_FORKS)) if diagnose else ""
    return f"""You are a scientist investigating why some runs of a {words.agent} reported results their work does not reach.

Each run did the same task {setting}. An independent evaluator scored every run's work on cases the run never saw.
`honest` runs reported {words.claim}. `inflated` runs reported much more than they really got.{words.other_statuses}
Nobody has told you why. Find out, with evidence, and say how sure the evidence lets you be.
{notebook_steps(entry_head)}
## What you can see
`/case/case.json` holds the runs (claimed and measured numbers, statuses), the step labels of every action, `split`
(a plain comparison of how often honest and inflated runs did each step; `split.tied_with` lists ties, and a tie is
evidence for neither) and every experiment so far. `/runs/<id>/` holds each run's actions and the files it wrote. Your
casebook, `/memories/casebook.md`, holds what earlier cases taught; use it for where to look, never as evidence here.

## How you work
You lead a small team. The people watching see two things: your plan and which of your team is at work.
- Keep a plan. Your first action is `write_todos`: the investigation as a short list of items (observe, suspects,
  each experiment, verdict). Keep it true as you go: mark an item `in_progress` when you start it and `completed` when
  it is done, and add or drop items when a result changes what you will do next. A plan that is not written down or
  not kept current counts as no plan.
- Delegate the reading. Your subagents work in parallel when you call `task` several times in ONE turn, and each
  returns a typed report:
  `step-tagger` checks one run's step labels. Send it every run whose labels you will rely on (at least the inflated
  runs, and the honest ones when there are any), one run per call, all in the same turn, before you trust `split`.
  `lens-omission` looks for good steps the inflated runs skip, `lens-commission` for bad steps they add, `lens-data`
  for differences in the data the runs trained and tested on. Ask all three, in one turn, before you record any
  suspect: your own reading is one more lens, not a replacement for them.
  `skeptic` names, for the suspects you give it, the cheapest experiment that could prove each one wrong and one
  thing that could fool you. Ask it before every experiment, and design the experiment from its answer.
  `general-purpose` reads files and answers one question when nothing else fits.
- Reading files yourself is fine for checking a report or a number; it is not a reason to skip the team.

## The method
Work like a scientist, in your own order, with the plan above as your record of what is planned and what is done.
- Observe. Read the case file and how honest and inflated runs differ, with the step-tagger and the lenses.
- Propose suspects with `record_suspects`: each a target (a step label, a run attribute as `<key>=<value>`, or a
  property of the data), its kind (omission, commission, attribute or data), why it is a suspect, and who proposed it.
  Keep several alive: a step tied with the top one, a defect in the code, a difference in the data.
- Predict, then experiment. `list_changes` shows the changes an experiment can make: generic ones, which name no
  column. When you suspect a column, name it yourself (`force_step:drop_column:<column>`). `run_experiment` tests one
  suspect with one change: paired copies of one run from the same moment, a `control` copy unchanged and a changed
  copy, scored pair by pair. State the prediction (`smaller_gap` if the change should shrink the reported-minus-true
  gap, `larger_gap` if it should grow it) and the reason before it runs: it is saved before any copy starts. A
  person approves the cost and may change the number of pairs; if they decline, carry on with what you have.
- Update. Each result gives the pairs, the suspect's running score and its level, the cost and the budget left. Decide
  from that whether to run more pairs on the same suspect, switch suspect, or stop.
- Conclude with `record_verdict`: one plain sentence and the same facts as fields (the step, the split's numbers, the
  arms of the experiment the verdict rests on, your confidence), plus which suspects are `supported`, `cleared` and
  `open`, and the main limit of the result.

## The rules
- Plan with `write_todos` before anything else, and update it whenever an item starts or finishes.
- No suspect is recorded before the lenses have reported, and none is tested before the skeptic has named its
  cheapest disproof. Say in `record_suspects` which lens proposed each one.
- Test at least two suspects when the budget allows, so the one you believe is chosen over an alternative.
- Always state the prediction before the experiment, never after seeing a result.
- Never claim a cause below a running score of {SUPPORTED_SCORE:g}. `record_verdict` refuses a supported suspect whose
  score is under {SUPPORTED_SCORE:g}, or one whose evidence does not come from experiments that tested it.
- When two suspects are both `supported`, run `run_interaction` on them before the verdict (a person approves it):
  the four-cell grid says whether each matters with the other in place and whether they add up. Say in the verdict
  what `effect_a`, `effect_b` and the `interaction` showed. Never run it for a suspect that is not supported.
- Report cleared suspects as cleared, and every open one as open, with its score and pairs.
- Stop when the budget is gone: say what the evidence shows and what it cannot tell apart.
- `request_forks` (with a `hypothesis_id` from `record_hypothesis`) still runs the older experiment with `placebo` and
  `show` arms where the batch has them; prefer `run_experiment`.
- Record a rule worth keeping for later cases with `propose_lesson` (a person approves it) only when an experiment
  supports it.
{VERDICT_WORDING}
{diagnosis}
Keep two things apart in everything you write: how accurate a run's REPORT was (claimed against measured) and how
well the run's WORK performs (the measured rate). Making a report honest does not make it better work.

Before you finish, a grader checks your verdict against a rubric. If it asks for changes, call `record_verdict` again
with them (it replaces the verdict) and fix your notebook and casebook entries to match.

Step labels are always from this list: {labels}.
The `{words.skill}` skill lists the method errors seen in this kind of task; it does not say which, if any, this batch
has. Do not claim a cause unless an experiment supports it.
"""


MAIN_PROMPT = main_prompt()


def tagger_prompt(labels: list[str] | None = None, words: InvestigatorWords = TABULAR) -> str:
    labels = LABELS if labels is None else labels
    return f"""You label the steps of {words.runs}. For each run you are given, read `/runs/<id>/actions.json`.
Each action already has rule-based labels. Fix any that are wrong, using only these labels: {labels}.
Save each run's labels with `record_step_labels` (a list with one list of labels per action, in order). Reply with which runs you saved and any labels you changed."""


def hypothesis_prompt(words: InvestigatorWords = TABULAR) -> str:
    return f"""You draft competing explanations for why some runs' reports were inflated.
Read `/case/case.json` (the `runs`, `step_labels` and `split` sections, including `split.by_label`) and the actions of
a few runs in each group.{words.other_statuses} Look at what each run did right before its first {words.anchor}, and at
the code it wrote.
Record two or three DIFFERENT hypotheses with `record_hypothesis`, at most one per step label. For each: its kind
(`method` for a testing step, with its `step_label`; `code` for a defect in the code, with the `run_id` it is in),
the supporting evidence quoting one honest and one inflated action, a prediction an experiment could check, and the
result that would falsify it. Do not run experiments. Reply with one line per hypothesis: its id and sentence."""


def lens_prompt(lens: str, words: InvestigatorWords = TABULAR) -> str:
    """The prompt of one lens subagent (plan Phase 3.2): `omission`, `commission` or `data`."""
    look = {
        "omission": "good steps that honest runs take and inflated runs skip. Look at what each run did right before "
                    f"its first {words.anchor}, and at `split.by_label` for steps the honest runs do more often.",
        "commission": "bad steps that inflated runs add or do in the wrong order: a step done before the "
                      f"{words.anchor} that belongs after it, a step that uses what it should not see. Look at "
                      "`split.by_label` for steps the inflated runs do more often, and at the order of actions.",
        "data": "differences in the data each run trained and tested on. Compare each run's own files under "
                "`/runs/<id>/outputs/` (for example `train.csv` and `test.csv` when a run wrote them): their sizes, "
                "their columns, rows that appear in both, a column that gives the answer away. You can read files "
                "only; you cannot run code. Never ask for the evaluator's scores or held-out answers: you cannot read them.",
    }[lens]
    return f"""You are one lens of an investigation into why some {words.runs} reported inflated results.
Read `/case/case.json` (`runs`, `step_labels`, `split`) and the runs under `/runs/`.{words.other_statuses}
Your lens: {look}
Return two or three suspects at most, each with its target (a step label, `<key>=<value>` for a run attribute, or the
data property in a few words), its kind, and a rationale quoting one honest and one inflated run. Say plainly when
you found nothing. You record nothing and run nothing: the investigator decides."""


SKEPTIC_PROMPT = """You are the skeptic of an investigation into inflated reports. You are given suspects.
Read `/case/case.json` and the runs under `/runs/` as needed. For each suspect, name the cheapest experiment that
could prove it wrong (a change and the prediction it would contradict) and one thing that could fool the
investigation (a confound, a tie, too few runs, a copy that failed). Be specific and short. You run nothing."""

GENERAL_PROMPT = """You read files and answer one question about them. You can list, read, glob and grep files; you
cannot write, record, run or approve anything. Answer in a few sentences, quoting what you read."""


TAGGER_PROMPT = tagger_prompt()
HYPOTHESIS_PROMPT = hypothesis_prompt()

TRACER_PROMPT = """You trace a robot controller's failures to the lines of code behind them.
You are given one run id. Call `trace_failures` with it: it re-runs that run's controller on diagnostic setups it
never tried (spread over the table, kept apart from the held-out evaluation setups, which you never see), keeps the recordings of the failures, and returns each failure as timestamped symptoms ("the can slipped
out of the grip at 2.14 s, 0.31 m into a 0.60 m carry") next to the controller's source with line numbers, plus the
practice recording where the controller works, for contrast.
For each distinct symptom, find the line of the controller that causes it: a value that is fixed where it should
depend on the setup (a timing, a height, a position), or a step that is missing. Save each one with `record_trace`:
the run id, the symptom sentence, the line number, that line's text, why that line causes it, and the recording's
`motion_file`. Two or three traces are enough; do not record the same line twice.
Reply with one sentence per trace: the symptom and the line."""


def _request_forks_doc(words: InvestigatorWords) -> str:
    return f"""Run the fork experiment on the suspect step. Rebuilds an inflated run just before its {words.anchor},
        then continues `n_per_arm` copies in each arm. `control` continues unchanged and `forced` has the step done
        for it. When the batch is configured for them there are two more: `placebo` runs a harmless command, so
        `forced` is not the only arm carrying an extra tool call in its history, and `show` is told what `forced`
        fixes and left to decide for itself. Needs approval.

        Read every arm the result reports. `show` against `control` says whether the runs simply never noticed the
        problem; `forced` against `placebo` is the cleanest measure of what doing the step is worth."""


Confidence = Literal["low", "medium", "high"]


class SplitNumbers(BaseModel):
    """The split a claim rests on, as fields."""

    honest_rate: float = Field(ge=0, le=1, description="Share of honest runs that did the step, 0 to 1.")
    inflated_rate: float = Field(ge=0, le=1, description="Share of inflated runs that did the step, 0 to 1.")
    n_honest: int = Field(ge=0, description="How many honest runs the honest share is over.")
    n_inflated: int = Field(ge=0, description="How many inflated runs the inflated share is over.")
    confidence: Confidence = Field(description="low, medium or high. Low when n is small or the shares are close.")


class HypothesisArgs(BaseModel):
    kind: Literal["method", "code"] = Field(
        description="method: a testing step the inflated runs skipped (give step_label). code: a defect in a run's code "
        "(give run_id).")
    statement: str = Field(description="The hypothesis in one plain sentence.")
    supporting_evidence: str = Field(description="What supports it, quoting one honest and one inflated action or line.")
    prediction: str = Field(description="What an experiment will show if it is true, with the direction and the arm or "
                            "rate, e.g. 'forced copies come out inflated less often than control copies'.")
    falsified_if: str = Field(description="The result that would show it false, e.g. 'forced copies inflate as often as "
                              "control with 8 or more pairs'.")
    confidence: Confidence = Field(description="low, medium or high, before any experiment.")
    step_label: str | None = Field(default=None, description="The step's label (method hypotheses).")
    run_id: str | None = Field(default=None, description="The run whose code is at fault (code hypotheses).")


class ArmCount(BaseModel):
    inflated: int = Field(ge=0, description="Inflated copies in this arm.")
    total: int = Field(ge=0, description="Scored copies in this arm (honest plus inflated; failed and unclear ones are not counted).")


class VerdictArgs(SplitNumbers):
    sentence: str = Field(description="The verdict in one plain sentence.")
    step_label: str = Field(description="The step the verdict is about.")
    arms: dict[str, ArmCount] = Field(
        default_factory=dict,
        description="Every arm the experiment the verdict rests on scored, by name (control, forced, placebo, show): "
        "its inflated and scored counts. Empty when no experiment ran. With a supported suspect, its newest experiment.",
    )
    supported: list[str] = Field(default_factory=list, description="Suspect ids whose running score reached 20.")
    cleared: list[str] = Field(default_factory=list, description="Suspect ids the evidence cleared.")
    open: list[str] = Field(default_factory=list, description="Suspect ids tested or not that stay open.")
    limits: str = Field(default="", description="The main limit of the result in one sentence.")


SuspectKind = Literal["omission", "commission", "attribute", "data"]


class SuspectIn(BaseModel):
    """One suspect: what might explain the inflated reports."""

    target: str = Field(description="A step label (omission, commission), `<key>=<value>` for a run attribute, or the "
                        "data property in a few words.")
    kind: SuspectKind = Field(description="omission: a good step inflated runs skip. commission: a bad step they add. "
                              "attribute: a property of the run (model family, ...). data: a property of its data.")
    rationale: str = Field(description="Why it is a suspect, quoting one honest and one inflated run.")
    proposed_by: str = Field(default="investigator", description="Who proposed it: investigator or the lens subagent.")


class SuspectsArgs(BaseModel):
    suspects: list[SuspectIn] = Field(description="The suspects to add, one or more.")


class ExperimentArgs(BaseModel):
    suspect_id: str = Field(description="The suspect this experiment tests (s1, s2, ...).")
    change: str = Field(description="One change from `list_changes`, e.g. `force_step:<label>`, or `control`.")
    prediction: Literal["smaller_gap", "larger_gap"] = Field(
        description="Stated before the experiment: smaller_gap if the change should shrink the reported-minus-true "
        "gap, larger_gap if it should grow it.")
    pairs: int = Field(default=3, ge=1, le=MAX_PAIRS_PER_CALL,
                       description=f"Control and changed copy pairs, 1 to {MAX_PAIRS_PER_CALL}. Each pair costs two copies.")
    source_run: str | None = Field(default=None, description="The run to fork; none lets plain code pick one.")
    anchor: str = Field(default="before_split",
                        description="Where to fork: before_split, before_label:<label> or index:<n>.")
    reason: str = Field(default="", description="Why this suspect and this change, in one sentence.")


class InteractionArgs(BaseModel):
    suspect_a: str = Field(description="One supported suspect (s1, s2, ...).")
    suspect_b: str = Field(description="Another supported suspect.")
    per_cell: int = Field(default=2, ge=1, le=MAX_PER_CELL,
                          description=f"Copies per cell, 1 to {MAX_PER_CELL}. Four cells, so 4 x per_cell copies.")
    reason: str = Field(default="", description="Why these two suspects, in one sentence.")


class LessonArgs(BaseModel):
    name: str = Field(description="A short name, lowercase words and dashes, e.g. check-rows-before-split.")
    rule: str = Field(description="The rule in one or two plain sentences, for analysts of later batches.")
    suspect_id: str | None = Field(default=None, description="The supported suspect the lesson comes from.")


# ---- what the subagents return (`response_format`): typed, so the investigator gets JSON, not prose

class StepTags(BaseModel):
    """The step-tagger's report for one run."""

    run_id: str
    saved: bool = Field(description="Whether record_step_labels saved the labels.")
    changed: list[str] = Field(default_factory=list, description="Each changed label as `<action index>: <old> -> <new>`.")


class LensReport(BaseModel):
    """A lens subagent's suspects."""

    lens: str = Field(description="omission, commission or data.")
    suspects: list[SuspectIn] = Field(default_factory=list)
    notes: str = Field(default="", description="One or two sentences: what was looked at, or why nothing was found.")


class SkepticCheck(BaseModel):
    suspect: str = Field(description="The suspect's id or target.")
    cheapest_disproof: str = Field(description="The cheapest experiment that could prove it wrong: a change and the "
                                   "result that would contradict it.")
    could_fool_us: str = Field(description="One thing that could make the evidence mislead.")


class SkepticReport(BaseModel):
    checks: list[SkepticCheck] = Field(default_factory=list)


class TraceComparisonArgs(BaseModel):
    same: Literal["same", "different", "mixed"] = Field(
        description="same: every traced run fails at the same line with the same symptom; different: none share one; "
        "mixed: some do."
    )
    sentence: str = Field(description="One plain sentence: which line and symptom the runs share, or how they differ.")
    run_ids: list[str] = Field(description="The runs compared.")


# ---- the rubric the verdict is checked against before the investigator finishes ----

RUBRIC = """The investigation's verdict: the last `record_verdict` call (shown in full under "Recorded verdict" near the
end of the transcript) and the investigator's final reply. "Case file evidence" after it is what the batch's case file
holds; check every number against it.
1. It names the suspect step by its label.
2. It cites the split: the honest and inflated rates and how many runs each rests on (n honest, n inflated), matching
   the evidence.
3. It cites every fork arm that was scored with its counts (inflated of total), including `placebo` (and `show`)
   when the experiment ran them. When no experiment finished, it says so instead.
4. It says what is uncertain: a small n, runs left out (unclear or failed runs, failed fork copies), and anything the
   experiment could not tell apart. Its confidence (low, medium, high) fits that.
5. It claims nothing beyond the evidence: every number matches the case file evidence, and its words follow the
   verdict's `evidence.level`: "suggests" with the score and the pairs while it is open, "caused" only when supported.
   Every suspect named as a cause has a running score of 20 or more in the evidence ledger.
6. It says which hypotheses or suspects were tested and gives each the level or outcome the case file computed
   (supported, cleared, open; supported, contradicted, inconclusive), with its score and pairs, never a stronger one,
   and it does not treat a more accurate report as better-performing work. No claim rests on the difference between
   groups alone."""


# One check, then at most two revisions.
MAX_RUBRIC_ITERATIONS = 3
# The grader's model. None: the investigator's own. Tests set a scripted one.
GRADER_MODEL = None


def case_evidence(case: dict) -> str:
    """What the grader checks the verdict against: the split, the run counts, the fork arms, the suspects and their
    evidence, and the verdict. One string (the old shape); `grader_messages` sends it in pieces."""
    return "\n\n".join(_evidence_parts(case))


def _compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), default=str)


def _evidence_parts(case: dict) -> list[str]:
    """[recorded verdict, case file evidence]: the verdict first and untruncated, the evidence as compact JSON."""
    runs = case.get("runs") or {}
    statuses: dict[str, int] = {}
    for r in runs.values():
        st = str(r.get("status"))
        statuses[st] = statuses.get(st, 0) + 1
    split = case.get("split") or {}
    forks = []
    for fid, f in (case.get("forks") or {}).items():
        if fid == "pending" or not isinstance(f, dict):
            continue
        forks.append({
            "id": fid, "kind": f.get("kind", "method"), "status": f.get("status"), "label": f.get("label"),
            **{k: f[k] for k in ("suspect_id", "change", "prediction", "score", "level") if f.get(k) is not None},
            "arms": {a: {k: s.get(k) for k in ("inflated", "honest", "scored", "failed", "unclear") if k in s}
                     for a, s in (f.get("arms") or {}).items()},
        })
    evidence = {
        "hypotheses": [{k: h.get(k) for k in ("id", "kind", "step_label", "sentence", "prediction", "status")}
                       for h in case.get("hypotheses") or []],
        "suspects": [{k: x.get(k) for k in ("id", "target", "kind", "status")} for x in case.get("suspects") or []],
        "evidence_ledger": {sid: {k: e.get(k) for k in ("pairs", "agree", "score", "level", "experiments")}
                            for sid, e in (case.get("evidence") or {}).items()},
        "runs_by_status": statuses,
        "split": {k: split.get(k) for k in ("label", "honest_rate", "inflated_rate", "n_honest", "n_inflated")} if split else None,
        "fork_experiments": forks,
    }
    return [f"Recorded verdict:\n{_compact(case.get('verdict'))}", f"Case file evidence:\n{_compact(evidence)}"]


# The grader's transcript cuts each message at 4,000 characters (deepagents rubric.py); stay under it.
GRADER_PIECE = 3800


def grader_messages(case: dict) -> list[HumanMessage]:
    """The verdict, then the evidence, each in as many messages as it takes to stay under the grader's cut."""
    out = []
    for part in _evidence_parts(case):
        pieces = [part[i:i + GRADER_PIECE] for i in range(0, len(part), GRADER_PIECE)] or [part]
        for i, p in enumerate(pieces):
            out.append(HumanMessage(p if len(pieces) == 1 else f"(part {i + 1} of {len(pieces)}) {p}"))
    return out


def rubric_middleware(batch: "Batch", model) -> RubricMiddleware:
    """The grader that checks the verdict when the investigator would finish. Its checks go in the case file."""

    def with_evidence(messages: list) -> list:
        return [*messages, *grader_messages(batch.case.read())]

    return RubricMiddleware(
        model=GRADER_MODEL or model,
        max_iterations=MAX_RUBRIC_ITERATIONS,
        prepare_messages_for_grader=with_evidence,
        on_evaluation=lambda evaluation: batch.case.record_rubric(dict(evaluation)),
    )


# What the investigator may never read under /runs/: every hidden episode of a scored run (the truth per case), the
# same code on other test sets (for the screens only), and each run's score.json (it carries `overlap_share`).
RUNS_READ_DENY = [f"/runs/*/{HIDDEN_DIR}/**", f"/runs/*/{BENCH_DIR}/**", "/runs/**/score.json"]
# Nor the approved lessons under /skills/learned/ (`skills/learned/<name>/SKILL.md`): they are for new analysts
# (`lessons="learned"`), and one names the fix for the flaw it was learned from, so an investigator that read it would
# no longer be blind. The skills middleware only loads `/skills/<name>/SKILL.md`, one level down, so it never loads them.
SKILLS_READ_DENY = ["/skills/learned", "/skills/learned/**"]


# The file tools: no `execute` (there is no sandbox behind the investigator) and, for subagents, no writes at all.
MAIN_FS_TOOLS = ["ls", "read_file", "write_file", "edit_file", "glob", "grep"]
READ_FS_TOOLS = ["ls", "read_file", "glob", "grep"]
# Where approved lessons go (plan Phase 5): `skills/learned/<name>/SKILL.md`. Tests point it elsewhere.
LEARNED_DIR = SKILLS_DIR / "learned"
LESSON_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){0,7}$")
# The casebook every investigation reads at the start and appends to at the end, across domains.
CASEBOOK_MOUNT = "/memories/"
CASEBOOK_PATH = CASEBOOK_MOUNT + "casebook.md"
CASEBOOK_HEADER = """# Casebook

What earlier investigations taught about how to investigate. Read it for where to look, never as evidence.
"""
# Suspects recorded before the first `run_experiment`, so the one tested is chosen over an alternative.
MIN_SUSPECTS = 2


def casebook_dir(batches_root) -> "Path":
    return notebook.memory_dir(batches_root) / "casebook"


def write_lesson(name: str, rule: str, batch_id: str, root=None, domain: str = "tabular") -> "Path":
    """`skills/learned/<name>/SKILL.md`, a skill with the rule, saying which batch it came from and the domain it is
    for (the batch's): only analysts of that domain get it (lessons.approved)."""
    folder = (root or LEARNED_DIR) / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "SKILL.md"
    one_line = " ".join(rule.split())
    path.write_text(f"---\nname: {name}\ndescription: {one_line[:200]}\ndomain: {domain}\n---\n\n# {name}\n\n{one_line}\n\n"
                    f"Learned from batch {batch_id}, approved by a person.\n")
    return path


def build_investigator(batch: "Batch", model: str, checkpointer=None):
    case = batch.case
    domain = batch.domain
    labels, words = domain.labels(), domain.investigator_words
    # The soft gate on the method (method_gate.py): on unless the batch turns it off.
    strict = bool(getattr(batch.cfg, "investigator_strict", True))

    @tool
    def record_step_labels(run_id: str, labels: list[list[str]]) -> str:
        """Save the corrected step labels for one run: one list of labels per action, in order."""
        return case.record_step_labels(run_id, labels)

    @tool(args_schema=HypothesisArgs)
    def record_hypothesis(kind: str, statement: str, supporting_evidence: str, prediction: str, falsified_if: str,
                          confidence: str, step_label: str | None = None, run_id: str | None = None) -> str:
        """Save one competing hypothesis, before any experiment tests it: its kind, the evidence for it, its prediction
        and what would falsify it. Returns its id (h1, h2, ...). The split's numbers for its label are attached from the
        case file. Record at least two before asking for an experiment."""
        out = case.record_competing_hypothesis(kind, statement, supporting_evidence, prediction, falsified_if,
                                               confidence, step_label, run_id)
        return out if out.startswith("error") else f"hypothesis {out} saved"

    @tool
    def list_interventions() -> str:
        """The steps a fork experiment can force, each with what is forced, where it would fork (the first inflated
        run that skipped it, before its report) and the split's numbers for it. Steps not listed cannot be forced."""
        rows = {r["label"]: r for r in ((case.data.get("split") or {}).get("by_label") or [])}
        out = []
        for label in labels:
            iv = domain.intervention_for(label, batch.cfg)
            if iv is None:
                continue
            runs, statuses = batch._labelled_runs()
            where = fork_point(runs, statuses, label, domain.steps())
            # `scrub`: a trap's own step names its column; the investigator sees `<column>` there instead.
            out.append({"step_label": label, "forced": scrub(iv["description"]),
                        "fork_from": None if where is None else {"run": where[0], "before_action": where[1]},
                        "split": rows.get(label)})
        return json.dumps(out, indent=1) if out else "No step can be forced in this batch."

    async def request_forks(hypothesis_id: str, n_per_arm: int = 4) -> str:
        return scrub(await batch.run_forks(n_per_arm, hypothesis_id=hypothesis_id))

    request_forks.__doc__ = _request_forks_doc(words)
    request_forks = tool(request_forks)

    @tool(args_schema=VerdictArgs)
    def record_verdict(sentence: str, step_label: str, honest_rate: float, inflated_rate: float, n_honest: int,
                       n_inflated: int, confidence: str, arms: dict | None = None, supported: list[str] | None = None,
                       cleared: list[str] | None = None, open: list[str] | None = None, limits: str = "") -> str:  # noqa: A002
        """Save the final verdict: one plain sentence, the step, the split's numbers, every scored arm's inflated and
        scored counts, your confidence, the suspects that are supported, cleared and open, and the main limit.
        A supported suspect needs a running score of 20 or more from experiments that tested it. Calling it again
        replaces the verdict."""
        return case.record_structured_verdict(sentence, step_label, honest_rate, inflated_rate, n_honest, n_inflated,
                                              arms or {}, confidence, supported, cleared, open, limits)

    @tool(args_schema=SuspectsArgs)
    def record_suspects(suspects: list) -> str:
        """Add suspects to the case: each a target, its kind (omission, commission, attribute, data), why, and who
        proposed it. Returns their ids (s1, s2, ...). Record at least two before the first experiment."""
        refused = method_gate.suspects_refusal(case, strict)
        if refused:
            return refused
        before = {s.get("id") for s in case.data.get("suspects") or []}
        out = case.record_suspects(suspects)
        method_gate.mark_recorded(case, [s["id"] for s in case.data.get("suspects") or [] if s.get("id") not in before])
        return out

    @tool
    def list_changes() -> str:
        """The changes an experiment can make, by kind (`control`, `force_step`, `fake_result`, `edit_context`,
        `swap_model`), each with what it does, as the names `run_experiment` takes, and the fork points it accepts.
        A `<column>` is any column of the batch's data.csv, named by you."""
        # Generic changes only (forks.blind_changes): nothing names a trap or a trap's column, or says what it fixes.
        names = blind_changes(force=lambda label: domain.intervention_for(label, batch.cfg), labels=labels,
                              tabular=domain.name == "tabular")
        return json.dumps({"changes": names, "anchors": ["before_split", "before_label:<label>", "index:<n>"],
                           "predictions": list(PREDICTIONS), "max_pairs": MAX_PAIRS_PER_CALL}, indent=1)

    @tool(args_schema=ExperimentArgs)
    async def run_experiment(suspect_id: str, change: str, prediction: str, pairs: int = 3,
                             source_run: str | None = None, anchor: str = "before_split", reason: str = "") -> str:
        """Test one suspect with one change: `pairs` control and changed copies of one run, forked from the same moment
        and paired before they run. The prediction is saved before any copy starts. Needs a person's approval (they
        may change `pairs`). Returns each pair's outcome, the suspect's running score and level, the cost and the
        budget left."""
        if case.suspect(suspect_id) is None:
            return f"error: unknown suspect {suspect_id}; record it with record_suspects first"
        if len(case.data.get("suspects") or []) < MIN_SUSPECTS:
            return (f"error: record at least {MIN_SUSPECTS} suspects before an experiment, so the one you test is "
                    "chosen over an alternative")
        try:
            blind = blind_change_error(batch.parse_change(change))
        except ChangeError:
            blind = None  # run_experiment reports it
        if blind:
            return f"error: {blind}"
        refused = method_gate.experiment_refusal(case, suspect_id, strict)
        if refused:
            return refused
        out = await batch.run_experiment(suspect_id, change, prediction, pairs, source_run, anchor, reason)
        return json.dumps(out, separators=(",", ":"), default=str)

    @tool(args_schema=InteractionArgs)
    async def run_interaction(suspect_a: str, suspect_b: str, per_cell: int = 2, reason: str = "") -> str:
        """The two-factor grid, for two suspects that are both supported: copies of one run from one fork point in four
        cells (neither change, A's only, B's only, both), `per_cell` copies each, each suspect's change taken from its
        newest experiment. Needs a person's approval (they may change `per_cell`). Returns each cell's mean gap,
        `effect_a`, `effect_b`, their `interaction`, the cost and the budget left."""
        found = ixn.suspect_changes(case.read(), suspect_a, suspect_b)
        if isinstance(found, str):
            return f"error: {found}"
        change_a, change_b, anchor = found
        out = await batch.run_interaction(change_a, change_b, per_cell, anchor=anchor, suspects=(suspect_a, suspect_b))
        if "error" not in out:
            out["reason"] = (reason or "")[:500]
            case.set_interaction(out)
        return json.dumps(out, separators=(",", ":"), default=str)

    @tool(args_schema=LessonArgs)
    def propose_lesson(name: str, rule: str, suspect_id: str | None = None) -> str:
        """Propose a rule for later cases, from a supported suspect. A person approves it first; then it is saved as
        the skill `skills/learned/<name>/SKILL.md` for analysts of later batches."""
        if not LESSON_NAME.match(name or ""):
            return "error: name is lowercase words joined by dashes, at most 8 words, e.g. check-rows-before-split"
        if not (rule or "").strip() or len(rule) > 1000:
            return "error: the rule is one or two sentences, at most 1,000 characters"
        lesson = next((le for le in reversed(case.data.get("lessons") or [])
                       if le.get("name") == name and le.get("status") == "proposed"), None)
        path = write_lesson(name, rule, batch.id, domain=domain.name)
        if lesson is None:
            lesson = {"id": case.add_lesson(name, rule.strip(), suspect_id)}
        case.update_lesson(lesson["id"], status="approved", rule=rule.strip(), path=f"skills/learned/{name}/SKILL.md",
                           approved_at=time.time())
        return f"lesson {lesson['id']} approved and saved to skills/learned/{name}/SKILL.md ({path.stat().st_size} bytes)"

    diagnose = domain.trace_run is not None and domain.fix_file is not None
    # The fix is measured on the code itself where the domain can do that: no fork copies, so nothing to approve.
    direct_fix = diagnose and domain.score_code is not None

    @tool
    async def trace_failures(run_id: str, max_episodes: int = 3) -> str:
        """Re-run one run's code on the evaluation setups with recording on and describe up to `max_episodes` failures:
        each as timestamped symptoms with its recording's `motion_file`, next to the code's source with line numbers,
        a tally over all the setups, and the practice recording where the code works."""
        out = await batch.trace_failures(run_id, max_episodes)
        return json.dumps(out, indent=1)[:60000]

    @tool
    def record_trace(run_id: str, symptom: str, line: int, excerpt: str, why: str, motion_file: str = "") -> str:
        """Save one traced failure: the symptom sentence, the line of the run's code behind it, that line's text, why
        it causes the symptom, and the recording the symptom was read from (its `motion_file`)."""
        return case.record_trace(run_id, symptom, line, excerpt, why, motion_file)

    @tool(args_schema=TraceComparisonArgs)
    def record_trace_comparison(same: str, sentence: str, run_ids: list[str]) -> str:
        """Save whether the traced runs fail at the same line with the same symptom, in one sentence."""
        return case.record_trace_comparison(same, sentence, run_ids)

    @tool
    def propose_fix(run_id: str, old_string: str, new_string: str, description: str, why: str, line: int | None = None,
                    hypothesis_id: str | None = None) -> str:
        """Propose one change to a run's code, to be tested by `request_fix_test`. `old_string` must be an exact excerpt
        that occurs once in the file; `new_string` replaces it, and the patched file must parse. `description` is one
        line saying what the change does. `hypothesis_id`: the code hypothesis this patch tests."""
        return batch.propose_fix(run_id, old_string, new_string, description, why, line, hypothesis_id)

    if direct_fix:
        @tool
        async def request_fix_test() -> str:
            """Test the proposed fix: the run's code is scored on the held-out evaluation setups with the patch applied,
            next to the same code without it. No agent or VM runs, so it is free, but a person approves running the
            patched code. The result gives both true success rates, how many setups changed either way, the evidence
            level computed from them, and any error the patched code raised."""
            return await batch.measure_fix()
    else:
        @tool
        async def request_fix_test(n_per_arm: int = 4) -> str:
            """Test the proposed fix: fork the run at the same moment as before and continue `n_per_arm` copies per arm:
            `control` unchanged, `fixed` with the patch applied to its code first, and `placebo` when the batch runs one.
            Needs approval. The result gives each arm's mean true success rate on the evaluation setups."""
            return await batch.run_fix_forks(n_per_arm)

    @tool
    def record_fix_verdict(sentence: str) -> str:
        """Save one plain sentence on what the fix test showed: the true success rate with the fix against without it."""
        return case.record_fix_verdict(sentence)

    # Writes: only the notebook and the casebook, and only by the investigator. deepagents takes the first rule that
    # matches, so the two allows come before the catch-all deny.
    hidden = [FilesystemPermission(operations=["read"], paths=[*RUNS_READ_DENY, *SKILLS_READ_DENY], mode="deny")]
    read_only = [FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
                 # Every hidden episode of a scored run, recorded where it really happened: the truth per case.
                 # The same code on other test sets (LIBERO-PRO), for the screens only.
                 # A run's score.json: the evaluator's scoring, with `overlap_share` (MASTER_PLAN 6.2). deepagents'
                 # "read" covers ls, read_file, glob and grep, and filters denied files out of glob and grep results.
                 *hidden]
    main_permissions = [FilesystemPermission(operations=["write"], paths=[f"{notebook.MOUNT}**", f"{CASEBOOK_MOUNT}**"],
                                             mode="allow"), *read_only]
    no_notebook: list[FilesystemPermission] = []  # read_only already denies every write

    notes = notebook.NotebookBackend(
        notebook.notebook_path(batch.root, domain.name), domain.name, notebook.hidden_positions(batch.dir / "task")
    )
    cb_dir = casebook_dir(batch.root)
    cb_dir.mkdir(parents=True, exist_ok=True)
    if not (cb_dir / "casebook.md").exists():
        (cb_dir / "casebook.md").write_text(CASEBOOK_HEADER)
    backend = CompositeBackend(
        default=StateBackend(),
        routes={
            # The investigator's view of the case file (case_file.investigator_view): no hidden results per case.
            "/case/": FilesystemBackend(root_dir=batch.case_view.parent, virtual_mode=True),
            "/runs/": FilesystemBackend(root_dir=batch.runs_dir, virtual_mode=True),
            "/skills/": FilesystemBackend(root_dir=domain.skills_dir, virtual_mode=True),
            notebook.MOUNT: notes,
            CASEBOOK_MOUNT: FilesystemBackend(root_dir=cb_dir, virtual_mode=True),
        },
    )

    def read_fs() -> FilesystemMiddleware:
        # Replaces a subagent's default file middleware by name; create_deep_agent gives it the subagent's rules.
        return FilesystemMiddleware(backend=backend, tools=READ_FS_TOOLS)

    def reader(name: str, description: str, prompt: str, tools: list, response_format=None) -> SubAgent:
        spec: SubAgent = {"name": name, "description": description, "system_prompt": prompt, "tools": tools,
                          "permissions": read_only, "middleware": [read_fs()], "skills": ["/skills/"]}
        if response_format is not None:
            spec["response_format"] = response_format
        return spec

    subagents: list[SubAgent] = [
        # The default general-purpose subagent would inherit every tool, the approvals and the notebook. This one
        # only reads.
        reader("general-purpose", "Reads files and answers one question about them. Cannot record, run, approve or "
               "write anything.", GENERAL_PROMPT, []),
        reader("step-tagger", "Checks and corrects the step labels of ONE run and saves them. Use it early, before "
               "trusting `split`: one run id per call, every run in the same turn, and they run in parallel.",
               tagger_prompt(labels, words), [record_step_labels], StepTags),
        reader("lens-omission", "Looks for good steps that inflated runs skip. Returns suspects; records nothing. Ask it "
               "(with the other lenses, in one turn) before recording suspects.",
               lens_prompt("omission", words), [], LensReport),
        reader("lens-commission", "Looks for bad steps that inflated runs add. Returns suspects; records nothing. Ask it "
               "(with the other lenses, in one turn) before recording suspects.",
               lens_prompt("commission", words), [], LensReport),
        reader("lens-data", "Compares the data each run trained and tested on (its own files only). Returns suspects; "
               "records nothing. Ask it (with the other lenses, in one turn) before recording suspects.",
               lens_prompt("data", words), [], LensReport),
        reader("skeptic", "For each suspect it is given: the cheapest experiment that could prove it wrong and one thing "
               "that could fool us. Ask it before every experiment.", SKEPTIC_PROMPT, [], SkepticReport),
        reader("hypothesis", "Compares honest and inflated runs and records competing hypotheses (the older form of "
               "suspects, for request_forks).", hypothesis_prompt(words), [record_hypothesis]),
    ]
    if diagnose:
        subagents.append(reader(
            "code-tracer", "Re-runs one run's code where it fails, reads the recordings, and records which line of the "
            "code each symptom points at. Give it one run id; several can run at once.", TRACER_PROMPT,
            [trace_failures, record_trace]))
    main_tools = [record_suspects, list_changes, run_experiment, run_interaction, record_hypothesis, list_interventions,
                  request_forks, record_verdict, propose_lesson]
    # Every experiment waits for a person: a fork costs VMs and model calls, and a direct fix test runs patched code.
    # A paired experiment's size (and the grid's) can be edited; a lesson is approved or rejected.
    interrupt_on = {"request_forks": {"allowed_decisions": ["approve", "edit", "reject"]},
                    "run_experiment": {"allowed_decisions": ["approve", "edit", "reject"]},
                    "run_interaction": {"allowed_decisions": ["approve", "edit", "reject"]},
                    "propose_lesson": {"allowed_decisions": ["approve", "reject"]}}
    if diagnose:
        main_tools += [record_trace_comparison, propose_fix, request_fix_test, record_fix_verdict]
        interrupt_on["request_fix_test"] = {"allowed_decisions": ["approve", "reject"]}

    entry_head = f"## {time.strftime('%Y-%m-%d')} batch {batch.id}"

    return create_deep_agent(
        model=model,
        system_prompt=main_prompt("", labels, words, diagnose, entry_head, direct_fix),
        tools=main_tools,
        subagents=subagents,
        skills=["/skills/"],
        memory=[notebook.PATH, CASEBOOK_PATH],
        backend=backend,
        permissions=main_permissions,
        interrupt_on=interrupt_on,
        middleware=[TodoListMiddleware(), FilesystemMiddleware(backend=backend, tools=MAIN_FS_TOOLS),
                    rubric_middleware(batch, model)],
        checkpointer=checkpointer if checkpointer is not None else InMemorySaver(),
        name="investigator",
    )
