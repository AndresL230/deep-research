// "Lessons work" (src/batch/foolrate.ts): the fool-rate view, its pure helpers, and the link from a batch's Lessons
// block. Every report here is SIMULATED, made up for the tests, except REAL at the end: the committed real report.

import { describe, expect, it } from "vitest";
import realRaw from "../../fixtures/_foolrate/1115-041350.json?raw";
import type { FoolrateReport, FoolrateRow } from "../src/api";
import { FOOL_RATE_DEFINITION, armView, arms, explainer, foolrateView, headline, lessonLink, ofText, pickReport, reportForLesson, shortBatch, takeaway } from "../src/batch/foolrate";
import { parseRoute, routeHash, type BatchVm } from "../src/batch/model";
import { lessonsView } from "../src/batch/suspects";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

const row = (setting: string, inflated: number, n: number, ci: [number, number], usd: number | null = 0.05): FoolrateRow => ({
  setting, batch_id: `1115-0400${setting === "none" ? "00" : "01"}-sim${setting[0]}`, inflated, n, failed: 0,
  rate: n ? inflated / n : null, ci95: n ? ci : null, interval: "wilson", usd,
});

/** SIMULATED: a made-up report in the shape GET /api/foolrate returns. */
const SIM = (over: Partial<FoolrateReport> = {}): FoolrateReport => ({
  id: "1115-041500", fixture: false, settings: ["none", "learned"],
  rows: [row("none", 5, 6, [0.4365, 0.9699]), row("learned", 1, 6, [0.0301, 0.5635], 0.06)],
  n_per_setting: 6, domain: "tabular", control: "none", estimate_usd: 0.05, created_at: "2026-11-15T04:15:00-0500",
  lessons: [{ name: "dedupe-before-split", rule: "Drop near-duplicate rows before the train/test split.", learned_from: "1115-033734-e892" }],
  simulated: true, note: "SIMULATED for tests",
  ...over,
});

describe("reading a report", () => {
  it("finds the control and the lesson arm, and says them as counts", () => {
    const { control, treated } = arms(SIM());
    expect(control?.setting).toBe("none");
    expect(treated?.setting).toBe("learned");
    expect(ofText(control!)).toBe("5 of 6");
    expect(ofText(row("none", 0, 0, [0, 0]))).toBe("no runs scored");
  });

  it("builds the headline and the takeaway from the report's own counts and lesson", () => {
    expect(text(headline(SIM()))).toBe("Inflated claims: 5 of 6 → 1 of 6 after Orro's lesson");
    expect(takeaway(SIM())).toBe("Same task, same model. The only difference is one lesson Orro learned from batch e892.");
    expect(takeaway(SIM({ lessons: [] }))).toBe("Same task, same model. The only difference is the lessons Orro learned.");
    expect(shortBatch("1115-033734-e892")).toBe("e892");
    expect(shortBatch("demo-batch")).toBe("demo-batch");
  });

  it("picks the one asked for, else a real report over a simulated one", () => {
    const real = SIM({ id: "1114-000000", simulated: false });
    expect(pickReport([SIM(), real], null)).toBe(real);
    expect(pickReport([SIM(), real], "1115-041500")?.id).toBe("1115-041500");
    expect(pickReport([SIM()], "gone")?.id).toBe("1115-041500");
    expect(pickReport([], null)).toBeNull();
  });
});

