// The home screen's batch table (src/batch/batch-table.ts), on hand-made list items.

import { describe, expect, it } from "vitest";
import type { BatchListItem, BatchSummary } from "../src/api";
import { DEFAULT_VIEW, batchTable, sortBy, sortItems, startedLabel } from "../src/batch/batch-table";
import { homeView } from "../src/batch/home";
import type { HomeVm } from "../src/batch/model";

const NOW = new Date(2026, 10, 14, 15, 0, 0);

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
  verdict: { state: "open", pairs: 4, needed_pairs: 8 },
  spend: { usd: 0.5455, usd_partial: false, tokens: 477_697 },
  ...over,
});

const FULL: BatchListItem = { id: "1114-032554-c05a", kind: "replay", summary: summary() };
const UNREADABLE: BatchListItem = { id: "1114-040000-dead", kind: "replay", summary: null };
const LIVE: BatchListItem = {
  id: "1114-150000-live",
  kind: "live",
  summary: summary({
    started_at: "2026-11-14T14:48:00",
    phase: "running",
    domain: { name: "robot_arm", title: "Robot arm pick and place" },
    analyst_models: ["anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5"],
    counts: { honest: 2, inflated: 1, unclear: 1, failed: 0, running: 5, queued: 3, stopped: 0 },
    claim: null,
    step: null,
    verdict: { state: "none" },
    spend: { usd: 0.12, usd_partial: true, tokens: 90_000 },
  }),
};
const HUB: BatchListItem = {
  id: "1114-101523-9a4c",
  kind: "replay",
  remote: true,
  machine: "laptop-b",
  summary: summary({
    started_at: "2026-11-14T10:15:23",
    phase: "done",
    domain: { name: "robot_arm", title: "Robot arm pick and place" },
    step: { label: "vary_positions", name: "testing other can positions" },
    verdict: { state: "supported", pairs: 9, needed_pairs: 8 },
    spend: { usd: 1.03, usd_partial: false, tokens: 1_200_000 },
  }),
};
const SIM: BatchListItem = {
  id: "demo-batch",
  kind: "replay",
  summary: summary({ started_at: null, simulated: true, spend: { usd: null, usd_partial: false, tokens: 573_000 } }),
};
const ALL = [SIM, UNREADABLE, FULL, LIVE, HUB];

/** The markup's visible text: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
/** One row's markup, by batch id. */
const rowOf = (html: string, id: string) => html.match(new RegExp(`<tr class="bt-row[^"]*" data-morph-key="${id}"[\\s\\S]*?</tr>`))![0];

describe("batchTable", () => {
  const html = batchTable(ALL, DEFAULT_VIEW, NOW);

  it("is a real table: a caption, column headers and a row header per batch", () => {
    expect(html).toMatch(/<table class="bt">\s*<caption[^>]*>5 batches, newest first, simulated last<\/caption>/);
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(9);
    expect((html.match(/<th scope="row"/g) ?? []).length).toBe(5);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain("<tbody data-morph-list>");
  });

  it("opens a batch from a real button in the first cell, and from anywhere on its row", () => {
    const row = rowOf(html, FULL.id);
    expect(row).toMatch(/^<tr [^>]*data-act="open-batch" data-arg="1114-032554-c05a"/);
    expect(row).toMatch(/<button type="button" class="bt-id" data-act="open-batch" data-arg="1114-032554-c05a"[^>]*>1114-032554-c05a<\/button>/);
  });

  it("shows a full summary in words and numbers", () => {
    const t = text(rowOf(html, FULL.id));
    expect(t).toContain("Data science");
    expect(t).toContain("11 h ago");
    expect(t).toContain("6 honest 6 inflated");
    expect(t).toContain("99% measured 59%");
    expect(t).toContain("40 pts over");
    expect(t).toContain("Removing duplicate rows");
    expect(t).toContain("Open 4 of 8 pairs");
    expect(t).toContain("Haiku Sonnet investigates");
    expect(t).toContain("$0.55");
    expect(rowOf(html, FULL.id)).toContain('<i class="bt-seg" data-k="honest" style="flex-grow:6"></i><i class="bt-seg" data-k="inflated" style="flex-grow:6"></i>');
  });

  it("says once when a case file could not be read, and the batch still opens", () => {
    const row = rowOf(html, UNREADABLE.id);
    expect(row).toContain('colspan="8"');
    expect(text(row)).toBe("1114-040000-dead Replay Case file could not be read");
    // A server older than the table sends no summary at all: the row is the batch alone.
    expect(text(batchTable([{ id: "old-1", kind: "replay" }], DEFAULT_VIEW, NOW))).toContain("old-1 Replay");
  });

  it("shows a live batch with runs still going, and empty cells as quiet words", () => {
    const row = rowOf(html, LIVE.id);
    const t = text(row);
    expect(t).toContain("1114-150000-live Live");
    expect(t).toContain("Robot arm");
    expect(t).toContain("12 min ago");
    expect(t).toContain("2 honest 1 inflated 1 unclear 5 running 3 queued");
    expect(t).toContain("Haiku, Sonnet");
    expect(row).toContain('class="bt-plus"');
    expect(row).toContain('data-k="running" style="flex-grow:5"');
    // Claim, step and verdict are not there yet.
    expect((row.match(/class="bt-none">none yet</g) ?? []).length).toBe(2);
    expect(t).toContain("not yet");
    expect(row).toContain("bt-row--live");
  });

  it("names the machine of a hub batch and a supported verdict", () => {
    const t = text(rowOf(html, HUB.id));
    expect(t).toContain("1114-101523-9a4c laptop-b Replay");
    expect(t).toContain("Testing other can positions");
    expect(t).toContain("Supported 9 pairs");
    expect(t).toContain("$1.03");
  });

  it("marks a simulated batch, shows its tokens and no date", () => {
    const row = rowOf(html, SIM.id);
    expect(row).toContain('data-kind="sim">Simulated<');
    expect(text(row)).toContain("573k tokens");
    expect(text(row)).toContain("no date");
    expect(row).toContain("bt-row--sim");
  });

  it("shows the other verdict states in words", () => {
    const states: [BatchSummary["verdict"], string][] = [
      [{ state: "fork_running" }, "Fork running"],
      [{ state: "awaiting_approval" }, "Fork to approve"],
      [{ state: "forked" }, "Fork done no verdict yet"],
      [{ state: "fork_stopped" }, "fork stopped"],
    ];
    for (const [verdict, words] of states) {
      const one = batchTable([{ id: "b1", kind: "replay", summary: summary({ verdict }) }], DEFAULT_VIEW, NOW);
      expect(text(one)).toContain(words);
    }
    const noSplit = batchTable([{ id: "b1", kind: "replay", summary: summary({ phase: "no_split", step: null, verdict: { state: "none" } }) }], DEFAULT_VIEW, NOW);
    expect(text(noSplit)).toContain("no split found");
    expect(text(noSplit)).toContain("no fork");
  });

  it("never shows a raw label, an em dash or a bare dash placeholder", () => {
    for (const item of ALL) {
      const t = text(batchTable([item], DEFAULT_VIEW, NOW));
      expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(t).not.toMatch(/[\u2013\u2014]/);
      expect(` ${t} `).not.toContain(" - ");
    }
    expect(html).not.toMatch(/\u2014/);
  });

  it("filters by domain once there is more than one, and says how many each has", () => {
    expect(html).toMatch(/data-act="bt-domain" data-arg="" aria-pressed="true">All<span class="bt-f-n">5<\/span>/);
    expect(html).toMatch(/data-arg="robot_arm" aria-pressed="false">Robot arm<span class="bt-f-n">2<\/span>/);
    const robots = batchTable(ALL, { ...DEFAULT_VIEW, domain: "robot_arm" }, NOW);
    expect((robots.match(/<th scope="row"/g) ?? []).length).toBe(2);
    expect(robots).toContain("2 batches in Robot arm");
    expect(batchTable([FULL], DEFAULT_VIEW, NOW)).not.toContain("bt-filter");
    // A domain no batch has any more shows everything.
    expect((batchTable(ALL, { ...DEFAULT_VIEW, domain: "gone" }, NOW).match(/<th scope="row"/g) ?? []).length).toBe(5);
  });
});

