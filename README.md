# deep-research

AI agents are starting to run data analyses for research, and they make method errors that still produce a clean, confident number. This project runs one data science agent many times in parallel Daytona VMs, checks each run's reported score against the truth, finds the step where honest and inflated runs split, then rewinds to that step, forks the VM, and replays both choices to prove which step caused the wrong result.

HackPrinceton Fall 2026. Tracks: Science + Discovery, LangChain deepagents, Amazon.

## How it fits together

| Part | What it is | File |
| --- | --- | --- |
| Task | Pima diabetes data with duplicate rows planted, plus a clean holdout whose labels never leave our server | `backend/deep_research/task.py` |
| Analyst agents | One flat deepagent per run, `DaytonaSandbox` backend, `write_todos` planning, no subagents | `agents/analyst.py` |
| Orchestrator | Plain Python: VMs, runs, scoring, split finding, fork experiment, costs | `batch.py` |
| Scorer | Reported accuracy vs true holdout accuracy, plus the share of test rows also in training | `scoring.py` |
| Split finder | Labels each action, finds the label honest runs do before the split and inflated runs skip | `analysis.py` |
| Fork experiment | Rebuild the run just before its split, fork the VM, continue N copies unchanged (control) and N with the step forced | `batch.py`, `forks.py` |
| Investigator | Deepagent with `step-tagger` and `hypothesis` subagents, the `method-errors` skill, and an approval gate on `request_forks` | `agents/investigator.py` |
| Case file | One JSON file per batch with everything the investigator knows. It is also the UI's data source | `case_file.py` |
| Costs | Tokens from every model response, VM time, budget guard | `costs.py`, `prices.json` |
| Lab page | Tiny web page inside each VM showing the agent's latest chart, embedded via a signed preview URL | `backend/lab_page/server.py` |
| API | FastAPI plus a websocket per batch | `api.py` |

### Who can write what

The analyst agents are fully isolated: no shared files, no labels, no case file.

The investigator reads `/case/`, `/runs/` and `/skills/` through the normal file tools, but a `FilesystemPermission` rule denies `write_file` and `edit_file` there. The case file changes only through narrow tools (`record_step_labels`, `record_hypothesis`, `record_verdict`), each writing one section and checking its input. `tests/test_agents_offline.py` checks that the denial works.

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env   # add ANTHROPIC_API_KEY and DAYTONA_API_KEY
python -m deep_research.snapshot   # once: bakes pandas, scikit-learn, matplotlib into a snapshot
```

Fill `backend/prices.json` from Anthropic's and Daytona's current pricing pages. Until then the UI shows token counts and the budget cap cannot be enforced.

## Run

```bash
cd backend
python -m pytest                              # deterministic parts and agent wiring, no keys needed
python -m deep_research.cli runs --n 1        # milestone 1: one real run end to end
python -m deep_research.cli runs --n 12       # milestone 2: a batch and the split finding
python -m deep_research.cli forks <batch_id> --n 4
uvicorn deep_research.api:app --reload        # API for the frontend on :8000
```

## API

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/defaults` | Default config, and whether prices are missing |
| POST | `/api/estimate` | Cost estimate for a config, from earlier runs |
| GET | `/api/batches` | Live batches and saved replays (`fixtures/`) |
| POST | `/api/batches` | Start a batch with a config |
| GET | `/api/batches/{id}/case` | The case file |
| GET | `/api/batches/{id}/runs/{run}/events` | One run's event log |
| GET | `/api/batches/{id}/forks/{fork}/{child}/events` | One fork child's event log |
| GET | `/api/batches/{id}/files/{path}` | Saved charts and outputs (never the holdout labels) |
| POST | `/api/batches/{id}/investigate` | Start the investigator |
| POST | `/api/batches/{id}/decision` | `{"approve": true}` answers the fork approval |
| WS | `/api/batches/{id}/ws` | A snapshot, then `case`, `event`, `fork_event` and `investigator` messages |

The case file's `phase` moves through `config`, `running`, `analyzing`, `ready` (or `no_split`), `investigating`, `awaiting_approval`, `forking`, `forked`, `done`.

## Demo data for the frontend

`fixtures/demo-batch/` is a **simulated** batch, made by `python3 scripts/make_fixture.py`. No model calls: each run is scripted to either remove duplicates or not, then really trains a random forest on the real trapped data, so the scores, overlap and charts are real but the agent's choices and timing are not. Its case file says `"simulated": true`. Do not present it as real agent runs.

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
- The API serves the demo batch

Not yet run, because it needs Anthropic and Daytona keys:
- Real analyst runs in Daytona, the lab page through a signed preview URL, the fork experiment, and the investigator end to end. Signatures were checked against the installed SDKs, but behaviour was not. Run milestone 1 first.

## Notes from calibrating the trap

Measured on Pima with scikit-learn, averaged over 5 seeds:
- Honest accuracy is about 74 to 76%.
- With half the rows duplicated, a random forest that skips deduplication reports about 89%. Logistic regression barely moves (about 79%). That is why the task asks for a random forest by default (`model_hint`).
- Honest runs can miss the true score by up to about 7 points from test-set noise, so a run counts as inflated only above an 8 point gap (`inflation_threshold`).
- Inflated runs' confusion matrices look cleaner and come from a larger test set, which is a visible tell on the lab page before the reveal.

## Next

1. Milestone 1 and 2 with real keys. Confirm a mix of honest and inflated runs; adjust `trap_strength`, `trap_noise` or `hint_level` if not.
2. Frontend: config screen, cost bar, wall of lab pages, lane chart, fork approval, verdict. Build against `fixtures/demo-batch` first.
3. One live fork wired to the approval button.
