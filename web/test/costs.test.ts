// The overall cost screen (src/batch/costs.ts): pure helpers and the markup, no DOM.

import { describe, expect, it } from "vitest";
import type { BatchCost, CostReport, CostTokens, CostUsd } from "../src/api";
import { batchRow, costsView, groupParts, modelName, money, outcomeChips, share, stackedBar, vmTime, whenLabel } from "../src/batch/costs";
import { parseRoute, routeHash, type Route } from "../src/batch/model";
import { navBar } from "../src/batch/nav";

const HAIKU = "anthropic:claude-haiku-5-5";
const SONNET = "anthropic:claude-sonnet-5-5";
const tok = (input = 0, output = 0, cache_read = 0, cache_write = 0): CostTokens => ({ input, output, cache_read, cache_write });
const dollars = (runs: number, forks: number, investigator: number, vm: number, other = 0): CostUsd => {
  const total = runs + forks + investigator + other;
  return { total, runs, forks, investigator, other, model: total - vm, vm };
};

const batch = (over: Partial<BatchCost> = {}): BatchCost => ({
  id: "1114-093012-a1b2", kind: "replay", started_at: "2026-11-14T09:30:12", phase: "done",
  dataset: "pima", trap: "duplicates", analyst_model: HAIKU, investigator_model: SONNET,
  simulated: false, prices_missing: false,
  counts: { runs: 12, honest: 6, inflated: 5, failed: 1, fork_runs: 8 },
  usd: dollars(1.2, 0.4, 0.8, 0.3), usd_partial: false, tokens: tok(5_200_000, 480_000, 3_900_000, 610_000), vm_seconds: 16200,
  ...over,
});

const SIM = batch({
  id: "demo-batch", started_at: null, simulated: true, prices_missing: true, usd: null,
  counts: { runs: 12, honest: 6, inflated: 6, failed: 0, fork_runs: 8 }, tokens: tok(516707, 55935), vm_seconds: 0,
});
const SMALL = batch({ id: "1113-080000-ffff", started_at: "2026-11-13T08:00:00", usd: dollars(0.3, 0, 0.3, 0.05), counts: { runs: 4, honest: 4, inflated: 0, failed: 0, fork_runs: 0 } });

const report = (over: Partial<CostReport> = {}): CostReport => ({
  totals: {
    batches: 2, runs: 16, honest: 10, inflated: 5, failed: 1, fork_runs: 8,
    usd: dollars(1.5, 0.4, 1.1, 0.35), usd_partial: false, tokens: tok(6_400_000, 590_000, 4_700_000, 800_000), vm_seconds: 39720, excludes_simulated: true,
  },
  simulated: { batches: 1, runs: 12, tokens: SIM.tokens },
  by_model: [
    { model: HAIKU, roles: ["analyst"], batches: 2, usd: 1.55, usd_by_group: { runs: 1.2, forks: 0.35, investigator: 0 }, usd_partial: false, tokens: tok(5_000_000, 400_000) },
    { model: SONNET, roles: ["investigator"], batches: 2, usd: 1.1, usd_by_group: { runs: 0, forks: 0, investigator: 1.1 }, usd_partial: false, tokens: tok(1_400_000, 190_000) },
  ],
  batches: [batch(), SMALL, SIM],
  not_counted: ["Disk kept by stopped VMs.", "Anything started outside this app with the same keys."],
  ...over,
});

