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
| GET | `/api/batches` | `[{"id", "kind": "live" or "replay"}]`: batches started on this server, saved batches in `batches/`, and replays in `fixtures/` |
| POST | `/api/batches` | Body: a `BatchConfig`. Starts a batch, returns `{"id"}` |
| GET | `/api/batches/{id}/case` | The case file (below) |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's `events.jsonl` as a JSON array |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's events, `child` like `control-1` or `forced-2` |
| GET | `/api/batches/{id}/investigator/events` | The investigator's events, each with an `agent` field |
| GET | `/api/batches/{id}/files/{path}` | A file saved with the batch, such as a run's `charts` entry. Served with a CSP that blocks scripts. The holdout labels are never served |
| POST | `/api/batches/{id}/investigate` | Live only. Starts the investigator (phase `ready`) |
| POST | `/api/batches/{id}/decision` | Live only. `{"approve": bool}` answers `forks.pending` (phase `awaiting_approval`) |
| POST | `/api/batches/{id}/stop` | Live only. Cancels the work and stops every VM |
| WS | `/api/batches/{id}/ws` | See below |

Errors: unknown batch is `404 {"detail": ...}`; a live-only call on a replay is `409`; any other unknown `/api/*`
path is `404 {"error": "not found"}`. Every other path serves `web/dist`, falling back to `index.html`.

## The case file

One JSON file per batch (`case/case.json`), written only by `deep_research/case_file.py`. Sections:

- `config`: the `BatchConfig` (`deep_research/config.py`). Fixtures add `"simulated": true`.
- `phase`: `config`, `running`, `analyzing`, then `ready` or `no_split`, `investigating`, `awaiting_approval`,
  `forking`, `forked`, `done`. Also `stopped`, `blocked: <why>` (over budget) and `error: <why>`.
- `runs`: by id (`r01`...). `status` goes `queued`, `starting`, `running`, then `honest`, `inflated` or `failed`.
  While running: `vm_id`, `lab_url`, `todos`, `step`, `last_tool`. Once scored: `reported_accuracy`,
  `true_accuracy`, `overlap_share`, `gap`, `reason`, `n_actions`, `labels` (step labels per action).
- `step_labels`: the investigator's labels per run.
- `split`: where honest and inflated runs part ways (`label`, `honest_rate`, `inflated_rate`, `fork_run_id`,
  `fork_at`, examples, `intervention`), or null.
- `hypotheses`: the investigator's, in order.
- `forks`: by id (`f1`...): `status` (`rebuilding`, `running`, `done`), `source_run`, `fork_at`, `label`,
  `intervention`, `n_per_arm`, `children` (each with `arm`, `status`, scores, `how`), and `arms` summaries when
  done. While the investigator waits for approval there is also `forks.pending` with `n_per_arm`, `vm_count` and
  `estimate_usd`.
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

`/api/batches/{id}/ws` first sends `{"kind": "snapshot", "case": <case file>, "live": bool}`. A replay then
closes. A live batch keeps sending:

```ts
{ kind: "case", section, value }                  // one case file section changed; replace it
{ kind: "event", run, event }                     // an analyst run's event
{ kind: "fork_event", fork, child, event }
{ kind: "investigator", event }
```

An unknown batch gets `{"kind": "error", "message"}` and a close with code 4404.
