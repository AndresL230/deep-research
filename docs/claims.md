# Orro: claims and what backs them

Every result claim made by the README, the landing page (`web/src/landing/`) and the How it works page
(`web/src/batch/how.ts`), with the file or batch that backs it. Checked Sun Nov 15, around 00:15 Eastern, against the
committed fixtures. There is no separate pitch file in the repo. The README's "Two-minute demo narrative" is the pitch.

Status values:

- **backed**: the number or fact is in the cited file.
- **rule**: backed, but the words depend on the evidence rule. This PR replaces the Fisher rule ("8 pairs and p < 0.05")
  with the plan 6.4 running score. The score starts at 1 and is multiplied by 1.9 for each control/forced pair that
  agrees and by 0.1 for each pair that does not. `supported` needs a score of 20 or more, which takes at least 5
  agreeing pairs. `cleared` needs at least 5 pairs and a score under 1. Anything else is `open`. Since the
  control-must-reproduce fix (Sun Nov 15, 04:20 Eastern), a pair counts only when its control copy reproduces the
  effect under test (inflated for `smaller_gap`, honest for `larger_gap`); an experiment with no such pair is
  `inconclusive`, never cleared. Recorded fixtures keep the levels they saved.
- **simulated**: backed by a simulated fixture (`config.simulated = true`), not by a real run.
- **wrong**: the cited file contradicts the claim.
- **UNBACKED**: no file or batch backs it.

`LIVE` is `fixtures/robot-live-investigation/case/case.json`, the recording of the real batch `1114-103920-eb72`
(`config.recording.kind = "live"`). `TAB` is `fixtures/tabular-live-investigation/case/case.json`, the recording of
the real tabular batch `1115-012104-800f` (`config.recording.kind = "live"`, not simulated). `TT` is
`fixtures/tabular-time-travel-investigation/case/case.json`, the recording of the real checkpoint-mode batch
`1115-033734-e892` (`kind = "live"`, not simulated; its rows were added Sun Nov 15 around 03:50 Eastern, checked
against `TT` itself). `DEMO` is
`fixtures/demo-batch/case/case.json` (simulated). The `TAB` rows were added Sun Nov 15 around 01:40 Eastern, checked
against `TAB` itself.

## README: "What we ran for real" (tabular, batch `1115-012104-800f`)

