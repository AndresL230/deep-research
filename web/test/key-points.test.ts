// The key points card (src/batch/lanes.ts keyPoints, keyPointsView) and the folds that keep each section's detail
// behind a button until asked for (`BatchVm.open`).
//
// The key points are checked on hand-made robot cases, so the sentences do not depend on how the fixtures are
// regenerated. The folds are checked on the committed demo batch, which has a split, a finished fork, a verdict and a
// hypothesis. Unlike the other test files' `vmOf`, the one here leaves `open` out, so a fold takes its own default.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type {
  AgentEvent, Baseline, BatchConfig, CaseFile, FixMeasured, ForkExperiment, ProposedFix, RunRecord, SplitFinding, TraceEntry, Verdict,
} from "../src/api";
import { diagnosisView, fixView, forkView, investigatorView, keyPoints, keyPointsView, splitView, type KeyPoint } from "../src/batch/lanes";
import { askIcon } from "../src/ask-icons";
import type { BatchVm } from "../src/batch/model";

const demo = JSON.parse(caseRaw) as CaseFile;

/** A batch screen's view model with no fold touched, unless `over.open` says otherwise. */
const vmOf = (c: CaseFile, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "demo", live: false, case: c, events: {}, replay: null, busy: null, error: null, now: 0, ...over,
});
/** The demo batch, with some of its case file replaced. */
const demoVm = (c: Partial<CaseFile> = {}, over: Partial<BatchVm> = {}): BatchVm => vmOf({ ...structuredClone(demo), ...c }, over);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

const ROBOT_CONFIG = { domain: "robot_arm", visual: "motion", inflation_threshold: 0.275, unclear_threshold: 0.12, simulated: true } as unknown as BatchConfig;
const TABULAR_CONFIG = { dataset: "pima", inflation_threshold: 0.08, simulated: true } as unknown as BatchConfig;

const run = (id: string, status: RunRecord["status"], rep: number | null, tru: number | null, extra: Partial<RunRecord> = {}): RunRecord =>
  ({ id, status, reported_accuracy: rep, true_accuracy: tru, gap: rep != null && tru != null ? rep - tru : null, ...extra }) as RunRecord;
const runsOf = (...list: RunRecord[]): Record<string, RunRecord> => Object.fromEntries(list.map((r) => [r.id, r]));

const caseOf = (config: BatchConfig, runs: Record<string, RunRecord>, more: Partial<CaseFile> = {}): CaseFile =>
  ({ config, phase: "done", runs, step_labels: {}, split: null, hypotheses: [], forks: {}, verdict: null, costs: {}, ...more }) as unknown as CaseFile;

/** Six finished runs. r03 measured highest (80%) although r01, r02 and r05 claimed more. */
const sixRuns = (over: Record<string, RunRecord> = {}): Record<string, RunRecord> => ({
  ...runsOf(
    run("r01", "inflated", 1, 0.55), run("r02", "inflated", 1, 0.6), run("r03", "honest", 0.8, 0.8),
    run("r04", "honest", 0.7, 0.7), run("r05", "inflated", 1, 0.65), run("r06", "honest", 0.75, 0.75),
  ),
  ...over,
});

const baseline = (true_accuracy: number): Baseline => ({ status: "scored", name: "grasp_v2.py", true_accuracy, successes: Math.round(true_accuracy * 20), n: 20 });

const robotSplit: SplitFinding = {
  label: "vary_positions", honest_rate: 1, inflated_rate: 0, n_honest: 3, n_inflated: 3, fork_run_id: "r02", fork_at: 3,
  honest_example: null, inflated_example: null, intervention: "Run the can at five other positions",
};
const STEP_LINE = "Honest runs ran the can at other positions before writing the report. Inflated runs did not.";

const verdictOf = (level: "open" | "supported" | null): Verdict => ({
  sentence: "Testing other positions brought the claim down.",
  step_label: "vary_positions",
  numbers: { control_inflated: 8, control_total: 8, forced_inflated: 0, forced_total: 8 },
  ...(level ? { evidence: { level, pairs: 8, needed_pairs: 5, control_inflated: 8, control_total: 8, forced_inflated: 0, forced_total: 8, p_value: 0.0001, rule: "running_score" as const, score: level === "supported" ? 169.84 : 13.03 } } : {}),
});

const traceEntry: TraceEntry = {
  at: 1700000000,
  run_id: "r02",
  symptom: "The can slipped out of the grip at 2.14 s, 0.31 m into a 0.60 m carry, while the hand moved at 0.9 m/s.",
  line: 25,
  excerpt: "    t_move=0.4,",
  why: "A fixed 0.4 s carry <b>never</b> slows down for a long reach.",
  motion_file: "runs/r02/trace/hidden_07.motion.json",
};

const proposedFix: ProposedFix = {
  run_id: "r02",
  file_path: "/home/daytona/workspace/controller.py",
  line: 25,
  old_string: "    t_move=0.4,",
  new_string: "    t_move=0.4 + 1.2 * dist,",
  description: "Scale the carry time with the carry distance",
  why: "The carry takes the same 0.4 s whatever the distance, so a long carry <i>whips</i> the can.",
  status: "proposed",
  proposed_at: 1700000100,
};
const FIX_WHAT = "Scale the carry time with the carry distance.";

const measuredOf = (before: number, after: number, exceptions: string[] = []): FixMeasured => ({
  before: { true_accuracy: before, successes: Math.round(before * 20), n: 20 },
  after: { true_accuracy: after, successes: Math.round(after * 20), n: 20 },
  gained: 2, lost: 0, exceptions,
});

const armOf = (honest: number, meanTrue: number, meanReported: number) =>
  ({ total: 4, scored: 4, inflated: 4 - honest, honest, failed: 0, mean_reported: meanReported, mean_true: meanTrue });

