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
| GET | `/api/batches` | `[{"id", "kind": "live" or "replay", "resumable"?: true}]`: batches started on this server, saved batches in `batches/`, and replays in `fixtures/`. `resumable` marks a saved batch that `resume` would accept |
| POST | `/api/batches` | Body: a `BatchConfig`. Starts a batch, returns `{"id"}`. `422 {"detail"}` when the dataset, target, script or trap cannot be used |
| GET | `/api/costs` | The cost report (below): spend across every batch, live ones from memory and saved ones from disk |
| GET | `/api/batches/{id}/case` | The case file (below) |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's `events.jsonl` as a JSON array |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's events, `child` like `control-1` or `forced-2` |
| GET | `/api/batches/{id}/investigator/events` | The investigator's events, each with an `agent` field |
| GET | `/api/batches/{id}/files/{path}` | A file saved with the batch, such as a run's `charts` entry. Served with a CSP that blocks scripts. The holdout labels and hidden can positions are never served, and a run's `hidden/` recordings only once the case lists them for the scored run |
| GET | `/api/robot/scene` | The robot scene for the 3D viewer (`deep_research/robot_view.py`): `{"bodies", "meshes", "geoms"}`, every visual geom with its body, type, size, local pose and color, meshes decimated to flat `v`/`f` arrays. About 1.4 MB, 0.45 MB gzipped (sent gzipped when accepted). `503` without mujoco or the panda meshes |
| GET | `/api/batches/{id}/motion?path=<motion file>` | One motion file as body poses: `{"t", "bodies", "frames": [[x, y, z, qw, qx, qy, qz per body], ...], "static", "result", "can_start", "place_target"}`, from `mj_kinematics` on each frame's qpos. `path` must be under `runs/<run>/outputs/` or `forks/<fork>/<child>/outputs/`, or be a scored run's hidden episode listed in its `hidden_results` (`400` otherwise, never `task/`; `404` for a hidden episode of a run not scored yet); `422` when the file is not a motion file |
| GET | `/api/batches/{id}/motion-summaries?path=...&path=...` | For the viewer's file picker: per path, `{"can_start", "place_target", "duration", "n", "result"}` or `{"error"}` |
| POST | `/api/batches/{id}/investigate` | Live only. Starts the investigator (phase `ready`) |
| POST | `/api/batches/{id}/decision` | Live only. `{"approve": bool}` answers `forks.pending` (phase `awaiting_approval`) |
| POST | `/api/batches/{id}/stop` | Live only. Cancels the work and stops every VM |
| POST | `/api/batches/{id}/resume?investigate=<bool>` | Bring a saved batch of ours back live, in phase `ready`, so the investigator and the fork experiment can run on it after a server restart. With `investigate=true` the investigator starts in the same call. Only a batch whose runs are all scored, with a split and no verdict yet; `409 {"detail"}` says why otherwise. The list and the websocket snapshot flag such a batch with `resumable: true` |
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
  `vm_count` and `estimate_usd`.

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
- `verdict`: `{sentence, step_label, numbers, evidence}` or null. `evidence` (`deep_research/evidence.py`,
  `VerdictEvidence` in `web/src/api.ts`): `{level, pairs, needed_pairs, control_inflated, control_total,
  forced_inflated, forced_total, p_value}`. `pairs` is min(control, forced scored copies); `level` is `supported`
  when pairs >= 8 and a one-sided Fisher exact test of fewer inflated forced copies than control copies gives
  p < 0.05, else `open`. The sentence says "suggests", with the score and the pairs, while it is open, and "caused"
  only when supported (`record_verdict` refuses a causal word while open). Verdicts saved before it get it when read.
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
  cache write tokens, `model_usd`, `vm_seconds`, `vm_usd`, `total_usd`.

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

## Websocket

`/api/batches/{id}/ws` first sends `{"kind": "snapshot", "case": <case file>, "live": bool}`. A replay adds
`"resumable": bool` and then closes. A live batch keeps sending:

```ts
{ kind: "case", section, value }                  // one case file section changed; replace it
{ kind: "event", run, event }                     // an analyst run's event
{ kind: "fork_event", fork, child, event }
{ kind: "investigator", event }
```

An unknown batch gets `{"kind": "error", "message"}` and a close with code 4404.
