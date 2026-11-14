// The top of a batch's page against the committed demo batches: the pipeline's steps, the title, the numbers.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { CaseFile, RunRecord } from "../src/api";
import type { BatchVm } from "../src/batch/model";
import { headline, overviewView, stages } from "../src/batch/overview";

const demo = JSON.parse(caseRaw) as CaseFile;
const robot = JSON.parse(robotRaw) as CaseFile;
const vmOf = (c: CaseFile, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "demo-batch", live: false, case: c, events: {}, replay: null, busy: null, error: null, now: 0, ...over,
});

/** The demo case while its agents work: r01..r03 scored, the rest running or waiting, nothing found yet. */
function midRun(): CaseFile {
  const runs: Record<string, RunRecord> = {};
  for (const [id, r] of Object.entries(demo.runs)) {
    const n = Number(id.slice(1));
    runs[id] = n <= 3 ? r : { id, status: n <= 7 ? "running" : "queued", charts: [] };
  }
  return { ...demo, phase: "running", runs, split: null, hypotheses: [], forks: {}, verdict: null };
}

const states = (vm: BatchVm): string => stages(vm).map((s) => `${s.key}:${s.state}${s.there ? "" : "?"}`).join(" ");

describe("stages", () => {
  it("has every step finished and on the page for the finished demo batch", () => {
    expect(states(vmOf(demo))).toBe("wall:done split:done phase:done fork:done verdict:done");
  });

  it("has the agents working, with how far along, and the later steps not there yet", () => {
    const vm = vmOf(midRun());
    expect(states(vm)).toBe("wall:active split:pending? phase:pending fork:pending? verdict:pending?");
    expect(stages(vm)[0].share).toBeCloseTo(3 / 12);
  });

  it("adds a robot batch's diagnosis and fix once the case has them", () => {
    expect(stages(vmOf(robot)).map((s) => s.key)).not.toContain("fix");
    const withFix = { ...robot, trace: [{ at: 1, run_id: "r02", line: 3, symptom: "s", excerpt: "e", why: "w" }], fix: { status: "testing" } } as unknown as CaseFile;
    const tail = stages(vmOf(withFix)).slice(-2).map((s) => `${s.key}:${s.state}`);
    expect(tail).toEqual(["diagnosis:done", "fix:active"]);
  });
});

describe("headline", () => {
  it("says what the scored agents came to once nothing is working", () => {
    expect(headline(vmOf(demo))).toBe("6 of 12 agents reported more than they scored");
  });

  it("says what is happening while something is", () => {
    expect(headline(vmOf(midRun()))).toBe("Agents are running");
    expect(headline(vmOf({ ...demo, phase: "forking" }))).toBe("Forking the run into control and forced arms");
  });

  it("gives the reason when the batch is blocked", () => {
    expect(headline(vmOf({ ...demo, phase: "blocked: budget reached" }))).toBe("Blocked: budget reached");
  });

  it("words a robot batch as claimed against the hidden test", () => {
    // One of its twelve agents failed, so the count is of the scored ones.
    expect(headline(vmOf(robot))).toMatch(/^\d+ of 11 scored agents claimed more than the hidden test showed$/);
  });

  it("says so when every scored agent was honest", () => {
    const runs = Object.fromEntries(Object.entries(demo.runs).filter(([, r]) => r.status === "honest"));
    expect(headline(vmOf({ ...demo, runs }))).toBe("All 6 scored agents reported what they scored");
  });
});

describe("overviewView", () => {
  const html = overviewView(vmOf(demo));

  it("draws a step per stage, each a button to its section, finished ones with a drawn check", () => {
    for (const key of ["wall", "split", "phase", "fork", "verdict"]) expect(html).toContain(`data-act="goto" data-arg="${key}"`);
    expect(html.match(/class="ov-step ov-step--done"/g)).toHaveLength(5);
    expect(html).not.toContain(" disabled>");
    // A step whose section is not on the page yet cannot be pressed.
    expect(overviewView(vmOf(midRun())).match(/ disabled>/g)).toHaveLength(3);
  });

  it("counts the runs in tiles, the inflated ones in the highlighted tile", () => {
    expect(html).toMatch(/class="ov-kpi ov-kpi--hi ds-pop"[^>]*data-morph-key="kpi:inflated"><span class="ov-kpi-k">Inflated<\/span><span class="ov-kpi-v"><span class="mo-n" data-count="6"/);
    expect(html).toContain('data-count="12" data-fmt="int" data-text="12"');
  });

  it("draws one bar per run, a scored one as its true score with what it reported above it", () => {
    expect(html.match(/class="ov-bar ov-bar--/g)).toHaveLength(12);
    expect(html.match(/class="ov-bar ov-bar--inflated"/g)).toHaveLength(6);
    expect(html).toContain("<b>r09</b> reported 92.4%, true 77.3%");
    // Not scored yet: an empty slot, so the row does not shift as runs finish.
    expect(overviewView(vmOf(midRun())).match(/class="ov-bar ov-bar--wait"/g)).toHaveLength(9);
  });

  it("names a robot batch's two scores in its own words, and its bars from 0%", () => {
    const r = overviewView(vmOf(robot, { id: "robot-demo-batch" }));
    expect(r).toContain("Claimed success against the hidden test");
    expect(r).toContain("from 0% to 100%");
    expect(r).toContain(">Hidden test</span>");
  });
});