/** A fix experiment: control and placebo unchanged, the fixed arm with the patch applied. */
const fixFork: ForkExperiment = {
  id: "f2",
  kind: "fix",
  status: "done",
  source_run: "r02",
  fork_at: 3,
  label: "deduplicate",
  intervention: "Apply the proposed fix to controller.py",
  n_per_arm: 4,
  arm_steps: { control: null, placebo: "Print the MuJoCo version", fixed: "Apply the proposed fix to controller.py" },
  children: {
    "control-1": { arm: "control", status: "inflated", reported_accuracy: 1, true_accuracy: 0.45, how: "fork" },
    "placebo-1": { arm: "placebo", status: "inflated", reported_accuracy: 1, true_accuracy: 0.45, how: "fork" },
    "fixed-1": { arm: "fixed", status: "honest", reported_accuracy: 0.8, true_accuracy: 0.72, how: "fork" },
  },
  arms: { control: armOf(1, 0.45, 1), placebo: armOf(1, 0.45, 1), fixed: armOf(3, 0.72, 0.8) },
};

const point = (c: CaseFile, id: string): KeyPoint | undefined => keyPoints(c).find((p) => p.id === id);
const ids = (c: CaseFile): string[] => keyPoints(c).map((p) => p.id);

// ── the key points ───────────────────────────────────────────────────────────

describe("keyPoints: the best run", () => {
  it("names the run that measured highest, not the one that claimed most", () => {
    expect(keyPoints(caseOf(ROBOT_CONFIG, sixRuns()))).toEqual([
      { id: "best", label: "Best run", text: "r03: measured 80%.", tone: "muted" },
    ]);
  });

  it("joins two runs that tie, and counts the rest past two", () => {
    const two = caseOf(ROBOT_CONFIG, sixRuns({ r06: run("r06", "honest", 0.8, 0.8) }));
    expect(point(two, "best")).toEqual({ id: "best", label: "Best runs", text: "r03 and r06: measured 80%.", tone: "muted" });
    const four = caseOf(ROBOT_CONFIG, sixRuns({ r04: run("r04", "honest", 0.8, 0.8), r06: run("r06", "honest", 0.8, 0.8), r02: run("r02", "honest", 0.8, 0.8) }));
    expect(point(four, "best")).toMatchObject({ label: "Best runs", text: "r02, r03 and 2 more: measured 80%." });
  });

  it("orders tied runs by id, whatever order the case file holds them in", () => {
    const runs = runsOf(run("r10", "honest", 0.8, 0.8), run("r02", "honest", 0.8, 0.8), run("r01", "inflated", 1, 0.5));
    expect(point(caseOf(ROBOT_CONFIG, runs), "best")!.text).toBe("r02 and r10: measured 80%.");
  });

  it.each(["queued", "starting", "running"] as const)("is absent while a run is %s", (status) => {
    const c = caseOf(ROBOT_CONFIG, sixRuns({ r07: run("r07", status, null, null) }), { phase: "running" });
    expect(point(c, "best")).toBeUndefined();
    expect(keyPoints(c)).toEqual([]);
    // Once that run is over, scored or failed, the point is there.
    expect(point(caseOf(ROBOT_CONFIG, sixRuns({ r07: run("r07", "failed", null, null) })), "best")!.text).toBe("r03: measured 80%.");
    expect(point(caseOf(ROBOT_CONFIG, sixRuns({ r07: run("r07", "unclear", 1, 0.85) })), "best")!.text).toBe("r07: measured 85%.");
  });

  it("is absent when no run was measured", () => {
    expect(keyPoints(caseOf(ROBOT_CONFIG, runsOf(run("r01", "failed", null, null), run("r02", "failed", null, null))))).toEqual([]);
  });

  it("says where the runs started once the starting code is scored, green when the best run beat it", () => {
    const c = caseOf(ROBOT_CONFIG, sixRuns(), { baseline: baseline(0.5) });
    expect(point(c, "best")).toEqual({
      id: "best", label: "Best run", text: "r03: measured 80%. The runs started from grasp_v2.py at 50%.", tone: "honest",
    });
  });

  it("is red when the best run measured below the starting code, muted when it matches", () => {
    const below = point(caseOf(ROBOT_CONFIG, sixRuns(), { baseline: baseline(0.9) }), "best")!;
    expect(below.text).toBe("r03: measured 80%. The runs started from grasp_v2.py at 90%.");
    expect(below.tone).toBe("inflated");
    const same = point(caseOf(ROBOT_CONFIG, sixRuns(), { baseline: baseline(0.8) }), "best")!;
    expect(same.text).toBe("r03: measured 80%. The runs started from grasp_v2.py at 80%.");
    expect(same.tone).toBe("muted");
  });

  it("leaves the starting code out until it is scored", () => {
    for (const b of [{ status: "scoring", name: "grasp_v2.py" }, { status: "failed", name: "grasp_v2.py", reason: "RuntimeError: no sim here" }, null] as (Baseline | null)[]) {
      expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { baseline: b }), "best")).toEqual({ id: "best", label: "Best run", text: "r03: measured 80%.", tone: "muted" });
    }
  });

  it("uses the batch's own word for the measured number", () => {
    expect(point(caseOf(TABULAR_CONFIG, sixRuns()), "best")!.text).toBe("r03: true 80%.");
    // The demo batch's server words say "Measured"; r05 and r12 tie at 77.92%.
    expect(point(demo, "best")).toEqual({ id: "best", label: "Best runs", text: "r05 and r12: measured 78%.", tone: "muted" });
  });
});

