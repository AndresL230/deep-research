<div align="center">

# Orro

### The scientific debugger for autonomous AI agents

**AI agents can run experiments. Orro investigates whether their conclusions deserve to be trusted.**

*Independent verification · Execution tracing · Controlled interventions · Evidence-based verdicts*

**HackPrinceton 2026 · Science + Discovery**

</div>

---

## The problem

Autonomous AI agents are becoming capable of writing code, conducting experiments, interpreting results, and presenting conclusions with minimal human supervision.

But **a successful run is not necessarily a sound experiment**.

An agent can produce convincing results while relying on an inadequate test, an accidental shortcut, a brittle implementation, or a methodological decision that does not generalize. A polished explanation does not reveal which decision caused the problem—or whether correcting that decision would change the outcome.

Most evaluation systems stop at **“Did the agent succeed?”** Orro asks a harder set of questions:

1. **What did the agent claim?**
2. **What happens under independent evaluation?**
3. **Where did the agent's process go wrong?**
4. **Can we experimentally test the suspected cause?**
5. **How strong is the resulting evidence?**

Orro turns agent evaluation into an **investigation of the process that produced the result**.

## What is Orro?

**Orro is an experimental auditing platform for autonomous AI research agents.**

It launches independent agents in isolated execution environments, records their work, evaluates their outputs against a separate ground-truth procedure, and investigates discrepancies between claims and measured outcomes. When it identifies a suspicious decision, Orro can reconstruct the relevant execution state and compare the original continuation against an intervention.

Instead of merely generating a critique, Orro attempts to **test an explanation**.

The underlying workflow is designed to apply across computational research and agent-driven engineering tasks. **Our flagship demonstration is robotic control**: AI agents write controllers for a simulated robotic arm, and Orro investigates whether apparent success survives unfamiliar conditions.

> **The key distinction:** Orro is not a robotic-arm controller. It is a system for auditing *how autonomous agents reach and justify their results*. Robotics makes that process visible.

## How it works

```mermaid
flowchart TD
    A["Research or engineering task"] --> B["Independent AI agents"]
    B --> C["Isolated Daytona sandboxes"]
    C --> D["Artifacts, decisions, tool traces, reported results"]
    D --> E["Independent evaluation"]
    E --> F{"Discrepancy or suspicious behavior?"}
    F -- No --> G["Record verified outcome"]
    F -- Yes --> H["Compare execution histories"]
    H --> I["Investigator proposes a testable hypothesis"]
    I --> J["Human approval and experiment budget"]
    J --> K["Reconstruct a decision point"]
    K --> L["Control: original continuation"]
    K --> M["Intervention: targeted change"]
    L --> N["Re-evaluate outcomes"]
    M --> N
    N --> O["Evidence-qualified verdict"]
    O --> P["Case file and interactive replay"]
```

### 01 / Observe independent agents

Multiple research agents receive the same task, but work in separate Daytona environments. Each agent can write code, execute tools, inspect outputs, and report a result. Orro preserves the artifacts and execution history needed to inspect **what the agent actually did**, not just what it said it did.

### 02 / Verify claims independently

Orro uses a domain-specific evaluator to measure the submitted artifact under conditions separate from the agent's own testing. This creates a meaningful comparison between **self-reported performance** and **independently measured performance**.

The evaluation procedure is implemented outside the analyst's sandbox. For the robotics demonstration, unseen object placements and their scoring logic remain server-side.

### 03 / Investigate the process

When claims and measured results diverge, Orro's investigator examines execution traces and artifacts to identify plausible failure points. It works **blind**: it is never told what the batch was built to go wrong, which step is the "right" one, or where the hidden test cases are. Only the evaluator knows those, and `tests/test_blind_investigator.py` checks every prompt, skill, case-file view and file-tool result the investigator can reach.

Before any experiment, the investigator must record **at least two competing hypotheses**. Each one states its kind (a testing step the agent skipped, or a defect in the code), the evidence for it, a **prediction**, and the result that would **falsify** it. The investigator then chooses which hypothesis to test.

A suspicious step is a **candidate explanation**, not an established cause.

