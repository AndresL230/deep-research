# Orro: claims and what backs them

Every result claim made by the README, the landing page (`web/src/landing/`) and the How it works page
(`web/src/batch/how.ts`), with the file or batch that backs it. Checked Sun Nov 15, around 00:15 Eastern, against the
committed fixtures. There is no separate pitch file in the repo. The README's "Two-minute demo narrative" is the pitch.

Status values:

- **backed**: the number or fact is in the cited file.
- **rule**: backed, but the words depend on the evidence rule. This PR replaces the Fisher rule ("8 pairs and p < 0.05")
  with the plan 6.4 running score. The score starts at 1 and is multiplied by 1.9 for each control/forced pair that
  agrees and by 0.1 for each pair that does not. `supported` needs a score of 20 or more, which takes at least 5
  agreeing pairs. `cleared` needs at least 5 pairs and a score under 1. Anything else is `open`.
- **simulated**: backed by a simulated fixture (`config.simulated = true`), not by a real run.
- **wrong**: the cited file contradicts the claim.
- **UNBACKED**: no file or batch backs it.

`LIVE` is `fixtures/robot-live-investigation/case/case.json`, the recording of the real batch `1114-103920-eb72`
(`config.recording.kind = "live"`). `DEMO` is `fixtures/demo-batch/case/case.json` (simulated).

## README: "What a real run found" and the two-minute narrative

