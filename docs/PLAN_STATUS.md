# Plan status: what the code really does

Audited `origin/main` at `d3a23ab` (merge of #41), Sat Nov 14 23:57 to Sun Nov 15 00:05 Eastern. Read-only. Audit against
`docs/MASTER_PLAN.md`. Product name: Orro.

## Summary

Updated Sun Nov 15 02:45 Eastern to match the sections below and the code on this branch. The phase sections further
down keep the 00:05 audit as it was written; the "Fixed", "Rebuilt" and "Open items" sections record what changed since.

| Phase | Status | One line |
| --- | --- | --- |
| 0 Baseline on real runs | **Done** | Real batch `1114-032554-c05a`: 8 honest, 4 inflated, a real fork, a real verdict. The real tabular batch `1115-012104-800f` is committed as `fixtures/tabular-live-investigation` |
| 1 Blind start, wider net | **Done, one kept exception** | Trap keys, `overlap_share`, `n_test_copies`, `config.seed`, `candidates` and `audit` are out of the view; `/runs/**/score.json` is denied to every file tool; `investigator_assist` exists; `rank_candidates`; `scripts/check_invariants.py`. Since 02:45 `list_changes`, `list_interventions`, `request_forks` and the `method-errors` skill name no trap and no trap column (generic changes, `drop_column:<column>` checked against data.csv). `split` stays in the view on purpose |
| 2 Experiments with a choice and a score | **Done** | 6.4 running score (`evidence.py`), the five-kind change registry, `Batch.run_experiment` with approve, edit, reject, `cli experiment --auto-approve`. Real: same-vs-same open at 0.019 and a harmless change cleared at 0.0002 (`1115-010055-bfc9`); a suspect supported at 24.76 (`1115-012104-800f`) |
| 3 The investigator does the science | **Done** | Prompt of role, method and rules; typed `step-tagger`, `lens-*` and `skeptic` subagents; `write_todos`. Real acceptance met on `1115-012104-800f`: blind, two suspects tested, one supported, one cleared |
| 4 A verdict that is checked | **Done offline, grid not run for real** | `RubricMiddleware` sent real verdicts back twice (robot run, `1115-012104-800f`). The audit sheet is built (`audit.py`, `Batch.write_audit`, at the end of every investigation). The two-factor grid is reachable since 02:45: the `run_interaction` tool (same approval as `run_experiment`, only for two supported suspects) and `cli interaction`; no real batch has run it |
| 5 It learns | **Mostly done, not run for real** | The casebook `/memories/casebook.md` beside the per-domain notebook, both through `memory=`; `propose_lesson` with approval writes `skills/learned/<name>/SKILL.md`. Since 02:30: `lessons: learned` gives analysts the approved lessons as skills, and `cli foolrate` exists (estimate first, `--yes` to run). The fool-rate run itself has not been run |
| 6 Real time travel | **Done offline, no real run yet** | The investigator and, since 02:30, every analyst checkpoint to the batch's `checkpoints.sqlite`; a pending approval survives a restart (tested); `fork_mode: checkpoint` seeds a copy from the source run's LangGraph snapshot (todo list kept); the VM still comes from replay. Not yet run for real |
| 7 A second trap | **Partial** | `leaky_column` (the plan's `standin_column`) and `repeat_rows` exist and calibrate. No real batch on them |
| 8 Show it | **Mostly done** | Suspect board, approval card with editable pairs, lessons, investigator panel (plan, subagents, finished summary), simulated and `investigator_assist` tags, and the grid's effects on the suspect board when `interaction` is set. No fool-rate view |
| 9 Demo hardening | **Partial** | A real robot recording and a real tabular recording (`1115-012104-800f`, the landing's "Demo replay"), the README's "What we ran for real", `docs/claims.md` with batch ids. The landing's own figures are still the simulated `demo-batch` |

## Fixed in this PR (after the audit)

The audit below is kept as it was written. These are the fixes landed on top of it, Sun Nov 15 from 00:05 Eastern.

| Finding | Fix | Where |
| --- | --- | --- |
| #9 optional stopping: more pairs rerun Fisher after every round | The level is now the 6.4 running score of control/forced pairs matched by copy number (x1.9 agree, x0.1 otherwise, a tie disagrees): `supported` at 20 or more, `cleared` after 5 or more pairs under 1, else `open`. Valid when checked after every pair (a test enumerates it). Fisher p and an exact gap test are kept for display. Known answers pinned on `fixtures/demo-batch` f1: Fisher 5/70, gap test 1/70, score 13.03. The more-pairs default is now the fewest agreeing pairs that could reach 20 | `deep_research/evidence.py`, `tests/test_evidence_score.py` |
| #9 the verdict's step is not tied to the tested fork | `record_structured_verdict` refuses a causal sentence whose step is not the `label` the supporting fork forced. More pairs reword the sentence with the fork's step | `case_file.py`, `batch.py` |
| #9 old verdicts that overclaim | Not rewritten. The loader (`with_evidence`) reads saved evidence without `rule` by the new rule and keeps the old one as `evidence_old_rule`; the stored sentence never changes, and the UI flags it as an overclaim. `1114-032554-c05a` (old: supported, 8 pairs, p = 0.0385) now reads **cleared**: 6 of 8 pairs agree on the gap and 2 are exact ties, score 0.47. `1114-034546-6c7a` stays open (13.03). The three fixtures stay open (13.03) | `case_file.py`, `batch_summary.py` |
| #8 contract | Additive only: verdict and fork evidence gain `rule`, `score`, `needed_score`, `agree`, `disagree`, `basis`, `p_exact`; forks gain `pairs`, `score`, `p_exact`, `level`; `cleared` joins the levels. `needed_pairs` is 5 for new evidence. Fixtures regenerated in place from the new functions (the robot fixture scripts need the meshes) | `docs/api-contract.md`, `web/src/api.ts`, `scripts/make_*fixture.py`, `fixtures/` |
| W1 blind view | `overlap_share`, `n_test_copies` (runs, fork copies, baseline, fix), `config.seed`, `candidates` and `audit` are out of the view. `/runs/**/score.json` is denied. deepagents' `read` rule covers `ls`, `read_file`, `glob` and `grep` and filters denied files out of glob and grep results (checked against the docs and the installed code), so no filtered folder was needed. A test drives the investigator's own tools at score.json. `split` stays in the view on purpose, as recommended; the README says so | `case_file.py`, `agents/investigator.py`, `tests/test_blind_view.py` |
| No `scripts/check_invariants.py` | Written to 8.1, runs with no keys. Passes on the 4 fixtures. On this machine's local `batches/` it flags stale saved views (case/view/case.json written by older code, with trap keys and `overlap_share`); they are rewritten the next time a batch is opened | `scripts/check_invariants.py`, `tests/test_check_invariants.py` |
| #11 fresh clone fails | Tests that need the panda or G1 meshes are marked and skip with the fetch command when the meshes are absent. With the panda meshes in place they pass | `tests/conftest.py` |
| No `docs/claims.md` | Written: 42 claims. Two were wrong and are fixed in the README (analysts were Haiku only; the rule's numbers). Still open on the landing page, which is simulated and does not say so: the "89% claimed, 75% real" pill, the terminal's causal verdict, and "forks the VM to prove". The 2-minute demo path is written there | `docs/claims.md`, `README.md` |
| Demo default | The How it works page said "a real batch" but drew from the simulated `robot-demo-batch`. It now draws from `fixtures/robot-live-investigation` (one constant, no `OWNER` file touched) | `web/src/batch/how.ts` |

Gate at the push: `uv run pytest -q` 503 passed, 14 skipped (4 of them the mesh skips); `npm run typecheck` clean;
`npm test` 791 passed; `scripts/check_invariants.py` ok.

## The investigator rebuilt on Deep Agents (Sun Nov 15, from 01:00 Eastern)

Merged `upgrade/experiments` (change registry, `Batch.run_experiment`, grid, audit) and `upgrade/ui` (suspect board,
approval card with pairs, lessons, investigator panel). Checked against the installed deepagents 0.7.38,
langgraph 1.2.22, langchain 1.5.0 and langgraph-checkpoint-sqlite 3.1.3. All offline; no real run yet.

| Plan item | Now | Where |
| --- | --- | --- |
| 6.4 one evidence rule | `experiments.py` has no math of its own: pairs, agreement, score, level and the exact test are `evidence.py` (`pair_up`, `agrees`, `score_pairs`). The fork path (`run_forks`, more pairs) and `run_experiment` score through the same function, and an experiment's fork carries the same `evidence` record | `evidence.py`, `experiments.py`, `batch.py` |
| 3.3 todo list | `TodoListMiddleware` on the investigator (it was missing: planning is opt-in since deepagents 0.7; the line below that said "default" was wrong). The plan reaches `investigator.todos` | `agents/investigator.py`, `batch.py` |
| Review bugs | Explicit read-only `general-purpose` subagent (no tools, no writes); no `execute` tool (`FilesystemMiddleware(tools=[...])` on the investigator and every subagent); the grader gets the verdict first, then the evidence, compact JSON, in pieces under its 4,000-character cut; subagent events carry the subagent's name, and `investigator.subagent` names the one at work | same |
| 6.5 tools | `record_suspects` (`suspects` section, linked to a hypothesis on the same label; `hypotheses` kept), `list_changes`, `run_experiment` (approve, edit, reject; `forks.pending` has suspect, change, anchor, prediction, reason, pairs, `estimate_usd`, `cost_per_pair_usd`; `POST /decision` takes an optional `pairs`), `record_verdict` with `supported`, `cleared`, `open`, `limits` (refuses a supported suspect under 20 or one whose evidence is not its own experiments; a cleared one must be `cleared`), `request_forks` unchanged | `case_file.py`, `batch.py`, `api.py` |
| 3.2 typed subagents | `step-tagger` (one per run, `StepTags`), `lens-omission`, `lens-commission`, `lens-data`, `skeptic` (`LensReport`, `SkepticReport`), each with `skills=["/skills/"]`, read-only, no tool that spends or writes. `lens-data` reads each run's own `outputs/` (train.csv, test.csv) under `/runs/`; `score.json` and hidden folders stay denied. No `run_python` lab VM (cut: not cheap) | `agents/investigator.py` |
| 3.1 prompt | Role, method (observe, suspects, predict, experiment, update, conclude) and rules; no numbered script, no trap | `main_prompt` |
| Phase 6 durable checkpointer | `AsyncSqliteSaver` per batch at `batches/<id>/checkpoints.sqlite`, `durability="sync"`, the stream read to its end after an interrupt. `Batch.resume` keeps a pending approval when the file exists, and `decide` continues the same thread (`investigator.thread_id`). Tested across a simulated restart | `batch.py` |
| Phase 5 casebook and lessons | `memory=[notebook, "/memories/casebook.md"]`; writes allowed only on `/memory/**` and `/memories/**` (investigator only), denied everywhere else. `propose_lesson` with approval writes `skills/learned/<name>/SKILL.md` and `lessons`; `POST /api/batches/{id}/lessons/{lesson_id}` answers it | same, `api.py` |
| `investigator_assist` | `BatchConfig.investigator_assist: none \| baseline`; `baseline` puts `candidates` in the view | `config.py`, `case_file.py` |
| Verdict view wording | The verdict page's evidence line says the running score decides and the Fisher p is shown only | `web/src/batch/lanes.ts` |
| Method gate (02:45) | The one real run never called `write_todos` or `task`, so plain code now asks for them. `record_suspects` is refused once before a plan and a lens call; `run_experiment` once per suspect before the skeptic, and that refusal is given before the approval card, so no one approves a cost that is not spent. The second try goes through and is logged in `investigator.skipped_steps`. Calls are read from `investigator.subagent_calls` and `todos` in the case file, so the gate survives a restart. `BatchConfig.investigator_strict` (default on) turns it off | `agents/method_gate.py`, `batch._method_gate_answer` |
| Flat analysts, per agent (02:45) | `_make_flat` registered a process-wide harness profile per model, which took the default general-purpose subagent from any other deep agent on the same model. The analyst now passes `NoSubagents`, a no-op middleware named `SubAgentMiddleware`, which replaces deepagents' own in that agent's stack only (`graph._apply_custom_middleware`, as `NoCompaction` does for summarization): no `task` tool, no subagents | `agents/analyst.py` |

Since 02:30 Nov 15, no longer cut: fork copies keeping the source run's todo list (`fork_mode: checkpoint`), the
analysts loading learned lessons (`lessons="learned"`) and the fool-rate command (`cli foolrate`, not run). Still cut: a
cheaper grader with an evidence tool, the `run_python` lab VM.
Offline tests: `tests/test_investigator_science.py` (two suspects, a predicted experiment approved with edited pairs, a
supported suspect under 20 refused; restart; lesson; subagent shapes and names).

The biggest divergence is that the flagship moved from the tabular trap to the **robot arm domain**
(`deep_research/domains/robot_arm.py`, `sim/`). It also has a code-trace and patch path the plan does not have. The README's
2-minute demo is built on `fixtures/robot-live-investigation`, a real run.

Broken or weakened invariants: **#9** is weakened in three ways and **#1/W1** in one (the blind view keeps the trap's own
evidence number). **#11** fails on a fresh checkout until the sim meshes are downloaded. **#2** holds. Details below.

## Offline checks

Run on a fresh worktree at `d3a23ab`, with no keys in the environment.

| Check | Result |
| --- | --- |
| `uv run pytest -q` | **Stops at collection**: `tests/test_scene_view.py` cannot open `sim/assets/franka_emika_panda/scene.xml` |
| `uv run pytest -q --continue-on-collection-errors` | **483 passed, 3 failed, 10 skipped, 1 error** in 87 s |
| The same 4 with the panda meshes linked in | 10 of 10 passed. The last failure (`test_humanoid_push_domain.py::test_check_config_and_starts`) needs the G1 meshes |
| `cd web && npm run typecheck` | Clean |
| `cd web && npm test` | **790 passed**, 39 files |
| `scripts/calibrate_traps.py --seeds 5 --trees 100` | All 3 traps usable (table under Phase 7) |
| `scripts/check_invariants.py` | **Does not exist** (plan 8.1) |

Every failure is a missing download (`sim/fetch_assets.py`, `sim/assets/` is gitignored), not a key or a VM. The Docker
image fetches the meshes (`Dockerfile:38-41`), so production is fine. A teammate who clones and runs `pytest` sees red.

## Real batches found

`batches/` is gitignored. These are on this machine only, unless the hub has them. The hub was not checked: reading it
needs `HUB_URL` from `.env`.

| Batch | Domain | Runs | Fork | Verdict |
| --- | --- | --- | --- | --- |
| `1114-024515-6bad` | tabular, duplicates | 9 honest, 3 inflated | approval left pending | none |
| `1114-030419-24ed` | tabular | 12 inflated, 0 honest | none (`no_split`) | none |
| `1114-032554-c05a` | tabular | 8 honest, 4 inflated | f1 replay: control 4/8, forced 0/8, p = 0.0385 | **supported**, after one round of more pairs |
| `1114-034546-6c7a` | tabular | 5 honest, 7 inflated | f1 replay: control 4/4, forced 0/4 | says "caused" at 4 pairs (open). Saved before the wording guard |
| `1114-103920-eb72` | robot_arm | 3 honest, 5 inflated, 2 unclear, 2 failed | f1 replay, 4 arms: forced 0/4, others 4/4, p = 0.014, open | open, rubric revised twice, fix measured worse. In git as `fixtures/robot-live-investigation` |
| `1114-173444-418b` | robot_arm | 11 honest, 6 inflated | none (phase `ready`) | none |
| `1114-222419-0c90`, `1114-224539-3922` | robot_arm | 23 and 31 of 36 **failed** | none | none |
| `1115-010055-bfc9` | tabular, duplicates | 12 honest, $0.09 | f1 control vs control from r01: 3 pairs, score 0.019, **open**. f2 harmless `edit_context` ("clock is set to UTC"): 5 pairs, score 0.0002, **cleared**. All copies by replay | none (an acceptance check, not an investigation). Local only |
| `1115-012104-800f` | tabular, duplicates with near-duplicates (strength 0.5, noise 0.05, hidden share 0.8) | 12 inflated, 0 honest, $0.486 of $1.50 | f1 (s1 `deduplicate_near`, from r01): 5 of 5 pairs agree, score 24.76, **supported**, p_exact 0.004. f2 (s2 `deduplicate`, from r08): 1 of 5 agree, score 0.0002, **cleared**. 20 copies by replay | "caused", confidence medium; s3 `evaluate` open; rubric sent back twice, then satisfied. In git as `fixtures/tabular-live-investigation` |

Added Sun Nov 15 around 01:40 Eastern, every number read from each batch's `case/case.json`:
`1115-012104-800f` is the first real run of the rebuilt investigator on the tabular trap, and the first real batch to
reach `supported` under the 6.4 score. It started blind (`investigator_assist: none`, `split: null`, no honest run).

## Fixed Sun Nov 15, from 02:35 Eastern (second audit, at `3177b86`)

| Gap | Fix | Where |
| --- | --- | --- |
| The investigator's view named the trap catalog: `list_changes` listed `drop_leak`, `group_split` and `drop_column:followup_score`, and the skill named `followup_score` | `list_changes` shows generic changes only, each with what it does (`forks.blind_changes`): `control`; `force_step` `deduplicate`, `deduplicate_near`, `drop_column:<column>`, `group_split:<column>`; `fake_result`; `edit_context`; `swap_model`. A trap's own step asked for by its label is refused with a pointer to the generic form. A named column must be a column of the batch's data.csv, and the error does not list them. `list_interventions` and `request_forks` output replace trap columns with `<column>`. `trap_fixes` stays with the orchestrator. Traps declare their columns (`Trap.columns`). The skill names no trap column | `forks.py`, `traps/`, `agents/investigator.py`, `batch.py`, `skills/method-errors/SKILL.md`, `tests/test_blind_view.py` |
| `check_invariants.py` gaps (8.1) | Fails when a suspect's status disagrees with `evidence.<id>` under the running-score rule, when `verdict.supported` names a suspect under 20, when a banned key or `holdout_labels` is on any investigator route (routes found by building the investigator's backend: `/case/`, `/runs/`, `/skills/`, `/memory/`, `/memories/`, plus the analyst VM's files), and when any GET route FastAPI has serves or names `holdout_labels` (each path parameter filled in; a new parameter fails until it gets a probe) | `scripts/check_invariants.py`, `tests/test_check_invariants.py` |
| The two-factor grid had no caller | `run_interaction(suspect_a, suspect_b, per_cell=2, reason="")` on the investigator, behind the same approve, edit, reject as `run_experiment`, refused unless both suspects are `supported`; each suspect's change comes from its newest experiment. `forks.pending.kind = "interaction"`. `cli interaction <batch> --a s1 --b s2 --per-cell 2 --auto-approve`. A prompt rule says when to run it | `agents/investigator.py`, `interaction.py`, `batch.py`, `cli.py`, `tests/test_interaction_offline.py` |

## Open items (Sun Nov 15, 01:40)

- **Fixed at 02:45, see above.** **`list_changes` names a fix for every trap.** In `1115-012104-800f` the investigator's `list_changes` result lists
  `force_step:deduplicate`, `drop_leak`, `group_split`, `deduplicate_near`, `deduplicate_fuzzy`,
  `drop_column:<name>` and `fake_result:no_duplicates`, and its `list_interventions` and the `method-errors` skill name
  the leaky column `followup_score` ("Drop the followup_score column from data.csv…"), the name the registry's
  `force_step:drop_column:followup_score` uses (`forks.py:194`). That hints at which traps exist
  and their column names. Small: the investigator still had to choose, and the trap's own keys stay hidden. Fix by
  listing only the change kinds that apply to the batch's domain without trap-specific names.

The three tabular batches with a fork predate the new investigator. Their hypotheses have no id or prediction, so their
forks carry no pre-registered prediction. The only real run of the current investigator is the robot one. Daytona refused
VM forks in every batch, so all copies were rebuilt by replay. The two newest robot batches failed most of their runs.
Nobody has logged why.

`docs/PROGRESS.md` was last updated Sat 17:27 (`33b4b3c`, a "Final sprint" section), not 04:40. Its phase checklist stayed
unticked. `fa1e290` deleted it at 17:47.

## Phases

### Phase 0: prove the baseline on real runs. Done

| Check | Met | Evidence |
| --- | --- | --- |
| A real batch with honest and inflated runs | met | `1114-032554-c05a` (8 honest, 4 inflated, $0.57), `1114-103920-eb72` |
| A real fork result | met | `1114-032554-c05a` f1, 16 copies by replay. Replay fallback taken, as allowed |
| A real verdict | met | `1114-032554-c05a`, `fixtures/robot-live-investigation` |
| All saved under `batches/` | met | The robot run as `fixtures/robot-live-investigation`; since 01:40 the tabular run `1115-012104-800f` as `fixtures/tabular-live-investigation` (holdout labels and `checkpoints.sqlite` left out, `scripts/make_live_fixture.py`) |
| Numbers logged in `docs/PROGRESS.md` | moved | The file was deleted. The README's "What a real run found" (robot) and "What we ran for real" (tabular, `1115-012104-800f`: 12 of 12 inflated, s1 supported at 24.76, s2 cleared at 0.0002, $0.486) carry them, with `docs/claims.md` |

### Phase 1: blind start and a wider net. Partial

| Check | Met | Evidence |
| --- | --- | --- |
| Blind view written on every save, `/case/` points at it | met | `case_file.py:156-162`, `agents/investigator.py:491` |
| Banned keys removed: `config.trap*` | met | `case_file.py:91-93` |
| Banned keys removed: `config.seed`, `runs.*.overlap_share`, `split`, `candidates` | **not met** | `VIEW_HIDDEN` only drops `hidden_results` and `benchmarks` (`case_file.py:85`). `overlap_share` is the trap's evidence number (`scoring.py:25-27`) |
| `/runs/*/score.json` denied | **not met** | Read denies cover `hidden/` and the bench folder only (`agents/investigator.py:444-447`). `score.json` is written at `batch.py:763` |
| Prompt never mentions the trap | met | `tests/test_blind_investigator.py:50`. But the prompt says "Start with ... `split`" (`agents/investigator.py:135-137`) |
| Skill is a general guide | met | `test_blind_investigator.py:72`. It still says "the label in nearly all honest runs ... is the suspect step" (`skills/method-errors/SKILL.md:28`) |
| `rank_candidates`, both directions, plus attributes | **not met** | `find_split` still ranks by `h - i` (`analysis.py:340-345`). `label_table` lists every label but in one direction (`analysis.py:386-402`) |
| A test that finds a planted commission | **not met** | No such test |
| New label rules: drop a column, group-aware split | met | `drop_leak`, `group_split` from the traps (`analysis.py:58-74`). Feature selection: not met |
| `ready` with inflated runs and no honest one | **not met** | `analysis.py:330-331` returns None. Real case: `1114-030419-24ed` ended `no_split` |
| `investigator_assist` flag | **not met** | No such flag. Moot while `split` stays in the view |
| `scripts/check_invariants.py` | **not met** | Missing |

### Phase 2: experiments with a choice and a score. Diverged

Built as hypotheses and Fisher counts instead of suspects and paired gaps.

| Check | Met | Evidence |
| --- | --- | --- |
| `evidence.py` with the 6.4 rules (pair, agree, 1.9 / 0.1 score, levels 20 and cleared) | **diverged** | `evidence.py:23-77`: a level from a one-sided Fisher test on arm counts, `supported` at 8 or more pairs and p < 0.05. No `cleared` level. The 6.4 score is drawn in the UI as a measure only (`web/src/batch/evidence.ts:1-20`) |
| Fixture known answers (5/70, 1/70, 13.03) pinned in tests | unknown | Not found in `tests/` |
| Change registry with five kinds | **not met** | `forks.py:14-28` keeps `INTERVENTIONS` (one forced step per label) plus `placebo` and `show` arms (`forks.py:82-97`). No `fake_result`, `edit_context` or `swap_model` |
| Fork points `before_label`, `index` | **partial** | Each hypothesis gets its own fork point, before the claim (`analysis.py:405-416`, `batch.py:891-899`) |
| `Batch.run_experiment` | **diverged** | `run_forks(n_per_arm, hypothesis_id)` (`batch.py:902-930`) over `_experiment` (`batch.py:1129-1186`) |
| The investigator chooses what to test | met | `request_forks(hypothesis_id)` (`agents/investigator.py:377-378`). At least 2 hypotheses first (`batch.py:56`, `batch.py:875-877`) |
| Prediction saved before any copy starts | met | `_preregistration` (`batch.py:932-936`), `tests/test_experiments.py:78` |
| A pair with a failed copy is dropped | met, by counts | Failed copies are left out of the totals (`evidence.py:12-13`) |
| `interrupt_on` with approve, edit, reject. `forks.pending` | **partial** | approve and reject only (`agents/investigator.py:479`). `POST /decision` takes `approve` only (`api.py:1008-1018`) |
| `cli experiment ... --auto-approve` | **diverged** | `cli forks` and `cli investigate --auto-approve` (`cli.py:207-212`) |
| Real: `deduplicate` reaches a score | met | `1114-032554-c05a`, supported after more pairs |
| Real: same-vs-same does not reach 20 | met | `1115-010055-bfc9` (tabular, 12 honest) f1: control vs control from r01, 3 pairs, score 0.019, **open**. Local only |
| Real: a harmless change is cleared | met | `1115-010055-bfc9` f2: `edit_context` ("this machine's clock is set to UTC"), 5 pairs, score 0.0002, **cleared** |
| Real: a suspect reaches 20 under the 6.4 score | met | `1115-012104-800f` f1: `force_step:deduplicate_near`, 5 of 5 pairs agree, score 24.76, supported (`fixtures/tabular-live-investigation`) |

Added beyond the plan: more pairs for an open verdict (`batch.py:1389-1450`), reworded in code (`batch.py:1498-1520`).

### Phase 3: the investigator does the science. Partial

| Check | Met | Evidence |
| --- | --- | --- |
| Prompt states a method, not a numbered script | **not met** | "The method: 1. ... 5." (`agents/investigator.py:140-160`) |
| Rules: at least 2 suspects, predict first, no cause below the bar | met | Enforced in code: `batch.py:863-878`, `evidence.py:90-102` |
| Subagents `step-tagger`, `lens-omission`, `lens-commission`, `lens-data`, `skeptic`, typed | **diverged** | `step-tagger`, `hypothesis`, `code-tracer` (`agents/investigator.py:450-476`). Typed tool arguments in place of `response_format`, with the reason given (`agents/investigator.py:19-25`). No `run_python` lab VM |
| `step-tagger` in parallel | unknown | Parallel `code-tracer` is tested (`tests/test_investigator_upgrades.py:419`) |
| Todo list | met (since 01:00) | Was **not** met: planning is opt-in since deepagents 0.7. `TodoListMiddleware` added |
| `/case/`, `/runs/`, `/skills/` read-only | met | `agents/investigator.py:444` |
| Offline: 2 or more suspects, an experiment with a prediction, a verdict under the bar refused | met | `tests/test_experiments.py:64`, `:78`, `tests/test_investigator_upgrades.py:274` |
| Real: blind, tests 2 or more, ends with one supported and one cleared or open | **met** | `1115-012104-800f` (`fixtures/tabular-live-investigation`): blind (`investigator_assist: none`, `split: null`), three suspects, two tested: s1 `deduplicate_near` **supported** (24.76), s2 `deduplicate` **cleared** (0.0002), s3 `evaluate` open. Earlier robot run: nothing supported |

### Phase 4: a verdict that is checked. Partial

| Check | Met | Evidence |
| --- | --- | --- |
| `RubricMiddleware` with a ledger | met, diverged rubric | `agents/investigator.py:276-337`. Rubric checks split, arms, level wording and hypothesis outcomes. Grader is the investigator's own model (`GRADER_MODEL = None`, line 295), not a cheaper one |
| Overclaim sent back, second passes | met | `tests/test_investigator_upgrades.py:228`. Real: `fixtures/robot-live-investigation` rubric rows: needs_revision, then satisfied. Real, tabular: `1115-012104-800f` rubric rows needs_revision (`inflated_rate` 0.0 with 12 of 12 inflated, f2's arm counts missing), needs_revision (rates still wrong), satisfied: sent back twice, the third version passed |
| Two-factor grid, `interaction` | **not met** | Absent |
| `audit.py`, a sheet per scored run | **not met** | Absent |

### Phase 5: it learns. Diverged

| Check | Met | Evidence |
| --- | --- | --- |
| Casebook read at start, appended at end | **diverged** | Per-domain notebook `batches/_memory/<domain>/AGENTS.md` (`notebook.py:53-57`) through `memory=` (`agents/investigator.py:505`). Subagents cannot write it (`:448`). Tested (`tests/test_investigator_upgrades.py:107-192`). The local tabular notebook has no entries |
| `propose_lesson`, `skills/learned/` | **not met** | Absent. `hint_level: none \| light` exists (`config.py:57`) |
| `lessons="learned"` batch | **met offline** (02:30 Nov 15) | `BatchConfig.lessons`. The analyst's VM backend is wrapped in a `CompositeBackend` whose `/skills/learned/` route reads `skills/learned/` read-only (writes denied by a route-scoped `FilesystemPermission`), and `skills=["/skills/learned/"]` is passed, so Deep Agents finds `<name>/SKILL.md` one folder below the source (`deepagents/middleware/skills.py`). A backend that is no sandbox gets the rules appended to its system prompt instead; the path used is logged and saved on each run (`runs.<id>.lessons`). The UI tags "Lessons on". `lessons.py`, `agents/analyst.py`; `tests/test_time_travel_offline.py` checks the skill is in the analyst's prompt. No real batch with lessons yet |
| Fool-rate table | **code met, not run** | `cli foolrate --n 12 --settings none,learned [--domain] [--noise --hidden] --budget X` prints the estimate (about $0.004 a run) and exits unless `--yes`. Writes `foolrate` (inflated, n, rate, 95% Wilson interval per setting; `none` always included as the control) to each batch and `batches/_foolrate/<stamp>.json`. `foolrate.py`. Tested offline with the scripted model only |

### Phase 6: real time travel. Done offline

| Check | Met | Evidence |
| --- | --- | --- |
| SQLite checkpointer per batch | **met** (02:30 Nov 15) | One `AsyncSqliteSaver` per batch on `batches/<id>/checkpoints.sqlite` (`Batch._saver`), shared by the investigator and every analyst. Runs use the stable thread `<batch>-<run>`, copies a new thread `<batch>-<fork>-<copy>`; both are saved as `thread_id`. The file closes when the last analyst lets go and no investigator holds it |
| `fork_mode: checkpoint` keeps the todo list | **met offline** | `BatchConfig.fork_mode` (default `messages`), `run_experiment(fork_mode=)`, `cli experiment --fork-mode checkpoint`. `Batch._checkpoint_seed` walks `aget_state_history` of the source thread for the snapshot whose next node is `model` and whose messages are the cut history; `_seed_copy` writes its values, plus the change's messages, into the copy's new thread with `aupdate_state(..., as_node="tools")`, then streams `astream(None, ...)`. Offline acceptance: the checkpoint copy starts with the same messages as the messages-mode copy and keeps the source run's todos (`tests/test_time_travel_offline.py`). No checkpoint (older batches such as the committed fixtures): falls back to messages mode, logs and records `fork_mode_fallback`. The VM always comes from replay; `forks.<id>.restore` says so. **Not yet run on a real batch** |
| Pending approval survives a restart | **met** | `Batch.resume` keeps `forks.pending` when `checkpoints.sqlite` exists (`batch.py`) |

### Phase 7: a second trap. Partial

| Check | Met | Evidence |
| --- | --- | --- |
| Stand-in column trap | met, renamed | `traps/leaky_column.py` (`followup_score`), label `drop_leak` |
| Its fix as a forced step | met | `traps/leaky_column.py:55-68` |
| Calibration script, 5 seeds | met | `scripts/calibrate_traps.py` |
| Gap above the threshold without the fix, near zero with it | met | Run tonight, 5 seeds, 100 trees: duplicates +14.8 / +0.1 pts, leaky_column +37.5 / +0.1, repeat_rows +18.1 / +2.4 |
| Numbers in the README | **not met** | The README covers the robot calibration only (`sim/CALIBRATION.md`) |
| A real batch on the new trap, through to a verdict | **not met** | None found |

### Phase 8: show it. Diverged, mostly done

| Check | Met | Evidence |
| --- | --- | --- |
| Suspect board with a score bar at 20 | **diverged** | Hypotheses with outcomes, and a Fork page that draws the 6.4 score as a measure. The level is the server's Fisher rule (`web/src/batch/evidence.ts`, `lanes.ts`) |
| Approval card | partial | `needs-you.ts`, admin-only. `pairs` not editable |
| Verdict with supported and cleared, grid, audit | partial | Verdict, evidence, rubric, fix. No grid or audit. Overclaims are flagged (`lanes.ts:1605`) |
| Investigator panel | met | Investigator lane with todo and subagent events (`lanes.ts:98-100`, `:1408`) |
| Lessons, fool-rate table | **not met** | Absent |
| Simulated tag | met | `batch-table.ts:137`, page header (`main.ts:322`) |
| `investigator_assist` tag | n/a | No flag |
| Web tests on an updated fixture | met | 790 passed |
| A real saved batch replays start to verdict | met | `fixtures/robot-live-investigation` |

### Phase 9: demo hardening. Partial

| Check | Met | Evidence |
| --- | --- | --- |
| A clean real batch as the default replay | met | `fixtures/tabular-live-investigation` (batch `1115-012104-800f`, real, ends supported) is what the landing's "Demo replay" links open (`LANDING.replay`). How it works stays on `fixtures/robot-live-investigation` (`HOW_BATCH`) |
| README matches what was run | met | "What a real run found" (robot) and "What we ran for real" (tabular, `1115-012104-800f`) |
| `docs/claims.md` | met | Every claim with its batch id; the tabular rows cite `1115-012104-800f`. Still unbacked: the landing's own figures ("89% claimed, 75% real", 6 of 12) are the simulated `demo-batch`, and no real copy was a VM fork |
| 2-minute path rehearsed | unknown | |

## Invariants (section 3)

| # | Invariant | Holds | Evidence |
| --- | --- | --- | --- |
| 1 | Same idea | holds, widened | Many runs, hidden truth, rewind and change one step, investigator verdict. The robot domain and the code-fix path are additions |
| 2 | Holdout labels never leave the server | **holds** | Written only to `task/holdout_labels.csv` (`task.py:96`). VMs get `data.csv` and `holdout_features.csv` only (`domains/tabular.py:62-63`). The files and motion routes refuse any `holdout_labels` or domain secret file by name, case-blind (`api.py:715-722`, `:872-884`). The hub never gets them (`hub.py:14`, `:61`). The investigator has no `/task/` route. Notes: (a) `fixtures/demo-batch/task/holdout_labels.csv` is committed to git (simulated Pima data, not served). (b) Robot hidden positions of scored runs are public through `/case` by design, and VMs have no egress limit (`sandboxes.py` sets none), so a fork copy could in theory read its own batch's hidden positions from the public site |
| 3 | Analysts isolated and flat | holds | No `task` tool per agent (`NoSubagents` in `agents/analyst.py`, no global profile), own VM, no case route |
| 4 | Deterministic work is plain Python | holds | Scoring, split, evidence, outcomes, more-pairs rewording are code (`evidence.py`, `batch.py:1188-1208`) |
| 5 | Every experiment has a control arm from the same point | holds | `forks.py:89`, `:121`. All arms fork one base VM (`batch.py:1151`, `:1167`) |
| 6 | Spending needs approval, the budget guard can refuse | holds, one gap | `interrupt_on` (`agents/investigator.py:479-482`). Budget check before a fork (`batch.py:1137`) and in flight (`batch.py:553-561`). Gap: `CostTracker.check` lets work through when no price is known (`costs.py:172-175`) |
| 7 | Case file is the UI's only data source, changed by its methods | mostly | UI reads the case plus event logs and motion files, as before. `scripts/live_investigation.py:49-51` writes `superseded_verdicts` and `sessions` straight into `case.data` |
| 8 | Contract is additive | holds | Old sections are all kept (`case_file.py:112-134`, `web/src/api.ts:11`). Only additions found |
| 9 | No cause claimed below the threshold | **weakened** | See below |
| 10 | Simulated data is labeled | holds | `config.simulated` in the 3 simulated fixtures. Live recording labeled `config.recording.kind = live`. UI tag (`batch-table.ts:137`) |
| 11 | Tests run with no keys and no VMs | **holds for keys, fails on a fresh clone** | 3 failures and 1 collection error until `sim/fetch_assets.py` downloads the meshes |

**#9 in detail.** The wording guard works: `record_structured_verdict` refuses "cause" while the level is open
(`case_file.py:439-441`, `evidence.py:90-102`), and the UI flags overclaims. Three gaps:

1. **Optional stopping.** More pairs pool every copy and rerun the fixed-sample Fisher test after each round, while the
   level is open (`batch.py:1462-1479`, `:248-249`). Looking again until p < 0.05 inflates false positives. The 6.4 score
   was chosen because it stays valid when checked after every pair. Real case: `1114-032554-c05a` was 0/4 vs 2/4 (open),
   then one more round gave 0/8 vs 4/8, p = 0.0385, and the sentence was reworded to "caused".
2. **The verdict's step is not tied to the tested fork.** `record_structured_verdict` checks that the step is a known
   label (`case_file.py:410`) and that the arms match the newest method fork (`:428-437`). It never checks that the fork
   tested that step. A "caused" verdict could name step A on step B's evidence.
3. **An old saved verdict overclaims.** `1114-034546-6c7a` says "caused" at 4 pairs. The level is computed as open on read
   (`case_file.py:45-52`), and the UI flags it, but the sentence is still stored. `CaseFile.record_verdict` itself has
   no guard (`case_file.py:373-381`).

**W1 in detail.** The blind view keeps `split` (the top label, the fork run and the rates) and `runs.*.overlap_share` /
`n_test_copies`. For the duplicates trap that number is the share of test rows that are copies of training rows, which is
the answer. `score.json` is readable under `/runs/`. The investigator is told to start with `split`.

## Recommendation

About 8 hours to the 8:00 am deadline. The flagship is the robot arm and its real recording. Spend the time on that path,
not on new phases.

**Finish (in order, about 3 h):**

1. **Close the #9 gaps (45 min).** Tie the verdict's step to the fork's `label` in `record_structured_verdict`. Either
   cap more pairs to one pre-declared round or decide the level with the 6.4 score, which `web/src/batch/evidence.ts`
   already computes. Reword or mark `1114-034546-6c7a` as overclaiming if it is ever shown.
2. **Blind view (30 min).** Add `overlap_share`, `n_test_copies` and `seed` to the hidden keys and deny `/runs/*/score.json`.
   Keep `split` (cutting it now changes the investigator's behaviour, too late to re-test), but say in the README that
   the investigator sees the deterministic split. The plan's `investigator_assist` tag covers this.
3. **Green tests on a fresh clone (20 min).** Skip the mesh tests when `sim/assets/` is missing, or document
   `python -m sim.fetch_assets --model all` as step one.
4. **`docs/claims.md` (40 min).** Every pitch number with its batch id: r06 100% vs 65%, 0/4 vs 4/4, p = 0.014, 65% → 25%, $2.50.
   Tie the landing's 89% / 75% to a batch or label it as calibration.
5. **Rehearse the 2-minute path on `fixtures/robot-live-investigation` (30 min).** Load it on the deployed site, with the
   hub and the meshes in place.

**Cut, following section 10:** Phase 7's real batch, Phase 6 entirely, the fool-rate run, `propose_lesson`, the two-factor
grid and `audit.py`, `fake_result` and `swap_model`. Keep the rubric middleware: it works and already caught a real
overclaim. Do not start `rank_candidates` or the lens subagents.

**Never cut, still open:** the same-vs-same check (plan 8.3). It costs one small fork. Run it only if keys and $1 to $2
are available and someone watches it. Otherwise say in the pitch that it has not been run.

**Riskiest gap for the live demo:** the "one live experiment" step. Daytona refuses VM forks, so every copy is rebuilt
by replay. The two newest real robot batches failed 23 and 31 of 36 runs, with no logged cause, and at 4 per arm a live
fork can only end "open". Play the experiment from the recording, and treat any live run as a bonus. If a live batch is
shown, start it well before the slot and keep the replay one click away.