const ready = (r: CostReport = report()) => costsView({ report: { state: "ready", value: r }, back: null });
/** The markup's visible text: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const rowOf = (html: string, id: string) => html.match(new RegExp(`<li class="cs-row[^>]*data-morph-key="${id}"[\\s\\S]*?</li>`))![0];
const grows = (html: string) => [...html.matchAll(/data-k="(\w+)" style="flex-grow:([\d.]+)"/g)].map((m) => [m[1], Number(m[2])] as const);

describe("formatting", () => {
  it("writes dollars to the cent, with separators", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(12.836)).toBe("$12.84");
    expect(money(0)).toBe("$0.00");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(1234567.891)).toBe("$1,234,567.89");
    expect(money(null)).toBe("-");
  });

  it("writes VM time in hours once there is an hour of it", () => {
    expect(vmTime(39720)).toBe("11h 02m");
    expect(vmTime(3600)).toBe("1h 00m");
    expect(vmTime(570)).toBe("9m 30s");
    expect(vmTime(0)).toBe("0s");
    expect(vmTime(undefined)).toBe("-");
  });

  it("reads a start time as written, with no time zone shift", () => {
    expect(whenLabel("2026-11-14T09:30:12")).toBe("Nov 14, 09:30");
    expect(whenLabel("2026-01-03T23:05:00")).toBe("Jan 3, 23:05");
    expect(whenLabel(null)).toBe("No date");
    expect(whenLabel("yesterday")).toBe("No date");
  });

  it("gives shares that never round a sliver down to nothing", () => {
    expect(share(64, 100)).toBe("64%");
    expect(share(0.2, 100)).toBe("<1%");
    expect(share(0, 100)).toBe("0%");
    expect(share(5, 0)).toBe("0%");
  });

  it("drops the provider from a model name", () => {
    expect(modelName(HAIKU)).toBe("claude-haiku-5-5");
    expect(modelName("claude-opus")).toBe("claude-opus");
  });
});

describe("stackedBar", () => {
  it("sizes the segments by their share, in group order, and skips empty groups", () => {
    const html = stackedBar(groupParts({ runs: 6, forks: 0, investigator: 2 }), { label: "Where it went" });
    expect(grows(html)).toEqual([["runs", 75], ["investigator", 25]]);
    expect(html).toContain('style="width:100.00%"');
    expect(html).toContain('aria-label="Where it went: Runs $6.00, Investigator $2.00"');
  });

  it("scales the whole bar against the most expensive batch", () => {
    expect(stackedBar(groupParts({ runs: 1, forks: 1, investigator: 0 }), { scale: 0.25, label: "Spend" })).toContain('style="width:25.00%"');
    expect(stackedBar(groupParts({ runs: 1, forks: 1, investigator: 0 }), { scale: 7, label: "Spend" })).toContain('style="width:100.00%"');
  });

  it("draws an empty track when nothing was spent", () => {
    const html = stackedBar(groupParts({ runs: 0, forks: 0, investigator: 0 }), { label: "Spend" });
    expect(grows(html)).toEqual([]);
    expect(html).toContain('style="width:0.00%"');
    expect(html).toContain("nothing yet");
    expect(html).not.toContain("NaN");
  });

  it("shows other spend only when there is some", () => {
    expect(groupParts({ runs: 1, forks: 1, investigator: 1, other: 0 }).map((p) => p.key)).toEqual(["runs", "forks", "investigator"]);
    expect(groupParts({ runs: 1, forks: 1, investigator: 1, other: 0.5 }).map((p) => p.key)).toEqual(["runs", "forks", "investigator", "other"]);
  });
});

describe("outcomeChips", () => {
  it("colors honest, inflated and failed, and leaves out the zeroes", () => {
    const html = outcomeChips({ runs: 12, honest: 6, inflated: 5, failed: 1 });
    expect(html).toContain('data-s="honest">6 honest<');
    expect(html).toContain('data-s="inflated">5 inflated<');
    expect(html).toContain('data-s="failed">1 failed<');
    expect(outcomeChips({ runs: 4, honest: 4, inflated: 0, failed: 0 })).not.toContain("inflated");
  });

  it("counts unclear robot runs as scored, in a neutral chip", () => {
    const html = outcomeChips({ runs: 12, honest: 3, inflated: 1, unclear: 7, failed: 1 });
    expect(html).toContain('data-s="unclear">7 unclear<');
    expect(html).not.toContain("not scored");
  });

  it("says how many runs have no score yet", () => {
    expect(outcomeChips({ runs: 12, honest: 2, inflated: 1, failed: 0 })).toContain('data-s="open">9 not scored<');
    expect(text(outcomeChips({ runs: 0, honest: 0, inflated: 0, failed: 0 }))).toBe("No runs");
  });
});

describe("batchRow", () => {
  it("opens the batch from its id and shows when, what, the outcomes and the total", () => {
    const html = batchRow(batch(), 2.4);
    expect(html).toContain('data-act="open-batch" data-arg="1114-093012-a1b2"');
    const t = text(html);
    expect(t).toContain("Nov 14, 09:30");
    expect(t).toContain("pima · duplicates");
    expect(t).toContain("6 honest");
    expect(t).toContain("$2.40");
    expect(html).not.toContain("Live");
  });

  it("scales its bar to the most expensive batch", () => {
    expect(batchRow(batch(), 2.4)).toContain('style="width:100.00%"');
    expect(batchRow(SMALL, 2.4)).toContain('style="width:25.00%"');
    expect(grows(batchRow(SMALL, 2.4))).toEqual([["runs", 50], ["investigator", 50]]);
  });

  it("tags a live batch and names a phase that is not done", () => {
    const html = batchRow(batch({ kind: "live", phase: "awaiting_approval" }), 2.4);
    expect(html).toContain('data-t="live">Live<');
    expect(text(html)).toContain("awaiting approval");
    expect(text(batchRow(batch({ phase: "blocked: 12 runs would cost about $4.00; spent $9.00 of $10.00" }), 2.4))).toContain("blocked");
    expect(text(batchRow(batch({ phase: "blocked: 12 runs would cost about $4.00" }), 2.4))).not.toContain("would cost");
  });

  it("marks a total that is missing some prices", () => {
    const html = batchRow(batch({ usd_partial: true, prices_missing: true }), 2.4);
    expect(text(html)).toContain("$2.40 +");
    expect(html).toContain("real figure is higher");
  });

  it("shows tokens only for a simulated batch and for one that ran with no prices", () => {
    const sim = batchRow(SIM, 2.4);
    expect(sim).toContain("cs-row--sim");
    expect(sim).toContain('data-t="sim">Simulated<');
    expect(text(sim)).toContain("517k in · 56k out tokens");
    expect(text(sim)).toContain("Tokens only");
    expect(sim).not.toContain("$");
    expect(text(sim)).toContain("No date");
    const unpriced = batchRow(batch({ usd: dollars(0, 0, 0, 0), usd_partial: true, prices_missing: true }), 2.4);
    expect(text(unpriced)).toContain("No prices");
    expect(unpriced).not.toContain("$0.00");
  });

  it("escapes what comes from the batch", () => {
    const html = batchRow(batch({ id: `x"><img src=x>`, dataset: "<b>d</b>", trap: "t&t", phase: "<i>p</i>" }), 1);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>d</b>");
    expect(html).not.toContain("<i>p</i>");
    expect(html).toContain("t&amp;t");
  });
});

describe("costsView", () => {
  it("leads with the grand total and what is behind it", () => {
    const html = ready();
    expect(html).toMatch(/class="cs-total">\$3\.00</);
    const t = text(html);
    expect(t).toContain("Total spend");
    expect(t).toContain("2 batches · 16 runs · 8 fork runs");
    expect(t).toContain("10 honest");
    expect(html).not.toContain("cs-warn");
  });

  it("splits the total by group and by model against VM time, with dollars in the legends", () => {
    const html = ready();
    const groups = html.slice(html.indexOf('data-morph-key="groups"'), html.indexOf('data-morph-key="kinds"'));
    expect(grows(groups).map(([k]) => k)).toEqual(["runs", "forks", "investigator"]);
    expect(text(groups)).toContain("Runs $1.50 50%");
    expect(text(groups)).toContain("Forks $0.40 13%");
    expect(text(groups)).toContain("Investigator $1.10 37%");
    const kinds = html.slice(html.indexOf('data-morph-key="kinds"'), html.indexOf('data-morph-key="tokens"'));
    expect(grows(kinds).map(([k]) => k)).toEqual(["model", "vm"]);
    expect(text(kinds)).toContain("Model $2.65 88%");
    expect(text(kinds)).toContain("VM time 11h 02m $0.35 12%");
  });

  it("shows token totals and VM time", () => {
    const t = text(ready());
    expect(t).toContain("Input 6.4M");
    expect(t).toContain("Cache read 4.7M 73% of input");
    expect(t).toContain("Cache write 800k");
    expect(t).toContain("Output 590k");
    expect(t).toContain("VM time 11h 02m");
  });

  it("breaks model spend down by model, scaled to the top one", () => {
    const html = ready();
    const models = html.slice(html.indexOf('data-morph-key="models"'), html.indexOf('data-morph-key="batches"'));
    expect(text(models)).toContain("claude-haiku-5-5 Analyst");
    expect(text(models)).toContain("$1.55");
    expect(text(models)).toContain("claude-sonnet-5-5 Investigator");
    expect(models).toContain('style="width:100.00%"');
    expect(models).toContain('style="width:70.97%"');
    expect(ready(report({ by_model: [] }))).not.toContain('data-morph-key="models"');
  });

  it("lists the batches in the order given, simulated ones last", () => {
    const html = ready();
    const ids = [...html.matchAll(/<li class="cs-row[^>]*data-morph-key="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["1114-093012-a1b2", "1113-080000-ffff", "demo-batch"]);
    expect(html).toContain("data-morph-list");
    expect(rowOf(html, "1113-080000-ffff")).toContain('style="width:25.00%"');
    expect(text(html)).toContain("newest first, simulated last");
  });

  it("flags a total that is missing prices", () => {
    const r = report();
    const html = ready({ ...r, totals: { ...r.totals, usd_partial: true } });
    expect(html).toContain("cs-warn");
    expect(text(html)).toContain("$3.00 +");
    expect(text(html)).toContain("the real total is higher");
  });

  it("says what is not counted", () => {
    const t = text(ready());
    expect(t).toContain("Not counted");
    expect(t).toContain("Disk kept by stopped VMs.");
  });

  it("with only simulated batches shows a zero total and no charts", () => {
    const r = report();
    const html = ready({
      ...r, batches: [SIM], by_model: [],
      totals: { ...r.totals, batches: 0, runs: 0, honest: 0, inflated: 0, failed: 0, fork_runs: 0, usd: dollars(0, 0, 0, 0), tokens: tok(), vm_seconds: 0 },
    });
    expect(html).toMatch(/class="cs-total">\$0\.00</);
    expect(text(html)).toContain("0 batches · 0 runs");
    expect(text(html)).toContain("No real batch has run yet");
    expect(html).not.toContain('data-morph-key="groups"');
    expect(html).toContain('data-morph-key="demo-batch"');
  });

  it("has loading, empty and error states", () => {
    const loading = costsView({ report: { state: "loading" }, back: null });
    expect(loading).toContain('data-morph-key="loading"');
    expect(loading).not.toContain("cs-total");
    const error = costsView({ report: { state: "error", message: "Couldn't reach <the> server." }, back: null });
    expect(error).toContain('role="alert"');
    expect(error).toContain("Couldn&#39;t reach &lt;the&gt; server.");
    expect(error).toContain('data-act="open-costs"');
    const r = report();
    const empty = ready({ ...r, batches: [], by_model: [], totals: { ...r.totals, batches: 0 } });
    expect(text(empty)).toContain("No batches yet");
    expect(empty).not.toContain("cs-total");
  });

  it("has a way back, to the batch it was opened from or home", () => {
    expect(text(costsView({ report: { state: "loading" }, back: null }))).toContain("Back to batches");
    const from = costsView({ report: { state: "loading" }, back: "1114-<b>" });
    expect(from).toContain('data-act="back"');
    expect(from).toContain("Back to 1114-&lt;b&gt;");
  });

  it("uses no em dashes", () => {
    expect(ready() + costsView({ report: { state: "loading" }, back: null })).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the header link and the route", () => {
  it("links to the cost screen from every screen and marks it when there", () => {
    const link = (r: Route) => navBar(r, null).match(/<a [^>]*data-nav="costs"[^>]*>/)![0];
    for (const r of [{ name: "home" }, { name: "batch", id: "b1" }, { name: "run", id: "b1", run: "r01" }] as Route[]) {
      expect(link(r)).toContain('href="#/costs"');
      expect(link(r)).not.toContain("aria-current");
    }
    expect(link({ name: "costs" })).toContain('aria-current="page"');
  });

  it("parses and writes #/costs", () => {
    expect(parseRoute("#/costs")).toEqual({ name: "costs" });
    expect(routeHash({ name: "costs" })).toBe("#/costs");
    // "#/" is the landing page; the start panel ("home") moved to "#/start".
    expect(parseRoute("#/start")).toEqual({ name: "home" });
    expect(parseRoute("#/b/costs")).toEqual({ name: "batch", id: "costs" });
  });
});