| Claim | Backing | Status |
| --- | --- | --- |
| The fixture is a recording of a real run, with nothing scripted or edited by hand | `LIVE` `config.recording` (`kind: live`, `source_batch: 1114-103920-eb72`). It also notes the rescoring and the second session done after the run | backed |
| Twelve agents | `LIVE` `config.n_runs = 12`, 12 entries in `runs` | backed |
| The agents were "Claude Haiku and Sonnet" | `LIVE` `config.analyst_model = anthropic:claude-haiku-5-5`. Every run's `messages.json` that names a model names Haiku. Sonnet is only `config.investigator_model` | **wrong** at audit time: the analysts were all Haiku, and Sonnet was the investigator. Fixed in the README by this PR |
| 20 hidden can positions | `LIVE` runs `n_hidden = 20`, `sim/hidden.py` `hidden_positions(n=20)`, `sim/CALIBRATION.md` | backed |
| Total spend $2.50 | `LIVE` `costs.spent_usd = 2.499` | backed |
| r06 reported 100% over 37 episodes, 13 of them at random layouts | `LIVE` `runs.r06.reported_accuracy = 1.0`. `fixtures/robot-live-investigation/runs/r06/actions.json` report: `episodes_run: 37`, "13 at other random can/zone layouts" | backed |
| r06 measured 65% | `LIVE` `runs.r06.true_accuracy = 0.65` | backed |
| 5 inflated, 3 honest, 2 unclear, 2 failed | `LIVE` `runs.*.status` | backed |
| Three hypotheses, each with a prediction and a falsification condition; h1 was tested | `LIVE` `hypotheses` h1 to h3, each with `prediction` and `falsified_if`. `forks.f1.hypothesis_id = h1` | backed |
| The prediction was registered before any copy ran | `LIVE` `forks.f1.preregistered_at` | backed |
| Forced copies ran 10 edge positions kept away from the hidden set | `LIVE` `forks.f1.arm_steps.forced`. `sim/domain.py:1532` draws them at least `MIN_FROM_HIDDEN` (3 cm) from every hidden position | backed |
| 0 of 4 forced inflated, against 4 of 4 for control, placebo and show | `LIVE` `forks.f1.arms` | backed |
| Fisher p = 0.014 | `LIVE` `forks.f1.evidence.p_value = 0.0143`. Kept for display only under the new rule | backed |
| "4 pairs of the 8 required", so inconclusive (README lines 176 and 370) | `LIVE` `forks.f1.evidence` was saved under the old rule (`needed_pairs: 8`). Under the 6.4 score, the 4 pairs all agree on the gap (control 0.35 against forced 0.0 to 0.1), so the score is 1.9^4 = 13.03, under 20: still **open** and inconclusive | **rule**: the outcome stands. The README now says "score of 13.0, under the 20 needed" |
| Method fork statistic: "`supported` needs ≥ 8 pairs and p < 0.05" (README line 108) | `deep_research/evidence.py` | **rule**: the README now states the running score |
| Four copies per arm can never reach `supported` | Old rule: 4 is under 8 pairs. New rule: the most 4 pairs can score is 13.03, under 20 | backed under both rules |
| Every forced copy rewrote its controller and measured 90 to 100%. Control copies measured 65% with the code unchanged | `LIVE` `forks.f1.children.forced-*.true_accuracy` 1.0, 1.0, 0.9, 0.9 (mean 0.95). Control copies are 0.65 | backed (the rewrite is in each forced copy's `actions.json`) |
| Forced copies' rewritten controllers measured 95% (narrative) | `LIVE` `forks.f1.arms.forced.mean_true = 0.95` | backed |
| The code fix took 65% to 25%, with 0 gained, 8 lost, sign test p = 0.004, worse | `LIVE` `fix.measured`: before 13/20, after 5/20, `gained 0`, `lost 8`, `evidence.p_value 0.0039`, `level worse` | backed |
| h3 is contradicted, and the fix verdict says the change is not shown to help | `LIVE` `fix.outcome = contradicted`, `fix.verdict` | backed |
| The investigator traced r06, r10 and r11 | `LIVE` `trace[*].run_id` | backed |
| The verdict says "suggests", confidence low | `LIVE` `verdict.sentence`, `verdict.confidence = low` | backed |
| The grader asked for revisions twice before passing it | `LIVE` `rubric`: the second session reads needs_revision, needs_revision, satisfied. The first session reads needs_revision, satisfied | backed (for the final session) |
| All 16 copies were rebuilt by replay because Daytona refused VM forks | `LIVE` `forks.f1.built = {fork: 0, replay: 16}` | backed |
| Ten copies were scored afterwards, with no agent involved | `LIVE` `forks.f1.rescored.copies` (10), with its `why` | backed |
| A second session wrote the verdict; the first is kept | `LIVE` `superseded_verdicts` (1), `sessions` | backed |
| The investigator works blind, and `tests/test_blind_investigator.py` checks every prompt, skill, view and file result it can reach | The test exists. The audit found `split`, `runs.*.overlap_share` and `runs/*/score.json` readable at `d3a23ab`. This PR closes the last two (see `docs/PLAN_STATUS.md`). `split` stays in the view | partly backed: the investigator still sees the plain-Python split |
| Diagnostic positions are kept at least 3 cm from every hidden position | `sim/domain.py:824-827`, `sim/hidden.py:41` | backed |

## Landing page (`web/src/landing/landing.ts`, `terminal.ts`)

The landing page draws every number from `DEMO`, which is simulated (`config.simulated = true`). The terminal titles say
"simulated". The pill, the tabs and the cards do not.

| Claim | Backing | Status |
| --- | --- | --- |
| "Inflated runs: 89% claimed, 75% real" (pill, and the terminal's "reported 89% · true 75%") | `DEMO` mean over the 6 inflated runs: reported 0.892, true 0.751 | **simulated**, and not labeled simulated where it is shown. It matches no real batch |
| 6 of 12 runs reported more than they scored on the holdout | `DEMO` `runs.*.status`: 6 inflated, 6 honest | simulated |
| 6 of 6 honest runs removed duplicates; none of the 6 inflated did | `DEMO` `split`: `deduplicate`, `honest_rate 1.0`, `inflated_rate 0.0` | simulated |
| 20% of the table is held out | `DEMO` `config.holdout_fraction = 0.2` | simulated |
| The per-run reported and holdout numbers (`RUNS`) and the fork gaps (`FORK`) | `DEMO` `runs.*`, `forks.f1.children.*.gap`, `config.inflation_threshold = 0.08` | simulated (r06 is 88.6 in the fixture and 88.7 on the page, r12 is 78.0 and 78.1: rounding) |
| Left alone, 3 of 4 copies stay inflated; made to deduplicate, 0 of 4 do | `DEMO` `forks.f1.arms` | simulated |
| Terminal verdict: "Skipping the duplicate check inflated the score" | `DEMO` `verdict.sentence` says "suggests". Its evidence is open: Fisher p = 5/70 on 4 pairs. The 6.4 score is 13.03 with 4 agreeing pairs, under 20 | **wrong**: a causal claim the fixture's own verdict does not make |
| "...then forks the VM to prove what went wrong" (lede) | Every real fork so far was rebuilt by replay (`LIVE` `forks.f1.built`). No real batch has reached `supported` under the new rule | **UNBACKED** as worded ("prove") |
| Robot chapter: copies "made to try 10 random positions. If those come out honest, that step was the cause." | `LIVE` `forks.f1.arm_steps.forced` backs the 10 positions. The live run's copies did come out honest, and the verdict is still open | **rule**: overclaims next to the real run |
| The agent's controller is run at 20 positions it never saw | `sim/hidden.py`, `LIVE` `runs.*.n_hidden` | backed |

## How it works page (`web/src/batch/how.ts`)

| Claim | Backing | Status |
| --- | --- | --- |
| "Every number and picture below comes from a real batch" | Before this PR the page drew from `robot-demo-batch`, which is simulated. This PR points `HOW_BATCH` at `robot-live-investigation`, so the claim now holds | backed (after this PR) |
| "Each run is one Deep Agent on Claude Haiku 5.5 or Sonnet 5.5, the models taking turns across the batch" | General description of the code. In the real recording every analyst was Haiku | backed as a description, but not true of the batch the page shows |
| "A fork is a copy on write of the VM... If a VM cannot be forked, the run's actions are replayed" | Every real copy so far was a replay (`LIVE` `forks.f1.built`) | backed, with the fallback being what actually ran |

## Not claimed anywhere, and not run

- **Same versus same** (plan 8.3): never run. Say so if asked.
- **No real batch is `supported` under the new rule.** The old Fisher rule called local batch `1114-032554-c05a`
  supported: control 4 of 8 inflated against forced 0 of 8, p = 0.0385, after one round of more pairs. Paired by
  copy number on the gaps, 6 of its 8 pairs agree and 2 are exact ties (both copies honest at the same gap), which
  count as disagreeing: score 1.9^6 × 0.1^2 = 0.47, so the new rule reads it `cleared`. Its stored sentence ("caused")
  is unchanged and now reads as an overclaim. That batch is local only (`batches/` is gitignored) and none of the docs
  above claim it. `1114-034546-6c7a` (4 of 4 against 0 of 4, saved "caused") stays `open` at 13.03.

## Demo path (2 minutes)

Play the experiment from the recording. Don't run it live: Daytona refuses VM forks, the last two real robot batches
failed 23 and 31 of their 36 runs, and 4 copies per arm can only end open.

1. Open `#/b/robot-live-investigation` on the deployed site, or locally at `http://localhost:5173/#/b/robot-live-investigation`.
   It is a fixture, so it needs no keys and no VMs. The How it works page (`#/how`) now draws from the same batch, and
   its "See a real batch" button opens it.
2. **The claim (0:00 to 0:20).** Open run r06: it reported 100%.
3. **The contradiction (0:20 to 0:45).** On the same run, the hidden positions show 65%. Replay a failed position in 3D.
4. **The investigation (0:45 to 1:10).** Show the investigator lane: three hypotheses with predictions, and h1 chosen.
5. **The experiment (1:10 to 1:40).** On the Fork page (f1): 0 of 4 forced copies inflated, against 4 of 4 for each
   other arm. The score is 13.0 of the 20 needed. Then the Fix page: 65% → 25%, worse.
6. **The verdict (1:40 to 2:00).** On the Verdict page the evidence is open, so the verdict says "suggests". Its limits
   are listed there.

Check the meshes and the hub on the deployed site before the slot. The 3D replay needs the motion files, which the
fixture ships, trimmed to 4 practice recordings per run.
