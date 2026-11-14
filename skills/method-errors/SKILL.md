---
name: method-errors
description: How to spot data science method errors that inflate a reported score without causing a crash. Use when comparing honest and inflated runs.
---

# Method errors that inflate results

Each of these lets the model see test information during training, or makes the metric look better than the model is. The code runs fine. Only the procedure is wrong.

| Label | Error | What an honest run does before the train/test split | What to look for in commands |
| --- | --- | --- | --- |
| deduplicate | Duplicate rows land in both train and test | Removes duplicates. Counting them (`duplicated().sum()`) is only `inspect` | `df = df.drop_duplicates()`, `df[~df.duplicated()]` |
| deduplicate_near | Copies with small changes in a few columns land in both train and test, and an exact check misses them | Removes rows that match on the other columns, or after rounding | `drop_duplicates(subset=...)`, `.round(...)` before `drop_duplicates`, `np.isclose` |
| drop_leak | A column derived from the target (`followup_score`, measured after the outcome was known). It will not exist when the model is used | Leaves the column out of the features | `drop(columns=[... 'followup_score' ...])`, `del df['followup_score']`, `c != 'followup_score'` |
| group_split | Several rows per subject (`subject_id`) split at random, so the same subject is in train and test | Splits by subject, or keeps one row per subject | `GroupKFold`, `GroupShuffleSplit`, `groups=`, `drop_duplicates(subset='subject_id')`, `df['subject_id'].isin(train_ids)` |
| preprocess | Scaling or feature selection fitted on all rows | Splits first, fits on train only | `fit_transform` before `train_test_split` |
| clean | Another target-derived feature, or gaps filled using all rows | Questions suspicious columns, fills from the training rows | `fillna` or `.median()` before the split |
| split | Dates shuffled, or related rows split apart when there is no id column | Splits by date or by group | sorting by date before the split |
| evaluate | Tuning on the test set, or accuracy on imbalanced data | Separate validation set, balanced metric | many `.score(` calls on the same test set |

Nothing in the case file says which of these flaws, if any, this batch has: that is what you find out. A grouped split is the split itself, so `group_split` counts when it is in the action that splits, not only before it. Dropping `followup_score` counts there too. Importing a splitter without using it is not the step.

## How to compare runs

1. Read `/case/case.json`. `runs` has each run's status: `honest` (reported score close to the true score) or `inflated` (reported score well above it). `split` has the deterministic finding: the label done before the split by honest runs and skipped by inflated ones.
2. Read a few runs' `/runs/<id>/actions.json`. Each action has its tool, arguments and labels.
3. Check the finding against the actions. Look at what happened right before each run's first `split` action.
4. A label that appears in nearly all honest runs and almost no inflated runs is the suspect step. If honest and inflated runs did the same things, say so: the difference may be in the model choice, not the method.

## What counts as proof

A difference between groups is only a correlation. The proof is the fork experiment: from the same point in the same run, half the copies continue unchanged and half get the step forced. If the forced copies come out honest much more often, the step caused the inflation. Report both arms' counts, not only the forced arm.
