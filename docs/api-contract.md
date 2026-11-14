# API contract (server and web)

Shared by `deep_research/api.py` (FastAPI) and `web/` (Vite + TS). The client and its types are in
`web/src/api.ts`; `web/test/api.test.ts` checks them against `fixtures/demo-batch/`.

Run: `uv run uvicorn deep_research.api:app --reload --port 8000`, then `cd web && npm run dev` (Vite on 5173
proxies `/api` and the websocket to 8000). Or build the web app once and let the server serve it at `/`.

## Endpoints

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/health` | `{"ok": true, "keys": {"anthropic": bool, "daytona": bool}}`: whether each key is set, never the value |
| GET | `/api/defaults` | `{"config": BatchConfig, "prices_missing": bool}` |
| POST | `/api/estimate` | Body: a `BatchConfig`. Cost estimate from earlier batches' average run cost (all nulls until one has finished) |
| GET | `/api/datasets` | `[DatasetInfo]`: the built-in `pima` first, then uploaded files |
| POST | `/api/datasets?name=<file name>` | The body is the CSV file itself (up to 20 MB). Saves it under `datasets/` and returns its `DatasetInfo`. `422 {"detail"}` says why a file cannot be used; `413` when it is too large |
| POST | `/api/scripts?name=<file name>` | The body is a Python training script (up to 200 KB). The server parses it and never runs it. Saves it under `user_scripts/` and returns its `ScriptInfo`; `422 {"detail"}` when it is not valid Python |
| GET | `/api/batches` | `[{"id", "kind": "live" or "replay", "resumable"?: true}]`: batches started on this server, saved batches in `batches/`, and replays in `fixtures/`. `resumable` marks a saved batch that `resume` would accept |
| POST | `/api/batches` | Body: a `BatchConfig`. Starts a batch, returns `{"id"}`. `422 {"detail"}` when the dataset, target or script cannot be used |
| GET | `/api/batches/{id}/case` | The case file (below) |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's `events.jsonl` as a JSON array |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's events, `child` like `control-1` or `forced-2` |
| GET | `/api/batches/{id}/investigator/events` | The investigator's events, each with an `agent` field |
| GET | `/api/batches/{id}/files/{path}` | A file saved with the batch, such as a run's `charts` entry. Served with a CSP that blocks scripts. The holdout labels are never served |
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
duplicates trap, the hidden holdout and the scoring are the same for every dataset.

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

## The case file

One JSON file per batch (`case/case.json`), written only by `deep_research/case_file.py`. Sections:

- `config`: the `BatchConfig` (`deep_research/config.py`). Fixtures add `"simulated": true`.
- `phase`: `config`, `running`, `analyzing`, then `ready` or `no_split`, `investigating`, `awaiting_approval`,
  `forking`, `forked`, `done`. Also `stopped`, `blocked: <why>` (over budget) and `error: <why>`.
- `runs`: by id (`r01`...). `status` goes `queued`, `starting`, `running`, then `honest`, `inflated` or `failed`.
  While running: `vm_id`, `lab_url`, `todos`, `step`, `last_tool`. The VM is deleted as soon as the run ends: `lab_url`
  becomes null and `charts` lists the saved PNG files (paths for `/api/batches/{id}/files/`). Once scored: `reported_accuracy`,
  `true_accuracy`, `overlap_share`, `gap`, `reason`, `n_actions`, `labels` (step labels per action).
- `step_labels`: the investigator's labels per run.
- `split`: where honest and inflated runs part ways (`label`, `honest_rate`, `inflated_rate`, `fork_run_id`,
  `fork_at`, examples, `intervention`), or null.
- `hypotheses`: the investigator's, in order.
- `forks`: by id (`f1`...): `status` (`rebuilding`, `running`, `done`), `source_run`, `fork_at`, `label`,
  `intervention`, `n_per_arm`, `arm_steps`, `children` (each with `arm`, `status`, scores, `how`), and `arms`
  summaries when done. While the investigator waits for approval there is also `forks.pending` with `n_per_arm`,
  `vm_count` and `estimate_usd`.

  `arm_steps` maps each arm, in the order it runs, to the step forced on it before it continues (null for
  `control`). `control` and `forced` are always there. `placebo` (`config.placebo_arm`) runs a harmless command so
  `forced` is not the only arm whose history carries an extra tool call, and `show` (`config.show_arm`) tells the
  agent what `forced` fixes and leaves it to decide. A batch saved before these existed has no `arm_steps` and ran
  `control` and `forced` only. `vm_count` is one base VM plus `n_per_arm` per arm.
- `verdict`: `{sentence, step_label, numbers}` or null.
- `costs`: `budget_usd`, `spent_usd` (null when a price is unknown), `prices_missing`, and `scopes`
  (`run:r01`, `fork:f1:base`, `fork:f1:control-1`, `investigator`), each with input, output, cache read and
  cache write tokens, `model_usd`, `vm_seconds`, `vm_usd`, `total_usd`.

## Event logs

`events.jsonl`, one JSON object per line, each with `t` (seconds since the run started):

```ts
{ t, type: "thought", text }                      // the agent's text between tool calls
{ t, type: "tool_call", id, name, args }
{ t, type: "tool_result", id, name, content }     // content cut to 4000 characters
{ t, type: "todos", todos: [{ content, status: "pending" | "in_progress" | "completed" }] }
{ t, type: "forced", command, output }            // forced fork children only, first line
```

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
