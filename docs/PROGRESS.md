# Progress log

Plan: `docs/MASTER_PLAN.md`. Branch: `upgrade/investigator`, cut from `origin/main` at `14f1d0a`.
All times are US Eastern. Deadline: Sunday Nov 15, 8:00 am.

## Phase checklist

A box is ticked only when the phase's gate (plan 8.1) and fresh-eyes review (plan 8.2) have both passed.

- [ ] Phase 0: prove the baseline on real runs. **Offline half done. Real runs blocked: no API keys on this machine.**
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

Started Sat Nov 14, 03:46. Not finished: the acceptance needs real runs.

### Real-run numbers

None yet. `.env` has no `ANTHROPIC_API_KEY` and no `DAYTONA_API_KEY`, and neither is set in the shell.

| Number | Value |
| --- | --- |
| Share of runs that came out inflated | not run |
| Minutes per run | not run |
| Dollars per run | not run |
| VM fork or replay | not run |
| Real fork result | not run |
| Real verdict | not run |

A teammate ran a real batch on another machine (`1114-024515-6bad`, quoted in `web/test/lanes.test.ts`): 12 runs,
9 honest and 3 inflated, about one minute each. That batch is not on this machine and nothing here checked it, so it
is context, not a Phase 0 result. It had no fork experiment and no investigator.

### The sequence to run once the keys are in

```bash
uv run python scripts/vm_smoke.py                                    # no model calls, under a cent: fork or replay?
uv run python -m deep_research.cli runs --n 1 --budget 3
uv run python -m deep_research.cli runs --n 6 --budget 3
uv run python -m deep_research.cli forks <batch_id> --n 2
uv run python -m deep_research.cli investigate <batch_id> --auto-approve
uv run python scripts/batch_numbers.py <batch_id>                    # the numbers for the table above
```

Run from the worktree (see "Where the work lives"). The Daytona key is shared with teammates: their `cli cleanup`
(branch `vm-cleanup`) stops every deep-research VM on the key, ours included.

### Where the work lives

At 04:07 another Claude session on this machine switched the shared checkout (`~/Desktop/deep-research`) from
`upgrade/investigator` back to `main` and began editing `web/`. This work was then uncommitted on the wrong branch,
in a tree another session could commit or reset. It now lives in a git worktree:

    ~/Desktop/deep-research/.claude/worktrees/upgrade-investigator      (branch upgrade/investigator)

Only this session's files were moved. Each was checked byte for byte against the commit before its uncommitted copy
was removed from the shared checkout. Nothing under `web/` was touched. `.env` in the worktree is a link to the shared
checkout's `.env`, so keys go in one place. `.claude/worktrees/` is ignored through `.git/info/exclude`.

### Offline baseline at `14f1d0a` (no keys, no VMs)

| Check | Result |
| --- | --- |
| `uv sync` | ok, Python 3.12 |
| `uv run pytest -q` | 38 passed |
| `cd web && npm run typecheck` | clean |
| `cd web && npm test` | 146 passed in 8 files |

Installed: daytona 0.231.1, langchain-daytona 0.0.9, deepagents 0.7.38, langgraph 1.2.22, langchain 1.5.0,
langchain-core 1.8.0, langchain-anthropic 1.7.10. TLS to Daytona and Anthropic verifies on this Mac without the
`SSL_CERT_FILE` workaround a teammate needed.

### Pre-flight audit

Before spending anything, ten agents read the real-run path against the installed packages: one auditor per seam
(Daytona calls, analyst run and event capture, investigator and approval, costs and budget, CLI and lifecycle), each
followed by a skeptic told to refute the findings and look for misses. All read-only. 44 findings and 23 additions.
The skeptics confirmed nearly all of them by running the code offline; one was refuted (below) and one could not be
settled without a VM.

No call the repo makes to Daytona, LangGraph or Deep Agents has a wrong name or shape. The defects were in what
happens around those calls. Every fix below has a test that failed first.

