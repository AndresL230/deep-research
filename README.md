# deep-research

AI agents are starting to run data analyses for research, and they make method errors that still produce a clean, confident number. This project runs one data science agent many times in parallel Daytona VMs, checks each run's reported score against the truth, finds the step where honest and inflated runs split, then rewinds to that step, forks the VM, and replays both choices to prove which step caused the wrong result.

HackPrinceton Fall 2026. Tracks: Science + Discovery, LangChain deepagents, Amazon.

## How it fits together

| Part | What it is | File |
| --- | --- | --- |
| Task | A dataset with duplicate rows planted, plus a clean holdout whose labels never leave our server. Pima diabetes by default, or an uploaded CSV with a chosen target column | `deep_research/task.py`, `datasets.py` |
| Analyst agents | One flat deepagent per run, `DaytonaSandbox` backend, `write_todos` planning, no subagents | `agents/analyst.py` |
| Orchestrator | Plain Python: VMs, runs, scoring, split finding, fork experiment, costs | `batch.py` |
| Scorer | Reported accuracy vs true holdout accuracy, plus the share of test rows also in training | `scoring.py` |
| Split finder | Labels each action, finds the label honest runs do before the split and inflated runs skip | `analysis.py` |
| Fork experiment | Rebuild the run just before its split, fork the VM, continue N copies unchanged (control) and N with the step forced | `batch.py`, `forks.py` |
| Investigator | Deepagent with `step-tagger` and `hypothesis` subagents, the `method-errors` skill, and an approval gate on `request_forks` | `agents/investigator.py` |
| Case file | One JSON file per batch with everything the investigator knows. It is also the UI's data source | `case_file.py` |
| Costs | Tokens from every model response, VM time, budget guard | `costs.py`, `prices.json` |
| Lab page | Tiny web page inside each VM showing the agent's latest chart. The server proxies it (no Daytona preview warning); the UI reads a live run's charts through it | `lab_page/server.py` |
| API | FastAPI plus a websocket per batch; also serves the web UI | `api.py` |
| Web UI | Vite + TypeScript, Trov Ask styling. A start panel, a wall of runs where each tile is a notebook typing out the agent's code, a side by side view of what the honest and inflated runs did differently, the fork experiment, the verdict, and a replay player for saved batches | `web/src/main.ts`, `web/src/batch/` |

### Who can write what

The analyst agents are fully isolated: no shared files, no labels, no case file.

The investigator reads `/case/`, `/runs/` and `/skills/` through the normal file tools, but a `FilesystemPermission` rule denies `write_file` and `edit_file` there. The case file changes only through narrow tools (`record_step_labels`, `record_hypothesis`, `record_verdict`), each writing one section and checking its input. `tests/test_agents_offline.py` checks that the denial works.

## Layout

```
deep_research/   the Python package: orchestrator, agents, scoring, API
data/pima.csv    the dataset
skills/          the investigator's method-errors skill
lab_page/        the page each VM serves with the agent's latest chart
prices.json      model and VM prices for the cost bar and budget guard
fixtures/        saved replays (the simulated demo batch)
batches/         batches from real runs (git-ignored)
datasets/        uploaded CSV files (git-ignored)
user_scripts/    uploaded training scripts (git-ignored)
scripts/         make_fixture.py
tests/           Python tests
web/             the UI (Vite + TypeScript)
docs/            api-contract.md
```

## Setup

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
uv sync
(cd web && npm install && npm run build)
cp .env.example .env                       # add ANTHROPIC_API_KEY and DAYTONA_API_KEY
uv run python -m deep_research.snapshot    # once: bakes pandas, scikit-learn, matplotlib into a snapshot
```

On macOS, if Daytona calls fail with `CERTIFICATE_VERIFY_FAILED`, Python has no default CA bundle. Add this to `.env`:
`SSL_CERT_FILE=<output of: uv run python -c "import certifi; print(certifi.where())">`.

`prices.json` was filled from Anthropic's and Daytona's pricing pages on 2026-11-14. A null price turns the dollar
budget guard off and the UI shows token counts only.

## Run

```bash
uv run uvicorn deep_research.api:app --reload --port 8000
```

That serves the API and the built UI at http://localhost:8000. Open a batch to watch it; a saved batch replays on a
timeline (play, pause, 1x/4x/16x, scrub, skip to end). Add `?end` to the URL to open a replay at its end. For UI work, also run `cd web && npm run dev`
(Vite on 5173, proxying `/api` and the websocket to 8000).

Without the UI:

```bash
uv run python -m deep_research.cli runs --n 1        # milestone 1: one real run end to end
uv run python -m deep_research.cli runs --n 12       # milestone 2: a batch and the split finding
uv run python -m deep_research.cli forks <batch_id> --n 4
uv run python -m deep_research.cli vms               # how many VMs are running on the Daytona key
uv run python -m deep_research.cli cleanup           # stop every running deep-research VM, from any machine
```

Credits are shared: the Daytona key is used from more than one machine. Run `vms` after a batch, and `cleanup` when
nothing should be running. `cleanup` also stops a teammate's live batch, so check first.

## Test

```bash
uv run pytest                                      # Python: no keys, no VMs
(cd web && npm run typecheck && npm test)          # web
```

## API

Full contract, including the case file and the websocket messages: `docs/api-contract.md`.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/health` | Whether each key is set (never the values) |
| GET | `/api/defaults` | Default config, and whether prices are missing |
| POST | `/api/estimate` | Cost estimate for a config, from earlier runs |
| GET | `/api/datasets` | The built-in dataset and uploaded CSV files, with their columns |
| POST | `/api/datasets` | Upload a CSV file (the request body) |
| POST | `/api/scripts` | Upload a Python training script (the request body) |
| GET | `/api/batches` | Live batches and saved replays (`fixtures/`) |
| POST | `/api/batches` | Start a batch with a config |
| GET | `/api/costs` | Spend across every batch: totals, by model, and one row per batch |
| GET | `/api/batches/{id}/case` | The case file |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's event log |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's event log |
| GET | `/api/batches/{id}/investigator/events` | The investigator's event log |
| GET | `/api/batches/{id}/files/{path}` | Saved charts and outputs (never the holdout labels) |
| POST | `/api/batches/{id}/investigate` | Start the investigator |
| POST | `/api/batches/{id}/decision` | `{"approve": true}` answers the fork approval |
| POST | `/api/batches/{id}/stop` | Stop a live batch and its VMs |
| WS | `/api/batches/{id}/ws` | A snapshot, then `case`, `event`, `fork_event` and `investigator` messages |