### 04 / Run a controlled intervention

Orro reconstructs an earlier point in the agent's execution and compares continuations with and without a targeted change. The platform's experiment machinery supports an unchanged control and an intervention branch; additional comparison arms may be available depending on the intervention.

```mermaid
flowchart LR
    S["Reconstructed execution state"] --> C["CONTROL<br/>Continue unchanged"]
    S --> I["INTERVENTION<br/>Apply targeted correction"]
    C --> EC["Independent scoring"]
    I --> EI["Independent scoring"]
    EC --> V["Compare outcomes and evidence"]
    EI --> V
    V --> R["Qualified finding"]
```

This is the heart of Orro: **instead of asking an LLM whether an explanation sounds plausible, test whether changing the suspected decision changes the result**.

Orro has two kinds of experiment, and they measure different things:

| Experiment | Tests | Measures | Statistic (computed in Python, never by the model) |
|---|---|---|---|
| **Method fork** | "The agent skipped step X" | Whether the agent's **report** becomes accurate (the copies may also change their code; their measured rates are shown, outside the evidence level) | One-sided Fisher exact test, forced vs. control. `supported` needs ≥ 8 pairs and p < 0.05 |
| **Code fix** | "Line N of the controller is wrong" | Whether the **controller** succeeds more often | Paired exact sign test on held-out positions, before vs. after the patch |

A more accurate report is not a better controller, and Orro never presents one as the other.

The controls behind these experiments:

- **Pre-registered predictions.** The tested hypothesis's prediction is written onto the experiment before any copy runs. Its outcome (`supported`, `contradicted` or `inconclusive`) is computed from the stored counts.
- **Separated diagnostic and test sets.** The investigator diagnoses the controller on a set of positions kept at least 3 cm from every hidden test position. The patch is then measured on the hidden set, which it never saw.
- **Bounded interventions.** Forced steps come from a fixed table. A proposed patch must replace one exact, unique excerpt, must still parse, and is size-limited.
- **Human approval for every experiment.** This includes the free local fix test, because it executes patched code.
- **Wording follows the evidence.** A verdict cannot say "caused" unless the evidence level is `supported`, and a fix verdict cannot say "improved" unless the sign test says so.

### 05 / Produce an auditable case

Orro stores run histories, investigation steps, experiment outcomes, and a qualified verdict in a case record. The web interface can display live execution, compare branches, and replay recorded behavior.

The result is not simply a pass/fail label. It is a traceable account of **what was claimed, what was measured, what was changed, and what the evidence supports**.

---

## Flagship demonstration: a robotic arm that succeeds for the wrong reasons

Our HackPrinceton demonstration uses a **Franka Panda robotic arm in MuJoCo**.

An autonomous AI agent is tasked with writing a Python controller that picks up a can and places it in a target zone. The agent can test its controller in a practice scene and report its performance.

The catch: **success at a familiar object position does not establish generalization**.

A controller may work at the practice location while failing when the can starts somewhere else. It might rely on fixed coordinates, an overly narrow trajectory, inadequate grasp alignment, or a testing procedure that never exercised the relevant variation.

Orro does not assume which explanation is correct. It gathers evidence.

### The experiment

| Stage | What the audience sees | What Orro is testing |
|---|---|---|
| **Agent execution** | Independent agents develop and test robot controllers | What did each agent build and claim? |
| **Hidden evaluation** | The same controllers attempt unseen can placements | Does apparent success generalize? |
| **Failure replay** | Recorded robot motions reveal missed, dropped, or tipped objects | What actually happened? |
| **Investigation** | Execution history and controller code are inspected | Which decision might explain the failure? |
| **Intervention** | An unchanged continuation is compared with a targeted correction | Does changing that decision improve the measured outcome? |
| **Verdict** | Scores, traces, and evidence are shown together | What conclusion is justified by the experiment? |

### What gets measured?

The robotics evaluator records episode outcomes such as `placed`, `dropped`, `tipped`, and `missed`, along with placement error, test conditions, and motion traces. This makes a failure **observable**, **replayable**, and **independently scored**.