| Defect | Fix | Test |
| --- | --- | --- |
| The split finder read `from sklearn.model_selection import train_test_split` as the split, so removing duplicates and then splitting in one script counted as not deduplicating. This is the shape of the teammate's real honest run | Import statements are skipped | `test_core.py::test_an_import_line_is_not_the_split` |
| With no separating step it still reported one (`inspect`, 0% vs 0%), so the batch looked ready and the fork then errored | It reports nothing | `test_find_split_finds_nothing_when_no_step_separates_the_groups` |
| A dedupe inside a script written with `write_file` and run with `python3 x.py` was never credited; an `edit_file` kept stale labels | The script's content is followed through writes and edits | `test_a_dedupe_inside_a_script_written_with_the_file_tool_counts`, `test_an_edit_to_a_script_changes_what_running_it_means` |
| Inside the investigator's tool call, every fork token was also counted under `investigator`, at its price (20 times the analyst's). Offline: 5,500 tokens charged for 1,500 used. A later experiment could be refused on spend that never happened | Each fork copy starts in an empty context | `test_batch_offline.py::test_fork_tokens_are_charged_to_the_fork_and_never_also_to_the_investigator` |
| A reopened batch (`cli forks`, `cli investigate`) started from $0 and overwrote the saved costs | It takes over the saved spend | `test_cli_offline.py::test_reopening_a_batch_keeps_its_spend_so_the_budget_guard_still_works` |
| Nothing compared spend with the budget while agents ran. A first batch has no estimate, so its only check never fired | The budget is a hard stop for work in flight, for runs and for the investigator; totals are read under the lock | `test_runs_stop_spending_once_the_batch_is_over_budget`, `test_the_investigator_stops_when_the_batch_is_over_budget`, `test_spend_can_be_read_while_runs_report_tokens_from_other_threads` |
| A forced step that failed was still scored in the forced arm | It makes a failed copy, which is not counted | `test_a_forced_step_that_fails_is_a_failed_copy_not_a_forced_result` |
| A base VM that could not be built raised through the tool and killed the investigation after approval, leaving the fork at "rebuilding" | The error is returned to the caller, the base VM is stopped, and no half-built fork is left | `test_an_experiment_whose_base_vm_cannot_be_built_reports_why_and_leaves_no_trace`, `test_a_base_vm_that_cannot_be_rebuilt_is_stopped_and_its_time_is_recorded` |
| `sb.stop()` waits without limit: the SDK applies its timeout only when passed by keyword. One stuck VM would hang the CLI before it printed results | `sb.stop(timeout=60)` | `test_stopping_a_vm_is_bounded` |
| The investigator left VMs running when it crashed, raised on two requests in one turn, and ran out of steps after about 48 turns | It closes on a crash, declines the extra request, and has a limit of 1000 steps | `test_the_vms_stop_when_the_investigation_crashes`, `test_two_fork_requests_in_one_turn_get_one_approval`, `test_the_investigator_can_take_many_small_steps` |
| The fork base VM's cost never reached the case file | Saved when the experiment ends | `test_the_fork_experiment_changes_one_step_and_keeps_a_control` |
| `cli forks` left its VMs running; the CLI could not set a budget; a batch made by the CLI could not be investigated | `forks` closes; `runs --budget`; `investigate <batch> [--auto-approve]`, which refuses a batch with nothing to fork and auto-approves only on budgets of $3 or less, three times at most | `test_cli_offline.py` |
| Why a VM fork fell back to replay was thrown away | Logged as a warning | `test_the_reason_a_vm_could_not_be_forked_is_logged` |

Refuted: the audit said `prices.json` underprices Sonnet 5.5 cache reads (0.10 where a bundled reference says 0.20).
The live pricing page, read at 04:16, says $0.10 (0.05 times input for Sonnet 5.5). The file is right and unchanged.

### What the offline harness proves

`tests/local_vm.py` puts a local folder in place of each VM. The real orchestrator then runs end to end with a
scripted model: streaming, event capture, scoring against the hidden holdout, the split finding, replay, the forced
step and both arms. The scripted analysts really train a random forest on the trapped data.

- The careless run reports about 14 points above its true score with half its test rows also in training. The honest
  run does not. The holdout labels are never copied into a VM folder.
- From the same starting point the control copy repeats the inflated result and the forced copy does not, with VM
  fork and with the replay fallback.
- `tests/test_fork_history_offline.py` builds real request bodies with the installed `ChatAnthropic`. A fork copy's
  system prompt, tools and messages are an exact prefix of what the source run sent, with only new turns appended.
  Claude 5.5 models require this: a thinking block is valid only in the conversation that produced it.