The case file's `phase` moves through `config`, `running`, `analyzing`, `ready` (or `no_split`), `investigating`, `awaiting_approval`, `forking`, `forked`, `done`.

### VM cleanup

A VM is used once. As soon as a run or a fork child is scored (or fails), its charts are downloaded and its VM is
deleted, so it stops costing compute and disk. A run's `lab_url` works only while the run is going; afterwards it is
null and the saved charts are listed in `charts`.

`Batch.close()` deletes any VM a batch still has (a fork base, a run that is still going). A batch closes itself as
soon as it is over: when the investigator finishes and the verdict is in, or when no step separates the runs. The
server also closes every open batch when it shuts down.

As a safety net for a VM that leaks anyway (a crash, a killed server), every VM is created with a 30 minute idle
auto-stop and is deleted the moment it stops.

## Demo data for the frontend

`fixtures/demo-batch/` is a **simulated** batch, made by `uv run python scripts/make_fixture.py`. No model calls: each run is scripted to either remove duplicates or not, then really trains a random forest on the real trapped data, so the scores, overlap and charts are real but the agent's choices and timing are not. Its case file says `"simulated": true`. Do not present it as real agent runs.

It has the same files real batches produce:

```
case/case.json              the case file
runs/<id>/events.jsonl      todos, tool_call, tool_result, thought events with a time offset `t`
runs/<id>/actions.json      the agent's tool calls with step labels
runs/<id>/score.json        status, reported_accuracy, true_accuracy, overlap_share, gap
runs/<id>/live/*.png        the charts the lab page would show
forks/f1/<arm>-<n>/...      the same, for each fork child
```

## What is verified and what is not

Verified here, without keys:
- Task building, scoring, overlap, split finding, cost tracking, case file (`tests/test_core.py`)
- Both agents build with the installed `deepagents` 0.7.38; the analyst has no `task` tool; the investigator cannot write to `/case/` but can read it (`tests/test_agents_offline.py`)
- The API serves the demo batch, the websocket snapshot, health, JSON 404s and the web app, and never serves the holdout labels (`tests/test_api.py`)
- The web client's types match the demo batch (`web/test/api.test.ts`)

Not yet run, because it needs Anthropic and Daytona keys:
- Real analyst runs in Daytona, the lab page through a signed preview URL, the fork experiment, and the investigator end to end. Signatures were checked against the installed SDKs, but behaviour was not. Run milestone 1 first.

## Notes from calibrating the trap

Measured on Pima with scikit-learn, averaged over 5 seeds:
- Honest accuracy is about 74 to 76%.
- With half the rows duplicated, a random forest that skips deduplication reports about 89%. Logistic regression barely moves (about 79%). That is why the task asks for a random forest by default (`model_hint`).
- Honest runs can miss the true score by up to about 7 points from test-set noise, so a run counts as inflated only above an 8 point gap (`inflation_threshold`).
- Inflated runs' confusion matrices look cleaner and come from a larger test set, which is a visible tell on the lab page before the reveal.

## Your own dataset

The New batch panel on the home screen has a Dataset row: pick Pima, or upload a CSV (or drop it on the row) and
choose the column to predict. The target must be a class label: 2 to 20 different values, at least 5 rows each, in
a file of at least 100 rows. `samples/churn.csv` is a synthetic table to try it with.

The trap was calibrated on Pima with a random forest. On another dataset the gap between honest and inflated runs
may be smaller than `inflation_threshold`, and the batch then ends in `no_split`.

## Your own training script

The same panel takes a Python training script (`.py`, one file; `samples/train_churn.py` goes with the sample table). Each agent then gets it as `train.py` and starts
from it instead of writing its own, so the batch shows how the score your script reports compares with its score
on the hidden holdout, and whether agents working from it catch the planted duplicates.

The VMs have pandas, scikit-learn and matplotlib only. A script that imports anything else (PyTorch, for example)
is accepted with a warning; the agents may fail on it or rewrite that part. Saved weights (`.pth`) are not
accepted: a finished model has no steps to compare or fork.

## Next

1. Milestone 1 and 2 with real keys. Confirm a mix of honest and inflated runs; adjust `trap_strength`, `trap_noise` or `hint_level` if not.
2. Frontend: built against `fixtures/demo-batch`. Still to check on a real batch: lab pages in the tile iframes, live websocket updates, and the fork approval round trip.
3. One live fork wired to the approval button.
