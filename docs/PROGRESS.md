# Progress log

Plan: `docs/MASTER_PLAN.md`. Branch: `upgrade/investigator`, cut from `origin/main` at `14f1d0a`.
All times are US Eastern. Deadline: Sunday Nov 15, 8:00 am.

## Phase checklist

A box is ticked only when the phase's gate (plan 8.1) and fresh-eyes review (plan 8.2) have both passed.

- [ ] Phase 0: prove the baseline on real runs
- [ ] Phase 1: blind start and a wider net
- [ ] Phase 2: experiments with a choice and a score
- [ ] Phase 3: the investigator does the science
- [ ] Phase 4: a verdict that is checked
- [ ] Phase 5: it learns
- [ ] Phase 6: real time travel
- [ ] Phase 7: a second trap
- [ ] Phase 8: show it
- [ ] Phase 9: demo hardening

## Phase 0: prove the baseline on real runs

Started: Sat Nov 14, 03:46 EST.

### Setup

- `git fetch` showed `origin/main` still at `14f1d0a`. Branch `upgrade/investigator` created from it.
- `git checkout -b ... origin/main` set the branch to track `origin/main`. Upstream was unset at once, so a bare
  `git push` can never target `main`.
- The plan was in `~/Downloads/MASTER_PLAN.md`, not the repo root. Copied byte for byte to `docs/MASTER_PLAN.md`.
- No task-list tool is available in this session, so the checklist above is the task list.

### Offline baseline (no keys, no VMs)

| Check | Result |
| --- | --- |
| `uv sync` | ok, Python 3.12 |
| `uv run pytest -q` | 38 passed |
| `cd web && npm run typecheck` | clean |
| `cd web && npm test` | 146 passed in 8 files |

Installed: daytona 0.231.1, langchain-daytona 0.0.9, deepagents 0.7.38, langgraph 1.2.22, langchain 1.5.0,
langchain-core 1.8.0, langchain-anthropic 1.7.10.