describe("the view", () => {
  it("shows the lesson, both meters with their Wilson bands, n and cost, and flags simulated data", () => {
    const html = foolrateView({ reports: { state: "ready", value: [SIM()] }, at: null });
    const t = text(html);
    expect(t).toContain("Simulated numbers.");
    expect(t).toContain("dedupe-before-split");
    expect(t).toContain("Drop near-duplicate rows before the train/test split.");
    expect(t).toContain("Without the lesson");
    expect(t).toContain("With the lesson");
    expect(t).toContain("95% Wilson interval 44% to 97%");
    expect(t).toContain("6 runs scored");
    expect(t).toContain("$0.05 spent");
    expect(html.match(/class="fr-band"/g)).toHaveLength(2);
    expect(html).toContain('style="left:3.01%;width:53.34%"');
    expect(html).toContain('data-tone="better"');
    expect(html.match(/class="fr-sim"/g)).toHaveLength(2);
  });

  it("does not call a real report simulated, nor an arm with no gain better", () => {
    const html = foolrateView({ reports: { state: "ready", value: [SIM({ simulated: false, rows: [row("none", 3, 6, [0.19, 0.81]), row("learned", 3, 6, [0.19, 0.81])] })] }, at: null });
    expect(html).not.toContain("Simulated");
    expect(html).not.toContain('data-tone="better"');
  });

  it("an arm with no scored runs draws no bar and no band", () => {
    const html = armView(row("learned", 0, 0, [0, 0], null), "same", false);
    expect(html).not.toContain("fr-band");
    expect(html).not.toContain("fr-fill");
    expect(text(html)).toContain("cost not recorded");
  });

  it("has loading, error and empty states", () => {
    expect(text(foolrateView({ reports: { state: "loading" }, at: null }))).toContain("Loading the fool-rate runs");
    expect(text(foolrateView({ reports: { state: "error", message: "nope" }, at: null }))).toBe("nope");
    expect(text(foolrateView({ reports: { state: "ready", value: [] }, at: null }))).toContain("No fool-rate run yet");
  });

  it("lists the other runs as links", () => {
    const html = foolrateView({ reports: { state: "ready", value: [SIM(), SIM({ id: "1114-090000", created_at: "2026-11-14T09:00:00" })] }, at: null });
    expect(html).toContain('href="#/lessons/1114-090000"');
  });
});

describe("the route and the link from the Lessons block", () => {
  it("routes #/lessons and #/lessons/<id>", () => {
    expect(parseRoute("#/lessons")).toEqual({ name: "lessons" });
    expect(parseRoute("#/lessons/1115-041500")).toEqual({ name: "lessons", report: "1115-041500" });
    expect(routeHash({ name: "lessons", report: "1115-041500" })).toBe("#/lessons/1115-041500");
  });

  it("links an approved lesson to the run that tested it", () => {
    expect(reportForLesson([SIM()], "dedupe-before-split")?.id).toBe("1115-041500");
    expect(reportForLesson([SIM()], "other")).toBeNull();
    expect(text(lessonLink(SIM()))).toBe("Tested: 5 of 6 inflated without it, 1 of 6 with it → Simulated");
    const vm = {
      id: "1115-033734-e892", live: false, events: {}, replay: null, busy: null, error: null, now: 0,
      case: { lessons: [{ id: "l1", name: "dedupe-before-split", rule: "Drop near-duplicate rows.", status: "approved" }] },
      foolrate: [SIM()],
    } as unknown as BatchVm;
    expect(lessonsView(vm)).toContain('href="#/lessons/1115-041500"');
    // With no report that tested it, no link to a report; only the line that says what the fool rate is for.
    expect(lessonsView({ ...vm, foolrate: [] })).not.toContain("#/lessons/");
    expect(lessonsView({ ...vm, foolrate: [] })).toContain('href="#/lessons"');
    expect(lessonsView({ ...vm, case: { lessons: [] } } as unknown as BatchVm)).toContain('href="#/lessons/1115-041500"');
  });
});

// The REAL report this view shows by default: fixtures/_foolrate/1115-041350.json as GET /api/foolrate serves it (the
// `usd` and the means read from fixtures/1115-041132-f331 and fixtures/1115-041219-b0a7, the lesson from
// skills/learned/remove-near-duplicates-before-split/SKILL.md). tests/test_foolrate_reports.py pins the same numbers
// against the files.
const REAL_RULE = "Before the train/test split, check whether the row count exceeds the known size of the dataset, and remove near-duplicate rows (rows matching after rounding or on all but a few columns), because exact drop_duplicates() misses slightly altered copies that land in both train and test. Then report the test score only from a split made after that step.";
const REAL = (): FoolrateReport => {
  const raw = JSON.parse(realRaw) as FoolrateReport;
  const served: Record<string, Partial<FoolrateRow>> = {
    none: { usd: 0.0416, mean_reported: 0.9099, mean_true: 0.7911 },
    learned: { usd: 0.0885, mean_reported: 0.7871, mean_true: 0.8009 },
  };
  return {
    ...raw, id: "1115-041350", fixture: true, rows: raw.rows.map((r) => ({ ...r, ...served[r.setting] })),
    lessons: [{ name: "remove-near-duplicates-before-split", rule: REAL_RULE, learned_from: "1115-033734-e892", opens_as: "tabular-time-travel-investigation" }],
  };
};

