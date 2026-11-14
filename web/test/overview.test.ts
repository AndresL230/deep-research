// The top of a batch's page against the committed demo batches: the pipeline's steps, the title, the numbers.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { CaseFile, RunRecord } from "../src/api";
import { parseRoute, routeHash, type BatchVm } from "../src/batch/model";
import { headline, notYetView, overviewView, pageHeadView, pageNav, pagerView, stages } from "../src/batch/overview";

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
  it("is the claim against the truth once every agent is in", () => {
    expect(headline(vmOf(demo))).toBe("6 of 12 agents claimed 89%. Measured on 154 rows they never saw: 75%.");
  });

  it("says what is happening until every agent is in, then keeps the claim while the batch works on", () => {
    expect(headline(vmOf(midRun()))).toBe("Agents are running");
    // The phase chip beside the name says the batch is forking; the title stays the one headline.
    expect(headline(vmOf({ ...demo, phase: "forking" }))).toBe("6 of 12 agents claimed 89%. Measured on 154 rows they never saw: 75%.");
    expect(overviewView(vmOf({ ...demo, phase: "forking" }))).toContain("Forking the run into control and forced arms");
  });

  it("gives the reason when the batch is blocked", () => {
    expect(headline(vmOf({ ...demo, phase: "blocked: budget reached" }))).toBe("Blocked: budget reached");
  });

  it("words a robot batch as claimed against measured at the positions it never tested", () => {
    expect(headline(vmOf(robot))).toBe("6 of 12 agents claimed 99%. Measured at 20 positions they never tested: 59%.");
    for (const gone of ["hidden test", "reported accuracy", "splitting into train and test"]) expect(headline(vmOf(robot))).not.toContain(gone);
  });

  it("says so when every scored agent was honest", () => {
    const runs = Object.fromEntries(Object.entries(demo.runs).filter(([, r]) => r.status === "honest"));
    expect(headline(vmOf({ ...demo, runs }))).toMatch(/^None of 6 agents overclaimed: they claimed \d+%\. Measured on 154 rows they never saw: \d+%\.$/);
  });

  it("falls back to the counts in the domain's words when no run has both numbers", () => {
    const runs = Object.fromEntries(Object.entries(demo.runs).map(([id, r]) => [id, { ...r, reported_accuracy: null }]));
    expect(headline(vmOf({ ...demo, runs }))).toBe("6 of 12 agents claimed more than was measured");
  });
});

describe("overviewView", () => {
  const html = overviewView(vmOf(demo));

  it("titles the page with the batch's one headline, revealed, and the run counts as a quieter line under it", () => {
    const title = html.slice(html.indexOf('<h1 class="ov-title"'), html.indexOf("</h1>"));
    expect(title).toContain('<span class="mo-sr">6 of 12 agents claimed 89%. Measured on 154 rows they never saw: 75%.</span>');
    expect(title).toContain('class="mo-t" aria-hidden="true"');
    expect(html).toContain('<p class="ov-count" data-morph-key="count" aria-live="polite">12 runs: 6 honest, 6 inflated, 0 failed</p>');
    expect(html.indexOf("</h1>")).toBeLessThan(html.indexOf("ov-count"));
    // The only headline: no second one in the overview.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toContain("bw-headline");
  });

  it("says Simulated nowhere: the page header says it once", () => {
    expect(html).not.toContain("Simulated");
    expect(pageHeadView(vmOf(demo), "fork")).not.toContain("Simulated");
    expect(html).toContain("token counts only, no real spend");
  });

  it("draws a step per stage, each a button to its page, finished ones with a drawn check, this page marked", () => {
    for (const key of ["wall", "split", "phase", "fork", "verdict"]) expect(html).toContain(`data-act="goto" data-arg="${key}"`);
    expect(html.match(/class="ov-step ov-step--done[ "]/g)).toHaveLength(5);
    expect(html).toContain('class="ov-step ov-step--done is-here" data-morph-key="step:wall"');
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
    expect(html).toContain("<b>r09</b> claimed 92.4%, measured 77.3%");
    // Not scored yet: an empty slot, so the row does not shift as runs finish.
    expect(overviewView(vmOf(midRun())).match(/class="ov-bar ov-bar--wait"/g)).toHaveLength(9);
  });

  it("names a robot batch's two scores in its own words, and its bars from 0%", () => {
    const r = overviewView(vmOf(robot, { id: "robot-demo-batch" }));
    expect(r).toContain("Claimed against measured");
    expect(r).toContain("from 0% to 100%");
    expect(r).toContain(">Measured</span>");
    expect(r).toContain("claimed more than was measured");
    expect(r).not.toContain("hidden test");
    expect(r).not.toContain("Hidden test");
  });
});

describe("the pages", () => {
  it("gives each later step an address of its own, and the first page none", () => {
    expect(parseRoute("#/b/demo-batch")).toEqual({ name: "batch", id: "demo-batch" });
    expect(parseRoute("#/b/demo-batch/agents")).toEqual({ name: "batch", id: "demo-batch" });
    expect(parseRoute("#/b/demo-batch/changed")).toEqual({ name: "batch", id: "demo-batch", step: "split" });
    expect(parseRoute("#/b/demo-batch/fork")).toEqual({ name: "batch", id: "demo-batch", step: "fork" });
    // A fork child's address still wins over the fork page's.
    expect(parseRoute("#/b/demo-batch/fork/f1/control-1")).toEqual({ name: "child", id: "demo-batch", fork: "f1", child: "control-1" });
    expect(parseRoute("#/b/demo-batch/nowhere")).toEqual({ name: "batch", id: "demo-batch" });
    expect(routeHash({ name: "batch", id: "demo-batch", step: "phase" })).toBe("#/b/demo-batch/investigator");
    expect(routeHash({ name: "batch", id: "demo-batch", step: "wall" })).toBe("#/b/demo-batch");
  });

  it("opens the first page onto the next only once every agent is scored", () => {
    const mid = pageNav(vmOf(midRun()), "wall");
    expect(mid.next).toBeNull();
    expect(mid.waiting).toEqual({ label: "What changed", why: "once every agent is scored" });
    const html = pagerView(vmOf(midRun()), "wall");
    expect(html).toContain("Next: <b>What changed</b>, once every agent is scored");
    expect(html).toContain("ds-spin");
    expect(html).not.toContain('class="pgr-next');

    const done = pageNav(vmOf(demo), "wall");
    expect(done.next?.key).toBe("split");
    expect(pagerView(vmOf(demo), "wall")).toContain('data-act="goto" data-arg="split" data-morph-key="next:split"');
  });

  it("goes back and forward through the stages, and ends on the way back to the start", () => {
    expect(pageNav(vmOf(demo), "phase")).toMatchObject({ at: 3, of: 5, prev: { key: "split" }, next: { key: "fork" } });
    const last = pagerView(vmOf(demo), "verdict");
    expect(last).toContain('data-arg="fork"');
    expect(last).toContain("That is the whole batch. Back to the agents");
    expect(last).not.toContain('class="pgr-next');
  });

  it("says a later page has nothing yet when the batch has not got there", () => {
    expect(notYetView(vmOf(midRun()), "verdict")).toContain("The verdict appears here once the batch gets there.");
    expect(pageHeadView(vmOf(demo), "fork")).toContain('class="ov-step ov-step--done is-here" data-morph-key="step:fork" data-act="goto" data-arg="fork" aria-current="step"');
  });
});