| Claim | Backing | Status |
| --- | --- | --- |
| A recording of a real run, nothing simulated or edited by hand | `TAB` `config.recording` (`kind: live`, `source_batch: 1115-012104-800f`); no `config.simulated`. Left out of the fixture: the holdout labels and `checkpoints.sqlite` (`config.recording.excluded`) | backed |
| 12 analysts on Claude Haiku, the investigator on Claude Sonnet | `TAB` `config.n_runs = 12`, `analyst_model = anthropic:claude-haiku-5-5`, every `runs.*.model` Haiku; `investigator_model = anthropic:claude-sonnet-5-5` | backed |
| Pima table, duplicates trap with near-duplicates: strength 0.5, noise 0.05, hidden share 0.8 | `TAB` `config.dataset = pima`, `trap = duplicates`, `trap_strength 0.5`, `trap_noise 0.05`, `trap_hidden_share 0.8`. `task/meta.json`: 921 rows given, 307 planted copies, `bmi` and `diabetes_pedigree` jittered | backed |
| Spend $0.49 of a $1.50 budget | `TAB` `costs.spent_usd = 0.4859`, `budget_usd = 1.5` | backed |
| All 12 runs inflated: reported 90.2 to 91.9%, measured 77.3 to 81.8% on 154 hidden rows | `TAB` `runs.*.status` all `inflated`; `reported_accuracy` 0.9017 to 0.9191, `true_accuracy` 0.7727 to 0.8182 (means 0.910 and 0.795), gaps 0.0899 to 0.1464; `n_hidden = 154` | backed |
| No honest run, so no split; the investigator started from the runs alone | `TAB` `split = null`, `config.investigator_assist = none`, `candidates = []` | backed |
| Three suspects: `deduplicate_near` (s1), exact `deduplicate` (s2), `evaluate` (s3) | `TAB` `suspects` s1 to s3, all `proposed_by: investigator` | backed |
| s1: forcing near-duplicate removal on r01, 5 pairs, all 5 agree, score 24.76, **supported** | `TAB` `forks.f1`: `change force_step:deduplicate_near`, `source_run r01`, `fork_at 3`, `pairs` 5 with `agree` true, `score 24.761` (1.9^5), `level supported`, `p_exact 0.004` (shown only). `evidence.s1` the same | backed |
| The prediction was registered before any copy ran | `TAB` `forks.f1.prediction = smaller_gap`, `forks.f1.preregistered_at` | backed |
| Control copies' gaps +10.3 to +12.8 pts; changed copies' −2.3 to −6.1 pts | `TAB` `forks.f1.pairs[*].control_gap` 0.103 to 0.1283, `changed_gap` −0.0231 to −0.0605 | backed |
| 5 of 5 control copies inflated, 0 of 5 forced | `TAB` `forks.f1.arms` | backed |
| The forced copies reported honestly, not better: mean measured 79.1% (control) and 79.4% (forced) | `TAB` `forks.f1.arms.control.mean_true = 0.7909`, `forced.mean_true = 0.7935`; reported 0.9075 against 0.7414 | backed |
| s2: forcing exact `deduplicate` on r08, 5 pairs, 1 agrees, score 0.0002, **cleared** | `TAB` `forks.f2`: `change force_step:deduplicate`, `source_run r08`, `score 0.00019`, `level cleared`, `p_exact 0.6746`; arms 4 of 5 inflated in both. Under today's rule its control-2 (gap 0.0792, just under the 0.08 threshold) did not reproduce the inflation, so 4 pairs count and it would read **open**, not cleared. The recording keeps `cleared` as saved; do not cite it as a clearing | rule (recorded cleared; open by today's rule) |
| s3 (`evaluate`) was not tested and stays open | `TAB` `suspects.s3.status = proposed`, `verdict.open = [s3]`, no fork with `suspect_id s3` | backed |
| The verdict says "caused", confidence medium | `TAB` `verdict.sentence` ("Skipping deduplicate_near caused the inflated claims…"), `verdict.evidence.level = supported` at 24.76, `confidence = medium` | backed (the score is over 20) |
| The rubric grader sent the verdict back before passing it | `TAB` `rubric`: needs_revision (wrong `inflated_rate`, f2's arm counts missing), needs_revision (rates still wrong), satisfied. Sent back **twice**; the third version passed | backed |
| All 20 copies were rebuilt by replay because Daytona refused VM forks | `TAB` `forks.f1.built` and `forks.f2.built` = `{fork: 0, replay: 10}` | backed |
| The investigator works blind | `TAB` `config.investigator_assist = none`, `split = null`, the saved view `case/view/case.json` passes `scripts/check_invariants.py`. It could still read the general skill and `list_changes`, which name every trap's fix (`docs/PLAN_STATUS.md`, open items) | partly backed |

## README: "What we ran for real" (time travel, batch `1115-033734-e892`)

| Claim | Backing | Status |
| --- | --- | --- |
| A recording of a real run, nothing simulated or edited by hand | `TT` `config.recording` (`kind: live`, `source_batch: 1115-033734-e892`); no `config.simulated`. Left out: the holdout labels and `checkpoints.sqlite` (`config.recording.excluded`) | backed |
| 12 Haiku analysts, a Sonnet investigator, blind | `TT` `config.n_runs = 12`, `analyst_model = anthropic:claude-haiku-5-5`, `investigator_model = anthropic:claude-sonnet-5-5`, `investigator_assist = none`, `split = null` | backed |
| Same trap as `TAB`: Pima, near-duplicates, strength 0.5, noise 0.05, hidden share 0.8, 154 hidden rows | `TT` `config.trap = duplicates`, `trap_strength 0.5`, `trap_noise 0.05`, `trap_hidden_share 0.8`; `runs.*.n_hidden = 154`; `task/meta.json` 921 rows given, 307 planted copies | backed |
| Spend $0.93 of $1.20, $0.80 of it the investigator | `TT` `costs.spent_usd = 0.9272`, `config.budget_usd = 1.2`, `costs.scopes.investigator.total_usd = 0.802` | backed |
| All 12 inflated: reported 90.2 to 91.3%, measured 77.9 to 81.8% | `TT` `runs.*.status` all `inflated`; `reported_accuracy` 0.9017 to 0.9133, `true_accuracy` 0.7792 to 0.8182, gaps 0.0899 to 0.1283 | backed |
| **The investigator uses its plan and subagents** | `TT` `investigator.todos` (5 items, written by `write_todos`), `investigator.subagent_calls` = `step-tagger` 4, `lens-omission` 1, `lens-commission` 1, `lens-data` 1, `skeptic` 1. `investigator/events.jsonl`: the four step-taggers and three lenses are `task` calls in one turn (same `t`), the skeptic after `record_suspects`. Also seen in `1115-031408-167d` (local) | backed |
| Three suspects: s1 `deduplicate_near` (from `lens-omission` and `lens-data`), s2 `deduplicate`, s3 `group_split` | `TT` `suspects` s1 to s3 with `proposed_by` | backed |
| **Time travel supported a cause on real runs** | `TT` `forks.f2`: `fork_mode checkpoint`, `restore.agent_state = checkpoint`, `checkpoint_id 1f1e0cfd-4064-6626-8007-7556caa4526e` from thread `1115-033734-e892-r01`, `fork_mode_fallback null`; `force_step:deduplicate_near`, 5 pairs kept of 6, all agree, `score 24.761`, `p_exact 0.004`, `level supported`; arms control 6 of 6 inflated, forced 0 of 5 | backed |
| Time travel cleared a wrong suspect on real runs | `TT` `forks.f3`: checkpoint `1f1e0cfd-2422-6a0c-8007-7831de4126af` from r12, `force_step:deduplicate`, 5 pairs, 2 agree, `score 0.00361`, `level cleared`; 5 of 5 inflated in both arms | backed |
| f1 stayed open: 2 of 5 pairs kept, score 3.61 | `TT` `forks.f1.pairs` (2), `dropped_pairs` (3: forced copies with a missing or invalid `report.json`), `score 3.61`, `level open` | backed |
| Only the agent's state came from the checkpoint; the VM was rebuilt by replay | `TT` `forks.*.restore.vm = replay`, `forks.*.built.fork = 0` | backed |
| **The change-held check drops pairs whose copy undid the change** | Code and tests: `forks.step_held`, `evidence.pair_up`; `tests/test_adherence.py` (a scripted copy that restores the data is dropped; on this machine every `1115-025003-ef94` f3 forced copy reads as not held). On `TT` the check ran on real copies and found none that undid it: `forks.f1.adherence` held_verified 2, `f2` 5, `f3` 5, `undid_change` 0 in all three | backed (the drop itself is shown offline and on ef94's saved copies; `TT` had nothing to drop) |
| **A pending approval survives a restart** | `tests/test_investigator_science.py::test_a_pending_experiment_survives_a_restart` and `::test_two_requests_in_one_turn_survive_a_restart_and_a_lost_pending_entry` (commit `652a656`). The second case is the bug that stopped `1115-031408-167d` ("Number of human decisions (1) does not match number of hanging tool calls (2)"). `TT` itself had no restart: each of its three experiments was approved and resumed in the same server | backed offline |
| The verdict says "caused", confidence medium, after the grader sent it back twice | `TT` `verdict.sentence`, `verdict.confidence = medium`, `verdict.supported = [s1]`, `cleared = [s2]`, `open = [s3]`; `rubric`: needs_revision, needs_revision, satisfied | backed |
| The footer's "Tabular replay" opens this recording | `web/src/landing/landing.ts` `LANDING.tabular = "tabular-time-travel-investigation"`; `web/test/landing.test.ts` | backed |

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

Rewritten Sun Nov 15 around 04:15 Eastern. The page no longer draws from the simulated `DEMO`. Every robot arm number
comes from `LIVE` (`fixtures/robot-live-investigation`), the terminal's title says "recorded run", and the rule the
page states is the 6.4 running score.

| Claim | Backing | Status |
| --- | --- | --- |
| Pill: "One agent claimed 100%. We measured 65%." | `LIVE` `runs.r06`: reported 1.0, true 0.65 | backed |
| "5 of 12 agents in our recorded run claimed far more than we measured" | `LIVE` `runs.*.status`: 5 inflated, 3 honest, 2 unclear, 2 failed | backed |
| "3 of 3 honest agents tuned the controller before they reported. Only 2 of the 5 that overclaimed did" | `LIVE` `split`: `tune_params`, honest 3 of 3, inflated 2 of 5 | backed |
| The per-run claimed and measured numbers (`RUNS`) and the copies' gaps (`FORK`), with the line at 27.5 | `LIVE` `runs.*`, `forks.f1.children.*.gap`, `config.inflation_threshold` | backed |
| "Left alone, 4 of 4 copies still overclaimed; made to test the edges of the table, 0 of 4 did" | `LIVE` `forks.f1.arms` | backed |
| "In all four pairs, only the copy made to test the edges of the table stopped overclaiming. That puts the score at 13. Orro names a cause at 20" | `LIVE` `forks.f1.pairs` (4, all `agree`), `verdict.evidence.score 13.0321`, `needed_score 20` | backed |
| Terminal: "4 pairs · 4 as predicted · score 13.03", ticket "Verdict · open", "Score 13.03 of 20 · 4 of 4 pairs agree", verdict "Skipping the edge test suggests why" | `LIVE` `verdict.evidence`: `level open`, `score 13.0321`, `agree 4` | backed |
| "Every pair of copies moves a score... Only at 20 may the verdict say a step caused the gap" | `deep_research/evidence.py` | backed |
| "On our recorded tabular run it passed 20, and a second suspect was cleared" | `TT` (`fixtures/tabular-time-travel-investigation`): `suspects` s1 `supported`, s2 `cleared`; `forks.f2.score 24.761`, `verdict.evidence.score 89.39` | backed |
| "A second agent, never told the answer, names its suspects. Once you approve, Orro rebuilds one run as pairs of copies" | `agents/investigator.py` (`record_suspects`, `run_experiment` behind approval), `experiments.py`. In `LIVE` the approval came from a written policy, and the copies were rebuilt by replay | backed as a description of the code |
| The humanoid tab: "3 of 3 motions tracked with balance feedback. Plain playback fell at 3.9 s on two of them" | Printed in the video (`web/public/media/humanoid-tracking.mp4`). Not a batch, and it has no replay | backed by the video only |
| The agent's controller is run at 20 positions it never saw | `sim/hidden.py`, `LIVE` `runs.*.n_hidden` | backed |

## How it works page (`web/src/batch/how.ts`)

| Claim | Backing | Status |
| --- | --- | --- |
| "Every number and picture below comes from a real batch" | Before this PR the page drew from `robot-demo-batch`, which is simulated. This PR points `HOW_BATCH` at `robot-live-investigation`, so the claim now holds | backed (after this PR) |
| "Each run is one LangChain Deep Agent on Claude Haiku 5.5; a robot batch can alternate it with Sonnet 5.5" | `config.py` (Haiku 5.5 is the default analyst model), `domains/robot_arm.py` (the robot domain alternates). In the real recording every analyst was Haiku | backed |
| "To copy a run, the server rebuilds it on a fresh VM by replaying its actions up to the cut, then copies that VM once for each copy; a copy that cannot be made that way is rebuilt by replay as well" | `batch.py` (the base VM, then a fork of it per copy, replay when a fork fails). Every real copy so far was a replay (`LIVE` `forks.f1.built`) | backed, with the fallback being what actually ran |
| Stop 3, "3 suspects", named "Testing the table edges", "Tuning the controller", "A defect in run r06's code", the first one tested | `LIVE` `hypotheses` h1, h2, h3; `forks.f1.hypothesis_id = h1` | backed |
| Stop 4, four pairs of copies of r06: left alone +35.0 pts each, changed 0, 0, +8.5 and +10.0 pts, all four "as predicted" | `LIVE` `forks.f1.pairs` and the `control-*` and `forced-*` children | backed |
| Stop 5, "Score: 1 x 1.9 x 1.9 x 1.9 x 1.9 = 13.03", "13.03 of 20", open | `LIVE` `verdict.evidence`: `rule running_score`, `score 13.0321`, `needed_score 20`, `level open` | backed |
| "Each pair that goes the predicted way multiplies a score by 1.9, and each one that does not by 0.1. At 20 the verdict may name a cause; a suspect still under 1 after five pairs is cleared" | `deep_research/evidence.py`, `web/src/batch/evidence.ts` | backed |
| The investigator's helpers: a step tagger, three lenses, a skeptic, and a code tracer where there is code to trace | `deep_research/agents/investigator.py`. The real robot recording predates the lenses and the skeptic: its investigator panel lists calls to the code tracer and the general-purpose helper only | backed as a description of the code, not of the batch the page shows |
| The last stop's moving dots | Drawn from `LIVE`: one dot per run in the colour of its status, sparks in proportion to each inflated run's gap, and r06 splitting into its four scored pairs (`web/src/batch/how-fx.ts`) | backed |

## Not claimed anywhere, and not run

- **Same versus same** (plan 8.3): run once, on local batch `1115-010055-bfc9` (tabular, 12 honest runs, $0.09).
  Control against control from r01: 3 pairs, score 0.019, **open**, so it did not reach 20. A harmless change
  (`edit_context`, "this machine's clock is set to UTC") on the same run: 5 pairs, score 0.0002, **cleared**. That batch
  is not committed (`batches/` is gitignored) and is backed by this file and `docs/PLAN_STATUS.md` only. **UNBACKED** by
  a committed fixture.
- **One real batch is `supported` under the new rule: `1115-012104-800f`** (`TAB`, above). Before it, none was. The old
  Fisher rule called local batch `1114-032554-c05a`
  supported: control 4 of 8 inflated against forced 0 of 8, p = 0.0385, after one round of more pairs. Paired by
  copy number on the gaps, 6 of its 8 pairs agree and 2 are exact ties (both copies honest at the same gap), which
  count as disagreeing: score 1.9^6 × 0.1^2 = 0.47, so the new rule reads it `cleared`. Its stored sentence ("caused")
  is unchanged and now reads as an overclaim. That batch is local only (`batches/` is gitignored) and none of the docs
  above claim it. `1114-034546-6c7a` (4 of 4 against 0 of 4, saved "caused") stays `open` at 13.03.
- **Adherence check** (Sun Nov 15, 03:30 Eastern): a pair now counts only when its changed copy kept the change.
  Plain code checks each changed copy's final train.csv and later commands (`forks.step_held`); a copy that undid
  the change drops its pair with "the copy undid the change", and the level comes from the held pairs only
  (`docs/PLAN_STATUS.md`, "Adherence check"). **`1115-025003-ef94` f3 is invalid evidence:** it reads `cleared`
  (score 0.00019) for `deduplicate_near` in checkpoint mode, but all 5 forced copies restored the original data
  (`cp data_before_dedup.csv data.csv`) right after the step. Nothing above claims it, and nothing may. Under the
  check its 5 pairs would all be dropped. The `TAB` result (`1115-012104-800f` f1, messages mode) is unaffected: all 5
  forced copies read as held.

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

### The tabular replay (the landing's "Demo replay")

`#/b/tabular-live-investigation` (`TAB`, batch `1115-012104-800f`) needs no meshes. It was the first real batch to end
`supported` (`TT`, `1115-033734-e892`, is the second, in checkpoint mode):

1. **The claim.** All 12 runs reported 90 to 92% and measured 77 to 82% on 154 hidden rows. No run was honest, so there
   is no split.
2. **The suspects.** The investigator, blind, named three: near-duplicates (s1), exact duplicates (s2), tuning on the
   test set (s3).
3. **The experiments.** f1 (s1): 5 of 5 pairs agree, score 24.76, supported; the gaps fall from +10 to +13 points to
   −2 to −6. f2 (s2): 1 of 5 agree, score 0.0002, cleared. s3 stays open.
4. **The verdict.** "Caused", confidence medium. The rubric sent it back twice first.
