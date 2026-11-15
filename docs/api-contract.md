# API contract (server and web)

Shared by `deep_research/api.py` (FastAPI) and `web/` (Vite + TS). The client and its types are in
`web/src/api.ts`; `web/test/api.test.ts` checks them against `fixtures/demo-batch/`.

Run: `uv run uvicorn deep_research.api:app --reload --port 8000`, then `cd web && npm run dev` (Vite on 5173
proxies `/api` and the websocket to 8000). Or build the web app once and let the server serve it at `/`.

## Endpoints

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/health` | `{"ok": true, "keys": {"anthropic": bool, "daytona": bool}}`: whether each key is set, never the value |
| GET | `/api/defaults` | `{"config": BatchConfig, "prices_missing": bool, "traps": [TrapInfo]}`: `traps` is every trap a batch can plant (see Traps) |
| POST | `/api/estimate` | Body: a `BatchConfig`. Cost estimate from earlier batches' average run cost (all nulls until one has finished) |
| GET | `/api/datasets` | `[DatasetInfo]`: the built-in `pima` first, then uploaded files |
| POST | `/api/datasets?name=<file name>` | The body is the CSV file itself (up to 20 MB). Saves it under `datasets/` and returns its `DatasetInfo`. `422 {"detail"}` says why a file cannot be used; `413` when it is too large |
| POST | `/api/scripts?name=<file name>` | The body is a Python training script (up to 200 KB). The server parses it and never runs it. Saves it under `user_scripts/` and returns its `ScriptInfo`; `422 {"detail"}` when it is not valid Python |
| POST | `/api/controllers?name=<file name>` | The body is a robot controller, a Python file (up to 200 KB). The server parses it and never runs it. Returns its `ControllerInfo`; `422 {"detail"}` when it is refused (not valid Python, or no `class Controller` with `reset` and `act` methods); `413` when it is too large |
| GET | `/api/batches` | `[{"id", "kind": "live" or "replay", "resumable"?: true, "fixture"?: true, "remote"?: true, "machine"?, "summary": BatchSummary or null}]`: batches started on this server, saved batches in `batches/`, replays in `fixtures/` (`fixture`), and the team hub's batches (`remote`, run on `machine`). `resumable` marks a saved batch that `resume` would accept. `summary` is below ([The batch list](#the-batch-list)) |
| POST | `/api/batches` | Body: a `BatchConfig`. Starts a batch, returns `{"id"}`. `422 {"detail"}` when the dataset, target, script or trap cannot be used |
| GET | `/api/costs` | The cost report (below): spend across every batch, live ones from memory and saved ones from disk |
| GET | `/api/batches/{id}/case` | The case file (below) |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's `events.jsonl` as a JSON array |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's events, `child` like `control-1` or `forced-2` |
| GET | `/api/batches/{id}/investigator/events` | The investigator's events, each with an `agent` field |
| GET | `/api/batches/{id}/files/{path}` | A file saved with the batch, such as a run's `charts` entry. Served with a CSP that blocks scripts. The holdout labels and hidden can positions are never served, and a run's `hidden/` recordings only once the case lists them for the scored run |
| GET | `/api/robot/scene` | The robot scene for the 3D viewer (`deep_research/robot_view.py`): `{"bodies", "meshes", "geoms"}`, every visual geom with its body, type, size, local pose and color, meshes decimated to flat `v`/`f` arrays. About 1.4 MB, 0.45 MB gzipped (sent gzipped when accepted). `503` without mujoco or the panda meshes |
| GET | `/api/batches/{id}/motion?path=<motion file>` | One motion file as body poses: `{"t", "bodies", "frames": [[x, y, z, qw, qx, qy, qz per body], ...], "static", "result", "can_start", "place_target"}`, from `mj_kinematics` on each frame's qpos. `path` must be under `runs/<run>/outputs/` or `forks/<fork>/<child>/outputs/`, or be a scored run's hidden episode listed in its `hidden_results` (`400` otherwise, never `task/`; `404` for a hidden episode of a run not scored yet); `422` when the file is not a motion file. A team hub batch's file comes from the hub (see [Motion files on the hub](#motion-files-on-the-hub)) |
| GET | `/api/batches/{id}/motion-summaries?path=...&path=...` | For the viewer's file picker: per path, `{"can_start", "place_target", "duration", "n", "result"}` or `{"error"}`. Same paths, checks and hub fallback as `/motion` |
| POST | `/api/batches/{id}/investigate` | Live only. Starts the investigator (phase `ready`) |
| POST | `/api/batches/{id}/decision` | Live only. `{"approve": bool}` answers `forks.pending` (phase `awaiting_approval`); `{"approve": true, "pairs": n}` (1 to 6) approves a paired experiment with `n` pairs (the edit decision) |
| POST | `/api/batches/{id}/lessons/{lesson_id}` | Live only. `{"approve": bool}` answers a lesson the investigator proposed (`forks.pending.lesson_id`) |
| POST | `/api/batches/{id}/stop` | Live only. Cancels the work and stops every VM |
| POST | `/api/batches/{id}/resume?investigate=<bool>` | Bring a saved batch of ours back live, in phase `ready`, so the investigator and the fork experiment can run on it after a server restart. With `investigate=true` the investigator starts in the same call. Only a batch whose runs are all scored, with a split and no verdict yet; `409 {"detail"}` says why otherwise. The list and the websocket snapshot flag such a batch with `resumable: true` |
| POST | `/api/batches/{id}/suspects/{suspect_id}/test` | For a finished, real saved batch: resume its investigator on its own saved thread (`checkpoints.sqlite`), asking it to test a suspect its verdict left untested. Loads the batch back as more pairs do and claims it (phase `investigating`); the experiment it asks for waits on the usual approval, under the budget. Returns `{"id", "phase", "suspect_id"}`. `409 {"detail"}` says why it cannot (simulated, a fixture, running, already tested, no saved thread, files missing) |
| GET | `/api/batches/{id}/more-pairs?n=<copies per arm>` | For a saved batch whose verdict is `open`: what running `n` more copies per arm of the verdict's fork experiment would add and cost, for the confirmation (`MorePairsQuote`, see More pairs below). Starts and loads nothing. `409 {"detail"}` says why more pairs cannot run; `422` for `n` below 1 |
| POST | `/api/batches/{id}/more-pairs?n=<copies per arm>` | Run them: loads the saved batch back into this server (as `resume` does), claims it (phase `forking`) and starts the copies, then updates the fork and the verdict. Returns the quote plus `id`, `phase` and the new `children`. `409 {"detail"}` when it cannot run, an over-budget estimate included |
| WS | `/api/batches/{id}/ws` | See below |

Errors: unknown batch is `404 {"detail": ...}`; a live-only call on a replay is `409`; any other unknown `/api/*`
path is `404 {"error": "not found"}`. Every other path serves `web/dist`, falling back to `index.html`.

## Datasets

A batch runs on `config.dataset`: `pima`, or the `id` of an uploaded CSV (`ds-` plus 8 hex digits). An uploaded
dataset also needs `config.target`, the column to predict; Pima defaults to `outcome`.

```ts
DatasetInfo { id, name, builtin, rows, columns: [{ name, kind: "number" | "text", n_unique, missing, target_problem }], target }
```

`target` is Pima's target or, for an upload, a suggestion (the last usable column). `target_problem` is null when
the column can be the target; otherwise it says why not. The task is classification scored by accuracy, so a
target needs 2 to 20 different values with at least 5 rows each, and a file needs at least 100 rows. The
traps, the hidden holdout and the scoring are the same for every dataset.

## Traps

`config.trap` is the name of the flaw planted in the data: one of the `traps` in `GET /api/defaults`
(`duplicates`, `leaky_column`, `repeat_rows`; one module each in `deep_research/traps/`). An unknown name is a
`422`. `config.trap_strength` (0 to 1) and `config.trap_noise` (0 to 0.5) mean what the trap says they mean.

```ts
TrapInfo {
  name, title, description,           // the config value, and two strings for the picker
  planted,                            // after "planted": "duplicate rows"
  strength_label,                     // what trap_strength means: "Duplicated rows"
  label, pattern, at_split,           // the step an honest run does, the regex that spots it in code (valid as a
                                      // JavaScript RegExp), and whether the step can be the split itself
  did, missing,                       // "removed duplicate rows", "No duplicate check here"
  intervention: { description, command },   // what the fork experiment's forced arm runs
  evidence_text,                      // finishes "52% ...", or null when the trap has no evidence number
}
```

The web app takes everything it says about a trap from this, so a new trap needs no change there. A trap's `label`
is a step label like any other: it appears in `runs[].labels`, `split.label` and the investigator's labels.

## Training scripts

`config.script` is optional: the `id` of an uploaded script (`sc-` plus 8 hex digits). Each analyst VM then gets
it as `train.py`, and the task tells the agent to start from it (run it, change what it judges wrong) instead of
writing a script from nothing. The model hint is left out, because the script decides the model. Scoring, the
split finder and the fork experiment are unchanged: the split finder reads the script's text, and the agent's
edits to it, to label a run of `python3 train.py`.

```ts
ScriptInfo { id, name, lines, imports: string[], missing_packages: string[] }
```

`missing_packages` are imports that are not installed in the VMs (they have pandas, scikit-learn and matplotlib).
It is a warning, not a refusal.

## Controllers

Robot arm only. `config.robot_controller` is optional: the `id` of an uploaded controller (`ct-` plus 8 hex digits).
With `robot_start: "uploaded"` each analyst VM gets it as `controller.py`, and the agents start from it instead of
from the blank template (`"blank"`) or a colleague's working controller (`"colleague"`). Starting a batch with
`robot_start: "uploaded"` and no `robot_controller` is a `422`.

```ts
ControllerInfo { id, name, lines, imports: string[], missing_packages: string[] }
```

A controller is refused (`422`) unless it is valid Python with a `class Controller` that has `reset` and `act`
methods. `missing_packages` are imports that are not installed in the robot VMs (they have numpy and mujoco, plus
the `sim` package). It is a warning, not a refusal, as for scripts.

## The case file

One JSON file per batch (`case/case.json`), written only by `deep_research/case_file.py`. Sections:

- `config`: the `BatchConfig` (`deep_research/config.py`), plus `trap_info`: the batch's trap as a `TrapInfo`.
  Batches saved before traps were pluggable have no `trap_info`; they planted duplicates, and the web app then
  uses its built-in words for that trap. Fixtures add `"simulated": true`. `domain_info` is the domain
  (`Domain.public()`), and `domain_info.words` how the screens talk about it (`DomainWords` in `web/src/api.ts`:
  `subject`, `judged_on` with `{n}`, `checked`, `claim_label`, `truth_label`, `step_when`, `skipped`,
  `evidence_text`, and `steps`: `{name, did, missing}` for every step label). Absent on batches saved before it.
- `phase`: `config`, `running`, `analyzing`, then `ready` or `no_split`, `investigating`, `awaiting_approval`,
  `forking`, `forked`, `done`. Also `stopped`, `blocked: <why>` (over budget) and `error: <why>`.
- `runs`: by id (`r01`...). `status` goes `queued`, `starting`, `running`, then `honest`, `inflated` or `failed`.
  While running: `vm_id`, `lab_url`, `todos`, `step`, `last_tool`. The VM is deleted as soon as the run ends: `lab_url`
  becomes null and `charts` lists the saved PNG files (paths for `/api/batches/{id}/files/`). Once scored: `reported_accuracy`,
  `true_accuracy`, `overlap_share`, `gap`, `reason`, `n_actions`, `labels` (step labels per action).
  `overlap_share` is the trap's evidence number, read from the run's own `train.csv` and `test.csv`: for
  duplicates the share of test rows also in training, for repeat subjects the share of test rows whose subject is
  also in training. It is null when the trap has no evidence number (`trap_info.evidence_text` is null too) or the
  run's files do not have what it is read from; the UI then leaves the line out.
  Also once scored (`score.json` has the same keys): `n_hidden`, how many hidden cases the true score is measured on
  (holdout rows, or robot can positions). Tabular: `n_test` (rows in the run's own `test.csv`) and `n_test_copies`
  (how many of them the trap's evidence counts as copies of training rows, `round(overlap_share * n_test)`, null
  without an evidence number). robot_arm: `checked_positions` (`[x, y]` the run's own episodes used: every can start its
  episode runs printed, `sim.run`'s `"can_start"` or a `can at (x, y): success` line, and every saved motion file's,
  rounded to the millimeter, deduplicated, in order of first appearance; a fork copy counts its source run's
  episodes before the fork and its forced step's too) and `hidden_results`, one per hidden position and seed:
  `{x, y, seed, result, place_error_cm, motion}`. `result` is `placed`, `dropped`, `tipped` or `missed`
  (`sim.domain.outcome`), `motion` that episode's recording at 8 fps (`runs/r02/hidden/07-s0.motion.json`, fork
  copies under `forks/<fork>/<child>/hidden/`). The files and `/motion` routes serve a `hidden/` file only when
  the case lists it for a scored run; the investigator reads a case without `hidden_results` and cannot read
  `hidden/` folders. Fork children carry the same fields.
- `step_labels`: the investigator's labels per run.
- `split`: where honest and inflated runs part ways (`label`, `honest_rate`, `inflated_rate`, `fork_run_id`,
  `fork_at`, examples, `intervention`), or null.
- `hypotheses`: the investigator's, in order.
- `feed`: the live commentary's notable moments across runs, oldest first, at most 200:
  `{t, run, model, kind, text}`, `t` on the run's clock like its events, `model` short ("Sonnet"), `kind` one of
  `first_success`, `drop`, `label`, `finish`, `failed`. Empty when the batch has no commentary
  (`config.commentary`, on by default for robot_arm only); absent in case files saved before it existed. Its
  spend is the cost scope `commentary`, capped by `config.commentary_budget_usd`.
- `forks`: by id (`f1`...): `status` (`rebuilding`, `running`, `done`), `source_run`, `fork_at`, `label`,
  `intervention`, `n_per_arm`, `arm_steps`, `children` (each with `arm`, `status`, scores, `how`), and `arms`
  summaries when done. While the investigator waits for approval there is also `forks.pending` with `n_per_arm`,
  `vm_count` and `estimate_usd` (an average run's spend per copy, rounded up to the cent).

  `arm_steps` maps each arm, in the order it runs, to the step forced on it before it continues (null for
  `control`). `control` and `forced` are always there. `placebo` (`config.placebo_arm`) runs a harmless command so
  `forced` is not the only arm whose history carries an extra tool call, and `show` (`config.show_arm`) tells the
  agent what `forced` fixes and leaves it to decide. A batch saved before these existed has no `arm_steps` and ran
  `control` and `forced` only. `vm_count` is one base VM plus `n_per_arm` per arm.

  `kind` says what the experiment tests: absent or `method` is the experiment above, which step caused the
  inflation. `fix` is the second experiment, forked from the same moment of the same run, that tests the
  investigator's proposed patch (`fix` below). A robot batch has none: its fix is measured on the code itself
  (`fix.measured`), with no fork, since a copy's agent may undo an edit it did not make. A fix experiment runs only
  in a domain that cannot score code without a run, and on batches saved before. Its `arm_steps` has `control`,
  optionally `placebo`, and `fixed`,
  the run with the patch applied, in place of `forced`; its `arms` summaries read the same way, and what matters
  in them is `honest` of `scored` and `mean_true` (did the code get better), not the inflation. `forks.pending`
  carries the same `kind`, so the approval card can say which experiment is being asked for. The verdict always
  belongs to the method experiment; a fix experiment's result is recorded on `fix`.

  `more_pairs` (absent until one runs): the rounds of more pairs run on this fork after its verdict, oldest first
  (see More pairs below), each `{at, n_per_arm, children, status, estimate_usd, pairs_before, level_before,
  n_per_arm_before}` plus `pairs_after` and `level_after` once it ended and `reason` when it `failed` or `stopped`.
  `status` is `rebuilding` and `running` while it runs (the fork's own `status` follows: `rebuilding`, `running`,
  then `done` again), then `done`, `failed` (the base VM could not be rebuilt: no copy ran and nothing else
  changed) or `stopped` (stopped, or the server stopped: its scored copies count, the others are failed children).
  The fork's `children` gain the round's copies, `arms` counts every copy of every round, and `n_per_arm` becomes
  the copies per arm over all rounds.
  A finished method fork also has (MASTER_PLAN 6.1, added with the running score) `evidence` (the same shape as the
  verdict's below), `pairs` (`[{i, control_gap, changed_gap, agree}]`: control copy i and forced copy i, both
  scored with a gap; `agree` when the forced gap is smaller, a tie disagrees), `score`, `p_exact` and `level`. A fork
  saved before these gets them when read, and keeps the evidence it was saved with as `evidence_old_rule`.
- `verdict`: `{sentence, step_label, numbers, evidence}` or null. `evidence` (`deep_research/evidence.py`,
  `VerdictEvidence` in `web/src/api.ts`): `{level, pairs, needed_pairs, control_inflated, control_total,
  forced_inflated, forced_total, p_value, rule, score, needed_score, agree, disagree, basis, p_exact}`. The level is
  the MASTER_PLAN 6.4 running score (`rule`: `running_score`): it starts at 1 and is multiplied by 1.9 per agreeing
  pair and 0.1 per other pair of the fork it rests on. A pair counts only when its control copy reproduces the effect
  under test (`inflated` for `smaller_gap`, `honest` for `larger_gap`); `level` is `inconclusive` (added, additive)
  when no pair counts and some were dropped for that reason. `level` is `supported` at `score` >= `needed_score` (20),
  `cleared` after `needed_pairs` (5) or more pairs with a score under 1, else `open`. The score stays valid when it
  is checked after every pair, so more pairs never inflate it. `basis` is `pairs` when the fork's copies were paired
  by their gaps, `counts` when only arm counts were known (then the least favourable pairing, inflated standing in for
  the gap, and never `cleared`). `p_value` (one-sided Fisher exact on the counts) and `p_exact` (exact permutation test
  on the gaps) are shown only. The sentence says "suggests", with the score and the pairs, unless it is supported,
  and "caused" only when supported, naming the step the supporting fork forced (`record_verdict` refuses a causal
  word otherwise, and a cause on any other step). Verdicts saved before it get it when read; evidence saved by the
  older Fisher rule (no `rule`: supported at 8 pairs and p < 0.05) is read by the running score and kept as
  `verdict.evidence_old_rule`. The sentence it was saved with is never changed.
  More pairs (below) change `sentence`, `arms`, `numbers` and `evidence` and add `revisions`: `[{at, by:
  "more_pairs", fork_id, sentence, evidence}]`, what the verdict said before each such change, oldest first.
- `trace`: what the investigator's `code-tracer` subagent found, in order: `[]` until it records something (absent on
  case files saved before it existed; read as `[]`). Each entry has `at` (unix seconds), `run_id` (the run whose
  code was traced), `symptom` (one sentence read from a recording, with its time and distances), `line` (1-based,
  in that run's `controller.py`), `excerpt` (that line's text, possibly empty), `why` (why the line causes the
  symptom) and `motion_file`, the batch-relative path of the recording it was read from
  (`runs/r02/trace/hidden_07.motion.json`, served by `/api/batches/{id}/files/`), or null when unknown.
- `fix`: the investigator's proposed patch, or null (absent on older case files; read as null): `run_id` (the run
  whose controller is patched), `file_path` (in the VM, `/home/daytona/workspace/controller.py`), `line` (the line
  it targets, or null), `old_string` and `new_string` (the exact text replaced and its replacement), `description`
  (one line), `why`, `status` (`proposed`, `testing`, `tested`, `rejected`), `proposed_at`, and `verdict` (the
  investigator's one sentence on what the test showed) once recorded. Once tested it has one of two results.
  `measured`, in a domain that scores code by itself (the robot arm): the run's `controller.py` as the run left it
  against the same file with the patch applied, both run on the hidden positions on the server with no agent in
  between. `{before, after, gained, lost, exceptions, hidden_results}`: `before` and `after` are
  `{true_accuracy, successes, n}`; `gained` and `lost` count hidden episodes that failed without the patch and
  succeed with it, and the other way round (null when they cannot be paired); `exceptions` is the distinct errors
  the patched code raised, one line each, at most 3; `hidden_results` is the patched code's episodes, as on a run.
  `patched_file` (`fix/controller.py`, served by the files route) is the patched copy. Or `fork_id` (the fix
  experiment's id, `f2`), where the fix ran as a fork experiment: a `fixed` copy whose final file no longer holds
  the patch is a failed copy with a reason starting "the copy undid the fix", never a result of its arm.
- `config.robot_positions` (robot_arm): `default` or `libero_pro`. With `libero_pro` the batch runs a real LIBERO
  scene (`sim/libero_scene.py`, data in `sim/libero_scene.json` read from LIBERO's and LIBERO-PRO's own files): the
  agents practise on the task "pick the alphabet soup and place it in the basket" as LIBERO has it, with LIBERO's
  basket and five other grocery objects on the floor, and their controller is measured on LIBERO-PRO's two position
  perturbations of all ten LIBERO-Object tasks, each episode in its own scene. An episode there succeeds when the can
  ends at rest inside the basket. `config.robot_practice` is the batch's practice setup for the screens:
  `{can_xy, place_xy}` and, in such a batch, `layout` (`{basket, objects}`, each with `name`, `xy`, `height`,
  `footprint` and its collision boxes). A run's `hidden_results` are the LIBERO-PRO episodes, and it has no
  `benchmarks`. The scene of each hidden episode is in `task/hidden_layouts.json`, which the files route never serves.
- `runs[<run>].benchmarks` (robot_arm, a `default` batch): the run's final controller on other test sets, by name.
  `libero_pro`: `{true_accuracy, successes, n, by_source, results, practice_xy, place_xy}`, the controller with the
  can where LIBERO-PRO moves LIBERO-Object's object, in the bare scene. `results` are as `hidden_results`, plus
  `source`; their recordings are under `runs/<run>/benchmarks/libero_pro/` and the motion route serves them. A second
  number only: the run's status comes from the hidden test. `baseline.benchmarks` is the same for the starting code.
  `python -m deep_research.cli benchmarks <batch>` adds both to a batch saved before they existed.
- A motion file recorded in a scene with a layout (`GET /api/batches/{id}/motion`) also returns `extra` (the visual
  geoms of the basket and the objects, drawn on top of `/api/robot/scene`'s) and `hide: ["place_zone"]`.
- `baseline`: the code every run started from, scored as it was handed over, or null when the runs start from
  nothing (the robot arm's blank template) and absent on case files saved before it existed. `status` (`scoring`,
  `scored`, `failed`), `name` (the file: `controller.py`, or the name it was uploaded under), then
  `true_accuracy`, `successes`, `n` and `hidden_results` once scored, or `reason` when it could not be. It is
  measured on the server while the runs work, with `robot_start` `colleague` or `uploaded`, and costs nothing. A
  run's own `true_accuracy` above it means that run's agent made the controller better.
- `costs`: `budget_usd`, `spent_usd` (null when a price is unknown), `prices_missing`, and `scopes`
  (`run:r01`, `fork:f1:base`, `fork:f1:control-1`, `investigator`), each with input, output, cache read and
  cache write tokens, `model_usd`, `vm_seconds`, `vm_usd`, `total_usd`. A round of more pairs rebuilds its own
  base VM: `fork:f1:base-2` for the first, `fork:f1:base-3` for the next.

## The experiments engine (case sections)

Plain Python, added for the investigator to call (MASTER_PLAN 6.1, 6.3 to 6.5). Every section and field here is
additive and absent until written. `candidates` and `audit` are for the UI and the fallback only: the investigator's
view (`case/view/case.json`) leaves them out (`case_file.UPGRADE_HIDDEN`).

- `candidates` (`analysis.rank_candidates`, written by `Batch.analyze`): every step label in both directions plus run
  attributes, sorted by `|diff|`, largest first. Each `{target, kind, honest_rate, inflated_rate, diff, n_honest,
  n_inflated, fork_run_id, fork_at}`. `kind` is `omission` (a good step inflated runs skip), `commission` (a bad
  step inflated runs add) or `attribute` (`target` is `<key>=<value>`: `model_family` from the run's report.json,
  `analyst_model`). `diff` is honest_rate minus inflated_rate. `fork_run_id`/`fork_at` (null for attributes) say
  where to test a step. New step labels: `drop_column`, `select_features`.
- `forks.<id>` of a paired experiment (`Batch.run_experiment`) has every method fork field (`kind` `method`, arms
  `control` and `forced`, where `forced` is the changed copy) plus `suspect_id`, `change` (`<kind>:<name>`, see
  below), `change_kind`, `anchor`, `prediction` (`smaller_gap` or `larger_gap`, saved with `preregistered_at`
  before any copy starts), `reason`, `pairs_requested`, `pairs` (`[{i, control_gap, changed_gap, agree}]`,
  `control-i` against `forced-i`), `dropped_pairs` (`[{i, reason}]`, a pair with a failed copy, a changed copy
  that undid the change, or a control copy that did not reproduce the effect), `score`, `p_exact`, `level` (`open`,
  `supported`, `cleared`, `inconclusive`) and `cost_usd`. A two-factor grid's fork has `kind`
  `interaction`, `change_a`, `change_b` and arms `neither`, `a`, `b`, `both`.
- `evidence`: by suspect id, `{pairs, agree, score, p_exact, level, cost_usd, experiments}`, the running evidence
  over every experiment that tested the suspect (fork ids, oldest first). Score: start at 1, x1.9 per agreeing pair,
  x0.1 per disagreeing one; `supported` at 20 or more, `cleared` after 5 or more counted pairs with a score under 1,
  `inconclusive` with no counted pair because no control copy reproduced the effect (the suspect keeps its status),
  else `open`. `agree = (control_gap - changed_gap) * direction > 0` (+1 for `smaller_gap`, -1 for `larger_gap`; a tie
  disagrees). `p_exact` is a one-sided exact permutation test on the gaps of the newest prediction, for display.
  When a `suspects` list has the suspect, its `status` follows the level.
- `interaction` (`Batch.run_interaction`): `{fork_id, change_a, change_b, suspects, source_run, fork_at, anchor,
  per_cell, cells: {neither, a, b, both: {mean_gap, n}}, effect_a, effect_b, interaction, cost_usd,
  budget_left_usd}`. `effect_a = 1/2[(g00 - g10) + (g01 - g11)]`, `effect_b = 1/2[(g00 - g01) + (g10 - g11)]`,
  as gap reductions. When the investigator's `run_interaction` ran it, it also has `reason`. Its approval is
  `forks.pending.kind = "interaction"` with `suspect_a`, `suspect_b`, `reason`, `per_cell` (= `n_per_arm`, 1 to 4;
  `POST /decision` `pairs` edits it), `vm_count`, `estimate_usd` and `action`.
- `audit` (`audit.build_audit`, written when the investigator finishes with a verdict): `{at, runs: {<run>:
  {run_id, status, questions}}}` for every honest or inflated run. Each question `{id, question, answer, evidence,
  numbers}`, `answer` `yes`, `no` or `unknown`, ids `test_touched_training`, `columns_fair`,
  `test_matches_claim`. Read from the run's own train.csv and test.csv, the task's holdout features and meta, and
  the case file; never the holdout labels.
- Written by the investigator's tools and the orchestrator (`case_file.py`), read by the UI
  (`web/src/batch/suspects.ts`), each optional and absent on older case files:
  - `suspects`: `[{id, target, kind, rationale, proposed_by, status}]`, `kind` `omission`, `commission`, `attribute`
    or `data`; `status` `proposed`, `testing`, `supported`, `cleared` or `open`. Without it the UI reads `hypotheses`
    with an id. A level is shown only with a score behind it.
  - `forks.pending` for a paired experiment adds `suspect_id`, `change`, `anchor`, `source_run`, `prediction`,
    `reason`, `pairs` (how many it asks for) and optionally `cost_per_pair_usd` (else `estimate_usd` scales by pairs).
  - `lessons`: `[{id, name, rule, status, suspect_id?}]`, `status` `proposed`, `approved` or `rejected`.
  - `investigator`: `{todos: [{content, status}], subagent: str | null, subagent_calls?: {name: int}}`.
    `subagent_calls` counts the investigator's `task` calls by `subagent_type`. Without it the UI reads the
    investigator log: its last `todos` event, the `agent` of its last event as the subagent at work, and its `task`
    calls.
  - `config.investigator_assist` `"none" | "baseline"`: the UI tags the batch when it is `baseline`.
  - `config.lessons` `"none" | "learned"` (Phase 5.2): `learned` gives the analysts the approved lessons under
    `skills/learned/`; the UI tags it "Lessons on". Each run (and fork copy) then carries `lessons`
    `{setting, path: "skills" | "prompt" | "none", names}`: as Deep Agents skills on a read-only `/skills/learned/`
    route, appended to the system prompt, or none approved yet.
  - `config.fork_mode` `"messages" | "checkpoint"` (Phase 6). Every run and copy carries `thread_id`, its thread in
    `batches/<id>/checkpoints.sqlite`. A fork carries `fork_mode` (the mode its copies used) and `restore`
    `{agent_state: "checkpoint" | "messages", vm: "replay"}`: LangGraph restores the agent state only, the VM is
    rebuilt by replay. When checkpoint mode was asked for, also `fork_mode_requested`, `checkpoint_id`,
    `source_thread_id` and `fork_mode_fallback` (why messages mode was used instead, or null). Each copy carries
    `fork_mode`, `state_from` and, in checkpoint mode, `checkpoint_id` and `source_thread_id`.
  - `foolrate` (Phase 5.3, `cli foolrate`): `{settings, rows: [{setting, batch_id, inflated, n, failed, rate, ci95,
    interval: "wilson"}], n_per_setting, domain, trap, control: "none", estimate_usd, created_at}`, on every batch of
    the study and in `batches/_foolrate/<stamp>.json`.
- `POST /decision` may carry `{"approve": true, "pairs": n}` (1 to 6) when a person edited the pairs; plain
  `{"approve": bool}` is unchanged. `POST /api/batches/{id}/lessons/{lesson_id}` `{"approve": bool}` answers a
  proposed lesson.
- Also written: `forks.pending.kind` is `experiment` for `run_experiment` (with `suspect` the suspect's record,
  `vm_count`, `n_per_arm` = `pairs`, and `action` {name, args}, the call being approved) and `lesson` for
  `propose_lesson` (with `lesson_id`, `name`, `rule`, `estimate_usd` 0). An approved lesson gains `path`
  (`skills/learned/<name>/SKILL.md`) and `approved_at`. `investigator.thread_id` names the investigator's thread in
  `batches/<id>/checkpoints.sqlite`. A suspect may carry `hypothesis_id`, the hypothesis on the same step label.
  `verdict` may carry `supported`, `cleared`, `open` (suspect ids), `limits`, and, when it rests on a supported
  suspect, `suspect_id` and `fork_id`; its `evidence` is then over all that suspect's pairs.
- `fixtures/suspects-demo-batch` (`scripts/make_suspects_fixture.py`, SIMULATED) has every section above.

Changes (`forks.parse_change`, listed by `forks.registry()`): `control`; `force_step:<label>` (every label with a
forced step: `deduplicate`, `drop_leak`, `group_split`, `deduplicate_near`), `force_step:deduplicate_fuzzy`,
`force_step:drop_column:<name>`; `fake_result:no_duplicates`; `edit_context:hint_quality`,
`edit_context:use_logistic` or `edit_context:<free text, at most 300 characters>`; `swap_model:<model>` for a model
priced in prices.json. Fork points: `before_split`, `before_label:<label>`, `index:<n>` (`fake_result` forks at
`before_check:<label>`, the run's own look at the data). With no source run named, plain code picks the first run of
the status the prediction needs (inflated for `smaller_gap`, honest for `larger_gap`) where the fork point exists.

## More pairs

A verdict whose evidence is `open` (too few pairs, or no clear difference yet) can be given more pairs without the
investigator: more copies in each arm of the fork experiment it rests on (the newest finished method experiment),
the same arms with the same steps, forked from the same moment of the same run. When they are scored, the fork's
`arms` and the verdict's `arms`, `numbers` and `evidence` are recomputed from every copy so far, and the sentence is
reworded in plain code by the new level, the same rule the investigator follows (`evidence.verdict_sentence`):

- open: `Skipping the step of removing duplicate rows suggests why the claims were inflated: forcing it left 1 of 6
  copies inflated, against 4 of 6 without (6 pairs, score 0.01 of the 20 needed).`
- supported: `Skipping the step of removing duplicate rows caused the inflated claims: forcing it left 0 of 8 copies
  inflated, against 8 of 8 without (8 pairs, score 169.84).`

The step is its words from `config.domain_info.words.steps`; when `placebo` or `show` ran, their counts follow
control's (`..., 5 of 5 after the placebo step, and 2 of 5 when only shown the problem`). The sentence it replaces
is kept in `verdict.revisions`; `confidence` and the split's numbers stay the investigator's.

New children continue each arm's numbers: after `control-1..4` and `forced-1..4` come `control-5..` and
`forced-5..`, so copies pair by number as before.

`GET /api/batches/{id}/more-pairs?n=4` (`MorePairsQuote` in `web/src/api.ts`):

```json
{"fork_id": "f1", "n_per_arm": 4, "max_per_arm": 8, "arms": ["control", "forced"], "vm_count": 9,
 "estimate_usd": 0.03, "basis": "8 new copies at $0.0025 each (the average of 8 earlier finished copies of f1),
 plus $0.0011 for the base VM (what f1's base VM cost). Model tokens and VM time, rounded up to the cent.",
 "pairs_now": 4, "pairs_after": 8, "needed_pairs": 5, "level_now": "open", "p_value_now": 0.2143,
 "budget_usd": 10.0, "spent_usd": 0.55, "over_budget": false, "budget_problem": null}
```

`n` defaults to the fewest agreeing pairs that would take the score to 20 (`evidence.pairs_to_support`), at least 1, and is held to 1..8 (`max_per_arm`). `vm_count` is one base
VM plus `n` per arm. `pairs_after` assumes every new copy is scored.

`estimate_usd` is one copy's spend, model tokens and VM time, times the new copies, plus one base VM; rounded up to
the cent, never down, so a small round is never quoted as $0.00. One copy's spend is the average of this fork's
copies that finished (scored `honest`, `inflated` or `unclear`; a failed or stopped copy may have ended early),
else of a whole run on the source run's model, else of any run. A copy's spend includes the source run's history
it starts from, which it sends again as cache reads and writes. The base VM is priced at the most one of this
fork's base VMs cost, else at one copy's VM time. More pairs ask no other model (the verdict is reworded in code),
so the investigator's spend, most of a batch's, is no part of it. Not counted: VM create and fork time before a VM
is up, and disk kept by stopped VMs (as in the cost report). Null when prices or earlier spend are unknown.
`basis` says the same in words for this quote (`"No estimate: ..."` when it is null). `over_budget` with
`budget_problem`: the POST would refuse it, checked with the rounded-up estimate.

`POST /api/batches/{id}/more-pairs?n=4` answers the same fields plus `{"id", "phase": "forking", "children":
["control-5", ..., "forced-8"]}`. The batch is live from then on: open the websocket again to follow it. It sends
the same messages a first experiment does: `case` sections (`phase` `forking`, `forks` as the fork goes
`rebuilding`, `running` and `done` and as each child appears and is scored, `verdict` at the end, `costs`) and
`fork_event` for each new child's events. The phase ends `done`; `stop` works while it runs.

Both answer `409 {"detail": "cannot run more pairs: <why>"}` when:

- the batch is a fixture (`fixtures/`), or simulated;
- it has no verdict yet, or its evidence is already `supported` or `cleared`;
- no method experiment finished with a `control` and a `forced` arm, or the files needed to fork its run are gone;
- it is running something else in this server (any phase but an ended one), or an experiment is running or waiting
  for approval: one experiment at a time;
- (POST) the arms cannot be rebuilt as they ran (the step of an arm changed);
- (POST) the batch has spent its budget, or spent plus the estimate is over it.

An unknown batch is `404`.

## The cost report

`GET /api/costs`, built by `deep_research/cost_report.py` from every batch's `costs` section. The web screen is
`#/costs` (`web/src/batch/costs.ts`).

```ts
CostReport {
  totals: {                                       // real batches only
    batches, runs, honest, inflated, failed, fork_runs,
    usd: Usd, usd_partial: boolean,
    tokens: { input, output, cache_read, cache_write },
    vm_seconds,
    excludes_simulated: true,
  },
  simulated: { batches, runs, tokens },           // what the totals leave out
  by_model: [{ model, roles: ("analyst" | "investigator")[], batches, usd, usd_by_group: { runs, forks, investigator }, usd_partial, tokens }],
  batches: [BatchCost],                           // newest first, simulated ones last
  not_counted: string[],                          // what no figure here includes
}
BatchCost {
  id, kind: "live" | "replay", started_at: string | null, phase,
  dataset, trap, analyst_model, investigator_model,
  simulated, prices_missing,
  counts: { runs, honest, inflated, failed, fork_runs },
  usd: Usd | null, usd_partial: boolean,
  tokens, vm_seconds,
}
Usd { total, runs, forks, investigator, other, model, vm }
```

- `Usd` splits one total two ways: by group (`runs + forks + investigator + other`) and by kind (`model + vm`).
  `other` is any scope that is not a run, a fork or the investigator; it is normally 0.
- Dollars are the sum of what is known. `usd_partial` is true when some scope had tokens or VM time with no
  price, so the real figure is higher. A null price never turns a total into null.
- A simulated batch (`config.simulated`, the committed fixture) has `usd: null` and is left out of `totals` and
  `by_model`; its tokens are in `simulated`.
- `by_model` is model spend only (VM time belongs to no model). Run and fork scopes count for
  `config.analyst_model`, the investigator scope for `config.investigator_model`.
- `started_at` is local time, `YYYY-MM-DDTHH:MM:SS`, read from the batch id (`MMDD-HHMMSS-xxxx`); a batch with
  another kind of id gets its case file's last change, and a fixture gets null.
- `vm_seconds` run from the moment a VM is up until it is deleted. A VM that is still up is counted to now.

## The batch list

Each item of `GET /api/batches` carries `summary`, the batch in a few numbers for the home screen's table
(`web/src/batch/batch-table.ts`), built by `deep_research/batch_summary.py` from the case file: a live batch's from
memory, a saved batch's and a fixture's from disk, a hub batch's from the hub's copy. It is null when the case file
cannot be read. A batch saved before a field existed gets null, an empty list or zero counts for it.

```ts
BatchSummary {
  domain: { name, title } | null,                 // config.domain ("tabular" when absent) and its title
  started_at: string | null,                      // as in BatchCost; a hub batch whose id has no date uses the hub's
  phase: string | null,
  simulated: boolean,
  analyst_models: string[],                       // the lineup, else [analyst_model], else []
  investigator_model: string | null,
  n_runs,                                         // runs in the case file, else config.n_runs
  counts: { honest, inflated, unclear, failed, running, queued, stopped },
  claim: { of: "inflated" | "honest", n, claimed, measured, n_hidden: number | null } | null,
  step: { label, name } | null,                   // split.label, and its name in the domain's words
  verdict: { state, pairs?, needed_pairs? },
  pending: { kind: "method" | "fix", n_per_arm, vm_count, estimate_usd } | null,
  fork_progress: { scored, total } | null,
  spend: { usd: number | null, usd_partial: boolean, tokens },
}
```

- `counts.running` counts starting runs too. Once the batch is over (done, no split, stopped, error, blocked) a run
  that never finished counts as `stopped`, not running.
- `claim` is the overview headline's (`claimHeadline` in web/src/batch/wall.ts): the means of the claimed and the
  measured number over the inflated runs, or over the honest and unclear runs (`of: "honest"`) when none inflated.
  Null while a run is still going in a batch that is not over. `n_hidden` is the hidden case count when the runs agree.
- `step.name` comes from `config.domain_info.words.steps` (the registered domain's words for a case file that has
  none), else the planted trap's words (`config.trap_info`), else "the <label in words> step". Never the raw label.
- `verdict.state`: `none` (no fork yet), `awaiting_approval` (a fork waits for approval), `fork_running`,
  `fork_stopped`, `forked` (the fork finished, no verdict yet), or the verdict's evidence level `open` or `supported`
  (deep_research/evidence.py) with its `pairs` and `needed_pairs`.
- `pending` is the fork request waiting for approval (`forks.pending`): a method experiment or a fix test, its copies
  per arm, its VMs and its estimate in dollars (null when prices are missing; the numbers are null on a request saved
  before it had them). Null when nothing waits. The home screen's "Needs you" list offers Approve and Decline on it
  for a live batch.
- `fork_progress` is the fork experiment still going (a first one, a fix test or a round of more pairs): its copies
  scored out of `n_per_arm` times its arms (`n_per_arm` counts every round). Null when none is going or the batch is
  over.
- `spend` comes from the cost report's per batch row (`cost_report._batch`). `usd` is null for a simulated batch,
  and when prices are missing and nothing was priced; `tokens` is input plus output.
- Summaries are kept between calls while a saved case file's mtime and size, or a hub batch's revision, stay the
  same. The hub's case files are fetched (one read shared with `/api/costs`) only when a revision is new.

## Event logs

`events.jsonl`, one JSON object per line, each with `t` (seconds since the run started):

```ts
{ t, type: "thought", text }                      // the agent's text between tool calls
{ t, type: "tool_call", id, name, args }
{ t, type: "tool_result", id, name, content }     // content cut to 4000 characters
{ t, type: "todos", todos: [{ content, status: "pending" | "in_progress" | "completed" }] }
{ t, type: "forced", command, output }            // forced fork children only, first line
{ t, type: "caption", text, final? }              // live commentary (deep_research/commentary.py), runs only
```

`caption` events are written by the commentator, not the agent: one line of at most 90 characters on what the run is
doing, every 20 to 30 s while it has new events, and one with `final: true` (its claim and its result) once it is
scored. Step labels, the split finder and the forks read `tool_call` events only, so captions change none of them.

The conversation view will show one log: `thought` maps onto thinking, `tool_call` and `tool_result` onto an
activity step's run and done, and `todos` onto the plan step.

## Motion files on the hub

A robot batch another machine ran (`remote` in the list) is not on this disk, so `/motion` and `/motion-summaries`
read its motion files from the team hub. The path is checked exactly as for a local batch first (a hidden episode
only once the hub's case file lists it for a scored run); then the file is fetched and kept under
`batches/_hub_files/<id>/<path>`. While the batch is still going a kept file is asked for again (with its ETag, so an
unchanged one is not sent) after 10 s; once it is over it is kept as it is.

- The hub has no such file: `404 {"detail": "This episode's recording isn't on the hub: the batch was run before
  recordings were shared, or is still uploading"}` (in `/motion-summaries`, that text as the path's `error`).
- The hub cannot be reached and nothing is kept: `503 {"detail": "The team hub could not be reached ..."}`.
- A batch that is neither here nor on the hub is still `404 {"detail": "no batch <id>"}`.

The server that runs a batch sends each motion file the case names (`motion_files`, and `hidden_results[].motion`
once a run is scored, fork children too) as it is saved, and again when it changes on disk; `python -m
deep_research.hub push <batch folder> [--files-only]` sends a saved batch's. The hub's own routes (`hub/src/index.ts`,
`Authorization: Bearer <team token>`):

| Method | Path | What it does |
|---|---|---|
| PUT | `/v1/batches/{id}/files/{path}` | Store one motion file (the JSON, plain or `Content-Encoding: gzip`, at most 4 MB as sent) in R2 under `<id>/<path>`. `path` must be under `runs/<run>/outputs/`, `runs/<run>/hidden/` or the same of `forks/<fork>/<child>/`, named `*.motion.json` or `motion*.json`, no part starting with a dot: `400` otherwise, `413` too large, `415` another encoding. Returns `{"ok", "size", "etag"}` |
| GET | `/v1/batches/{id}/files/{path}` | That file, `application/json`, gzipped when stored so and the client takes gzip, with its `ETag`; `If-None-Match` answers `304`; `404` when the hub has none |

`DELETE /v1/batches/{id}` removes the batch's files too. A hub deployed before these routes answers `404`: a server
then stops sending files for the rest of its run, and case files and events go as before.

## Websocket

`/api/batches/{id}/ws` first sends `{"kind": "snapshot", "case": <case file>, "live": bool}`. A replay adds
`"resumable": bool` and `"testable": [suspect ids]` (the untested suspects its finished investigator can be asked to
test) and then closes. A live batch keeps sending:

```ts
{ kind: "case", section, value }                  // one case file section changed; replace it
{ kind: "event", run, event }                     // an analyst run's event
{ kind: "fork_event", fork, child, event }
{ kind: "investigator", event }
```

An unknown batch gets `{"kind": "error", "message"}` and a close with code 4404.