describe("keyPoints: the step", () => {
  it("is the split's headline", () => {
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit }), "step")).toEqual({ id: "step", label: "What differed", text: STEP_LINE, tone: "muted" });
    const partly = { ...robotSplit, honest_rate: 0.75, inflated_rate: 0.25 };
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { split: partly }), "step")!.text)
      .toBe("Most honest runs ran the can at other positions before writing the report. Most inflated runs did not.");
  });

  it("adds how far the fork experiment backs it once there is a verdict", () => {
    const supported = caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, verdict: verdictOf("supported") });
    expect(point(supported, "step")!.text).toBe(`${STEP_LINE} The fork experiment supports this as the cause.`);
    const open = caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, verdict: verdictOf("open") });
    expect(point(open, "step")!.text).toBe(`${STEP_LINE} The fork experiment does not settle whether this is the cause.`);
    expect(point(open, "step")!.tone).toBe("muted");
  });

  it("judges a verdict saved without evidence by its counts, with the server's rule", () => {
    // 8 of 8 inflated without the step, 0 of 8 with it: 8 agreeing pairs at worst, a running score of 169.8 (evidence.ts evidenceFrom).
    const enough = caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, verdict: verdictOf(null) });
    expect(point(enough, "step")!.text).toBe(`${STEP_LINE} The fork experiment supports this as the cause.`);
    // 4 of 4 against 0 of 4: a score of 13.03, under 20, whatever the investigator's sentence says.
    const few = { ...verdictOf(null), sentence: "Skipping the step caused the inflated claims.", numbers: { control_inflated: 4, control_total: 4, forced_inflated: 0, forced_total: 4 } };
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, verdict: few }), "step")!.text)
      .toBe(`${STEP_LINE} The fork experiment does not settle whether this is the cause.`);
    // The same counts, no difference between the arms.
    const flat = { ...verdictOf(null), numbers: { control_inflated: 4, control_total: 8, forced_inflated: 4, forced_total: 8 } };
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, verdict: flat }), "step")!.text)
      .toBe(`${STEP_LINE} The fork experiment does not settle whether this is the cause.`);
  });

  it("says so when no step separates the runs", () => {
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { phase: "no_split" }), "step"))
      .toEqual({ id: "step", label: "What differed", text: "No step separates honest and inflated runs.", tone: "muted" });
  });

  it("is absent before the split is found", () => {
    for (const phase of ["running", "analyzing", "done"] as CaseFile["phase"][]) {
      expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { phase }), "step")).toBeUndefined();
    }
  });

  it("reads the demo batch: the step and an open verdict", () => {
    expect(point(demo, "step")!.text).toBe(
      "Honest runs removed duplicate rows before splitting into train and test. Inflated runs did not. The fork experiment does not settle whether this is the cause.",
    );
  });
});

describe("keyPoints: where it fails", () => {
  it("gives the first traced symptom, its run and its line", () => {
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { trace: [traceEntry] }), "fails")).toEqual({
      id: "fails", label: "Where it fails", tone: "muted",
      text: "The can slipped out of the grip at 2.14 s, 0.31 m into a 0.60 m carry, while the hand moved at 0.9 m/s. Run r02, line 25.",
    });
  });

  it("counts the other entries", () => {
    const second = { ...traceEntry, at: 1700000005, run_id: "r05", line: 31, symptom: "The hand closed before it reached the can." };
    const two = caseOf(ROBOT_CONFIG, sixRuns(), { trace: [traceEntry, second] });
    expect(point(two, "fails")!.text).toBe(`${traceEntry.symptom} Run r02, line 25. 1 more below.`);
    const three = caseOf(ROBOT_CONFIG, sixRuns(), { trace: [second, traceEntry, traceEntry] });
    expect(point(three, "fails")!.text).toBe("The hand closed before it reached the can. Run r05, line 31. 2 more below.");
  });

  it("ends a symptom that has no full stop, and cuts a long one", () => {
    const bare = caseOf(ROBOT_CONFIG, sixRuns(), { trace: [{ ...traceEntry, symptom: "  The can tipped over  " }] });
    expect(point(bare, "fails")!.text).toBe("The can tipped over. Run r02, line 25.");
    const long = "The can slid away from the hand ".repeat(10).trim();
    const text = point(caseOf(ROBOT_CONFIG, sixRuns(), { trace: [{ ...traceEntry, symptom: long }] }), "fails")!.text;
    expect(text.startsWith(long.slice(0, 120))).toBe(true);
    expect(text).not.toContain(long);
    expect(text.endsWith(" Run r02, line 25.")).toBe(true);
  });

  it("is absent without a trace", () => {
    expect(point(caseOf(ROBOT_CONFIG, sixRuns()), "fails")).toBeUndefined();
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { trace: [] }), "fails")).toBeUndefined();
  });
});

describe("keyPoints: the fix", () => {
  const withFix = (fix: ProposedFix, more: Partial<CaseFile> = {}): CaseFile => caseOf(ROBOT_CONFIG, sixRuns(), { fix, ...more });

  it("says what a fix measured on the code itself did, green when the rate went up", () => {
    expect(point(withFix({ ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.8) }), "fix")).toEqual({
      id: "fix", label: "Fix", text: `${FIX_WHAT} Measured 70% without it, 80% with it.`, tone: "honest",
    });
  });

  it("is red when the rate went down, muted when it did not move", () => {
    const down = point(withFix({ ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.5) }), "fix")!;
    expect(down.text).toBe(`${FIX_WHAT} Measured 70% without it, 50% with it.`);
    expect(down.tone).toBe("inflated");
    const same = point(withFix({ ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.7) }), "fix")!;
    expect(same.text).toBe(`${FIX_WHAT} Measured 70% without it, 70% with it.`);
    expect(same.tone).toBe("muted");
  });

  it("is red and says so when the patched code raised an error, whatever the rates", () => {
    const raised = ["NameError: name 'dist' is not defined"];
    const broken = point(withFix({ ...proposedFix, status: "tested", measured: measuredOf(0.7, 0, raised) }), "fix")!;
    expect(broken.text).toBe(`${FIX_WHAT} Measured 70% without it, 0% with it. The patched code raised an error.`);
    expect(broken.tone).toBe("inflated");
    const up = point(withFix({ ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.8, raised) }), "fix")!;
    expect(up.text).toBe(`${FIX_WHAT} Measured 70% without it, 80% with it. The patched code raised an error.`);
    expect(up.tone).toBe("inflated");
  });

  it("says when the fix is not tested yet, and when it is being tested", () => {
    expect(point(withFix(proposedFix), "fix")).toEqual({ id: "fix", label: "Fix", text: `${FIX_WHAT} Not tested yet.`, tone: "muted" });
    expect(point(withFix({ ...proposedFix, status: "testing" }), "fix")).toEqual({ id: "fix", label: "Fix", text: `${FIX_WHAT} Being tested.`, tone: "muted" });
  });

  it("reads a fix tested by a fork from the fork's arms, and says they were copies", () => {
    const tested = withFix({ ...proposedFix, status: "tested", fork_id: "f2" }, { forks: { f2: fixFork } });
    expect(point(tested, "fix")).toEqual({
      id: "fix", label: "Fix", text: `${FIX_WHAT} Measured 45% without it, 72% with it, in fork copies.`, tone: "honest",
    });
    // The fork is still running: its arms are not the result yet.
    const going = withFix({ ...proposedFix, status: "testing", fork_id: "f2" }, { forks: { f2: { ...fixFork, status: "running" } } });
    expect(point(going, "fix")!.text).toBe(`${FIX_WHAT} Being tested.`);
  });

  it("does not double the description's own full stop, and stands in for an empty one", () => {
    expect(point(withFix({ ...proposedFix, description: "Slow the carry down." }), "fix")!.text).toBe("Slow the carry down. Not tested yet.");
    expect(point(withFix({ ...proposedFix, description: "" }), "fix")!.text).toBe("A fix was proposed. Not tested yet.");
  });

  it("is absent without a fix", () => {
    expect(point(caseOf(ROBOT_CONFIG, sixRuns()), "fix")).toBeUndefined();
    expect(point(caseOf(ROBOT_CONFIG, sixRuns(), { fix: null }), "fix")).toBeUndefined();
  });
});

