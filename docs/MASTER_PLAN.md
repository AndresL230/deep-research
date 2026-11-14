# Master plan: turn the investigator from a narrator into a scientist

You are Claude Code, working in the `deep-research` repo (`github.com/AndresL230/deep-research`). This file is your brief. Read all of it before you change any code. Then copy it to `docs/MASTER_PLAN.md` on your branch so teammates and reviewers can read it, and work through it phase by phase.

## 1. Mission

The project runs one data science agent many times on a dataset with a hidden flaw, checks each run's claimed score against a hidden truth, and proves which step caused the fake scores by rewinding a run and changing one step.

The idea stays exactly the same. The problem is that today the investigator agent does almost no real work: it is told the answer, follows four scripted steps, and narrates a result that plain Python found. Your job is to make it do the science itself:

1. It starts blind.
2. It proposes several suspects.
3. It states a prediction, then runs a controlled experiment on real machines to try to prove itself wrong.
4. It keeps a running evidence score and stops when the evidence is strong enough or the money runs out.
5. It clears wrong suspects, reports the real cause, and teaches the fix to future agents.

Hard deadline: the hackathon submission closes **Sunday Nov 15, 8:00 am Eastern**. The live demo is 2 minutes. Run `date` when you start and plan against section 10.

## 2. Where the repo stands

Checked at commit `14f1d0a` on `main`. Teammates push every few minutes and `main` has been force-pushed once, so fetch and re-read before trusting any line number here.

**What exists and works offline:**

| Part | File | Notes |
| --- | --- | --- |
| Task builder | `deep_research/task.py` | Pima data, `plant_duplicates`, clean holdout whose labels stay on the server |
| Analyst agent | `deep_research/agents/analyst.py` | Flat deepagent, one Daytona VM each, `TodoListMiddleware`, `InMemorySaver` |
| Orchestrator | `deep_research/batch.py` | Runs, scoring, `find_split`, `run_forks`, investigator driver, costs |
| Scorer | `deep_research/scoring.py` | Reported vs true accuracy, `overlap_share`, `gap`, 8-point `inflation_threshold` |
| Split finder | `deep_research/analysis.py` | 11 fixed labels by regex, `find_split` picks one label |
| Fork helpers | `deep_research/forks.py` | `INTERVENTIONS` (one entry), `cut_history`, `forced_turn` |
| VM helpers | `deep_research/sandboxes.py` | Create, replay actions, `fork_vm` with replay fallback, lab page, charts |
| Investigator | `deep_research/agents/investigator.py` | Two subagents, `method-errors` skill, approval on `request_forks` |
| Case file | `deep_research/case_file.py` | One JSON per batch, narrow write methods, feeds the UI |
| API | `deep_research/api.py` | FastAPI, websocket, lab page proxy |
| Web UI | `web/src/batch/*.ts`, `web/src/main.ts` | Start panel, wall of run notebooks, side-by-side "what changed", fork view, verdict, replay timeline. Pure `(vm) => html` views |
| Tests | `tests/`, `web/test/` | Run with no keys and no VMs |

**What has not been proven:** the README says real analyst runs, the fork experiment, the investigator end to end, live websocket updates and the approval round trip have not been checked on a real batch. `fixtures/demo-batch` is simulated and says so.

**Installed:** `deepagents>=0.7.38`, `langchain-daytona`, `daytona`, `langchain-anthropic`. `.mcp.json` configures the `docs-langchain` and `reference-langchain` MCP servers. Use them.

## 3. What must not change

These are the invariants. Every review gate checks them.

1. **Same idea.** Many runs of one analyst on a trapped dataset, hidden holdout for the true score, rewind and change one step to prove the cause, investigator writes the verdict.
2. **Holdout labels never leave the server.** Not into a VM, the case file, an API response, a log, or any path an agent can read.
3. **Analysts stay isolated and flat.** No subagents, no shared files, no view of other runs or of the case file.
4. **Deterministic work stays plain Python.** VM lifecycle, scoring, cost tracking, the budget guard and the evidence math are code, not model calls.
5. **Every experiment has a control arm** started from the same point.
6. **Spending needs approval** and the budget guard can refuse.
7. **The case file is the UI's only data source** and changes only through its methods.
8. **The case file contract is additive.** Never rename or remove an existing section or field. The UI and its tests depend on them.
9. **No cause is claimed below the evidence threshold.**
10. **Simulated data is labeled simulated**, in the data and in the UI.
11. **Tests run with no keys and no VMs.**

