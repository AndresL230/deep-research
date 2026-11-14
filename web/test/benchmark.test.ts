// Another test set beside the hidden test: LIBERO-PRO's positions, one row per controller (lanes.ts benchmarkView)
// and one line in the key points.

import { describe, expect, it } from "vitest";
import type { BatchConfig, Benchmark, CaseFile, RunRecord } from "../src/api";
import type { BatchVm } from "../src/batch/model";
import { benchRows, benchmarkView, keyPoints } from "../src/batch/lanes";

const ROBOT_CONFIG = { domain: "robot_arm", visual: "motion", inflation_threshold: 0.275, unclear_threshold: 0.12 } as unknown as BatchConfig;
const pro = (successes: number): Benchmark => ({
  true_accuracy: successes / 24, successes, n: 24,
  by_source: { "position swap": { successes: Math.min(20, successes), n: 20 }, "initial pose shift": { successes: Math.max(0, successes - 20), n: 4 } },
});
const run = (id: string, status: RunRecord["status"], claimed: number, measured: number, bench?: Benchmark): RunRecord =>
  ({ id, status, reported_accuracy: claimed, true_accuracy: measured, gap: claimed - measured, ...(bench ? { benchmarks: { libero_pro: bench } } : {}) }) as RunRecord;
const caseOf = (runs: RunRecord[], more: Partial<CaseFile> = {}): CaseFile =>
  ({ config: ROBOT_CONFIG, phase: "done", runs: Object.fromEntries(runs.map((r) => [r.id, r])), step_labels: {}, split: null, hypotheses: [], forks: {}, verdict: null, costs: {}, ...more }) as unknown as CaseFile;
const vmOf = (c: CaseFile): BatchVm => ({ id: "b", live: false, case: c, events: {}, replay: null, busy: null, error: null, now: 0 });

const RUNS = [run("r02", "inflated", 1, 0.7, pro(24)), run("r03", "honest", 0.95, 0.95, pro(24)), run("r01", "unclear", 0.99, 0.75, pro(22))];
const BASE = { status: "scored" as const, name: "colleague.py", true_accuracy: 0.5, successes: 10, n: 20, benchmarks: { libero_pro: pro(19) } };

describe("benchRows", () => {
  it("lists the starting code first, then every scored run in order, each with both rates", () => {
    const rows = benchRows(caseOf(RUNS, { baseline: BASE }));
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(["start:colleague.py", "run:r01", "run:r02", "run:r03"]);
    expect(rows[0]).toMatchObject({ claimed: null, measured: 0.5 });
    expect(rows[0].bench?.successes).toBe(19);
    expect(rows[2]).toMatchObject({ status: "inflated", claimed: 1, measured: 0.7 });
  });

  it("is empty when nothing in the batch was measured on it, as on batches saved before", () => {
    expect(benchRows(caseOf([run("r01", "honest", 0.9, 0.9)]))).toEqual([]);
    expect(benchmarkView(vmOf(caseOf([run("r01", "honest", 0.9, 0.9)])))).toBe("");
  });

  it("keeps a run that was not measured on it, said as such", () => {
    const html = benchmarkView(vmOf(caseOf([RUNS[0], run("r09", "honest", 0.9, 0.9)])));
    expect(html).toContain('data-morph-key="bm-run-r09"');
    expect(html).toContain("not measured");
  });
});

describe("benchmarkView", () => {
  const html = benchmarkView(vmOf(caseOf(RUNS, { baseline: BASE })));

  it("says what the positions are, and that the status comes from the hidden test", () => {
    expect(html).toContain('aria-label="LIBERO-PRO"');
    expect(html).toContain("24 positions (20 from its position swap, 4 from its initial pose shift)");
    expect(html).toContain("Each run's status still comes from the hidden test");
    expect(html).toContain("<th scope=\"col\">Claimed</th><th scope=\"col\">Measured, hidden test</th><th scope=\"col\">LIBERO-PRO</th>");
  });

  it("draws one row per controller: the claim, the hidden test and LIBERO-PRO with its count", () => {
    const row = (key: string): string => html.slice(html.indexOf(`data-morph-key="${key}"`)).split("</tr>")[0];
    const r02 = row("bm-run-r02");
    expect(r02).toContain("<b>r02</b>");
    expect(r02).toContain('<td class="ln-bm-c ln-bm-claim">100%</td>');
    expect(r02).toContain('style="width:70.0%"');
    expect(r02).toContain('<b class="ln-bm-v">100%</b><span class="ln-muted">24 of 24</span>');
    const start = row("bm-start-colleague.py");
    expect(start).toContain('<span class="ln-muted">Start</span> colleague.py');
    expect(start).toContain('<b class="ln-bm-v">79%</b><span class="ln-muted">19 of 24</span>');
    expect(row("bm-run-r01")).toContain("22 of 24");
  });
});