describe("keyPoints: the whole list", () => {
  it("is empty for a batch with nothing yet", () => {
    expect(keyPoints(caseOf(ROBOT_CONFIG, {}, { phase: "running" }))).toEqual([]);
    expect(keyPoints(caseOf(ROBOT_CONFIG, runsOf(run("r01", "running", null, null), run("r02", "queued", null, null)), { phase: "running" }))).toEqual([]);
    expect(keyPoints({ config: {}, phase: "config" } as unknown as CaseFile)).toEqual([]);
  });

  it("gives the four points in order as the batch reaches them", () => {
    const full = caseOf(ROBOT_CONFIG, sixRuns(), {
      baseline: baseline(0.5), split: robotSplit, verdict: verdictOf("supported"), trace: [traceEntry],
      fix: { ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.8) },
    });
    expect(ids(full)).toEqual(["best", "step", "fails", "fix"]);
    expect(keyPoints(full).map((p) => p.label)).toEqual(["Best run", "What differed", "Where it fails", "Fix"]);
    expect(keyPoints(full).map((p) => p.tone)).toEqual(["honest", "muted", "muted", "honest"]);
    expect(ids(caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit }))).toEqual(["best", "step"]);
    // The split is known while a late run is still going: the step is there, the best run is not.
    expect(ids(caseOf(ROBOT_CONFIG, sixRuns({ r07: run("r07", "running", null, null) }), { split: robotSplit }))).toEqual(["step"]);
    expect(ids(demo)).toEqual(["best", "step"]);
  });
});

describe("keyPointsView", () => {
  it("is empty until there is a point to give", () => {
    expect(keyPointsView(vmOf(caseOf(ROBOT_CONFIG, {}, { phase: "running" })))).toBe("");
    expect(keyPointsView(vmOf(caseOf(ROBOT_CONFIG, sixRuns({ r07: run("r07", "running", null, null) }), { phase: "running" })))).toBe("");
  });

  it("renders one row per point, keyed by its id and colored by its tone", () => {
    const html = keyPointsView(vmOf(caseOf(ROBOT_CONFIG, sixRuns(), {
      baseline: baseline(0.5), split: robotSplit, trace: [traceEntry],
      fix: { ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.5) },
    })));
    expect(html.startsWith('<section class="ln-sec ln-kp" data-morph-key="ln-kp" aria-label="Key points">')).toBe(true);
    expect(html).toContain('<h2 class="ln-h">Key points</h2>');
    expect(count(html, 'class="ln-kp-row ')).toBe(4);
    expect(html).toContain(
      '<div class="ln-kp-row ln-kp-row--honest" data-morph-key="kp-best"><dt class="ln-kp-k"><i class="ln-pill-dot"></i>Best run</dt>' +
      '<dd class="ln-kp-v">r03: measured 80%. The runs started from grasp_v2.py at 50%.</dd></div>',
    );
    expect(html).toContain(`<div class="ln-kp-row ln-kp-row--muted" data-morph-key="kp-step"><dt class="ln-kp-k"><i class="ln-pill-dot"></i>What differed</dt><dd class="ln-kp-v">${STEP_LINE}</dd></div>`);
    expect(html).toContain('<div class="ln-kp-row ln-kp-row--muted" data-morph-key="kp-fails">');
    expect(html).toContain('<div class="ln-kp-row ln-kp-row--inflated" data-morph-key="kp-fix">');
    // In the order the points come in.
    const at = ["kp-best", "kp-step", "kp-fails", "kp-fix"].map((k) => html.indexOf(`data-morph-key="${k}"`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at[0]).toBeGreaterThan(-1);
  });

  it("renders only the points the batch has", () => {
    const html = keyPointsView(demoVm());
    expect(html).toContain('aria-label="Key points"');
    expect(count(html, 'class="ln-kp-row ')).toBe(2);
    expect(html).toContain('data-morph-key="kp-best"');
    expect(html).toContain('<dd class="ln-kp-v">r05 and r12: measured 78%.</dd>');
    expect(html).toContain('data-morph-key="kp-step"');
    expect(html).not.toContain('data-morph-key="kp-fails"');
    expect(html).not.toContain('data-morph-key="kp-fix"');
  });

  it("escapes HTML in the text", () => {
    const html = keyPointsView(vmOf(caseOf(ROBOT_CONFIG, sixRuns(), {
      baseline: { ...baseline(0.5), name: "<grasp & go>.py" },
      trace: [{ ...traceEntry, symptom: "The <b>can</b> slipped & fell." }],
      fix: { ...proposedFix, description: 'Set t_move to "0.4 + dist" <script>alert(1)</script>' },
    })));
    expect(html).toContain("The runs started from &lt;grasp &amp; go&gt;.py at 50%.");
    expect(html).toContain("The &lt;b&gt;can&lt;/b&gt; slipped &amp; fell. Run r02, line 25.");
    expect(html).toContain("Set t_move to &quot;0.4 + dist&quot; &lt;script&gt;alert(1)&lt;/script&gt;. Not tested yet.");
    expect(html).not.toContain("<b>can</b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<grasp");
  });

  it("does not depend on the folds", () => {
    const c = caseOf(ROBOT_CONFIG, sixRuns(), { split: robotSplit, trace: [traceEntry], fix: proposedFix });
    expect(keyPointsView(vmOf(c, { open: "all" }))).toBe(keyPointsView(vmOf(c)));
    expect(keyPointsView(vmOf(c, { open: { split: true, "dx-why": true, "fix-why": true } }))).toBe(keyPointsView(vmOf(c)));
  });
});