## 4. Weak spots to patch

| ID | Weak spot | Where | Fixed in |
| --- | --- | --- | --- |
| W1 | Investigator is told the answer | `MAIN_PROMPT` says duplicates were planted; `config.trap*`, `split` and `runs.*.overlap_share` are readable; `SKILL.md` points at `split` | Phase 1 |
| W2 | It cannot choose what to test | `request_forks(n_per_arm)` has no suspect; one intervention | Phase 2 |
| W3 | Its steps are scripted | Prompt lists steps 1 to 4 | Phase 3 |
| W4 | Split finder sees one kind of error | `find_split` ranks by `h - i`, so it only finds a good step that inflated runs skip | Phase 1 |
| W5 | Proof is weak | 4 vs 4, counted as inflated or not. The fixture's 3 of 4 vs 0 of 4 happens by chance 1 time in 14 | Phase 2 |
| W6 | Rewind is not LangGraph time travel | `cut_history` slices messages onto a new thread and drops the todo list; each agent's `InMemorySaver` is thrown away | Phase 6 |
| W7 | Model choice is fixed by the prompt | `model_hint="random_forest"` | Phase 2 (as a testable change) |
| W8 | One trap | `Literal["duplicates"]` | Phase 7 |
| W9 | Two subagents in a fixed order | No parallel work, typed output, memory or todo list | Phases 3 and 5 |
| W10 | Nothing verified on real runs | README | Phase 0 |

## 5. Target architecture

```
Analysts (flat deepagents, one VM each)
      │ events, outputs
      ▼
Orchestrator (plain Python, batch.py)
  ├─ scorer            scoring.py        truth from the hidden holdout
  ├─ candidate finder  analysis.py       ranked baseline, both directions (UI and fallback only)
  ├─ changes           forks.py          five kinds of change, fork points
  ├─ experiment runner batch.py          paired copies, control arm, early stop
  ├─ evidence          evidence.py  NEW  pair score, exact test, two-factor split
  ├─ audit sheet       audit.py     NEW  three-question sheet per run
  └─ case file         case_file.py      full file for the UI, filtered view for the investigator
      ▲ narrow tools                         │ websocket
      │                                      ▼
Investigator (deepagent)                   Web UI
  reads   /case/ (blind view), /runs/, /skills/, /memories/
  agents  step-tagger ×N (parallel, typed), lens-omission, lens-commission, lens-data, skeptic
  tools   record_step_labels, record_suspects, run_experiment (approval), record_verdict, propose_lesson (approval)
  extras  todo list, rubric grader on the verdict, casebook memory, durable checkpointer
```

## 6. Contracts

Build to these. Where a library API is named, confirm it against the installed version with the docs MCP servers before you rely on it. If an API differs, keep the behavior, adapt the call, and log it in `docs/PROGRESS.md`.

### 6.1 Case file (additive)

Keep every existing section. Add:

- `candidates`: the plain-Python ranking from Phase 1. UI and fallback only.
- `suspects`: list from the investigator. Each: `id`, `target` (a step label or an attribute such as `model_family`), `kind` (`omission`, `commission`, `attribute`, `data`), `rationale`, `proposed_by`, `status` (`proposed`, `testing`, `supported`, `cleared`, `open`).
- `forks.<id>`: keep all current fields and add `suspect_id`, `change`, `anchor`, `prediction`, `pairs` (list of `{i, control_gap, changed_gap, agree}`), `score`, `p_exact`, `level`.
- `evidence`: by suspect id: `pairs`, `score`, `p_exact`, `level`, `cost_usd`, `experiments`.
- `interaction`: optional two-factor result (6.4).
- `lessons`: proposed and approved rules.
- `audit`: one sheet per run (Phase 4).
- `foolrate`: the table from Phase 5.