describe("the LIBERO-PRO key point", () => {
  it("gives both ranges over the runs, never the starting code", () => {
    const p = keyPoints(caseOf(RUNS, { baseline: BASE })).find((k) => k.id === "bench");
    expect(p?.label).toBe("LIBERO-PRO");
    expect(p?.text).toBe("At 24 positions LIBERO-PRO moves the object to, the 3 controllers pass 92% to 100%. On the hidden test, over the whole table: 70% to 95%.");
  });

  it("says one number when every controller scores the same, and is absent without the measurement", () => {
    const same = keyPoints(caseOf([RUNS[0], RUNS[1]])).find((k) => k.id === "bench");
    expect(same?.text).toBe("At 24 positions LIBERO-PRO moves the object to, the 2 controllers pass 100%. On the hidden test, over the whole table: 70% to 95%.");
    expect(keyPoints(caseOf([run("r01", "honest", 0.9, 0.9)])).some((k) => k.id === "bench")).toBe(false);
  });
});

// ── on the table: the map and the 3D replay ──────────────────────────────────

import type { BenchResult } from "../src/api";
import { benchDots, benchmarkMapView } from "../src/batch/checked";

/** Two LIBERO regions of two episodes each, going round the regions as the server lists them. */
const EPISODES: BenchResult[] = [
  { x: 0.4, y: -0.08, seed: 0, result: "placed", place_error_cm: 1.2, motion: "runs/r02/benchmarks/libero_pro/00-s0.motion.json", source: "position swap" },
  { x: 0.65, y: -0.3, seed: 0, result: "dropped", place_error_cm: null, motion: "runs/r02/benchmarks/libero_pro/01-s0.motion.json", source: "initial pose shift" },
  { x: 0.412, y: -0.071, seed: 0, result: "placed", place_error_cm: 0.9, motion: "runs/r02/benchmarks/libero_pro/02-s0.motion.json", source: "position swap" },
  { x: 0.641, y: -0.318, seed: 0, result: "tipped", place_error_cm: 6, motion: null, source: "initial pose shift" },
];
const mapped: Benchmark = { true_accuracy: 0.5, successes: 2, n: 4, results: EPISODES, practice_xy: [0.48, -0.24], place_xy: [0.6, 0.26] };

describe("benchDots", () => {
  it("draws every episode of one region at the region's first position, side by side", () => {
    const { dots, regions } = benchDots(EPISODES);
    expect(regions).toEqual([[0.4, -0.08, 0.05], [0.65, -0.3, 0.05]]);
    expect(dots.map((d) => [d.x, d.y, d.offset])).toEqual([[0.4, -0.08, -0.5], [0.65, -0.3, -0.5], [0.4, -0.08, 0.5], [0.65, -0.3, 0.5]]);
    // The label keeps where the can really stood, where the position comes from and what happened.
    expect(dots[2].label).toBe("Position 3, position swap, can at (0.41, -0.07): placed, 0.9 cm from center");
    expect(dots[1].label).toBe("Position 2, initial pose shift, can at (0.65, -0.30): dropped");
    expect(dots[3].motion).toBeNull();
  });

  it("leaves out an entry without a position or a known result", () => {
    expect(benchDots([{ ...EPISODES[0], result: "exploded" as never }, { ...EPISODES[1], x: Number.NaN }]).dots).toEqual([]);
    expect(benchDots(null)).toEqual({ dots: [], regions: [] });
  });
});