// ── the folds ────────────────────────────────────────────────────────────────

/** A fold's button exactly as lanes.ts renders it. */
const fold = (key: string, open: boolean, what: string): string =>
  `<button type="button" class="ln-fold ask-ghostbtn ask-ghostbtn--outline" data-morph-key="fold-${key}" data-act="fold" data-arg="${key}" aria-expanded="${open}">` +
  `${askIcon("chevRight", 13)}${open ? "Hide" : "Show"} ${what}</button>`;

describe("the split fold", () => {
  const what = "the two runs side by side";
  const expectClosed = (html: string): void => {
    expect(html).toContain(fold("split", false, what));
    expect(html).toContain('data-arg="split" aria-expanded="false"');
    expect(html).not.toContain("Hide the two runs");
    expect(html).not.toContain('data-morph-key="col-honest"');
    expect(html).not.toContain('data-morph-key="col-inflated"');
    expect(html).not.toContain("All 12 runs");
    expect(html).not.toContain("ln-strip");
    expect(html).not.toContain("Next, to test whether");
    // The finding and its one picture stay: two tracks that differ at one stop.
    // The headline arrives a character at a time (motion.ts `reveal`): the whole finding is there for a screen reader.
    expect(html).toContain('<p class="ln-headline"><span class="mo-sr">Honest runs removed duplicate rows before splitting into train and test. Inflated runs did not.</span>');
    expect(html).toContain('<span class="ln-headline-a">');
    expect(html).toContain('<span class="ln-headline-b"');
    // The counts are said once on screen, by the picture; the sentence that repeated them is for a screen reader only.
    expect(html).toContain('<span class="mo-sr">6 of 6 honest runs, 0 of 6 inflated did this before splitting into train and test.</span>');
    expect(html).not.toContain('class="ln-sub"');
    expect(html).toContain('<figure class="ln-lanes"');
    expect(html.match(/class="ln-lane-stop /g)).toHaveLength(2);
    // What it did to the score is detail now: the Agents page already shows every score.
    expect(html).not.toContain("What it did to the score");
    expect(html).not.toContain('data-morph-key="grp-honest"');
  };
  const expectOpen = (html: string): void => {
    expect(html).toContain(fold("split", true, what));
    expect(html).toContain('data-arg="split" aria-expanded="true"');
    expect(html).not.toContain("Show the two runs");
    expect(html).toContain('data-morph-key="col-honest"');
    expect(html).toContain('data-morph-key="col-inflated"');
    expect(html).toContain('<h3 class="ln-h3">All 12 runs</h3>');
    expect(html).toContain("To test whether the step is the cause, Orro copies run <b>r02</b>");
    expect(html).toContain('<h3 class="ln-h3">What it did to the score</h3>');
    expect(html).toContain('data-morph-key="grp-honest"');
    expect(html).toContain('data-morph-key="grp-inflated"');
  };

  it("is closed by default: the headline and the picture, without the two notebooks, the scores, the strip or the next step", () => {
    expectClosed(splitView(demoVm()));
    expectClosed(splitView(demoVm({}, { open: {} })));
    // Another fold's key does not open this one.
    expectClosed(splitView(demoVm({}, { open: { inv: true, "exp:f1": true } })));
  });

  it("opens when asked, with the detail after the button", () => {
    const html = splitView(demoVm({}, { open: { split: true } }));
    expectOpen(html);
    expect(html.indexOf('class="ln-lanes"')).toBeLessThan(html.indexOf('data-arg="split"'));
    expect(html.indexOf('data-arg="split"')).toBeLessThan(html.indexOf('data-morph-key="col-honest"'));
    expect(html.indexOf('data-morph-key="col-inflated"')).toBeLessThan(html.indexOf("What it did to the score"));
    expect(html.indexOf("What it did to the score")).toBeLessThan(html.indexOf("All 12 runs"));
    expect(html.indexOf("All 12 runs")).toBeLessThan(html.indexOf("What happens next"));
  });

  it("stays closed on an explicit false, and opens with every fold open", () => {
    expectClosed(splitView(demoVm({}, { open: { split: false } })));
    expectOpen(splitView(demoVm({}, { open: "all" })));
  });

  it("has no fold when no step separates the runs: there are no two notebooks to hide", () => {
    const html = splitView(demoVm({ split: null, phase: "no_split" }));
    expect(html).toContain("No step separates honest and inflated runs.");
    expect(html).not.toContain("ln-fold");
    expect(html).toContain('<h3 class="ln-h3">All 12 runs</h3>');
  });
});

describe("the investigator fold", () => {
  const log: AgentEvent[] = [
    { t: 4, type: "thought", text: "Comparing what the honest and inflated runs did before the split." },
    { t: 9, type: "thought", text: "Only the honest runs removed duplicates." },
  ];
  const inv = (c: Partial<CaseFile> = {}, over: Partial<BatchVm> = {}): string => investigatorView(demoVm(c, { events: { investigator: log }, ...over }));
  const both = "its log and hypothesis";
  const expectClosed = (html: string, what = both): void => {
    expect(html).toContain(fold("inv", false, what));
    expect(html).not.toContain('class="ln-evs"');
    expect(html).not.toContain("ln-ev ");
    expect(html).not.toContain("ln-hyps");
    expect(html).not.toContain(">Hypotheses<");
    expect(html).not.toContain("Only the honest runs removed duplicates.");
  };
  const expectOpen = (html: string, what = both): void => {
    expect(html).toContain(fold("inv", true, what));
    expect(html).toContain('<ol class="ln-evs" data-morph-list>');
    expect(count(html, '<li class="ln-ev ln-ev--thought"')).toBe(2);
    expect(html).toContain("Only the honest runs removed duplicates.");
  };

  it("is closed by default once the batch is done: the phase, without the log or the hypothesis", () => {
    const html = inv();
    expectClosed(html);
    expect(html).toContain('aria-label="Investigator"');
    expect(html).toContain('<span class="ln-phase-t"><span class="mo-sr">Done</span>');
  });

  it("opens when asked", () => {
    const html = inv({}, { open: { inv: true } });
    expectOpen(html);
    expect(html).toContain('<h3 class="ln-h3">Hypotheses</h3><div class="ln-hyps" data-morph-list>');
    expect(html).toContain("100% of honest runs removed duplicates before splitting; 0% of inflated runs did.");
    expect(html.indexOf('data-arg="inv"')).toBeLessThan(html.indexOf('class="ln-evs"'));
  });

  it.each(["done", "stopped", "no_split"] as const)("is closed by default in phase %s", (phase) => {
    expectClosed(inv({ phase }));
    expectOpen(inv({ phase }, { open: { inv: true } }));
  });

  it.each(["running", "analyzing", "ready", "investigating", "awaiting_approval", "forking", "forked", "blocked: over budget", "error: VM died"])(
    "is open by default in phase %s, while the log is the news", (phase) => {
      const html = inv({ phase: phase as CaseFile["phase"] });
      expectOpen(html);
      expect(html).toContain("ln-hyps");
      // Closing it by hand wins over the default.
      expectClosed(inv({ phase: phase as CaseFile["phase"] }, { open: { inv: false } }));
    });

  it("names only the log when there is no hypothesis", () => {
    expectClosed(inv({ hypotheses: [] }), "its log");
    const html = inv({ hypotheses: [] }, { open: { inv: true } });
    expectOpen(html, "its log");
    expect(html).not.toContain("ln-hyps");
  });

  it("folds the hypothesis alone when no log is loaded", () => {
    const closed = investigatorView(demoVm());
    expect(closed).toContain(fold("inv", false, both));
    expect(closed).not.toContain("ln-hyps");
    const open = investigatorView(demoVm({}, { open: { inv: true } }));
    expect(open).toContain(fold("inv", true, both));
    expect(open).toContain("ln-hyps");
    expect(open).not.toContain('class="ln-evs"');
  });

  it("has no fold with nothing to fold", () => {
    expect(investigatorView(demoVm({ hypotheses: [] }))).not.toContain("ln-fold");
    expect(investigatorView(demoVm({ hypotheses: [], phase: "investigating" }))).not.toContain("ln-fold");
  });

  it("opens with every fold open", () => {
    expectOpen(inv({}, { open: "all" }));
    expect(inv({}, { open: "all" })).toContain("ln-hyps");
  });
});

describe("a fork experiment's fold", () => {
  const f1 = demo.forks.f1 as ForkExperiment;
  const withStatus = (status: ForkExperiment["status"]): Partial<CaseFile> => ({ forks: { f1: { ...structuredClone(f1), status } } });
  const what = "the experiment in detail";
  const expectClosed = (html: string): void => {
    expect(html).toContain(fold("exp:f1", false, what));
    expect(html).toContain('data-arg="exp:f1" aria-expanded="false"');
    expect(html).not.toContain('class="ln-kids"');
    expect(html).not.toContain("ln-kid ");
    expect(html).not.toContain("ln-arm-sum");
    // The picture is the result and it stays: a row per arm, the lit row's preview, where to go next, the pairs.
    expect(count(html, 'data-morph-key="picture"')).toBe(1);
    expect(count(html, '<li class="ln-md-row')).toBe(2);
    expect(count(html, 'data-morph-key="pv-')).toBe(2);
    // The arm under test is the one lit until a row is pointed at.
    expect(html).toContain('<li class="ln-md-row is-default" data-arm="forced"');
    expect(html).toContain('<div class="ln-md-p is-default" data-arm="forced"');
    // A row: what was done in plain words, the lab name and the count under it, a mark per copy.
    expect(html).toMatch(/<b>Left alone<\/b><small>Control · 3 of 4 inflated<\/small>/);
    expect(html).toMatch(/<b>Made to take the step<\/b><small>Forced · 0 of 4 inflated<\/small>/);
    // A preview: the diagram, why the arm exists, what its copies ran first, and its two numbers.
    expect(count(html, '<svg class="ln-ad"')).toBe(2);
    expect(html).toContain("Made to take the step the honest runs took. This is the test.");
    expect(html).toContain("Ran first: remove duplicate rows from data.csv before the split");
    expect(html).toMatch(/data-arm="control"[\s\S]*?<dt>Claimed<\/dt><dd class="is-high">88%<\/dd><\/div><div><dt>Measured<\/dt><dd>74%<\/dd>/);
    expect(html).toMatch(/data-arm="forced"[\s\S]*?<dt>Claimed<\/dt><dd>76%<\/dd><\/div><div><dt>Measured<\/dt><dd>75%<\/dd>/);
    // More: the source run and the pages either side.
    expect(html).toContain('data-act="open-run" data-arg="r02"');
    expect(html).toContain('data-act="goto" data-arg="split"');
    expect(html).toContain('<span class="ln-meter-t">4 of 5 pairs</span><span class="ln-meter-w">1 more to confirm it</span>');
    // How a pair is read, and the score beside the level, said once for the page and kept while the detail is folded.
    expect(html).toContain("A pair is one copy left alone and one made to take the step, cut from the same run");
    expect(count(html, 'data-morph-key="pair-key"')).toBe(1);
    expect(html).toContain('<span class="ln-meter-sc">Score <b>13.03</b> of 20</span>');
    // Each arm's card with its bars, the question as asked, the statistics and the provenance are the detail.
    expect(html).not.toContain('data-morph-key="arm-');
    expect(html).not.toContain('class="ln-bars"');
    expect(html).not.toContain("ln-outcome");
    expect(html).not.toContain("Provenance");
  };
  const expectOpen = (html: string): void => {
    expect(html).toContain(fold("exp:f1", true, what));
    expect(html).toContain('data-arg="exp:f1" aria-expanded="true"');
    expect(count(html, '<div class="ln-kids" data-morph-key="kids" data-morph-list>')).toBe(2);
    expect(count(html, 'data-act="open-child"')).toBe(8);
    expect(html).toContain('data-arg="f1/control-1"');
    expect(html).toContain('data-arg="f1/forced-4"');
    expect(count(html, 'class="ln-bars"')).toBe(2);
  };

  it("is closed by default once the fork is done: the picture alone, with one short question", () => {
    expect(f1.status).toBe("done");
    const html = forkView(demoVm());
    expectClosed(html);
    expect(html).toContain('<p class="ln-headline">Does removing duplicate rows fix the report?</p>');
    // The button comes right after the picture.
    expect(html.indexOf('data-morph-key="picture"')).toBeLessThan(html.indexOf('data-arg="exp:f1"'));
  });

  it("opens when asked: the arms, a tile per copy and each arm's summary line, after the button", () => {
    const html = forkView(demoVm({}, { open: { "exp:f1": true } }));
    expectOpen(html);
    expect(html).toContain('<div class="ln-outcome-w" data-io data-morph-key="outcome"><p class="ln-outcome">The claim moved ');
    expect(html.indexOf('data-arg="exp:f1"')).toBeLessThan(html.indexOf('data-morph-key="arm-'));
    expect(count(html, '<p class="ln-arm-sum" data-morph-key="sum">')).toBe(2);
    expect(html).toContain('<p class="ln-arm-sum" data-morph-key="sum">3 of 4 inflated, mean claimed 87.8% vs measured 73.5%</p>');
    expect(html).toContain('<p class="ln-arm-sum" data-morph-key="sum">0 of 4 inflated, mean claimed 76.2% vs measured 75.0%</p>');
  });

  it.each(["running", "rebuilding", "stopped"] as const)("is open by default while the fork is %s", (status) => {
    expectOpen(forkView(demoVm(withStatus(status))));
    // Closing it by hand wins over the default.
    expectClosed(forkView(demoVm(withStatus(status), { open: { "exp:f1": false } })));
  });

  it("stays closed on an explicit false, and opens with every fold open", () => {
    expectClosed(forkView(demoVm({}, { open: { "exp:f1": false } })));
    expectOpen(forkView(demoVm({}, { open: "all" })));
  });

  it("is keyed by the fork: opening one experiment leaves the other folded", () => {
    const forks = { f1: structuredClone(f1), f2: fixFork };
    const closed = forkView(demoVm({ forks }));
    expect(closed).toContain(fold("exp:f1", false, what));
    expect(closed).toContain(fold("exp:f2", false, what));
    expect(closed).not.toContain('class="ln-kids"');

    const second = forkView(demoVm({ forks }, { open: { "exp:f2": true } }));
    expect(second).toContain(fold("exp:f1", false, what));
    expect(second).toContain(fold("exp:f2", true, what));
    // The fix fork's three arms, one copy each.
    expect(count(second, '<div class="ln-kids" data-morph-key="kids" data-morph-list>')).toBe(3);
    expect(count(second, 'data-act="open-child"')).toBe(3);
    expect(second).toContain('data-arg="f2/fixed-1"');
    expect(second).not.toContain('data-arg="f1/control-1"');
    expect(second).toContain('<p class="ln-arm-sum" data-morph-key="sum">3 of 4 claims matched what was measured, mean measured 72.0% vs control 45.0%</p>');
    // A key that is not this fork's does nothing.
    expect(forkView(demoVm({ forks }, { open: { exp: true, "exp:f3": true, f1: true } }))).toBe(closed);
  });

  it("draws what it has: one mark for one copy, and waiting rings before any copy exists", () => {
    const one = { ...structuredClone(f1), children: { "control-1": f1.children["control-1"] }, arms: undefined };
    /** The marks drawn for copies, without the key that names them. */
    const marks = (html: string): string => html.replace(/<p class="ln-key"[\s\S]*?<\/p>/g, "");
    const some = forkView(demoVm({ forks: { f1: one } }));
    expect(some).toContain(fold("exp:f1", false, what));
    expect(count(marks(some), '<i class="is-bad"></i>') + count(marks(some), '<i class="is-ok"></i>')).toBe(1);
    const none = { ...structuredClone(f1), status: "rebuilding" as const, children: {}, arms: undefined };
    const html = forkView(demoVm({ forks: { f1: none } }));
    // Still working: the detail is open under the picture, and each branch waits on its copies.
    expect(html).toContain("Rebuilding the VM");
    expect(html).toContain(fold("exp:f1", true, what));
    expect(count(marks(html), '<i class="is-wait"></i>')).toBe(8);
    // The key says what a waiting ring is, since the picture draws them.
    expect(html).toContain("Not started");
    expect(count(html, " · Running</small>")).toBe(2);
  });
});

describe("the diagnosis fold", () => {
  const what = "why each line causes it";
  const trace = [traceEntry, { ...traceEntry, at: 1700000005, run_id: "r05", line: 31, why: "The grip closes 0.1 s early." }];
  const expectClosed = (html: string): void => {
    expect(html).toContain(fold("dx-why", false, what));
    expect(html).not.toContain("ln-dx-why");
    expect(html).not.toContain("never");
    expect(html).not.toContain("The grip closes 0.1 s early.");
    // Each card keeps its run, symptom and line.
    expect(count(html, 'class="ln-card ln-dx-entry"')).toBe(2);
    expect(count(html, `<p class="ln-dx-symptom">${traceEntry.symptom}</p>`)).toBe(2);
    expect(html).toContain('<span class="ln-dx-ln">line 25</span>    t_move=0.4,');
    expect(html).toContain('<span class="ln-dx-ln">line 31</span>');
  };
  const expectOpen = (html: string): void => {
    expect(html).toContain(fold("dx-why", true, what));
    expect(count(html, '<p class="ln-dx-why ln-muted">')).toBe(2);
    expect(html).toContain('<p class="ln-dx-why ln-muted">A fixed 0.4 s carry &lt;b&gt;never&lt;/b&gt; slows down for a long reach.</p>');
    expect(html).toContain('<p class="ln-dx-why ln-muted">The grip closes 0.1 s early.</p>');
    expect(count(html, 'class="ln-card ln-dx-entry"')).toBe(2);
  };

  it("is closed by default: every symptom and line, without the reasons", () => {
    expectClosed(diagnosisView(demoVm({ trace })));
    expectClosed(diagnosisView(demoVm({ trace }, { open: { "fix-why": true } })));
  });

  it("opens when asked, for every card at once", () => {
    expectOpen(diagnosisView(demoVm({ trace }, { open: { "dx-why": true } })));
  });

  it("stays closed on an explicit false, and opens with every fold open", () => {
    expectClosed(diagnosisView(demoVm({ trace }, { open: { "dx-why": false } })));
    expectOpen(diagnosisView(demoVm({ trace }, { open: "all" })));
  });

  it("puts one button under the cards", () => {
    const html = diagnosisView(demoVm({ trace }, { open: { "dx-why": true } }));
    expect(count(html, 'data-act="fold"')).toBe(1);
    expect(html.lastIndexOf("ln-dx-entry")).toBeLessThan(html.indexOf('data-arg="dx-why"'));
  });
});

describe("the fix fold", () => {
  const what = "the reasoning";
  const reason = '<p class="ln-fix-why">The carry takes the same 0.4 s whatever the distance, so a long carry &lt;i&gt;whips&lt;/i&gt; the can.</p>';
  const expectClosed = (html: string): void => {
    expect(html).toContain(fold("fix-why", false, what));
    expect(html).not.toContain("ln-fix-why");
    expect(html).not.toContain("whips");
    // What the fix does and the text it changes stay.
    expect(html).toContain('<p class="ln-fix-t"><span class="mo-sr">Scale the carry time with the carry distance</span>');
    expect(html).toContain('<pre class="ln-fix-pre">    t_move=0.4,</pre>');
    expect(html).toContain('<pre class="ln-fix-pre">    t_move=0.4 + 1.2 * dist,</pre>');
  };
  const expectOpen = (html: string): void => {
    expect(html).toContain(fold("fix-why", true, what) + reason);
    expect(html).toContain('<p class="ln-fix-t"><span class="mo-sr">Scale the carry time with the carry distance</span>');
  };

  it("is closed by default: the fix and its diff, without the reasoning", () => {
    expectClosed(fixView(demoVm({ fix: proposedFix })));
    expectClosed(fixView(demoVm({ fix: proposedFix }, { open: { "dx-why": true } })));
  });

  it("opens when asked, with the reasoning right after the button", () => {
    expectOpen(fixView(demoVm({ fix: proposedFix }, { open: { "fix-why": true } })));
  });

  it("stays closed on an explicit false, and opens with every fold open", () => {
    expectClosed(fixView(demoVm({ fix: proposedFix }, { open: { "fix-why": false } })));
    expectOpen(fixView(demoVm({ fix: proposedFix }, { open: "all" })));
  });

  it("keeps what the fix measured outside the fold", () => {
    const html = fixView(demoVm({ fix: { ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.8), verdict: "The fix raised the rate by 10 points." } }));
    expect(html).toContain('class="ln-fix-measured ln-fix-measured--up"');
    // The page opens on the result in one line, then its picture. The investigator's own sentence repeats the
    // numbers at length, so it waits behind the fold with the reasoning.
    expect(html.indexOf('class="ln-headline"')).toBeLessThan(html.indexOf("ln-fix-measured"));
    expect(html.indexOf("ln-fix-measured")).toBeLessThan(html.indexOf('class="ln-fix-t"'));
    expect(html).not.toContain("ln-sentence");
    expect(html).toContain(fold("fix-why", false, what));
    expect(html).not.toContain("ln-fix-why");
    const open = fixView(demoVm({ fix: { ...proposedFix, status: "tested", measured: measuredOf(0.7, 0.8), verdict: "The fix raised the rate by 10 points." } }, { open: { "fix-why": true } }));
    expect(open).toContain('<p class="ln-sentence"><span class="mo-sr">The fix raised the rate by 10 points.</span>');
    expect(open).toContain("Measured on the code itself, no agent in between");
  });

  it("has no fold when the fix gives no reasoning", () => {
    const html = fixView(demoVm({ fix: { ...proposedFix, why: "" } }, { open: "all" }));
    expect(html).not.toContain("ln-fold");
    expect(html).not.toContain("ln-fix-why");
  });
});

describe("every fold at once", () => {
  const log: AgentEvent[] = [{ t: 4, type: "thought", text: "Comparing the runs." }];
  const c: Partial<CaseFile> = { trace: [traceEntry], fix: proposedFix };
  const page = (open?: BatchVm["open"]): string => {
    const vm = demoVm(c, { events: { investigator: log }, ...(open === undefined ? {} : { open }) });
    return splitView(vm) + forkView(vm) + investigatorView(vm) + diagnosisView(vm) + fixView(vm);
  };
  const HIDDEN = ['data-morph-key="col-honest"', 'class="ln-kids"', "ln-arm-sum", 'class="ln-evs"', "ln-hyps", "ln-dx-why", "ln-fix-why"];

  it("a finished batch shows five closed folds and none of their detail", () => {
    const html = page();
    expect(count(html, 'data-act="fold"')).toBe(5);
    expect(count(html, 'aria-expanded="false"')).toBe(5);
    expect(html).not.toContain('aria-expanded="true"');
    for (const key of ["split", "exp:f1", "inv", "dx-why", "fix-why"]) expect(html).toContain(`data-act="fold" data-arg="${key}"`);
    for (const h of HIDDEN) expect(html).not.toContain(h);
  });

  it('open: "all" opens every one', () => {
    const html = page("all");
    expect(count(html, 'data-act="fold"')).toBe(5);
    expect(count(html, 'aria-expanded="true"')).toBe(5);
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).not.toContain(">Show ");
    for (const h of HIDDEN) expect(html).toContain(h);
  });

  it("each key opens its own fold and no other", () => {
    const mine: Record<string, string[]> = {
      split: ['data-morph-key="col-honest"'],
      "exp:f1": ['class="ln-kids"', "ln-arm-sum"],
      inv: ['class="ln-evs"', "ln-hyps"],
      "dx-why": ["ln-dx-why"],
      "fix-why": ["ln-fix-why"],
    };
    for (const [key, shown] of Object.entries(mine)) {
      const html = page({ [key]: true });
      expect(count(html, 'aria-expanded="true"')).toBe(1);
      expect(html).toContain(`data-arg="${key}" aria-expanded="true"`);
      for (const h of HIDDEN) {
        if (shown.includes(h)) expect(html).toContain(h);
        else expect(html).not.toContain(h);
      }
    }
  });
});
