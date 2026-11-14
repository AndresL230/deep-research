// The home screen's "Needs you" list (src/batch/needs-you.ts), on hand-made list items.

import { describe, expect, it } from "vitest";
import { ApiError, type BatchListItem, type BatchSummary, type MorePairsQuote } from "../src/api";
import { homeView } from "../src/batch/home";
import type { HomeVm, Loadable } from "../src/batch/model";
import {
  NY_ACT, moreFailedUi, needKey, needOf, needsOf, needsView, pruneNeeds, quoteText, quoteUi, refusalText, type NeedUi,
} from "../src/batch/needs-you";

const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  domain: { name: "tabular", title: "Tabular data science" },
  started_at: "2026-11-14T03:25:54",
  phase: "done",
  simulated: false,
  analyst_models: ["anthropic:claude-haiku-5-5"],
  investigator_model: "anthropic:claude-sonnet-5-5",
  n_runs: 12,
  counts: { honest: 6, inflated: 6, unclear: 0, failed: 0, running: 0, queued: 0, stopped: 0 },
  claim: { of: "inflated", n: 6, claimed: 0.9917, measured: 0.5944, n_hidden: 20 },
  step: { label: "deduplicate", name: "removing duplicate rows" },
  verdict: { state: "none" },
  pending: null,
  fork_progress: null,
  spend: { usd: 0.5455, usd_partial: false, tokens: 477_697 },
  ...over,
});

const APPROVE: BatchListItem = {
  id: "1114-090000-appr", kind: "live",
  summary: summary({ phase: "awaiting_approval", verdict: { state: "awaiting_approval" }, pending: { kind: "method", n_per_arm: 4, vm_count: 17, estimate_usd: 2.1 } }),
};
const READY: BatchListItem = { id: "1114-024515-6bad", kind: "replay", resumable: true, summary: summary({ phase: "ready" }) };
const OPEN: BatchListItem = { id: "1114-032554-c05a", kind: "replay", summary: summary({ verdict: { state: "open", pairs: 4, needed_pairs: 8 } }) };
const RUNNING: BatchListItem = {
  id: "1114-150000-live", kind: "live",
  summary: summary({ phase: "running", claim: null, counts: { honest: 3, inflated: 4, unclear: 0, failed: 1, running: 3, queued: 1, stopped: 0 } }),
};
const DONE: BatchListItem = { id: "1114-034546-6c7a", kind: "replay", summary: summary({ verdict: { state: "supported", pairs: 9, needed_pairs: 8 } }) };