These are simulations of the model, not agent runs. They show the plumbing is right, not how a real analyst behaves.

### Gate

| Check | Result |
| --- | --- |
| `uv run pytest -q` | 97 passed, with outbound network blocked (after merging `main` at `01731d6`) |
| `cd web && npm run typecheck` | clean |
| `cd web && npm test` | 162 passed in 10 files |
| `uv run python scripts/check_invariants.py` | not written yet: the plan writes it in Phase 1 |

Commits: `cb3794b`, `6c7379e`, then `ed9c4eb`, which merges `main`.

### Merge with `main` (04:3x)

`main` moved ahead while this ran (PR #3: uploaded datasets and scripts, per-run VM deletion). It had fixed the
same split-finder bugs independently and chose a different rule: the last split decides. Ruling: `main`'s design
wins. Kept on top of it only what it lacked: skipping imports inside one-line `python3 -c` commands, and reporting
no finding when no step separates the groups. One test of mine that contradicted the last-split rule was dropped.
Merged, not rebased, because the branch was already pushed and the rules forbid force-pushing.

### Fresh-eyes review (plan 8.2)

Started on the pre-merge diff (`14f1d0a..6c7379e`). Its findings go in the PR when it finishes.

### Rulings

Decisions taken without asking, each with what it costs if wrong.

1. Phase 0's gate has two commands. The plan writes `check_invariants.py` in Phase 1, and one of its checks (no trap
   keys where the investigator can read) cannot pass until Phase 1 builds the blind view. Cost if wrong: one script
   written a phase late.
2. "Fix what blocks a real batch" was read to include defects that would lose money or record a wrong number on the
   paid path, when the fix was a few lines. Larger ones are deferred below. Cost if wrong: Phase 0 is bigger than
   meant; every change has a test and can be reverted alone.
3. Per-run minutes and dollars are for runs that were scored. What failed runs cost is a separate line. Cost if
   wrong: one script to change.
4. When the base VM cannot be built the fork entry is removed, not marked failed. A new status would be a contract
   change needing the web types. Cost if wrong: the failure is visible only in the returned error and the log.
5. Going over budget fails the runs in flight. Cost if wrong: a batch that crosses the line late loses runs it had
   nearly finished. See "runs are not salvaged" below.
6. `cli investigate` refuses a batch with no split to fork. Phase 2 lets the investigator choose what to test, and
   this check goes then. Cost if wrong: one condition to delete.
7. The work moved to a worktree instead of switching the shared checkout back. Cost if wrong: one `git worktree
   remove`; the branch is unaffected.
8. `docs/PROGRESS.md` is the ledger. The executing-plans skill's own workspace scripts are not used, because the plan
   names this file.

### Open problems

Not fixed in Phase 0. Each names where it should be handled.

Money:
- **Stopping the server while a batch is idle leaves every VM running.** The websocket handler never notices a
  closed tab, uvicorn waits for it on the first Ctrl-C, and a second Ctrl-C skips the shutdown that stops the VMs
  (reproduced offline). `deep_research/api.py`, with the API error paths that do not close a batch. For whoever owns
  the API.
