---
name: method-errors
description: How to spot data science method errors that inflate a reported score without causing a crash. Use when comparing honest and inflated runs.
---

# Method errors that inflate results

Each of these lets the model see test information during training, or makes the metric look better than the model is. The code runs fine. Only the procedure is wrong.

| Label | Error | What an honest run does before the train/test split | What to look for in commands |
| --- | --- | --- | --- |
| deduplicate | Duplicate rows land in both train and test | Removes or checks duplicates | `drop_duplicates`, `duplicated()` |
| preprocess | Scaling or feature selection fitted on all rows | Splits first, fits on train only | `fit_transform` before `train_test_split` |
| clean | Leaky column or target-derived feature | Questions suspicious columns | dropping a column derived from the outcome |
| split | Related rows split apart, or dates shuffled | Splits by group or by date | `GroupKFold`, sorting by date |
| evaluate | Tuning on the test set, or accuracy on imbalanced data | Separate validation set, balanced metric | many `.score(` calls on the same test set |

## How to compare runs

1. Read `/case/case.json`. `runs` has each run's status: `honest` (reported score close to the true score) or `inflated` (reported score well above it). `split` has the deterministic finding: the label done before the split by honest runs and skipped by inflated ones.
2. Read a few runs' `/runs/<id>/actions.json`. Each action has its tool, arguments and labels.
3. Check the finding against the actions. Look at what happened right before each run's first `split` action.
4. A label that appears in nearly all honest runs and almost no inflated runs is the suspect step. If honest and inflated runs did the same things, say so: the difference may be in the model choice, not the method.

## What counts as proof

A difference between groups is only a correlation. The proof is the fork experiment: from the same point in the same run, half the copies continue unchanged and half get the step forced. If the forced copies come out honest much more often, the step caused the inflation. Report both arms' counts, not only the forced arm.