```mermaid
flowchart TD
    TASK["Pick up the can and place it in the target zone"] --> AGENT["AI-generated controller.py"]
    AGENT --> PRACTICE["Visible practice scene"]
    PRACTICE --> CLAIM["Agent reports performance"]
    AGENT --> HIDDEN["Server-side unseen can positions"]
    HIDDEN --> SCORE["Measured success and failure traces"]
    CLAIM --> COMPARE["Compare claim vs. measured outcome"]
    SCORE --> COMPARE
    COMPARE --> INVESTIGATE["Trace code and test a correction"]
```

### What a real run found

`fixtures/robot-live-investigation` is a **recording of a real run**. It contains no scripted or hand-edited data (`config.recording.kind = "live"`). Twelve agents (Claude Haiku and Sonnet) each wrote a controller in their own Daytona VM. Orro scored every controller on 20 hidden can positions, and then the investigator (Claude Sonnet) ran blind. Total spend: **$2.50**.

| Stage | What happened |
|---|---|
| **Claim vs. measured** | Run r06 reported **100%** over 37 episodes (13 of them at "random layouts") and measured **65%** on the hidden positions. Five runs came out inflated, three honest and two unclear. Two runs failed. |
| **Hypotheses** | The investigator recorded three, each with a prediction and a falsification condition: **h1**, inflated runs never tested the table edges; **h2**, `tune_params`, the top split, which no fork can force; **h3**, a shared controller defect. It chose to test h1. |
| **Method fork (h1)** | The prediction was registered first. Forced copies ran the controller at 10 edge positions kept away from the hidden set. Result: **0 of 4 forced copies inflated**, against **4 of 4** for control, placebo and show. Fisher p = 0.014, but on **4 pairs of the 8 required**, so the outcome is **inconclusive**. |
| **What the forced copies did** | They didn't only report more honestly. Every forced copy **rewrote its controller** after seeing it fail at the edges, and measured **90–100%** on hidden positions (control copies: 65%, code unchanged). That gain is shown beside the evidence level, not counted in it. |
| **Code fix (h3)** | The investigator traced r06, r10 and r11 on diagnostic positions and proposed scaling r06's carry duration with distance. Measured on the 20 held-out positions: **65% → 25%**, 0 gained, 8 lost, sign test p = 0.004, **worse**. h3 is **contradicted**, and the investigator's own fix verdict says the change is not shown to help. |
| **Verdict** | "Skipping test_table_edges **suggests** why the claims were inflated, but the evidence is open…" Confidence low. The grader asked for revisions twice before passing it. |

What went wrong along the way is part of the record:

- Daytona refused to fork VMs, so all 16 copies were **rebuilt by replay**.
- The server-side scoring of ten copies timed out because the laptop was overloaded. Their saved outputs were scored afterwards, deterministically and with no agent involved (`forks.f1.rescored`). The scoring is now rate-limited.
- A second investigator session wrote the verdict on the corrected counts. The first verdict is kept under `superseded_verdicts`.

**Why robotics?** It makes methodological failure tangible. Rather than showing only a number, we can show the arm reaching to the wrong location, missing a grasp, or failing to place an object—and then examine the code and decisions behind that behavior.

**Why not robotics only?** The agent orchestration, observation, independent evaluation, experiment branching, and evidence reporting are the platform. The robotic simulator is one domain-specific evaluator connected to that workflow.

---

## What makes Orro different?

| Conventional agent evaluation | Orro's approach |
|---|---|
| Checks a final answer or benchmark score | Inspects the **execution process** behind the answer |
| Trusts an agent's own tests or summary | Runs **independent evaluation** |
| Uses another model to speculate about mistakes | Attempts **controlled interventions** to test explanations |
| Reports success or failure | Connects **claims, traces, interventions, and outcomes** |
| Produces a one-off judgment | Preserves an **auditable case record and replay** |

Orro is designed to bridge the gap between **agent observability** and **experimental evidence**.

## System architecture