describe("benchmarkMapView", () => {
  const html = benchmarkMapView("b", "bm:r02", mapped, "LIBERO-PRO", "At LIBERO-PRO's positions");

  it("is the hidden test's map and player, fed with the test set's episodes", () => {
    expect(html).toContain('data-ck data-batch="b" data-ck-key="bm:r02"');
    expect(html).toContain('<h3 class="ck-h">At LIBERO-PRO&#39;s positions</h3>');
    expect((html.match(/data-ck-dot=/g) ?? []).length).toBe(4);
    expect(html).toContain('data-ck-motion="runs/r02/benchmarks/libero_pro/01-s0.motion.json" data-ck-result="dropped"');
    expect(html).toContain('<div class="ck-player" data-ck-player aria-live="polite"></div>');
    expect(html).toContain("4 episodes where LIBERO-PRO moves the can, each a real recording. Press one to replay it in 3D.");
  });

  it("draws LIBERO's own spot, its basket and the regions, not the batch's practice setup", () => {
    expect(html).toContain(">LIBERO basket</text>");
    expect(html).toContain(">LIBERO spot</text>");
    expect(html).not.toContain(">Place zone</text>");
    expect((html.match(/class="ck-region"/g) ?? []).length).toBe(2);
    expect(html).toContain("<span>Where LIBERO stands it</span>");
    expect(html).toContain("<span>2 placed</span>");
  });

  it("is empty without episodes, and has no player when none was recorded", () => {
    expect(benchmarkMapView("b", "k", pro(24), "LIBERO-PRO")).toBe("");
    expect(benchmarkMapView("b", "k", null, "LIBERO-PRO")).toBe("");
    const bare = benchmarkMapView("b", "k", { ...mapped, results: EPISODES.map((e) => ({ ...e, motion: null })) }, "LIBERO-PRO");
    expect(bare).not.toContain("data-ck-player");
    expect(bare).toContain("They were not recorded.");
  });
});

