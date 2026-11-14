# Evidence Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fork experiment carries a saved prediction, pairs, a sequential evidence score, exact p values and two separate outcomes (claim and capability). Experiments stop as soon as the evidence is decisive. The verdict's numbers are computed by code, and the investigator cannot name a cause the evidence does not support.

**Architecture:**
- A new pure module, `deep_research/evidence.py`, holds all the math, following `MASTER_PLAN.md` §6.4.
- `Batch._experiment` runs copies in rounds from one base VM, writes the prediction before the first copy and the evidence after every round, and stops on a decisive level or at the cap.
- `record_verdict` attaches the evidence computed by code and refuses an unsupported "caused" claim.
- All additions to the case file are additive.

**Tech Stack:** Python 3.12, SciPy 1.18 (already installed through scikit-learn; no new dependency), pytest offline with `tests/local_vm.py` and `tests/scripted.py`, TypeScript types in `web/src/api.ts`.

**Spec:** `docs/MASTER_PLAN.md` §3 (invariants), §6.1, §6.4, and `docs/superpowers/plans/2026-11-14-technical-depth-roadmap.md` (Plan A).

## Global Constraints

- `MASTER_PLAN.md` §3 overrides this plan. In particular:
  - §3.4: the evidence math is plain code.
  - §3.5: every experiment has a control arm from the same point.
  - §3.8: the case file contract is additive. Never rename or remove a field.
  - §3.9: no cause is claimed below the evidence threshold.
  - §3.11: tests run with no keys and no VMs.
- The constants are copied from §6.4:
  - A pair that agrees multiplies the score by `1.9`; one that disagrees multiplies it by `0.1`.
  - The score starts at `1`.
  - `supported` at a score of at least `20`.
  - `cleared` after at least `5` pairs with a score below `1`.
  - Anything else is `open`.
  - A tie counts as disagree.
- Pairs are capped at `8` per experiment in total (the existing cap in `_experiment`).
- No new dependencies.
- The gate after each task:
  - `uv run pytest -q`
  - `(cd web && npm run typecheck && npm test)` whenever `web/` changed

## Review Focus

1. **A copy that failed, or that is `unclear`** (robot only), is dropped together with its partner and never counted as a disagreement. Pinned in Task 1.
2. **An experiment where every copy failed** gives level `open`, score `1.0`, p values `None`. It must not crash, and a `caused` verdict is refused. Pinned in Tasks 2 and 4.
3. **The budget runs out between rounds:** the rounds already finished keep their evidence, the experiment stops, and the tool says it stopped for budget. Pinned in Task 3.
4. **A fix experiment** (robot domain, arm `fixed`) is judged on the true success rate (`higher_true`), not on the gap. Pinned in Task 2.
5. **A saved batch or fixture with no `prediction` or `evidence`** (legacy) gets prediction `smaller_gap` (or `higher_true` for kind `fix`) when its evidence is computed, and everything reading `evidence` tolerates its absence. Pinned in Tasks 2 and 5.

---

### Task 1: The evidence math

**Files:**
- Create: `deep_research/evidence.py`
- Test: `tests/test_evidence.py`

**Interfaces:**
- Produces:
  - `Prediction = Literal["smaller_gap", "larger_gap", "higher_true"]`
  - `Level = Literal["supported", "cleared", "open"]`
  - Constants: `AGREE_X = 1.9`, `DISAGREE_X = 0.1`, `SUPPORT_AT = 20.0`, `CLEAR_MIN_PAIRS = 5`
  - `@dataclass(frozen=True) class Pair: i: int; control_gap: float; changed_gap: float; control_true: float | None; changed_true: float | None; agree: bool`, with `to_dict() -> dict`
  - `agrees(control: dict, changed: dict, prediction: Prediction) -> bool`. Each argument is a copy's record with `gap` and `true_accuracy`. `smaller_gap`: control gap minus changed gap is greater than 0. `larger_gap`: it is less than 0. `higher_true`: changed true minus control true is greater than 0. Ties are False.
  - `pairs_from_children(children: dict[str, dict], changed_arm: str, prediction: Prediction, control_arm: str = "control") -> list[Pair]`
    - Pairs `control-i` with `<changed_arm>-i` by the number after the last `-`, in ascending order.
    - A pair is kept only when both copies have `status` in `{"honest", "inflated"}` and a numeric `gap`.
  - `pair_score(pairs: Sequence[Pair]) -> float`
  - `level(score: float, n_pairs: int) -> Level`
  - `fisher_one_sided(control_inflated: int, control_scored: int, changed_inflated: int, changed_scored: int) -> float | None`
    - Uses `scipy.stats.fisher_exact([[ci, cs-ci], [fi, fs-fi]], alternative="greater")`.
    - Returns None when either scored count is 0.
  - `permutation_p(control: Sequence[float], changed: Sequence[float], direction: int, two_sided: bool = False) -> float | None`
    - The statistic is `direction * (mean(control) - mean(changed))`.
    - Returns None when either side is empty.
    - Exact over all splits when `comb(n+m, n) <= 50_000`; otherwise 20 000 random splits from `random.Random(0)`.
    - Counts splits with a statistic at least the observed one minus `1e-12`.
    - `two_sided` compares absolute values.