The `forced` arm name stays. It now means "the changed copy".

Update together, in the same commit: `docs/api-contract.md`, `web/src/api.ts` (`CASE_SECTIONS`, types, `PHASES`), `scripts/make_fixture.py` and the fixture, and the tests that pin them.

### 6.2 Blind view

The investigator never reads `case.json`. `CaseFile` writes a filtered copy on every save, and the `/case/` route points at the folder holding only that copy.

Removed from the view: `config.trap`, `config.trap_strength`, `config.trap_noise`, `config.seed`, `runs.*.overlap_share`, `split`, `candidates`, `audit`, and anything from `task/meta.json`. Under `/runs/`, deny reads of `score.json` (it carries `overlap_share`); if permission rules cannot cover `grep` and `glob` as well as `read_file`, serve `/runs/` from a filtered folder instead.

Kept in the view: each run's status, reported score, true score and gap, step labels, actions, costs, suspects, evidence, fork results.

A config flag `investigator_assist: "none" | "baseline"` (default `none`) adds `candidates` to the view. It exists as a demo safety net. The UI must show when it is on.

### 6.3 Changes and fork points

Replace `INTERVENTIONS` with a registry. Five kinds, named after the published method they come from:

| Kind | What it does | First entries |
| --- | --- | --- |
| `control` | Nothing. The copy continues unchanged | always the other half of a pair |
| `force_step` | We run a command in the copy's VM and append the call and its real output | `deduplicate` (exists), `deduplicate_fuzzy`, `drop_column:<name>` |
| `fake_result` | Append a tool call and a made-up result without running it | `no_duplicates`: the check "found 0 duplicate rows" |
| `edit_context` | Append a short message to the agent | `hint_quality`, `use_logistic`, or free text up to 300 characters |
| `swap_model` | Build the copy's analyst with another model from an allowlist | the investigator model |

