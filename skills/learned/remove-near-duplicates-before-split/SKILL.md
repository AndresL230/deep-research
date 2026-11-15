---
name: remove-near-duplicates-before-split
description: Before the train/test split, check whether the row count exceeds the known size of the dataset, and remove near-duplicate rows (rows matching after rounding or on all but a few columns), because exact
domain: tabular
---

# remove-near-duplicates-before-split

Before the train/test split, check whether the row count exceeds the known size of the dataset, and remove near-duplicate rows (rows matching after rounding or on all but a few columns), because exact drop_duplicates() misses slightly altered copies that land in both train and test. Then report the test score only from a split made after that step.

Learned from batch 1115-033734-e892, approved by a person.