const ready = (items: BatchListItem[]): Loadable<BatchListItem[]> => ({ state: "ready", value: items });
/** The markup's visible text: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const rowOf = (html: string, id: string): string => {
  const at = html.indexOf(`<li class="ny-row" data-morph-key="${id}"`);
  expect(at).toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf("</li>", at) + 5);
};

const quote = (over: Partial<MorePairsQuote> = {}): MorePairsQuote => ({
  fork_id: "f1", n_per_arm: 4, max_per_arm: 8, arms: ["control", "forced"], vm_count: 9, estimate_usd: 1.12, basis: "8 new copies plus the base VM",
  pairs_now: 4, pairs_after: 8, needed_pairs: 8, level_now: "open", p_value_now: 0.0714, budget_usd: 10, spent_usd: 3.4,
  over_budget: false, budget_problem: null, ...over,
});

describe("needs you: the items", () => {
  it("asks for a fork's approval with its VMs and estimate, and Approve and Decline", () => {
    const row = rowOf(needsView(ready([APPROVE])), APPROVE.id);
    expect(text(row)).toContain("Fork waiting for approval: 17 VMs, about $2.10");
    expect(row).toContain(`data-act="${NY_ACT.approve}" data-arg="${APPROVE.id}"`);
    expect(row).toContain(`data-act="${NY_ACT.decline}" data-arg="${APPROVE.id}"`);
    expect(row).toContain('data-kind="approve"');
    // A fix test with no prices says what it is and that the cost is unknown.
    const fix = { ...APPROVE, summary: summary({ phase: "awaiting_approval", pending: { kind: "fix", n_per_arm: 3, vm_count: 10, estimate_usd: null } }) };
    expect(text(needsView(ready([fix])))).toContain("Fix test waiting for approval: 10 VMs, cost unknown");
    // A server older than the pending numbers still asks.
    const old = { ...APPROVE, summary: summary({ phase: "awaiting_approval", verdict: { state: "awaiting_approval" }, pending: undefined }) };
    expect(text(needsView(ready([old])))).toContain("Fork waiting for approval Approve Decline");
  });

  it("offers Investigate on a saved batch at its split", () => {
    const row = rowOf(needsView(ready([READY])), READY.id);
    expect(text(row)).toContain("Scored, split found: removing duplicate rows. Ready to investigate");
    expect(row).toContain(`data-act="${NY_ACT.investigate}" data-arg="${READY.id}"`);
  });

  it("offers more pairs on an open verdict", () => {
    const row = rowOf(needsView(ready([OPEN])), OPEN.id);
    expect(text(row)).toContain("Open at 4 of 8 pairs: removing duplicate rows");
    expect(row).toContain(`data-act="${NY_ACT.more}" data-arg="${OPEN.id}"`);
    expect(text(row)).toContain("Run 4 more");
    // Enough pairs but no clear difference: one more, the server's default.
    const even = { ...OPEN, summary: summary({ verdict: { state: "open", pairs: 9, needed_pairs: 8 } }) };
    expect(text(needsView(ready([even])))).toContain("Run 1 more");
  });

  it("shows a running batch's progress with a thin bar and Open", () => {
    const row = rowOf(needsView(ready([RUNNING])), RUNNING.id);
    expect(text(row)).toContain("8 of 12 scored");
    expect(row).toContain('role="progressbar"');
    expect(row).toContain('aria-valuenow="67"');
    expect(row).toContain(`data-act="open-batch" data-arg="${RUNNING.id}"`);
    expect(text(row)).toContain("Open");
    // A fork going: its copies.
    const fork = { ...RUNNING, summary: summary({ phase: "forking", fork_progress: { scored: 5, total: 16 } }) };
    expect(text(needsView(ready([fork])))).toContain("Fork running: 5 of 16 copies scored");
    const inv = { ...RUNNING, summary: summary({ phase: "investigating" }) };
    expect(text(needsView(ready([inv])))).toContain("Investigator at work");
    expect(needsView(ready([inv]))).not.toContain("progressbar");
  });

  it("opens each row's batch from its name", () => {
    const html = needsView(ready([APPROVE, READY, OPEN, RUNNING]));
    for (const it of [APPROVE, READY, OPEN, RUNNING]) {
      expect(rowOf(html, it.id)).toMatch(new RegExp(`<button type="button" class="ny-name" data-act="open-batch" data-arg="${it.id}"`));
    }
  });
});

describe("needs you: what is listed", () => {
  it("orders approvals, then ready to investigate, open verdicts, then running", () => {
    const order = needsOf([RUNNING, OPEN, DONE, READY, APPROVE]).map((n) => n.kind);
    expect(order).toEqual(["approve", "investigate", "open", "running"]);
    const html = needsView(ready([RUNNING, OPEN, READY, APPROVE]));
    const at = (id: string) => html.indexOf(`data-morph-key="${id}"`);
    expect(at(APPROVE.id)).toBeLessThan(at(READY.id));
    expect(at(READY.id)).toBeLessThan(at(OPEN.id));
    expect(at(OPEN.id)).toBeLessThan(at(RUNNING.id));
    // Newest first within a kind.
    const older = { ...OPEN, id: "1113-010000-oldr", summary: summary({ started_at: "2026-11-13T01:00:00", verdict: { state: "open", pairs: 2, needed_pairs: 8 } }) };
    expect(needsOf([older, OPEN]).map((n) => n.id)).toEqual([OPEN.id, older.id]);
  });

  it("leaves out hub, fixture and simulated batches, and batches with nothing to do", () => {
    for (const it of [OPEN, READY, RUNNING, APPROVE]) {
      expect(needOf({ ...it, remote: true, machine: "lab-2" })).toBeNull();
      expect(needOf({ ...it, fixture: true })).toBeNull();
      expect(needOf({ ...it, summary: { ...it.summary!, simulated: true } })).toBeNull();
    }
    expect(needOf(DONE)).toBeNull();
    expect(needOf({ id: "x", kind: "replay", summary: null })).toBeNull();
    expect(needOf({ id: "x", kind: "replay" })).toBeNull();
    // A saved batch waiting for approval cannot be decided (the server answers live batches only): it is picked up
    // by Investigate, if at all. A live one with an open verdict is running a round of more pairs.
    expect(needOf({ ...APPROVE, kind: "replay" })).toBeNull();
    expect(needOf({ ...APPROVE, kind: "replay", resumable: true })).toBe("investigate");
    expect(needOf({ ...OPEN, kind: "live", summary: summary({ phase: "forking", verdict: { state: "open", pairs: 4, needed_pairs: 8 } }) })).toBe("running");
  });

  it("says nothing needs you in one quiet line, and nothing at all before the list loads", () => {
    const html = needsView(ready([DONE, { ...OPEN, fixture: true }]));
    expect(text(html)).toBe("Nothing needs you.");
    expect(html).not.toContain("<h2");
    expect(needsView({ state: "loading" })).toBe("");
    expect(needsView({ state: "error", message: "x" })).toBe("");
  });

  it("sits above the batches table on the home screen", () => {
    const vm: HomeVm = { batches: ready([OPEN]), health: null, defaults: null, draft: null, estimate: null, starting: false, error: null };
    const html = homeView(vm);
    expect(html.indexOf('data-morph-key="needs"')).toBeGreaterThan(0);
    expect(html.indexOf('data-morph-key="needs"')).toBeLessThan(html.indexOf('data-morph-key="batches"'));
  });
});

describe("needs you: the more pairs confirm", () => {
  const view = (ui: NeedUi) => rowOf(needsView(ready([OPEN]), { [needKey("open", OPEN.id)]: ui }), OPEN.id);

  it("spins Run more while the quote loads", () => {
    const row = view({ state: "busy", action: "quote" });
    expect(row).toMatch(/data-act="ny-more"[^>]*disabled[^>]*aria-busy="true"/);
  });

  it("opens the confirm in the row from the quote, with Start and Cancel", () => {
    const ui = quoteUi(quote());
    expect(ui.state).toBe("confirm");
    const row = view(ui);
    expect(text(row)).toContain("9 VMs, about $1.12. 4 pairs now, 8 after.");
    expect(row).toContain(`data-act="${NY_ACT.start}" data-arg="${OPEN.id}"`);
    expect(row).toContain(`data-act="${NY_ACT.cancel}" data-arg="${OPEN.id}"`);
    expect(row).not.toContain(`data-act="${NY_ACT.more}"`);
    // The confirm's words are read out as they come.
    expect(row).toMatch(/<div class="ny-say"[^>]*aria-live="polite"[^>]*>9 VMs/);
    // Start takes the focus once the confirm opens.
    expect(row).toMatch(/data-act="ny-start"[^>]*data-ny-focus/);
    expect(quoteText(quote({ estimate_usd: null, vm_count: 3, pairs_now: 1, pairs_after: 2 }))).toBe("3 VMs, cost unknown, prices missing. 1 pair now, 2 after.");
  });

  it("shows the budget problem in place of Start", () => {
    const ui = quoteUi(quote({ over_budget: true, budget_problem: "the batch has spent $9.80 of its $10.00 budget" }));
    expect(ui).toEqual({ state: "refused", message: "Over budget: the batch has spent $9.80 of its $10.00 budget." });
    const row = view(ui);
    expect(row).not.toContain(`data-act="${NY_ACT.start}"`);
    expect(row).toContain(`data-act="${NY_ACT.cancel}"`);
    expect(row).toContain('data-tone="bad"');
    expect(text(row)).toContain("Over budget: the batch has spent $9.80 of its $10.00 budget.");
  });

  it("shows the server's refusal when the quote answers 409", () => {
    const ui = moreFailedUi(new ApiError("The server answered HTTP 409: cannot run more pairs: its evidence is already supported", 409));
    expect(ui).toEqual({ state: "refused", message: "Can't run more pairs: its evidence is already supported." });
    expect(view(ui)).not.toContain(`data-act="${NY_ACT.start}"`);
    expect(refusalText("cannot run more pairs")).toBe("Can't run more pairs.");
  });

  it("shows any other failure under the row with Run more there to try again", () => {
    const ui = moreFailedUi(new ApiError("Couldn't reach the server. Is it running on port 8000?", 0));
    expect(ui.state).toBe("error");
    const row = view(ui);
    expect(text(row)).toContain("Couldn&#39;t reach the server.");
    expect(row).toContain(`data-act="${NY_ACT.more}"`);
  });

  it("spins Start while it starts, with Cancel off", () => {
    const row = view({ state: "confirm", quote: quote(), starting: true });
    expect(row).toMatch(/data-act="ny-start"[^>]*disabled/);
    expect(row).toMatch(/data-act="ny-cancel"[^>]*disabled/);
  });

  it("keeps a row's state while its batch still needs it, or while its call is in flight", () => {
    const ui = { [needKey("open", OPEN.id)]: quoteUi(quote()), [needKey("approve", APPROVE.id)]: { state: "done", message: "Approved." } as NeedUi };
    // A repaint with the same list keeps the open confirm.
    expect(pruneNeeds(ui, [OPEN, APPROVE])).toEqual(ui);
    // The approved batch moved on to running: its row's word goes; the confirm stays.
    const moved = { ...APPROVE, summary: summary({ phase: "forking" }) };
    expect(Object.keys(pruneNeeds(ui, [OPEN, moved]))).toEqual([needKey("open", OPEN.id)]);
    // Started: the batch went live, but the POST is still being answered.
    const starting = { [needKey("open", OPEN.id)]: { state: "confirm", quote: quote(), starting: true } as NeedUi };
    expect(pruneNeeds(starting, [{ ...OPEN, kind: "live" }])).toEqual(starting);
  });
});

describe("needs you: the words", () => {
  it("never has an em dash or a snake_case word", () => {
    const states: NeedUi[] = [
      { state: "busy", action: "quote" }, quoteUi(quote()), quoteUi(quote({ over_budget: true, budget_problem: "over it" })),
      { state: "error", message: "Couldn't reach the server." }, { state: "done", message: "Approved. The fork is starting." },
    ];
    const items = [APPROVE, READY, OPEN, RUNNING, { ...RUNNING, id: "f", summary: summary({ phase: "forking", fork_progress: { scored: 1, total: 4 } }) }];
    const pages = [needsView(ready(items)), needsView(ready([])), ...states.map((s) => needsView(ready(items), {
      [needKey("open", OPEN.id)]: s, [needKey("approve", APPROVE.id)]: s, [needKey("investigate", READY.id)]: s,
    }))];
    for (const html of pages) {
      const t = text(html);
      expect(t).not.toMatch(/\u2014|\u2013/);
      expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(html).not.toMatch(/\u2014/);
    }
  });
});
