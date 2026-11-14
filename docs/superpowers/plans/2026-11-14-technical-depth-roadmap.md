# Technical depth roadmap: from a narrator to a scientist

> Written Sat Nov 14, 12:30 Eastern, against `origin/main` at `bb21bcb` plus `frontend-product`. Submission closes
> **Sun Nov 15, 8:00 Eastern** (about 19.5 hours). This roadmap re-plans `docs/MASTER_PLAN.md` for what the repo is
> now: Phase 0 is done (merged); Phases 1 to 9 have not started on any branch; the robot domain, the diagnose and fix
> loop, and the paged dashboard landed after the master plan was written. `MASTER_PLAN.md` section 3 (what must not
> change) still overrides everything here.

## The gaps this closes

| Gap the user named | What is true in the code today | Plan |
| --- | --- | --- |
| "The traps are planted by us, so there is no technical depth" | The investigator is told the trap in its prompt and skill, reads `config.trap*` and `split`; `find_split` picks one label by regex; the change it tests comes from a table we wrote (`forks.INTERVENTIONS`, each trap's `intervention`) | B |
| Demo verdict | 3 of 4 inflated vs 0 of 4: one-sided Fisher p = 5/70 = 0.071. Called a cause anyway | A |
| Robot verdict | 4 of 4 vs 0 of 4: p = 1/70 = 0.014. Four agreeing pairs score 13.03, under the plan's own threshold of 20 | A |
| The verdict's numbers | **Typed by the model** as tool arguments (`record_verdict(control_inflated=..., ...)`), not computed | A |
| What forcing actually fixes | Nothing separates "the report became honest" from "the work got better". On the robot batch the claim fell 98.8% to 58.6% while the hidden test moved 55% to 60%: forcing fixed the report, not the controller | A |
| Rewinding is not LangGraph time travel | `cut_history` slices `messages.json` onto a fresh thread; every agent's `InMemorySaver` is thrown away; an approval does not survive a restart | C |
| Screens 4 and 5 do not show the science | The fork page is a grid of copies; the verdict page shows four raw counts | E |

## How each library carries the weight (the part judges for the LangChain track will look for)

- **LangGraph**
  - Durable checkpoints (SQLite) for every analyst and the investigator.
  - **Time travel as the fork mechanism**: `get_state_history` plus `update_state(as_node=...)` give the agent's state at the fork point, paired with a Daytona VM fork for the machine's state.
  - `interrupt` with approve, edit and reject, so a person signs off on spending and can change the number of pairs.
- **Deep Agents**
  - A blind investigator with typed subagents (`response_format`): step-tagger, lens-omission, lens-commission, lens-data and skeptic.
  - `TodoListMiddleware`, read-only filesystem permissions, the `method-errors` skill, `RubricMiddleware` grading the verdict against the evidence ledger, and casebook memory (`memory=`).
- **LangChain**
  - Tools with validated arguments.
  - Structured output: native, not a forced tool call, because Sonnet 5.5 rejects forced tool choice (`PROGRESS.md`).
  - Usage callbacks for the cost bar, and model fallback and retry middleware on the investigator.
- **Plain Python**, by design (`MASTER_PLAN.md` §3.4): scoring, the evidence math, the budget guard and the VMs. The model never produces a number we show as a result.

## Plans, in order

Each plan is its own file in this folder when it starts. Only Plan A is written in full now; B to E below are scoped
so they can be expanded the same way once A lands, against the code as it is then.

### Plan A: evidence engine. About 3 h. `2026-11-14-evidence-engine.md`

The math and the experiment loop, all plain Python, all offline-testable:

- `deep_research/evidence.py` implements `MASTER_PLAN.md` §6.4:
  - Pairs, a saved prediction, and a sequential score (×1.9 when a pair agrees, ×0.1 when it doesn't). Supported at a score of 20 or more; cleared after at least 5 pairs with a score below 1.
  - A one-sided Fisher test on the counts, and an exact permutation test on the gaps.
  - Two outcomes per experiment: the claim (the gap between claimed and true) and the capability (the true score).
  - A placebo check: placebo against control must not be supported.
- Experiments run in rounds and stop as soon as the evidence is decisive or the cap is reached.
- The verdict's numbers are computed by code, and `record_verdict` refuses to name a cause the evidence does not support.

### Plan B: the blind scientist investigator. About 5 h

This is `MASTER_PLAN.md` Phases 1 to 3, now covering both domains. It answers "planted by us".

1. **Blind view.**
   - The investigator reads a filtered copy of the case file: no `config.trap*`, `overlap_share`, `split` or `candidates`.
   - Its prompt and the `method-errors` skill never name the trap. They teach the eight published leak types and, for robots, evaluation coverage.
   - Robot domain: no hidden positions, no `overlap_share`, no `robot_prompt` value.
2. **`rank_candidates` replaces `find_split`.**
   - It checks every label in both directions (a good step skipped, a bad step added), plus attributes such as model family.
   - It ranks by the difference between honest and inflated rates, with a Fisher p and a Holm correction across labels.
   - Its output is UI and fallback only. `find_split` stays as a wrapper.
3. **Suspects and `run_experiment`.**
   - `record_suspects` takes a list of `Suspect` objects.
   - `run_experiment(suspect_id, change, prediction, pairs, source_run, anchor)` pauses for approval, with approve, edit and reject.
   - **The change is designed by the investigator, not taken from our table.**
     - `force_step` carries a command it writes. It runs only in the fork copy's VM, is checked against an allowlist of tools, and has its own output limit.
     - `edit_context` carries a message to the agent.
     - `fake_result` and `swap_model` come last and can be cut.
   - The existing intervention table becomes the baseline the UI can show next to it, and the demo safety net (`investigator_assist="baseline"`, shown in the UI).
4. **Subagents with typed `response_format`:**
   - step-tagger, one per run, all in parallel in one turn
   - lens-omission and lens-commission
   - lens-data: compares `train.csv` and `test.csv` through a single `run_python` tool on a lab VM
   - skeptic: for each suspect, names the cheapest experiment that could prove it wrong
5. **A prompt that states a method, not a script:** observe, suspect, predict, experiment, update, conclude. Test at least two suspects. Report the ones cleared.

Acceptance for Plan B, offline with the scripted model:

- No banned key or the words "planted" or "trap" appear in the view, the prompt or the skill.
- It records at least two suspects.
- An experiment carries a prediction saved before any copy starts.
- A change the investigator wrote runs only in the changed copy.
- `rank_candidates` finds a planted commission, such as a scaler fitted before the split, that `find_split` misses.

The same acceptance holds for a robot batch.

### Plan C: LangGraph durability and real time travel. About 2.5 h

This is `MASTER_PLAN.md` Phase 6.

- Add `langgraph-checkpoint-sqlite`, the one dependency the master plan pre-approved. Each batch gets one async checkpointer at `batches/<id>/checkpoints.sqlite`, passed to every analyst and to the investigator.
- `fork_mode: "checkpoint" | "messages"`, defaulting to `messages` until checkpoint mode is proven.
  - Checkpoint mode picks the snapshot just before the model turn that made the fork-point action.
  - It seeds the child's new thread with `update_state(values, as_node=...)` and appends the change.
  - The VM state still comes from a VM fork or from replay. That pairing stays explicit in the code and the UI.
- A pending approval survives a server restart.

Acceptance:

- A checkpoint-mode child starts with the same messages as message mode **and** keeps the source run's todo list.
- The thinking-block rule in `PROGRESS.md` holds: changes are append-only, and the batch saves a hash of the analyst's prompt and tools that is checked before forking.

### Plan D: it learns, and it generalizes. Stretch, cut first

These are `MASTER_PLAN.md` Phases 4, 5 and 7, plus one new piece.

- `RubricMiddleware` grades the verdict against the evidence ledger, with a cheaper grader model. If it fights back, the same rules stay in `record_verdict`.
- Casebook memory (`memory=["/memories/casebook.md"]` on a writable `StoreBackend` route). The investigator reads it at the start of a case and appends to it at the end.
- One new trap per domain:
  - Tabular: `standin_column`, a column that tracks the outcome in training and carries no signal in the holdout.
  - Robot: `privileged_state`. The controller reads the can's true pose from the simulator instead of the noisy observation, which is the sim-to-real leak.
- **New: an attribution benchmark.** N batches across traps, investigator blind. Count how often its supported suspect is the planted cause, against a log-only baseline (one model reads the logs and names the step, the method AgenTracer and Who&When measure at 3% to 39%). This is the number that makes the technical claim checkable. Real runs cost money, so estimate first and ask.

### Plan E: screens 4 and 5 show the experiment and the result. About 2 h, after A

This runs on `frontend-product`. It uses the paged batch view and `system.css`.

- **Screen 4, "The experiment":**
  - The question in one line, and the saved prediction.
  - The source run's timeline with the fork point, branching into the arms, each labelled with the one thing it changes.
  - A running score per round with the line at 20.
  - Claimed and true per arm on one axis.
  - "How the agents got here", from the investigator's log: subagent, tool, approval, cost.
  - The copies move into a drawer.
- **Screen 5, "The result":**
  - The effect in one line with the score, the p value and the level.
  - Two outcomes side by side: what changed in the claim, and what changed in the work.
  - The placebo and shown arms as the confounds they rule out.
  - The evidence chain: observation, mechanism, intervention.
  - For robots, a top-down table map of the hidden positions, placed or failed, control against changed.
  - A limits line: pairs, and simulated or real.

## Schedule (Eastern)

| By | Done | Notes |
| --- | --- | --- |
| Sat 15:30 | Plan A | Offline, no spend |
| Sat 20:30 | Plan B | Offline acceptance. Then one cheap real smoke run, under $1, if keys are set |
| Sat 22:30 | Plan E | Can run in parallel with Plan B in a second session, because Plan A fixes the contract |
| Sun 01:00 | Plan C | Checkpoint mode can be cut; the durable checkpointer cannot |
| Sun 04:00 | Real runs on real data (the user asked for these last), plus Plan D if time | Ask before any batch over 12 runs or $3 |
| Sun 07:00 | Demo hardening, `docs/claims.md`, freeze | `MASTER_PLAN.md` Phase 9 |

**Cut order if behind:** Plan D, then checkpoint mode in C, then `fake_result` and `swap_model` in B, then lens-data in B.

**Never cut:** the blind view, a choice of suspect, pairs with a control and a saved prediction, the score threshold, verdict numbers computed by code.

## Decisions the user owns

1. **Branch.** Proposed: `upgrade/scientist`, branched from `frontend-product` (which contains `main`), so the backend and the screens land together. The alternative is backend on a branch from `origin/main` with UI on `frontend-product`, which means two PRs and a merge in between.
2. **Dependency.** `langgraph-checkpoint-sqlite` for Plan C. The master plan pre-approves it; confirm.
3. **Spend.** One real smoke run after Plan B (under $1), and the real-data runs at the end, each with an estimate first.
