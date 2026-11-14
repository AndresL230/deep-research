# deep-research

AI agents are starting to run data analyses for research, and they make method errors that still produce a clean, confident number. This project runs one data science agent many times in parallel Daytona VMs, checks each run's reported score against the truth, finds the step where honest and inflated runs split, then rewinds to that step, forks the VM, and replays both choices to prove which step caused the wrong result.

HackPrinceton Fall 2026. Tracks: Science + Discovery, LangChain deepagents, Amazon.

## How it fits together

| Part | What it is | File |
| --- | --- | --- |
| Task | A dataset with a trap planted (duplicate rows by default), plus a clean holdout whose labels never leave our server. Pima diabetes by default, or an uploaded CSV with a chosen target column | `deep_research/task.py`, `datasets.py` |
| Domains | The kind of task a batch runs, one module each: the task and its prompt, the scoring, the step labels and the split anchor, the forced steps, the investigator's skill and wording, the lab image, and what the UI draws (`charts` or `motion`). `tabular` (the default) wraps the modules below; `robot_arm` wraps `sim/domain.py`, a pick and place controller for a Franka Panda in MuJoCo. Pick one with `BatchConfig.domain` | `deep_research/domains/` |
| Traps | The flaw planted in the data, one module each: how to plant it, the step an honest run does and the regex that spots it, the forced fix, the evidence number, and the words the UI shows. See [Traps](#traps) | `deep_research/traps/` |
| Analyst agents | One flat deepagent per run, `DaytonaSandbox` backend, `write_todos` planning, no subagents | `agents/analyst.py` |
| Orchestrator | Plain Python: VMs, runs, scoring, split finding, fork experiment, costs | `batch.py` |
| Scorer | Reported accuracy vs true holdout accuracy, plus the trap's evidence number (for duplicates: the share of test rows also in training) | `scoring.py` |
| Split finder | Labels each action, finds the label honest runs do before the split and inflated runs skip | `analysis.py` |
| Fork experiment | Rebuild the run just before its split, fork the VM, then run N copies in each arm: `control` unchanged, `forced` with the step done for it, and by default `placebo` (a harmless command, so `forced` is not the only arm with an extra tool call in its history) and `show` (told what `forced` fixes, left to decide) | `batch.py`, `forks.py` |
| Investigator | Deepagent with `step-tagger` and `hypothesis` subagents, the `method-errors` skill, and an approval gate on `request_forks` | `agents/investigator.py` |
| Diagnosis and fix | The investigator's `code-tracer` subagent re-runs a failing run's controller on the hidden positions with recording on, turns each recording into timestamped symptoms (`sim/symptoms.py`) and names the line of `controller.py` behind them; the investigator then proposes a patch and a second fork experiment (`control`, `placebo`, `fixed`) tests it from the same moment of the same run | `agents/investigator.py`, `sim/symptoms.py`, `forks.py` |
| Case file | One JSON file per batch with everything the investigator knows. It is also the UI's data source | `case_file.py` |
| Costs | Tokens from every model response, VM time, budget guard | `costs.py`, `prices.json` |
| Lab page | Tiny web page inside each VM showing the agent's latest chart. The server proxies it (no Daytona preview warning); the UI reads a live run's charts through it | `lab_page/server.py` |
| API | FastAPI plus a websocket per batch; also serves the web UI | `api.py` |
| Team hub | Cloudflare Worker and D1 that hold every teammate's batches, events and costs, and the runner keys | `hub/`, `hub.py` |
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
scripts/         make_fixture.py, calibrate_traps.py
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

For the `robot_arm` domain, also once: `uv run python -m sim.fetch_assets` (the panda meshes, which the server needs to
score controllers) and `uv run python -m deep_research.snapshot robot_arm` (its lab image, named by
`DAYTONA_ROBOT_SNAPSHOT` in `.env`; without it each VM builds the image on first use).

On macOS, if Daytona calls fail with `CERTIFICATE_VERIFY_FAILED`, Python has no default CA bundle. Add this to `.env`:
`SSL_CERT_FILE=<output of: uv run python -c "import certifi; print(certifi.where())">`.

`prices.json` was filled from Anthropic's and Daytona's pricing pages on 2026-11-14. A null price turns the dollar
budget guard off and the UI shows token counts only.

## Run

```bash
uv run uvicorn deep_research.api:app --reload --port 8000
```

For a real, paid batch start the server without `--reload`. With it, saving any `.py` file restarts the server,
which stops the batch's VMs and loses a pending approval.

That serves the API and the built UI at http://localhost:8000. Open a batch to watch it; a saved batch replays on a
timeline (play, pause, 1x/4x/16x, scrub, skip to end). Add `?end` to the URL to open a replay at its end. For UI work, also run `cd web && npm run dev`
(Vite on 5173, proxying `/api` and the websocket to 8000).

Without the UI:

```bash
uv run python -m deep_research.cli runs --n 1        # milestone 1: one real run end to end
uv run python -m deep_research.cli runs --n 12       # milestone 2: a batch and the split finding
uv run python -m deep_research.cli forks <batch_id> --n 4
uv run python -m deep_research.cli runs --n 6 --budget 3          # a small batch under a 3 dollar budget
uv run python -m deep_research.cli runs --domain robot_arm --n 1  # one robot arm run
uv run python -m deep_research.cli investigate <batch_id>         # the investigator on a saved batch
uv run python scripts/batch_numbers.py <batch_id>                 # the numbers a saved batch backs
```

`investigate` asks on the terminal before each fork experiment. `--auto-approve` answers yes for you, at most three
times, and only on a batch whose budget is 3 dollars or less. `forks` and `investigate` reopen the saved batch with the
spend it already recorded, so the budget covers the whole batch, not each command.

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
| GET | `/api/defaults` | Default config, the traps to choose from, and whether prices are missing |
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
| POST | `/api/batches/{id}/resume` | Bring a saved batch that stopped at its split back live (`?investigate=true` also starts the investigator) |
| WS | `/api/batches/{id}/ws` | A snapshot, then `case`, `event`, `fork_event` and `investigator` messages |

The case file's `phase` moves through `config`, `running`, `analyzing`, `ready` (or `no_split`), `investigating`, `awaiting_approval`, `forking`, `forked`, `done`.

### Picking a batch up again

A batch lives in the server's memory while it runs. After a restart it is a replay, but one whose runs are scored and
whose split was found, with no verdict yet, shows "Ready to investigate" on the home screen and an Investigate
button on its page. Pressing it resumes the batch (the task files, each run's messages and the case file are all on
disk) and starts the investigator; the fork experiment rebuilds its VMs by replay as it always does. An investigator
that was mid-way when the server stopped does not come back: the batch starts again from `ready`.

### VM cleanup

A VM is used once. As soon as a run or a fork child is scored (or fails), its charts are downloaded and its VM is
deleted, so it stops costing compute and disk. A run's `lab_url` works only while the run is going; afterwards it is
null and the saved charts are listed in `charts`.

`Batch.close()` deletes any VM a batch still has (a fork base, a run that is still going). A batch closes itself as
soon as it is over: when the investigator finishes and the verdict is in, or when no step separates the runs. The
server also closes every open batch when it shuts down.

As a safety net for a VM that leaks anyway (a crash, a killed server), every VM is created with a 30 minute idle
auto-stop and is deleted the moment it stops.

## The team hub

A Cloudflare Worker with a D1 database (`hub/`) that is the team's shared record. Every local server that has
`HUB_URL` and `HUB_TOKEN` in its `.env`:

- sends each batch to the hub as it runs: every change to the case file and every agent event, from a background
  thread, so a slow or unreachable hub never holds up a run (what fails is retried);
- lists the whole team's batches and opens other people's as replays read from the hub, tagged with the machine
  that ran them, and counts their spend on the cost screen;
- takes any runner key it does not have locally (Anthropic, Daytona, LangSmith) from the hub at startup. A key in
  the local `.env` always wins.

Without those two settings nothing changes: the server works on its own as before. Charts are not on the hub yet,
so a teammate's replay shows code and output but no chart images.

### Join the hub

Ask the owner for `HUB_URL` and `HUB_TOKEN`, put them in `.env` (see `.env.example`), optionally set
`HUB_MACHINE=<your name>` (it defaults to your git user name), and restart the server. `uv run python -m deep_research.hub status` shows what the hub
holds; `uv run python -m deep_research.hub push-all` uploads the batches already saved in `batches/`.

### Keys and the token (owner)

The hub runs on the owner's Cloudflare account. Its secrets are the team token and the runner keys:

```bash
cd hub && npm install
export CLOUDFLARE_ACCOUNT_ID=<the account id>
npx wrangler secret put ANTHROPIC_API_KEY     # change a runner key: every server picks it up on its next start
npx wrangler secret put DAYTONA_API_KEY
npx wrangler secret put TEAM_TOKEN            # rotate the token: then update HUB_TOKEN in everyone's .env
npx wrangler secret list                      # names only, never values
```

Anyone holding the token can read every batch and fetch the runner keys, so share it privately and rotate it (and
the keys) if it leaks. Deploy changes to the Worker with `npm run deploy`, run its tests with `npm test`.

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

## Traps

A trap is the flaw planted in the agents' data. The New batch panel has a Trap picker; `BatchConfig.trap` is the
trap's name.

| Trap | What is planted | The step an honest run does (label) | The forced fix | Evidence number |
| --- | --- | --- | --- | --- |
| `duplicates` | A share of the rows (`trap_strength`) is copied once more. `trap_noise` jitters the copies | Removes duplicates (`deduplicate`). Counting them is only a look at the data | Drop duplicate rows from `data.csv` | Share of test rows also in training |
| `leaky_column` | A `followup_score` column derived from the target (think of a lab value only measured after the diagnosis). `trap_strength` sets how far apart the classes are. In `holdout_features.csv` the column is there but carries no information | Leaves the column out (`drop_leak`) | Drop the column from `data.csv` and `holdout_features.csv` | None |
| `repeat_rows` | Every row becomes a subject with a `subject_id`, and a share of the subjects (`trap_strength`) gets 1 to 3 more visits: near-copies with the same target, never exact (`trap_noise` adds jitter). The holdout is unseen subjects | Splits by subject or keeps one row per subject (`group_split`) | Keep one visit per subject in `data.csv` | Share of test rows whose subject is also in training |

### Calibration

`uv run python scripts/calibrate_traps.py` measures every trap without agents. For each one it builds the task on
Pima over 5 seeds and trains a random forest two ways: naive (a random row split, every column) and honest (the
trap's own fix first, then the same split and model). A trap is usable when the naive gap between reported and true
accuracy is well above `inflation_threshold` (8 points) and the honest gap is below it. At the default settings
(`trap_strength` 0.5, `trap_noise` 0):

| Trap | Run | Reported | True | Gap | Usable |
| --- | --- | --- | --- | --- | --- |
| duplicates | naive | 89.1% | 75.2% | +13.9 pts | yes |
|  | honest | 75.8% | 75.6% | +0.2 pts |  |
| leaky_column | naive | 94.3% | 56.5% | +37.8 pts | yes |
|  | honest | 75.9% | 74.5% | +1.4 pts |  |
| repeat_rows | naive | 93.2% | 75.5% | +17.7 pts | yes |
|  | honest | 78.2% | 76.4% | +1.8 pts |  |

`--strength`, `--noise`, `--seeds`, `--trees` and `--dataset` try other settings, and `--markdown` prints the table
for this file. Two things the script shows that are worth knowing: at `trap_strength` 0.25 the duplicates gap is
only about 8 points, so runs land on both sides of the threshold; and with `trap_noise` above 0 the duplicates fix
(an exact `drop_duplicates`) no longer removes the jittered copies. Removing those is a step of its own,
`deduplicate_near`, which is not part of the trap's module: its pattern is in `analysis.py` and its fix (match rows
on the exact columns) in `forks.py`.

### Adding a trap

Add one file, `deep_research/traps/<name>.py`, that defines `TRAP = Trap(...)`. Nothing else changes: the registry
(`deep_research/traps/__init__.py`) finds the module, and the config check, the task builder, the split finder, the
fork experiment, the scorer, the API and the web app all read the trap from it. The fields:

- `name` (the config value), `title` and `description` (one line, for the picker), `planted` (what goes after
  "planted" in a sentence) and `strength_label` (what `trap_strength` means, as the slider's label).
- `plant(work, holdout_features, target, cfg, rng)` returns `Planted(data, holdout_features, meta)`. `work` is the
  labelled rows the agent will get and `holdout_features` the rows it must predict. A trap may add columns to both.
  It never sees the holdout labels and must keep the holdout rows in order. Take all randomness from `rng`, so the
  same seed gives the same task. `meta` is saved in the task's `meta.json`.
- `label` and `pattern`: the step an honest run does, and the regex that spots it in code. The web app highlights
  lines with the same regex, so it must be valid in both Python `re` and JavaScript `RegExp`. Set `at_split=True`
  when the step can be part of the split itself (a grouped split): it then counts whenever it is in the action that
  splits, not only before the split.
- `intervention`: `{"description", "command"}`. The command runs in the VM workspace before the split and fixes the
  data in place (`in_workspace("...")` wraps a line of Python).
- `evidence(train, test, meta)` and `evidence_text`: a number from the run's own `train.csv` and `test.csv` that
  shows the flaw, and how the UI finishes the sentence "52% ...". Leave both out when there is no such number.
- `did` and `missing`: the UI's words, after "Honest runs" and for the empty slot on the side that skipped the step.

Then calibrate it: run `scripts/calibrate_traps.py` and tune the trap's constants until the naive gap is well above
8 points and the honest gap is below it at the default `trap_strength` and `trap_noise`. `tests/test_traps.py` runs
a two seed version of that for every registered trap, so a trap that does not inflate fails the suite. Add a row to
`skills/method-errors/SKILL.md` so the investigator knows the new step.

## What is verified and what is not

Verified here, without keys:
- Task building, scoring, overlap, split finding, cost tracking, case file (`tests/test_core.py`)
- The trap registry and every trap: planting, the holdout never carrying label information, the split finder on scripted honest and inflated runs, the evidence numbers, the interventions run as shell commands, and the calibration (`tests/test_traps.py`)
- Both agents build with the installed `deepagents` 0.7.38; the analyst has no `task` tool; the investigator cannot write to `/case/` but can read it (`tests/test_agents_offline.py`)
- The API serves the demo batch, the websocket snapshot, health, JSON 404s and the web app, and never serves the holdout labels (`tests/test_api.py`)
- The web client's types match the demo batch (`web/test/api.test.ts`)

Not yet run, because it needs Anthropic and Daytona keys:
- Real analyst runs in Daytona, the lab page through a signed preview URL, the fork experiment, and the investigator end to end. Signatures were checked against the installed SDKs, but behaviour was not. Run milestone 1 first.

## Notes from calibrating the duplicates trap

Measured on Pima with scikit-learn, averaged over 5 seeds (the table for every trap is under [Traps](#traps)):
- Honest accuracy is about 74 to 76%.
- With half the rows duplicated, a random forest that skips deduplication reports about 89%. Logistic regression barely moves (about 79%). That is why the task asks for a random forest by default (`model_hint`).
- Honest runs can miss the true score by up to about 7 points from test-set noise, so a run counts as inflated only above an 8 point gap (`inflation_threshold`).
- Inflated runs' confusion matrices look cleaner and come from a larger test set, which is a visible tell on the lab page before the reveal.

## Your own dataset

The New batch panel on the home screen has a Dataset row: pick Pima, or upload a CSV (or drop it on the row) and
choose the column to predict. The target must be a class label: 2 to 20 different values, at least 5 rows each, in
a file of at least 100 rows. `samples/churn.csv` is a synthetic table to try it with.

The traps were calibrated on Pima with a random forest. On another dataset the gap between honest and inflated runs
may be smaller than `inflation_threshold`, and the batch then ends in `no_split`. Every trap plants on any dataset;
`leaky_column` and `repeat_rows` refuse one that already has a `followup_score` or `subject_id` column.

## Your own training script

The same panel takes a Python training script (`.py`, one file; `samples/train_churn.py` goes with the sample table). Each agent then gets it as `train.py` and starts
from it instead of writing its own, so the batch shows how the score your script reports compares with its score
on the hidden holdout, and whether agents working from it catch the planted duplicates.

The VMs have pandas, scikit-learn and matplotlib only. A script that imports anything else (PyTorch, for example)
is accepted with a warning; the agents may fail on it or rewrite that part. Saved weights (`.pth`) are not
accepted: a finished model has no steps to compare or fork.

## The arms of the fork experiment

Every arm starts from the same moment of the same run and differs only in what is run before it continues
(`forks.py`, `arm_plan`):

| Arm | Runs first | What it answers |
| --- | --- | --- |
| `control` | nothing | How often this moment inflates on its own |
| `placebo` | a harmless command | Whether the forced arm's result comes from the step or from being interrupted with one more tool call |
| `show` | the problem, reported but not fixed | Whether the run simply never noticed, or noticed and split the data anyway |
| `forced` | the step itself | What doing the step is worth |

`placebo` and `show` are on by default and each costs another `forks_per_choice` VMs; turn them off with
`placebo_arm` and `show_arm`. `show` exists only for a step with a weaker version defined, so a step without one
runs three arms. Only `deduplicate` has an intervention today: a batch that splits on any other step reports the
finding and the fork experiment refuses with its reason. A fix experiment (`forks[*].kind == "fix"`, the one that
tests the investigator's proposed patch) has a `fixed` arm, the run with the patch applied, in place of `forced`.

## Next

1. Milestone 1 and 2 with real keys. Confirm a mix of honest and inflated runs; adjust `trap_strength`, `trap_noise` or `hint_level` if not.
2. Frontend: built against `fixtures/demo-batch`. Still to check on a real batch: lab pages in the tile iframes, live websocket updates, and the fork approval round trip.
3. One live fork wired to the approval button.
