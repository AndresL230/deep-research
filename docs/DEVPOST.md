# Orro: Devpost technical description

Paste-ready. Every number is from `fixtures/robot-live-investigation`, a recording of a real run.

## Inspiration

AI agents now write code, run experiments and report results. When an agent says "100% success", nobody checks how it got that number. We wanted a tool that treats an agent's claim the way a scientist treats a surprising result: measure it independently, form competing explanations, and test them.

## What it does

Orro is a scientific debugger for autonomous AI agents:

1. **Independent agents.** Agents work in isolated Daytona VMs. In our flagship task, each one writes a pick-and-place controller for a Franka Panda arm in MuJoCo and reports its success rate.
2. **Independent evaluation.** Orro scores every controller on 20 can positions the agents never see. The positions stay on the server and never reach a VM.
3. **Discrepancy detection.** Each run is labelled honest, unclear or inflated by its claimed-minus-measured gap.
4. **Blind investigation.** An investigator agent reads the runs, their step-by-step actions and their code. It is never told what the batch was designed to go wrong. It must record at least two competing hypotheses, each with a prediction and a falsification condition, and then choose which one to test.
5. **Controlled intervention.** Orro has two kinds of experiment:
   - A **method fork** rebuilds a run just before it wrote its report. Copies then continue with or without the suspected step, alongside placebo and "show" arms.
   - A **code fix** scores the investigator's patch against the original controller on the held-out positions.
6. **Measured outcome.** Statistics are computed in Python, never by the model:
   - Fisher's exact test for the fork.
   - A paired exact sign test for the fix.
   - A pre-registered prediction, set before anything runs, with its outcome (supported, contradicted or inconclusive) computed from the stored counts.
7. **Evidence-backed verdict.** The verdict may say "caused" only with at least 8 pairs and p < 0.05, and a fix may be called an improvement only if the sign test says so. A grader agent checks the verdict against the case file.

### What our real run found ($2.50 total)

- **The discrepancy.** One agent claimed **100%**; its controller measures **65%** on unseen positions.
- **The hypotheses.** Working blind, the investigator proposed three. The top statistical split could not be tested, so it chose to test "inflated agents never tested the table edges".
- **The method fork.** Forcing an edge test left **0 of 4** copies inflated, against **4 of 4** in each of the control, placebo and show arms. The forced copies also rewrote their controllers, which measured **95%** against 65% for control. With 4 pairs, the outcome is honestly **inconclusive**: the threshold is 8.
- **The code fix.** The investigator's own patch made the controller **worse: 65% → 25%** (p = 0.004). Orro recorded that hypothesis as **contradicted**, and the investigator's verdict says so.

## How we built it

- **Agents:** LangChain Deep Agents on LangGraph, with Claude Haiku and Sonnet. The analysts work in Daytona sandboxes. The investigator uses subagents (step tagger, hypothesis drafter, parallel code tracers), typed tools that write one case-file section each, human-in-the-loop interrupts for every experiment, and a rubric grader.
- **Science core** (`deep_research/evidence.py`): Fisher's exact test, the sign test, outcome rules and wording guards, all in plain Python.
- **Simulation:** MuJoCo with the Franka Panda model from MuJoCo Menagerie. Positions are stratified over the workable area, and the diagnostic, forced and hidden position sets are kept apart.
- **Backend:** FastAPI with WebSockets streaming the case file and events. It has a budget guard covering model tokens and VM time, and cancel-safe VM cleanup.
- **Frontend:** Vite and TypeScript, with three.js for 3D motion replay. Pages in order: Agents, What changed, Investigator, Fork, Verdict, Diagnosis, Fix. Each claim on the page is tagged with who made it: an LLM, plain Python or a person.

## Challenges

- **Keeping the investigator blind.** Our first version leaked the answer in three places: the system prompt, a skill file and the case-file view. We removed all three and wrote tests that check everything the investigator can reach, including paths outside its folders.
- **Not tuning the fix on its own test.** Tracing originally re-ran the hidden positions. It now uses a separate diagnostic set.
- **Real infrastructure fails.** Daytona refused to fork VMs, so every copy was rebuilt by replay, and the page says so. Our laptop starved the scorer during the live run. We scored the affected copies afterwards from their saved outputs, labelled them as re-scored, and rate-limited scoring.

## Accomplishments

- A complete, real, end-to-end investigation, with a negative result reported as negative.
- Statistics and wording guards that stopped both the model and us from overclaiming.

## What we learned

- A more honest report and a better controller are different outcomes, and they need different experiments.
- Small samples need to be said out loud: 4 pairs cannot support a causal claim, however clean they look.

## What's next

- Larger fork experiments (8 or more per arm) so results can reach `supported`.
- Native VM forking once the sandbox supports it.
- More domains: the engine already runs a tabular-ML domain with planted data-leakage traps.

## Built with

Python, LangChain Deep Agents, LangGraph, Claude (Anthropic), Daytona, MuJoCo, MuJoCo Menagerie, FastAPI, WebSockets, TypeScript, Vite, three.js, pandas, scikit-learn, NumPy.