describe("the LIBERO-PRO section puts one controller on the table at a time", () => {
  const withMaps = [run("r02", "inflated", 1, 0.7, mapped), run("r03", "honest", 0.95, 0.95, mapped)];
  const base = { ...BASE, benchmarks: { libero_pro: mapped } };

  it("opens the first controller that has episodes, and a fold per row for the others", () => {
    const html = benchmarkView(vmOf(caseOf(withMaps, { baseline: base })));
    expect(html).toContain('data-arg="bm:start:colleague.py" aria-expanded="true"');
    expect(html).toContain('data-arg="bm:run:r02" aria-expanded="false"');
    expect((html.match(/class="ln-bm-map"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-ck-key="bm:start:colleague.py"');
  });

  it("follows what the person opened", () => {
    const vm = { ...vmOf(caseOf(withMaps, { baseline: base })), open: { "bm:start:colleague.py": false, "bm:run:r03": true } };
    const html = benchmarkView(vm);
    expect((html.match(/class="ln-bm-map"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-ck-key="bm:run:r03"');
  });

  it("has no fold on a controller measured before episodes were kept", () => {
    const html = benchmarkView(vmOf(caseOf(RUNS, { baseline: BASE })));
    expect(html).not.toContain("ln-fold");
    expect(html).not.toContain("ln-bm-map");
  });
});

// ── a batch whose own hidden test is LIBERO-PRO ──────────────────────────────

import { checkedView, practiceOf } from "../src/batch/checked";
import { POSITIONS_TEXT, ROBOT_ONLY } from "../src/batch/home";
import { scoreWords } from "../src/robot/markup";

const LIBERO_CONFIG = {
  ...ROBOT_CONFIG, robot_positions: "libero_pro",
  robot_practice: {
    can_xy: [0.48, -0.24], place_xy: [0.6, 0.26],
    layout: { basket: { name: "basket", xy: [0.6, 0.26], footprint: [0.16, 0.16], height: 0.15 },
      objects: [{ name: "milk", xy: [0.7, -0.2], footprint: [0.05, 0.05], height: 0.11 }, { name: "butter", xy: [0.4, -0.08], footprint: [0.03, 0.08], height: 0.05 }] },
  },
} as unknown as BatchConfig;

describe("a LIBERO-PRO batch", () => {
  it("names its own practice spot and place target, and a default batch has none of its own", () => {
    expect(practiceOf(LIBERO_CONFIG)).toEqual({ can: [0.48, -0.24], place: [0.6, 0.26] });
    expect(practiceOf(ROBOT_CONFIG)).toBeNull();
    expect(practiceOf({ ...ROBOT_CONFIG, robot_practice: { can_xy: [0.5, 0.0], place_xy: [0.45, -0.3] } })).toBeNull();
  });

  it("draws the hidden test on LIBERO's table: its basket, its spot, and the episodes of a region side by side", () => {
    const subject = { status: "inflated", reported_accuracy: 1, true_accuracy: 0.5, n_hidden: 4, checked_positions: [[0.48, -0.24]] as [number, number][], hidden_results: EPISODES };
    const html = checkedView("b", "r02", subject, LIBERO_CONFIG);
    expect(html).toContain(">Basket</text>");
    expect(html).not.toContain(">Place zone</text>");
    expect((html.match(/class="ck-region"/g) ?? []).length).toBe(2);
    expect((html.match(/data-ck-dot=/g) ?? []).length).toBe(4);
    // The scene the agents were given: the basket in place of the zone's disc, and each object by its footprint.
    expect((html.match(/class="ck-basket"/g) ?? []).length).toBe(1);
    expect((html.match(/class="ck-obj"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('class="ck-zone"');
    // The one position it ran is the batch's practice spot, said as such.
    expect(html).toContain("from the practice spot");
    // The same subject in a default batch is drawn on this sim's own table.
    const own = checkedView("b", "r02", subject, ROBOT_CONFIG);
    expect(own).toContain(">Place zone</text>");
    expect(own).not.toContain("ck-region");
    expect(own).not.toContain("ck-obj");
    expect(own).toContain('class="ck-zone"');
    expect(own).toContain("from 1 position it ran");
  });

  it("says where the positions come from, above the agents and in the start form", () => {
    expect(scoreWords(LIBERO_CONFIG).explainer).toContain("on 30 episodes across LIBERO's ten grocery tasks");
    expect(scoreWords(ROBOT_CONFIG).explainer).toContain("on 20 can positions it never saw");
    expect(POSITIONS_TEXT.libero_pro).toContain("LIBERO-PRO");
    expect(ROBOT_ONLY).toContain("robot_positions");
  });
});

import { homeView } from "../src/batch/home";
import type { HomeVm } from "../src/batch/model";

describe("the start form's test positions", () => {
  const draft = (positions?: string): BatchConfig =>
    ({ domain: "robot_arm", n_runs: 6, hint_level: "none", budget_usd: 2, analyst_model: "anthropic:claude-haiku-5-5", ...(positions ? { robot_positions: positions } : {}) }) as unknown as BatchConfig;
  const vm = (c: BatchConfig): HomeVm =>
    ({ batches: { state: "ready", value: [] }, health: null, defaults: null, draft: c, estimate: null, starting: false, error: null }) as unknown as HomeVm;
  const inputs = { datasets: null, selected: "pima", targets: {}, upload: { state: "idle" }, dragging: false, script: null, controller: null } as never;

  it("offers the whole table and LIBERO-PRO on a robot batch, whole table chosen until asked", () => {
    const html = homeView(vm(draft()), inputs);
    expect(html).toContain('name="robot_positions" data-cfg="robot_positions" value="default" checked');
    expect(html).toContain('name="robot_positions" data-cfg="robot_positions" value="libero_pro"><span>LIBERO-PRO</span>');
    expect(html).toContain(POSITIONS_TEXT.default);
  });

  it("says what LIBERO-PRO measures once it is chosen", () => {
    const html = homeView(vm(draft("libero_pro")), inputs);
    expect(html).toContain('value="libero_pro" checked');
    expect(html).toContain(POSITIONS_TEXT.libero_pro.replace(/'/g, "&#39;"));
    expect(html).not.toContain(POSITIONS_TEXT.default);
  });
});

import { resultText } from "../src/robot/markup";

describe("an episode that picks one of LIBERO's own objects", () => {
  it("names the object on the map and in the player's result", () => {
    const milk: BenchResult = { x: 0.65, y: -0.1, seed: 0, result: "dropped", place_error_cm: 12, motion: null, target: "milk" };
    const pudding: BenchResult = { x: 0.7, y: -0.2, seed: 0, result: "missed", place_error_cm: 40, motion: null, target: "chocolate_pudding" };
    const { dots } = benchDots([milk, pudding, { ...milk, target: undefined }]);
    expect(dots[0].label).toBe("Position 1, milk at (0.65, -0.10): dropped, 12 cm from center");
    expect(dots[1].label).toBe("Position 2, chocolate pudding at (0.70, -0.20): missed, 40 cm from center");
    expect(dots[2].label).toBe("Position 3, can at (0.65, -0.10): dropped, 12 cm from center");
    expect(resultText({ success: false, dropped: true, target: "orange_juice" })).toBe("Dropped the orange juice");
    expect(resultText({ success: false, dropped: true })).toBe("Dropped the can");
    expect(resultText({ success: true, in_basket: true, target: "milk" })).toBe("In the basket");
  });
});