- [ ] **Step 1: Write the failing tests** in `tests/test_evidence.py`:

```python
from deep_research import evidence as ev

def kid(status, gap, true=0.7):
    return {"status": status, "gap": gap, "true_accuracy": true}

def test_agree_follows_the_prediction_and_a_tie_disagrees():
    assert ev.agrees(kid("inflated", 0.2), kid("honest", 0.0), "smaller_gap")
    assert not ev.agrees(kid("inflated", 0.2), kid("honest", 0.0), "larger_gap")
    assert not ev.agrees(kid("inflated", 0.1), kid("inflated", 0.1), "smaller_gap")
    assert ev.agrees(kid("honest", 0, 0.55), kid("honest", 0, 0.75), "higher_true")

def test_pairs_match_by_index_and_drop_a_pair_with_a_failed_or_unclear_copy():
    children = {"control-1": kid("inflated", 0.2), "forced-1": kid("honest", 0.0),
                "control-2": {"status": "failed"}, "forced-2": kid("honest", 0.0),
                "control-3": kid("inflated", 0.2), "forced-3": {"status": "unclear", "gap": 0.15},
                "control-10": kid("inflated", 0.3), "forced-10": kid("honest", 0.0)}
    pairs = ev.pairs_from_children(children, "forced", "smaller_gap")
    assert [p.i for p in pairs] == [1, 10] and all(p.agree for p in pairs)

def test_score_and_level_follow_the_sequential_rule():
    agree = lambda n: [ev.Pair(i, .2, 0, None, None, True) for i in range(n)]
    disagree = lambda n: [ev.Pair(i, 0, .2, None, None, False) for i in range(n)]
    assert ev.pair_score([]) == 1.0 and ev.level(1.0, 0) == "open"
    assert round(ev.pair_score(agree(4)), 2) == 13.03 and ev.level(ev.pair_score(agree(4)), 4) == "open"
    assert round(ev.pair_score(agree(5)), 2) == 24.76 and ev.level(ev.pair_score(agree(5)), 5) == "supported"
    assert ev.level(ev.pair_score(disagree(4)), 4) == "open"
    assert ev.level(ev.pair_score(disagree(5)), 5) == "cleared"

def test_exact_tests_match_the_known_answers():
    assert abs(ev.fisher_one_sided(3, 4, 0, 4) - 5 / 70) < 1e-12
    assert abs(ev.fisher_one_sided(4, 4, 0, 4) - 1 / 70) < 1e-12
    assert ev.fisher_one_sided(0, 0, 0, 4) is None
    control, changed = [.1743, .2219, .0581, .117], [.0207, .0337, -.0232, .0175]
    assert abs(ev.permutation_p(control, changed, +1) - 1 / 70) < 1e-12
    assert ev.permutation_p([], changed, +1) is None
```