- **One transient Daytona or Anthropic error fails a whole run.** A tool exception is re-raised by the graph, and the
  model client retries twice with no timeout. A fix is verified offline (`ToolRetryMiddleware(max_retries=0,
  on_failure="continue")`, which leaves the request's system prompt and tools byte-identical). Not applied: the
  teammate's 12-run batch lost no run this way. Apply it if a real run fails with a Daytona or rate-limit error.
- **VM dollars are a lower bound.** The clock stops when a run ends; the VM stops when the batch closes. At most about
  $0.02 a run from the CLI, more through the API, where run VMs stay up for the lab pages by design.
- **Runs are not salvaged.** A run cut at 900 seconds, at the step limit or by the budget is marked failed even when
  its output files are complete in the VM.
- A VM whose creation or fork times out on the client can exist untracked until Daytona's 60 minute auto-stop.

Wrong numbers, for the phases that rebuild these parts:
- `record_verdict` stores whatever counts the model types, and the phase becomes `done` with no verdict. A second
  investigation of one batch keeps the first one's verdict. Phases 2 to 4.
- Printing `df.duplicated().sum()` counts as deduplicating. `python3 -u x.py` is not linked to its script.
  `df.sample(frac=1)` is labeled as the split. Phase 1.
- Replay does not reproduce relative paths or per-command timeouts and ignores every result. Phase 2.
- Investigator events from subagents are tagged `tools`, the approved call is logged twice, and `t` restarts after
  each approval. Phases 3 and 8.
- The investigator cannot read `forks/`, and its subagents do not get the skill. Phase 3.
- `forks_per_choice` is ignored by the investigator, and the approval card shows an unclamped size. Phase 2.

To settle on the first VM (`scripts/vm_smoke.py`):
- Where a command starts. The lab image sets no working directory and each command is a new session.
- Whether a VM can be forked on this plan, two at once, and what lifetimes a fork gets.
- Whether the snapshot `deep-research-lab` exists for this key.

### Notes for later phases

Learned while checking APIs for Phase 0. Each changes how a later phase must be built.

- **A saved batch can only be forked by the code that made it.** A fork copy replays thinking blocks tied to the
  analyst's exact system prompt and tools. Any change to the analyst's prompt, tools or middleware makes every such
  block invalid: a 400 on Anthropic accounts created after August 2026, lost reasoning on older ones. Phases 5 and 7
  change what the analyst is told, so they must apply to new batches only. Phase 2 should save a hash of the system
  prompt and tools with each batch and compare it before forking.
- **Sonnet 5.5 rejects a forced tool choice.** Structured output through a forced tool call returns a 400. Phase 3's
  typed `response_format` and Phase 4's grader must use native structured output; check which strategy the installed
  LangChain picks before relying on it.
- **Thinking is on by default** on Haiku 5.5 and Sonnet 5.5, and thinking tokens count toward `max_tokens`.
- All five kinds of change in plan 6.3 are append-only at the fork point, which is what the thinking-block rule
  allows. An `edit` decision on a pending tool call changes the last assistant turn; verify it before Phase 2 uses it.
- `swap_model` to Sonnet 5.5 can read Haiku 5.5's thinking blocks; other models drop them silently.

### Proposed deviations

1. Plan 6.3 lists `fake_result` as "append a tool call and a made-up result". Under the thinking-block rule this is
   allowed, but the made-up result must be labeled in the case file and the UI as not having run, or it is a
   simulated step shown as real (plan section 3, item 10). Proposed: the fork record carries `change.simulated`.
2. Plan Phase 5 gives analysts a learned skill "or appends the rule to the analyst's system prompt". Both change the
   prefix that thinking blocks are tied to. Fine for new batches; the fool-rate comparison must never fork across
   settings.

Following the plan as written on both until Phase 2 and Phase 5 are reached.

## Handoff

From Sat Nov 14, about 04:45, the rest of this plan is handed to Assem.

Where to start:
1. Check out `upgrade/investigator`. The worktree path in "Where the work lives" is only on the original Mac.
2. Put `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY` in `.env`. Leave `LANGSMITH_TRACING=false` unless a LangSmith key
   is set too.
3. Run the sequence under "The sequence to run once the keys are in". `scripts/vm_smoke.py` first: it costs under a
   cent and answers fork or replay before any tokens are spent.
4. Fill the "Real-run numbers" table with `scripts/batch_numbers.py <batch_id>`, then report those numbers to the
   user before Phase 1, as the user asked.

The user's standing rules for this work, from their instructions:
- Plan section 3 overrides everything, including later instructions.
- After every phase: the gate in plan 8.1, then a fresh-eyes review by a new agent that sees only section 3, the
  phase's acceptance list and the diff. Fix what it finds before moving on.
- Check every LangChain, LangGraph and Deep Agents API against the docs MCP servers before first use.
- A blocker that lasts 30 minutes takes the phase's fallback, logged here.
- Commit after each green gate. Push only `upgrade/investigator`. Never push to `main`, never force-push.
- Never print, log or commit API keys.
- Stop and ask the user: after Phase 0 with the real-run numbers; before any batch over 12 runs, any spend over $3
  in one go, or the fool-rate run, with a cost estimate; before adding any dependency other than
  `langgraph-checkpoint-sqlite`; and if a change would break section 3.