Fork points: `before_split` (today's behavior), `before_label:<label>`, or `index:<n>`. Plain code picks an eligible source run when the investigator does not name one, and returns a clear error when none is eligible. Example: `fake_result:no_duplicates` needs an honest run whose duplicate check is its own action before the split.

### 6.4 Evidence math (`deep_research/evidence.py`, pure functions)

- One **pair** is one control copy and one changed copy from the same fork point, paired by index before they run.
- The investigator states a **prediction** before the experiment: `smaller_gap` or `larger_gap`. It is saved before any copy starts.
- `agree = (control_gap - changed_gap) * direction > 0`, with `direction` +1 for `smaller_gap` and -1 for `larger_gap`. A tie counts as disagree. A pair with a failed copy is dropped and logged.
- **Score** starts at 1. Multiply by 1.9 for agree and by 0.1 for disagree. Under "the change does nothing" each pair is a fair coin, and 0.5 × 1.9 + 0.5 × 0.1 = 1, so the score is a valid running test that can be checked after every pair.
- **Levels:** `supported` at score ≥ 20 (five agreeing pairs give 24.8). `cleared` after at least 5 pairs with score < 1. Otherwise `open`.
- `p_exact`: exact permutation test on the gaps, for display.
- **Two factors:** when two suspects are both supported, run the four-cell grid (neither changed, A only, B only, both) from one fork point. With `g` the mean gap per cell: `effect_A = ½[(g00 − g10) + (g01 − g11)]`, `effect_B = ½[(g00 − g01) + (g10 − g11)]`.
- Known answers to pin in tests, from `fixtures/demo-batch` fork `f1`: counts give a one-sided Fisher p of 5/70; the gap test gives 1/70; four pairs give a score of 13.03.

### 6.5 Investigator tools

```python
record_step_labels(run_id, labels)                       # exists
record_suspects(suspects: list[Suspect]) -> str
run_experiment(suspect_id, change, prediction, pairs=3,
               source_run=None, anchor="before_split", reason="") -> str   # approval: approve, edit, reject
record_verdict(sentence, supported, cleared, open, limits, interaction=None) -> str
propose_lesson(name, rule) -> str                        # approval
```

`run_experiment` validates its input, refuses over budget, caps `pairs` at 6 per call, runs the pairs, updates `forks`, `evidence` and the suspect's status, and returns the pair outcomes, the new score, the cost and the budget left. The investigator decides whether to run more pairs, switch suspect or stop. `request_forks` stays as a thin wrapper so nothing breaks.

## 7. Phases

Do them in order. Each has a goal, tasks, acceptance checks and a fallback. Do not start a phase until the previous gate (section 8) passes.

### Phase 0: prove the baseline on real runs (about 1.5 h)

Goal: know what really works before changing it.

1. `git fetch`, branch `upgrade/investigator` from `origin/main`. Run `uv run pytest` and `(cd web && npm run typecheck && npm test)`.
2. With keys set: one real run (`cli runs --n 1`), then a small batch (`--n 6`), then one real fork with 2 per arm (`cli forks <batch_id> --n 2`), then the investigator end to end through the API. Add a small `cli investigate <batch_id> --auto-approve` if that is faster. Keep the budget at $3 for this phase.
3. Write what happened to `docs/PROGRESS.md`: fork or replay path taken, minutes per run, cost per run, share of runs that came out inflated, and every failure.
4. Fix what blocks a real batch. Do not refactor yet.

Acceptance: one real batch with both honest and inflated runs, one real fork result, one real verdict, all saved under `batches/`. If Daytona VM forks fail, the replay fallback is acceptable; log it.

Fallback: if real runs cannot be made to work in 2 hours, stop and tell the user. Nothing below matters without this.

### Phase 1: blind start and a wider net (about 1.5 h)

1. Blind view (6.2). Rewrite `MAIN_PROMPT` so it never mentions the trap. Rewrite `skills/method-errors/SKILL.md` as a general guide: the eight published leak types and how each shows up in commands, how to design an experiment, what counts as proof. No pointer to `split` or `config`.
2. Replace `find_split` internals with `rank_candidates(runs, statuses) -> list[Candidate]`: every label in both directions (a good step skipped, a bad step added), plus attributes read from `report.json` such as model family. Rank by the absolute difference between honest and inflated rates. Keep `find_split` as a wrapper so current callers and tests pass. Write the list to `candidates`.
3. Add label rules that are missing: dropping a column, group-aware splits, feature selection.
4. Phase logic: `ready` whenever at least one run is inflated, even if no run is honest.

Acceptance:
- A test builds a case with trap settings and asserts none of the banned keys or the words "planted" or "trap" appear in the view, the prompt or the skill.
- A test shows `rank_candidates` finds a planted commission (scaling fitted before the split) that `find_split` used to miss.
- The offline investigator test still passes: it can read `/case/`, cannot write it.

### Phase 2: experiments with a choice and a score (about 3 h)

1. `evidence.py` with tests for every rule in 6.4, including the fixture's known answers.
2. Changes registry and fork points (6.3) in `forks.py`, with offline tests for each kind using the scripted fake model already in `tests/test_agents_offline.py`.
3. `Batch.run_experiment(...)`: build the base VM by replay to the fork point, then run pairs. Reuse the code in `run_forks`; make `run_forks` call it.
4. Investigator tools `record_suspects` and `run_experiment` with `interrupt_on` allowing approve, edit and reject. `_on_interrupt` writes the suspect, change, prediction, pairs and cost estimate to `forks.pending`. `POST /decision` accepts an optional `pairs` so a person can edit the request; `{"approve": bool}` keeps working.
5. CLI: `cli experiment <batch_id> --suspect ... --change ... --pairs 3 --auto-approve` for unattended tests under a small budget.

Acceptance:
- Offline: all five kinds build the right messages; pair scoring matches 6.4; a pair with a failed copy is dropped.
- Real: on the Phase 0 batch, `force_step:deduplicate` with prediction `smaller_gap` reaches a score, and a **same-vs-same test** (control against control) does not reach 20.
- The approval card data is in `forks.pending` and survives an edit of `pairs`.

Fallback: if `fake_result` or `swap_model` misbehave on real runs, ship `force_step` and `edit_context` and log the rest.

### Phase 3: the investigator does the science (about 3 h)

1. New prompt. Describe the role and the method (observe, propose suspects, predict, experiment, update, conclude). State the rules: test at least two suspects when the budget allows, always state a prediction first, never claim a cause below 20, report cleared suspects, stop when the budget is gone. Do not write a numbered script of tool calls.
2. Subagents, each with a typed `response_format`:
   - `step-tagger`: one per run, dispatched in parallel in one turn.
   - `lens-omission`: good steps that inflated runs skip.
   - `lens-commission`: bad steps that inflated runs add.
   - `lens-data`: compares each run's `train.csv` and `test.csv`. Give it one narrow tool, `run_python(code)`, that executes in a dedicated lab VM where plain code has uploaded those files (never `score.json`, never the holdout labels).
   - `skeptic`: for each suspect, names the cheapest experiment that could prove it wrong and one thing that could fool us.
3. `TodoListMiddleware` on the investigator. Its todo events already flow to the UI.
4. Keep `/case/`, `/runs/` and `/skills/` read-only.

Acceptance:
- Offline scripted test: the investigator records at least two suspects, requests an experiment with a prediction, and the verdict tool refuses a `supported` suspect whose score is under 20.
- Real: on a real batch with `investigator_assist="none"`, it proposes the duplicate check among its suspects, tests at least two, and ends with one supported and one cleared or open. Save the batch.

Fallback: if it cannot find the cause blind after two real attempts, improve the lens prompts once, then turn on `investigator_assist="baseline"` and log it. Do not hand it the answer in the prompt.

### Phase 4: a verdict that is checked (about 1.5 h)

1. `RubricMiddleware` on the investigator with a cheaper grader model and one read-only tool that returns the evidence ledger. Rubric:
   - Every suspect named as a cause has a score of at least 20 in the ledger.
   - Every tested suspect is listed as supported, cleared or open, with its score and number of pairs.
   - Every number in the verdict matches the ledger.
   - The verdict says how many suspects were tested and names one limit of the result.
   - No claim rests on the difference between groups alone.
2. Two-factor grid when two suspects are supported (6.4), written to `interaction`.
3. `audit.py`: after the verdict, plain code writes one sheet per run answering three questions with evidence: did test data touch training, is every column fair to use, does the test set match the claim.

Acceptance: a scripted test where the first verdict overclaims is sent back and the second passes; the audit sheet exists for every scored run.

Fallback: if the rubric middleware is not usable in the installed version, enforce the same rules in `record_verdict` and log it.

### Phase 5: it learns (about 2.5 h)

1. Casebook: `memory=["/memories/casebook.md"]` on a persistent, writable route. The investigator appends what it learned at the end of a case and reads it at the start of the next. Deny writes everywhere else.
2. `propose_lesson`: on approval, writes `skills/learned/<name>/SKILL.md`. New batches with `lessons="learned"` give that skill to the analysts. If analyst skills cannot load from the VM backend, append the rule to the analyst's system prompt instead and log it.
3. `cli foolrate --n 20 --settings none,light,learned`: runs the batches, counts inflated runs per setting, writes `foolrate`. Estimate the cost first and **ask the user before running it.**

Acceptance: a second investigation of a new batch reads the casebook; a batch with `lessons="learned"` runs; the fool-rate table has real counts with sample sizes.

### Phase 6: real time travel (about 2.5 h)

1. Add `langgraph-checkpoint-sqlite`. One async SQLite checkpointer per batch at `batches/<id>/checkpoints.sqlite`, passed into every analyst and the investigator.
2. `fork_mode: "checkpoint" | "messages"` (default `messages` until proven). In checkpoint mode: read the source run's state history, pick the snapshot just before the model turn that made the fork-point action, build the child on the forked VM with a new thread id, seed it with the snapshot's values through `update_state` with an explicit `as_node`, then run it with no new input. The change's messages go into the seeded values.
3. LangGraph restores agent state only. The VM state still comes from fork or replay. Keep that pairing explicit in the code and in the UI.

Acceptance: an offline test with the scripted model shows a checkpoint-mode child starts with the same messages as message mode **and** keeps the source run's todo list. One real experiment runs in checkpoint mode. The investigator's pending approval survives a server restart.

Fallback: 90 minutes. If seeding state fights the graph, keep `messages` mode, keep the durable checkpointer, and log it.

### Phase 7: a second trap (about 2.5 h)

1. `trap: "standin_column"`: add a column that tracks the outcome in `data.csv` and carries no signal in `holdout_features.csv`. Describe it in the task prompt's column list as something recorded after the outcome, the way a real data dictionary would.
2. `force_step:drop_column:<name>` as its fix. Label rule for dropping a column.
3. `scripts/calibrate_trap.py`: plain scikit-learn, 5 seeds, prints claimed vs true with and without the fix for both traps. Put the numbers in the README.
4. Optional: `deduplicate_fuzzy` for `trap_noise > 0`.

Acceptance: calibration shows a gap above the inflation threshold without the fix and near zero with it; a real batch on the new trap runs through to a verdict.

### Phase 8: show it (in parallel if a second session exists, otherwise after Phase 3)

Follow the existing UI rules: pure `(vm) => html` views, class prefixes, tests beside each view, replay support for every new section. Respect the `OWNER:` comments at the top of the files in `web/src/batch/`, and rebase before touching them, because a teammate is working there.

1. **Suspect board:** each suspect with who proposed it, its prediction, a score bar with a line at 20, pair dots, cost, and status.
2. **Approval card:** suspect, change, prediction, pairs (editable), cost estimate.
3. **Verdict:** supported and cleared suspects, the two-factor grid when present, the audit sheet.
4. **Investigator panel:** its todo list and which subagent is working.
5. **Lessons:** the proposed rule with approve and reject. **Fool-rate table.**
6. A visible tag when a batch is simulated or when `investigator_assist` is on.

Acceptance: web tests pass against an updated fixture; a real saved batch replays from start to verdict.

### Phase 9: demo hardening (last 5 hours)

1. Record one clean real batch and make it the default replay.
2. Rewrite the README to match what was actually run. Add `docs/claims.md`: every claim the pitch makes, with the batch id that backs it.
3. Rehearse the 2-minute path: wall, reveal, suspects, one live experiment, verdict.

## 8. Review system

This is how the work stays on course. Do not skip it to save time.

### 8.1 Gate after every phase

```bash
uv run pytest -q
(cd web && npm run typecheck && npm test)
uv run python scripts/check_invariants.py
```

Write `scripts/check_invariants.py` in Phase 1 and extend it as you go. It must fail when:
- any file under a path the investigator can read contains a banned key from 6.2;
- the string `holdout_labels` is reachable through any API route or agent route;
- a `forks` entry has a changed copy with no control copy;
- a `supported` suspect has a score under 20;
- an existing case section or field from `docs/api-contract.md` is missing;
- a simulated batch lacks its flag.

### 8.2 Fresh-eyes review

After the gate commands pass, start a new subagent that has not seen your work. Give it only: section 3 of this file, the phase's acceptance list, and `git diff <phase-start>..HEAD`. Ask it to answer with file and line evidence:

1. Is the idea still the same? Name any feature that is not in the plan.
2. Is any invariant broken or weakened?
3. Can the investigator learn the trap from anything it can read? List every path checked.
4. Does every experiment have a control arm and a prediction saved before it ran?
5. Does any number shown in a verdict, the UI or the README lack a real run behind it?
6. Do the tests still run with no keys?
7. What is the riskiest line in this diff for the live demo?

Fix what it finds, or record why not in `docs/PROGRESS.md`.

### 8.3 Truth checks on real runs

Run these once Phase 2 works, and again before the demo:
- **Same-vs-same:** control against control should not reach 20. A false alarm is possible about 1 time in 20, so rerun once before concluding anything.
- **Harmless change:** a suspect that should not matter must end `cleared` or `open`.
- **Known cause:** the duplicate check must reach `supported`.

If the first or second check fails, the pipeline is fooling itself. Stop and fix before adding anything.

### 8.4 Progress log

Keep `docs/PROGRESS.md` current. One block per phase: start and end time, commit hash, gate result, real-run numbers, fallbacks taken, open problems. Add a section **Proposed deviations**: if you think this plan is wrong somewhere, write the reason there and keep following the plan unless it blocks you. Ask the user only when a change would touch section 3.

### 8.5 When stuck

Give a blocker 30 minutes. Then take the phase's fallback, log it and move on. Do not invent a new design to get around a blocker.

## 9. Working rules

- **Git:** work on `upgrade/investigator`. Commit after each green gate with `phase N: <what>`. Rebase on `origin/main` before each phase, since teammates are pushing UI work. Never force-push a shared branch. Push your branch; let the user merge.
- **Money:** real runs cost money. Use small batches and `--auto-approve` only with a budget of $3 or less. Ask the user before any batch over 12 runs and before the fool-rate run.
- **Secrets:** keys live in `.env`. Never print, log or commit them.
- **Verify APIs:** before first use, check these against the installed version with the docs MCP servers: subagent `response_format`; `RubricMiddleware` and how the rubric is passed; `memory=`; `FilesystemPermission` read rules and `mode="interrupt"`; the `edit` decision shape for `interrupt_on`; the async SQLite checkpointer; `get_state_history` and `update_state(as_node=...)`.
- **Dependencies:** only `langgraph-checkpoint-sqlite` and what it needs. Ask before adding anything else.
- **Scope:** no async subagents, no interpreter-based subagents, no new frameworks. Do not rewrite the UI architecture.
- **Own code:** the research ideas below are published, but write the code yourself. Do not copy from their repositories.
- **Honesty in the product:** never present simulated runs as real, and never show a cause without its score.

## 10. Time plan and cut order

| By (Eastern) | Done |
| --- | --- |
| Sat 8 am | Phase 0 and 1 |
| Sat 1 pm | Phase 2 and 3 |
| Sat 5 pm | Phase 4, core of Phase 8 |
| Sat 10 pm | Phase 5 and 6 |
| Sun 2 am | Phase 7, feature freeze |
| Sun 7 am | Phase 9, submission ready |

If behind, cut in this order: Phase 7, checkpoint mode in Phase 6, the fool-rate run, casebook memory, the rubric middleware (keep the rules in `record_verdict`), `fake_result` and `swap_model`.

Never cut: Phase 0, the blind view, the choice of suspect, pairs with a control and a saved prediction, the score threshold, the review gates.

## 11. Why each piece exists

| Piece | Idea it comes from |
| --- | --- |
| Investigator that tries to disprove its own suspects, with a running evidence score | [POPPER, ICML 2025](https://arxiv.org/abs/2502.09858) |
| Five kinds of change, control as the "do nothing" case, two-factor split | [Causal Agent Replay, 2026](https://arxiv.org/abs/2606.08275). That paper tested on toy models with fake tools and left real tools out of scope. Running it on real machines is our contribution |
| Experiments instead of asking a model to read the logs | [AgenTracer, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/file/134ed7a477770f227f12450ef0cbb8f4-Paper-Conference.pdf): top models found the failing step from logs alone 3% to 39% of the time |
| Planted flaws as a test method | [Hidden pitfalls of AI scientist systems, NeurIPS 2025](https://arxiv.org/abs/2509.08713) |
| Eight leak types, the second trap, the audit sheet | [Leakage and the reproducibility crisis](https://arxiv.org/abs/2207.07048) and its [running list](https://reproducible.cs.princeton.edu/): 648 affected papers in 30 fields |
| An outside check on AI scientists | [2026 survey of AI scientists](https://arxiv.org/abs/2608.05179): no surveyed system had one built into its loop |
| Rewind and fork | [LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel), [checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) |
| Subagents, skills, memory, rubric, approvals | Deep Agents docs: [subagents](https://docs.langchain.com/oss/python/deepagents/subagents), [skills](https://docs.langchain.com/oss/python/deepagents/skills), [memory](https://docs.langchain.com/oss/python/deepagents/memory), [rubric](https://docs.langchain.com/oss/python/deepagents/rubric), [human-in-the-loop](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop) |

## 12. Start here

1. Run `date`, `git fetch`, and create the branch.
2. Copy this file to `docs/MASTER_PLAN.md` and create `docs/PROGRESS.md`.
3. Begin Phase 0. Report to the user after Phase 0 with the real-run numbers before going further.