```mermaid
flowchart LR
    WEB["Vite / TypeScript interface"] <-->|"HTTP + WebSockets"| API["FastAPI server"]
    API --> ORCH["Batch orchestration"]
    ORCH --> AGENTS["LangChain Deep Agents"]
    AGENTS --> VM["Isolated Daytona sandboxes"]
    ORCH --> EVAL["Domain-specific evaluator"]
    ORCH --> INV["Investigator and experiment runner"]
    EVAL --> CASE["Scored artifacts and case record"]
    INV --> CASE
    CASE --> API
```

### Technology

- **LangChain Deep Agents / LangGraph** — autonomous agent execution and structured investigation workflows.
- **Daytona** — isolated environments for independent agent work and experiment reconstruction.
- **Python** — orchestration, scoring, experiment logic, and simulation integration.
- **MuJoCo** — physics simulation for the robotic-arm demonstration.
- **FastAPI + WebSockets** — batch control, state, and live updates.
- **Vite + TypeScript** — investigation dashboard, run comparisons, and replay UI.

### Repository guide

| Path | Purpose |
|---|---|
| `deep_research/agents/analyst.py` | Autonomous analyst execution |
| `deep_research/agents/investigator.py` | Investigation and experiment requests |
| `deep_research/batch.py` | Batch execution and experiment orchestration |
| `deep_research/sandboxes.py` | Daytona sandbox lifecycle and reconstruction |
| `deep_research/domains/robot_arm.py` | Robotics task and evaluation integration |
| `deep_research/api.py` | Backend API and event streaming |
| `sim/` | Franka Panda simulation, controllers, and scoring |
| `web/` | Interactive frontend |
| `fixtures/robot-live-investigation/` | **Real** recorded robot investigation (the demo backup; see "What a real run found") |
| `fixtures/robot-demo-batch/` | **Simulated** robotics replay data for UI testing |
| `docs/` | Design notes, development plans, and progress |

---

## Getting started

### Requirements