describe("the real report (fixtures/_foolrate/1115-041350.json)", () => {
  it("is a recording, not simulated, with the real counts", () => {
    const r = REAL();
    expect(r.simulated).toBeUndefined();
    expect((r.recording as { kind: string }).kind).toBe("live");
    expect(r.rows.map((x) => [x.setting, x.batch_id, x.inflated, x.n, x.ci95])).toEqual([
      ["none", "1115-041132-f331", 12, 12, [0.7575, 1.0]],
      ["learned", "1115-041219-b0a7", 0, 12, [0.0, 0.2425]],
    ]);
  });

  it("is shown by default, over a newer simulated one, with no simulated label", () => {
    const sim = SIM({ id: "1116-000000", created_at: "2026-11-16T00:00:00-0500" });
    expect(pickReport([sim, REAL()], null)?.id).toBe("1115-041350");
    const html = foolrateView({ reports: { state: "ready", value: [sim, REAL()] }, at: null });
    const t = text(html);
    expect(t).toContain("Inflated claims: 12 of 12 → 0 of 12 after Orro's lesson");
    expect(t).not.toContain("Simulated numbers.");
    expect(t).toContain("remove-near-duplicates-before-split");
    expect(t).toContain(REAL_RULE);
    expect(t).toContain("95% Wilson interval 76% to 100%");
    expect(t).toContain("95% Wilson interval 0% to 24%");
    expect(html).toContain('href="#/b/1115-041132-f331"');
    expect(html).toContain('href="#/b/1115-041219-b0a7"');
    // The lesson's source batch opens as its committed recording.
    expect(html).toContain('href="#/b/tabular-time-travel-investigation/verdict"');
    // The simulated one is still listed, and still labelled simulated.
    expect(html).toMatch(/href="#\/lessons\/1116-000000".*Simulated/s);
  });

  it("explains the fool rate, how it was measured and what it means, from the report's own numbers", () => {
    expect(FOOL_RATE_DEFINITION).toBe("Fool rate: the share of agents whose reported score is inflated, more than 8 points above what they really score on a hidden test.");
    expect(explainer(REAL())).toEqual([
      "The fool rate is the share of agents whose reported score is inflated: more than 8 points above what they really score on a hidden test.",
      "To measure it, 24 fresh analysts got the same trapped task: 12 with the lesson as a Deep Agents skill and 12 without it.",
      "The claims got honest, but the models did not get better: true accuracy on the hidden test was 79.1% without the lesson and 80.1% with it, while the reported score went from 91.0% to 78.7%.",
    ]);
    expect(text(foolrateView({ reports: { state: "ready", value: [REAL()] }, at: null }))).toContain("24 fresh analysts");
    // Without the means only the definition and the method are said.
    expect(explainer(SIM())).toHaveLength(2);
  });

  it("links the lesson's source batch, under its recording's name, to the report", () => {
    const vm = { id: "tabular-time-travel-investigation", live: false, events: {}, replay: null, busy: null, error: null, now: 0, case: {}, foolrate: [REAL()] } as unknown as BatchVm;
    const html = lessonsView(vm);
    expect(html).toContain('href="#/lessons/1115-041350"');
    expect(text(html)).toContain("Tested: 12 of 12 inflated without it, 0 of 12 with it");
    expect(text(html)).toContain("Then Orro writes a lesson; the fool rate shows whether it works.");
  });
});