describe("sorting", () => {
  const ids = (items: BatchListItem[]) => items.map((it) => it.id);

  it("opens newest first, with simulated batches and undated ones last", () => {
    expect(ids(sortItems(ALL))).toEqual([LIVE.id, HUB.id, FULL.id, UNREADABLE.id, SIM.id]);
  });

  it("sorts by a column, and the same column again turns the order round", () => {
    const bySpend = sortBy(DEFAULT_VIEW, "spend");
    expect(bySpend).toEqual({ ...DEFAULT_VIEW, sort: "spend", dir: "desc" });
    expect(ids(sortItems(ALL, bySpend))).toEqual([HUB.id, FULL.id, LIVE.id, UNREADABLE.id, SIM.id]);
    const cheapest = sortBy(bySpend, "spend");
    expect(cheapest.dir).toBe("asc");
    expect(ids(sortItems(ALL, cheapest))).toEqual([LIVE.id, FULL.id, HUB.id, UNREADABLE.id, SIM.id]);
    expect(ids(sortItems(ALL, sortBy(DEFAULT_VIEW, "batch")))).toEqual([FULL.id, UNREADABLE.id, HUB.id, LIVE.id, SIM.id]);
    expect(sortBy(DEFAULT_VIEW, "nope")).toBe(DEFAULT_VIEW);
  });

  it("marks the sorted column for screen readers", () => {
    const html = batchTable(ALL, sortBy(DEFAULT_VIEW, "claim"), NOW);
    expect(html).toMatch(/<th scope="col" class="bt-h bt-c-claim" aria-sort="descending">/);
    expect(html).toContain("sorted by claimed vs measured");
    expect((html.match(/aria-sort=/g) ?? []).length).toBe(1);
  });
});

describe("startedLabel", () => {
  it("says how long ago within a day, else the date", () => {
    expect(startedLabel("2026-11-14T14:59:30", NOW)).toBe("just now");
    expect(startedLabel("2026-11-14T14:48:00", NOW)).toBe("12 min ago");
    expect(startedLabel("2026-11-14T03:25:54", NOW)).toBe("11 h ago");
    expect(startedLabel("2026-11-02T09:00:00", NOW)).toBe("Nov 2");
    expect(startedLabel("2025-12-30T09:00:00", NOW)).toBe("Dec 30, 2025");
    expect(startedLabel(null, NOW)).toBeNull();
  });
});

describe("homeView with the table", () => {
  it("passes the table's view through", () => {
    const vm = {
      batches: { state: "ready", value: ALL }, health: null, defaults: null, draft: null, estimate: null, starting: false,
      error: null, table: { sort: "spend", dir: "asc", domain: null },
    } as HomeVm;
    expect(homeView(vm)).toMatch(/bt-c-spend" aria-sort="ascending"/);
  });
});