- Python and [`uv`](https://docs.astral.sh/uv/)
- Node.js and npm for the web interface
- Credentials for the agent and sandbox services when running live experiments (see `.env.example`)
- MuJoCo dependencies for the robotics demonstration

### Install Python dependencies

```bash
uv sync
```

### Prepare the robotics simulator

```bash
uv run python -m sim.fetch_assets
```

Run a practice episode and save a motion trace:

```bash
uv run --with-requirements sim/requirements.txt \
  python -m sim.run \
  --controller sim/controllers/baseline.py \
  --can 0.5,0.1 \
  --place 0.4,-0.3 \
  --out motion.json
```

Run the independent position evaluator locally:

```bash
uv run --with-requirements sim/requirements.txt \
  python -m sim.evaluate \
  --controller sim/controllers/baseline.py \
  --set hidden
```

Run simulation tests:

```bash
uv run --with-requirements sim/requirements.txt --with pytest \
  pytest sim/tests -q
```

### Run a live robotics agent batch

Configure the service credentials documented in `.env.example`, then prepare the robotics sandbox image and launch a batch:

```bash
uv run python -m deep_research.snapshot robot_arm
uv run python -m deep_research.cli runs --domain robot_arm --n 1
```

Live model calls and Daytona workspaces may incur charges. Review experiment budgets and active sandboxes before running larger batches.

### Launch the dashboard

Backend:

```bash
uv run uvicorn deep_research.api:app --port 8000
```

Frontend, in another terminal:

```bash
cd web
npm install
npm run dev
```

The development frontend runs at `http://localhost:5173` and connects to the backend on port `8000`.

To replay the real investigation with no keys and no VMs, open `http://localhost:5173/#/b/robot-live-investigation`. With a built frontend (`cd web && npm run build`), the backend serves the page itself at `http://localhost:8000/#/b/robot-live-investigation`.

For simulator internals, see [`sim/README.md`](sim/README.md), [`sim/CALIBRATION.md`](sim/CALIBRATION.md), and [`sim/MOTION_FORMAT.md`](sim/MOTION_FORMAT.md).

---

## Two-minute demo narrative

Every number below is from `fixtures/robot-live-investigation`.

**0:00–0:20 — The claim.** Run r06's agent wrote a controller and reported **100%** success.

**0:20–0:45 — The contradiction.** On 20 positions it never saw, the controller measures **65%**. The fork's control copies run r06's controller unchanged, and each of their hidden positions can be replayed in 3D. The investigator's trace, on separate diagnostic positions, shows the can slipping out of the grip near the table's edges.

**0:45–1:10 — The investigation.** The investigator, never told the answer, records three competing hypotheses with predictions and falsification conditions, and chooses to test "never tested the edges" (Fork page).

**1:10–1:40 — The experiment.** Copies continue from just before the report. Forced to test the edges: **0 of 4 inflated** against 4 of 4 in each of control, placebo and show, and the forced copies' rewritten controllers measure **95%**. The investigator's own code patch is measured on held-out positions and makes things **worse** (65% → 25%) (Fix page).

**1:40–2:00 — The verdict.** "Suggests", not "caused": 4 pairs of the 8 required, so the outcome is inconclusive. Each limit is listed on the Verdict page.

The point is not that Orro can make a robot move. **The point is that Orro can investigate whether an autonomous agent's apparent success was scientifically meaningful.**

## Scientific integrity and current limitations

Orro is an experimental system, and the distinction between implemented infrastructure and validated scientific findings matters.

- **Hidden evaluation is independent of agent self-reporting.** The robotics evaluator keeps unseen test conditions on the server side.
- **A hypothesis is not a proven cause.** An observed failure or suspicious code path motivates an intervention; it does not establish causality by itself.
- **Execution reconstruction is not perfect time travel.** Replayed or forked agent continuations can differ because of nondeterminism and environment state.
- **Evidence must be qualified.** The repository includes evidence-gating logic, but a single experiment is not universal proof of causality or generalization.
- **Simulation is not physical deployment.** Success in MuJoCo does not establish performance on a real robot.
- **Simulated fixtures are not live experiments.** The repository's prerecorded robotics demo fixture is intended for interface and storytelling tests and must be identified as simulated.
- **VM forking falls back to replay.** Our Daytona sandboxes refused native forking ("Forking is not supported for this sandbox"), so experiment copies are rebuilt by replaying the source run's commands on a fresh VM. Every experiment records how each copy was built.
- **Small samples are reported as small.** Robot scores use 20 hidden positions, so rates move in 5-point steps. Four copies per arm can never reach `supported` by design; such results are reported as `inconclusive`.

## Credits

Orro is built on open-source work and hosted services:

- [LangChain Deep Agents](https://github.com/langchain-ai/deepagents), [LangGraph](https://github.com/langchain-ai/langgraph) and LangChain (`langchain-anthropic`, `langchain-daytona`): agent runtime, subagents, human-in-the-loop interrupts and the rubric grader.
- [Anthropic Claude](https://www.anthropic.com/) models (Haiku and Sonnet) for the analyst agents, the investigator and the grader.
- [Daytona](https://www.daytona.io/) sandboxes for the agents' isolated machines.
- [MuJoCo](https://mujoco.org/) (Apache 2.0) for physics. The Franka Emika Panda model comes from [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) (Apache 2.0, see `sim/ASSETS_LICENSE`) and is downloaded at a pinned commit by `sim/fetch_assets.py`.
- FastAPI, Uvicorn, httpx, pandas, scikit-learn, NumPy and python-dotenv on the backend.
- Vite, TypeScript, Vitest, [three.js](https://threejs.org/) (3D replay) and Lenis (scrolling) on the frontend.
- The Geist and Hanken Grotesk fonts (SIL Open Font License, see `web/src/fonts/`).

## The bigger picture

As AI systems take on more scientific and engineering work, verifying the final output will not be enough. We will need tools that can reconstruct the process, identify questionable decisions, and experimentally test whether those decisions explain observed results.

**Orro is a step toward that future: an experimental debugger for the scientific reasoning and engineering work of autonomous AI agents.**

---

<div align="center">

**Orro · Built at HackPrinceton 2026**

*Don't just trust the result. Investigate how it happened.*

</div>