- [ ] **Step 2: Run them to check they fail.** Run: `uv run pytest tests/test_evidence.py -q`. Expected: FAIL with `ModuleNotFoundError: deep_research.evidence`.
- [ ] **Step 3: Implement the interfaces above** in `deep_research/evidence.py`. Give it a module docstring that names `MASTER_PLAN.md` §6.4 and says why the score is a valid running test: under "no effect" each pair is a fair coin, and 0.5×1.9 + 0.5×0.1 = 1.
- [ ] **Step 4: Run them to check they pass.** Run: `uv run pytest tests/test_evidence.py -q`. Expected: 4 passed.
- [ ] **Step 5: Commit.** `git add deep_research/evidence.py tests/test_evidence.py && git commit -m "Add the evidence math: pairs, a sequential score, exact tests"` (with the session's co-author line).

### Task 2: Evidence for one experiment

**Files:**
- Modify: `deep_research/evidence.py`
- Test: `tests/test_evidence.py`

**Interfaces:**
- Consumes: Task 1.
- Produces: `experiment_evidence(fork: dict) -> dict`, from one `case["forks"][id]` record. It returns these keys:

| Key | Value |
| --- | --- |
| `prediction` | The fork's `prediction`, else `"higher_true"` for `kind == "fix"`, else `"smaller_gap"` |
| `changed_arm` | `"fixed"` for kind `fix`, else `"forced"` |
| `pairs` | `[Pair.to_dict()]` |
| `n_pairs` | Number of usable pairs |
| `score` | Rounded to 2 decimals |
| `level` | From Task 1 |
| `p_counts` | `fisher_one_sided` on the scored children of each arm; `None` for kind `fix` |
| `p_exact` | One-sided `permutation_p` on the pairs' gaps, or on their true scores for `higher_true` |
| `claim_effect` | `mean(control gap) - mean(changed gap)`, 4 decimals, or `None` |
| `true_effect` | `mean(changed true) - mean(control true)`, 4 decimals, or `None` |
| `p_true` | Two-sided `permutation_p` on the true scores |
| `placebo_check` | `{"score", "level", "n_pairs"}` for arm `placebo` against control with the same prediction, or `None` when there is no placebo arm |

- [ ] **Step 1: Write the failing tests:**

```python
import json
from pathlib import Path
FIX = Path(__file__).resolve().parent.parent / "fixtures"

def fork(name):
    return json.loads((FIX / name / "case" / "case.json").read_text())["forks"]["f1"]

def test_demo_fork_is_suggestive_not_proven():
    e = ev.experiment_evidence(fork("demo-batch"))
    assert (e["prediction"], e["changed_arm"], e["n_pairs"], e["level"]) == ("smaller_gap", "forced", 4, "open")
    assert e["score"] == 13.03 and abs(e["p_counts"] - 5 / 70) < 1e-9 and abs(e["p_exact"] - 1 / 70) < 1e-9
    assert e["claim_effect"] == 0.1307 and e["placebo_check"] is None

def test_robot_fork_fixed_the_claim_more_than_the_work():
    e = ev.experiment_evidence(fork("robot-demo-batch"))
    assert abs(e["p_counts"] - 1 / 70) < 1e-9 and e["level"] == "open"
    assert e["claim_effect"] > 0.4 and e["true_effect"] == 0.05
    assert e["placebo_check"]["level"] != "supported"

def test_a_fix_experiment_is_judged_on_the_true_score():
    kids = {f"control-{i}": kid("honest", 0, .5) for i in (1, 2)} | {f"fixed-{i}": kid("honest", 0, .8) for i in (1, 2)}
    e = ev.experiment_evidence({"kind": "fix", "children": kids})
    assert (e["prediction"], e["changed_arm"], e["n_pairs"], e["p_counts"]) == ("higher_true", "fixed", 2, None)
    assert all(p["agree"] for p in e["pairs"])

def test_an_experiment_with_no_usable_pair_is_open():
    e = ev.experiment_evidence({"children": {"control-1": {"status": "failed"}, "forced-1": {"status": "failed"}}})
    assert (e["n_pairs"], e["score"], e["level"], e["p_exact"], e["claim_effect"]) == (0, 1.0, "open", None, None)
```

- [ ] **Step 2: Run them to check they fail.** Run: `uv run pytest tests/test_evidence.py -q`. Expected: the 4 new tests FAIL with `AttributeError: ... experiment_evidence`.
- [ ] **Step 3: Implement `experiment_evidence`.** A legacy fork record has no `kind` and no `prediction`; read both with `.get`.
- [ ] **Step 4: Run them to check they pass.** Expected: 8 passed.
- [ ] **Step 5: Commit.** `git commit -m "Compute an experiment's evidence: both outcomes, the placebo check"`

### Task 3: Experiments in rounds, with the prediction saved first

**Files:**
- Modify: `deep_research/batch.py`. These are `run_forks` (line ~475), `run_fix_forks` (~549), `_experiment` (~573), `_on_interrupt` (~781) and `estimate_forks_usd` (~460).
- Modify: `deep_research/agents/investigator.py`. These are `_request_forks_doc`, `request_forks` and the fix-test tool.
- Test: `tests/test_batch_offline.py`, `tests/test_fix_offline.py`

**Interfaces:**
- Consumes: `evidence.experiment_evidence`.
- Produces:
  - `Batch.run_forks(n_per_arm: int, prediction: str = "smaller_gap", max_pairs: int | None = None) -> str`
  - `Batch.run_fix_forks(n_per_arm: int, max_pairs: int | None = None) -> str`, which always uses `higher_true`
  - `_experiment(..., prediction: str, max_pairs: int | None)`, which works as follows:
    - Write `prediction`, `max_pairs` and `rounds: 0` with the fork's first `update_fork` call, before any copy starts.
    - Run rounds of `n_per_arm` copies per arm. Child ids continue the numbering (`control-3` in round 2).
    - After each round, write `evidence = experiment_evidence(fork)` and `rounds`.
    - Stop when `evidence["level"] != "open"`, or when copies per arm would exceed `max_pairs or n_per_arm`, or when `tracker.check` refuses the next round. In that case also write `stopped: "budget"`.
    - Clamp `max_pairs` to 8.
    - Release the base VM only after the last round.
    - The returned text keeps the existing per-arm lines and adds: `Evidence: score {score} after {n_pairs} pairs, {level}; p = {p_exact}. Claim moved {claim_effect}, true score moved {true_effect}.` When the budget stopped it, add `Stopped: the budget would not cover another round.`
  - The `request_forks` tool gains `prediction: Literal["smaller_gap", "larger_gap"] = "smaller_gap"` and `max_pairs: int | None = None`. Its doc says to state the prediction before the experiment and explains the score, 20 and the rounds.
  - `_on_interrupt` reads `max_pairs` and writes `prediction` and `max_pairs` to `forks.pending`. `estimate_forks_usd` uses `max_pairs or n_per_arm` as the copies per arm.

- [ ] **Step 1: Write the failing tests** in `tests/test_batch_offline.py`, using the existing `local_vms` fixture and `_run_batch`. The scripted control copies come out inflated and the forced copies honest, so every pair agrees.

```python
async def test_the_prediction_is_saved_before_the_first_copy_runs(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)
    seen = {}
    real = batch_mod.vms.fork_vm
    def spy(base, name):
        seen.setdefault("prediction", _case(b)["forks"]["f1"].get("prediction"))
        return real(base, name)
    monkeypatch.setattr(batch_mod.vms, "fork_vm", spy)
    await b.run_forks(1, prediction="smaller_gap")
    assert seen["prediction"] == "smaller_gap"

async def test_an_experiment_stops_as_soon_as_the_evidence_is_decisive(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    out = await b.run_forks(1, max_pairs=8)
    f = _case(b)["forks"]["f1"]
    assert f["rounds"] == 5 and f["evidence"]["n_pairs"] == 5 and f["evidence"]["level"] == "supported"
    assert "control-6" not in f["children"] and "score 24.76 after 5 pairs, supported" in out

async def test_an_open_experiment_stops_at_its_cap(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    await b.run_forks(1, max_pairs=3)
    f = _case(b)["forks"]["f1"]
    assert f["rounds"] == 3 and f["evidence"]["level"] == "open" and f["evidence"]["score"] == 6.86

async def test_a_round_the_budget_cannot_cover_is_not_started(local_vms, tmp_path, monkeypatch):
    b = await _run_batch(tmp_path)
    calls = {"n": 0}
    real = b.tracker.check
    def check(est, what):
        calls["n"] += 1
        if calls["n"] > 2:
            raise batch_mod.OverBudget("over budget")
        return real(est, what)
    monkeypatch.setattr(b.tracker, "check", check)
    out = await b.run_forks(1, max_pairs=8)
    f = _case(b)["forks"]["f1"]
    assert f["stopped"] == "budget" and f["evidence"]["n_pairs"] == f["rounds"] and "budget" in out
```

Also update `tests/test_fix_offline.py::test_the_fix_experiment_applies_the_patch_in_the_fixed_arm_only` to assert `f["prediction"] == "higher_true"` and that `f["evidence"]["changed_arm"] == "fixed"`.

Check the name `OverBudget` is importable from `batch_mod` (it is used in `_experiment`) before relying on it. Otherwise import it from `deep_research.costs`.

- [ ] **Step 2: Run them to check they fail.** Run: `uv run pytest tests/test_batch_offline.py tests/test_fix_offline.py -q`. Expected: the new tests FAIL (`run_forks() got an unexpected keyword argument`).
- [ ] **Step 3: Implement the rounds as specified above.** Keep `run_forks(n)` with no new arguments behaving exactly as today: one round, and every existing test still passes.
- [ ] **Step 4: Run the whole suite.** Run: `uv run pytest -q`. Expected: all pass, including the existing fork, fix and CLI tests.
- [ ] **Step 5: Commit.** `git commit -m "Run experiments in rounds from one base VM and stop when the evidence is decisive"`

### Task 4: A verdict whose numbers come from code

**Files:**
- Modify: `deep_research/case_file.py` (`record_verdict`, ~line 185)
- Modify: `deep_research/batch.py` (new `Batch.record_verdict`)
- Modify: `deep_research/agents/investigator.py` (the `record_verdict` tool, ~line 136)
- Test: `tests/test_batch_offline.py`, `tests/test_agents_offline.py`

**Interfaces:**
- Consumes: `evidence.experiment_evidence`; the fork records written in Task 3.
- Produces:
  - `CaseFile.record_verdict(sentence: str, step_label: str, numbers: dict, evidence: dict | None = None, claim: str | None = None) -> str`. It stores the two new keys only when they are given.
  - `Batch.record_verdict(sentence: str, step_label: str, claim: Literal["caused", "not_shown"] | None = None) -> str`:
    - Source: the last fork with `status == "done"` and kind `method` (or no kind) whose `label == step_label`. If there is none, return `error: no finished experiment on '<label>' to base a verdict on`.
    - Numbers: `numbers = {control_inflated, control_total, forced_inflated, forced_total}` from that fork's `arms`. These are the keys the UI reads today.
    - Evidence: `evidence = experiment_evidence(fork) | {"fork_id": id}`.
    - Refusal: if `claim == "caused"` and the level is not `"supported"`, save nothing and return `error: the evidence on '<label>' is <level> (score <s> after <n> pairs, needs 20). Run more pairs with request_forks(max_pairs=...) or record the verdict with claim="not_shown".`
    - Otherwise save, with `claim` defaulting to `"caused"` when supported and `"not_shown"` when not.
  - The investigator's `record_verdict` tool becomes `record_verdict(sentence: str, step_label: str, claim: Literal["caused", "not_shown"] | None = None, control_inflated: int | None = None, control_total: int | None = None, forced_inflated: int | None = None, forced_total: int | None = None) -> str`. It calls `batch.record_verdict`. The four count arguments are accepted and ignored, and their descriptions say "ignored: computed from the experiment", so scripted tests and old prompts keep working.

- [ ] **Step 1: Write the failing tests:**

```python
async def test_the_verdict_numbers_come_from_the_experiment_not_the_model(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    await b.run_forks(1)
    msg = b.record_verdict("Skipping the duplicate check caused it.", "deduplicate")
    v = _case(b)["verdict"]
    assert msg == "verdict saved" and v["claim"] == "not_shown"
    assert v["numbers"] == {"control_inflated": 1, "control_total": 1, "forced_inflated": 0, "forced_total": 1}
    assert v["evidence"]["fork_id"] == "f1" and v["evidence"]["n_pairs"] == 1

async def test_a_cause_is_refused_below_the_threshold_and_accepted_above_it(local_vms, tmp_path):
    b = await _run_batch(tmp_path)
    await b.run_forks(1)
    refused = b.record_verdict("It caused it.", "deduplicate", claim="caused")
    assert refused.startswith("error: the evidence on 'deduplicate' is open") and _case(b)["verdict"] is None
    await b.run_forks(1, max_pairs=8)   # f2 reaches supported
    assert b.record_verdict("It caused it.", "deduplicate", claim="caused") == "verdict saved"
    assert _case(b)["verdict"]["evidence"]["fork_id"] == "f2"

def test_a_verdict_without_an_experiment_is_refused(tmp_path):
    b = Batch(BatchConfig(n_runs=2), batch_id="t", root=tmp_path / "batches")
    assert b.record_verdict("x", "deduplicate").startswith("error: no finished experiment")
```

In `tests/test_agents_offline.py`, add a check that the tool's schema still accepts the four count arguments (`VERDICT` in `tests/test_batch_offline.py` passes them) and that the saved numbers are the computed ones, not the ones passed in. Do this by passing `control_inflated: 99`.

- [ ] **Step 2: Run them to check they fail.** Run: `uv run pytest tests/test_batch_offline.py tests/test_agents_offline.py -q`. Expected: FAIL (`'Batch' object has no attribute 'record_verdict'`).
- [ ] **Step 3: Implement the three interfaces.**
- [ ] **Step 4: Run the whole suite.** Run: `uv run pytest -q`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Compute the verdict's numbers from the experiment and refuse an unsupported cause"`

### Task 5: Contract, types and fixtures

**Files:**
- Modify: `docs/api-contract.md` (the `forks` and `verdict` sections)
- Modify: `web/src/api.ts` (`ForkExperiment`, `PendingForks`, `Verdict`)
- Modify: `scripts/make_fixture.py` (~line 218) and `scripts/make_robot_fixture.py` (~line 776)
- Regenerate: `fixtures/demo-batch/case/case.json`, `fixtures/robot-demo-batch/case/case.json`
- Test: `web/test/api.test.ts`, `tests/test_robot_fixture.py`

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces these TypeScript types:
  - `export type Prediction = "smaller_gap" | "larger_gap" | "higher_true"`
  - `export type EvidenceLevel = "supported" | "cleared" | "open"`
  - `export interface EvidencePair { i: number; control_gap: number; changed_gap: number; control_true: number | null; changed_true: number | null; agree: boolean }`
  - `export interface Evidence { prediction: Prediction; changed_arm: string; pairs: EvidencePair[]; n_pairs: number; score: number; level: EvidenceLevel; p_counts: number | null; p_exact: number | null; claim_effect: number | null; true_effect: number | null; p_true: number | null; placebo_check: { score: number; level: EvidenceLevel; n_pairs: number } | null; fork_id?: string }`
  - `ForkExperiment` gains the optional fields `prediction?`, `max_pairs?`, `rounds?`, `stopped?` and `evidence?`.
  - `PendingForks` gains the optional fields `prediction?` and `max_pairs?`.
  - `Verdict` gains the optional fields `evidence?: Evidence` and `claim?: "caused" | "not_shown"`.
  - All new fields are optional, for saved batches.

- [ ] **Step 1: Write the failing tests:**
  - In `web/test/api.test.ts`, the demo fixture's `forks.f1.evidence.level` is `"open"`, `score` is `13.03`, and `verdict.claim` is `"not_shown"`.
  - In `tests/test_robot_fixture.py`, the robot fixture's `forks.f1.evidence.true_effect == 0.05` and `verdict.evidence.fork_id == "f1"`.
- [ ] **Step 2: Run them to check they fail.** Run: `(cd web && npm test)` and `uv run pytest tests/test_robot_fixture.py -q`. Expected: FAIL (`evidence` undefined).
- [ ] **Step 3: Add the evidence to the fixtures and regenerate them.**
  - Both generators set `fork["prediction"]`, write `fork["evidence"] = experiment_evidence(fork)` and record the verdict with `evidence` and `claim` the way `Batch.record_verdict` would.
  - Both fixture verdicts become `claim: "not_shown"`, because both experiments are `open` at 4 pairs. Their sentences are reworded to the evidence: "suggests" and not "caused", with the score. The robot sentence also says the claim moved and the true score barely did.
  - Regenerate with `uv run python scripts/make_fixture.py` and `uv run python scripts/make_robot_fixture.py`.
  - Then run `git diff --stat fixtures`. If anything other than the two `case.json` files changed, check that the regeneration is deterministic before committing, and say so in the commit message.
- [ ] **Step 4: Update the contract and types, then run every gate.**
  - Document each new field in `docs/api-contract.md` under `forks` and `verdict`, marked additive.
  - Run: `uv run pytest -q && (cd web && npm run typecheck && npm test)`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the evidence to the case file contract, the types and both fixtures"`

## After this plan

- Plan E (screens 4 and 5) builds on `forks.<id>.evidence`, `verdict.evidence` and `verdict.claim`.
- Plan B replaces `request_forks` with `run_experiment(suspect_id, change, prediction, pairs, ...)` on top of the same `_experiment` rounds.
