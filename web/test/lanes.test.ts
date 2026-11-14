// The Split, Fork, Verdict and Investigator views (src/batch/lanes.ts) against the committed demo batch.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import forcedEventsRaw from "../../fixtures/demo-batch/forks/f1/forced-1/events.jsonl?raw";
import type { AgentEvent, CaseFile, ForkExperiment, PendingForks } from "../src/api";
import {
  armSummaryText, clip, eventLine, forkView, investigatorView, isProblemPhase, laneLabel, numberLabel, phaseText,
  shortArgs, sortedChildren, splitIndex, splitSentence, splitView, verdictArms, verdictView,
} from "../src/batch/lanes";
import type { BatchVm } from "../src/batch/model";

const demo = JSON.parse(caseRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);

const vmOf = (c: Partial<CaseFile> = {}, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "demo", live: false, case: { ...structuredClone(demo), ...c }, events: {}, replay: null, busy: null, error: null, now: 0, ...over,
});
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("helpers", () => {
  it("phaseText covers every phase and keeps blocked and error reasons", () => {
    expect(phaseText("running")).toBe("Agents are running");
    expect(phaseText("analyzing")).toBe("Scoring runs and finding the split");
    expect(phaseText("ready")).toBe("Split found. Ready to investigate");
    for (const p of ["investigating", "awaiting_approval", "forking", "forked", "done", "no_split", "stopped"]) {
      expect(phaseText(p)).not.toBe(p);
    }
    expect(phaseText("blocked: over budget")).toBe("Blocked: over budget");
    expect(phaseText("error: VM died")).toBe("Error: VM died");
    expect(isProblemPhase("error: x")).toBe(true);
    expect(isProblemPhase("done")).toBe(false);
    expect(phaseText("something_new")).toBe("something_new");
  });

  it("laneLabel prefers the split label, then split, then the first non-load label", () => {
    expect(laneLabel(["load", "deduplicate"], "deduplicate")).toBe("deduplicate");
    expect(laneLabel(["load", "inspect", "plot"])).toBe("inspect");
    expect(laneLabel(["load", "split", "train"], "deduplicate")).toBe("split");
    expect(laneLabel(["load"])).toBe("load");
    expect(laneLabel([])).toBe("");
  });

  it("splitIndex finds the first split action", () => {
    expect(splitIndex(demo.runs.r01.labels!)).toBe(4);
    expect(splitIndex(demo.runs.r02.labels!)).toBe(3);
    expect(splitIndex([["load"], ["inspect"]])).toBe(2);
  });

  it("splitSentence and armSummaryText read the demo numbers", () => {
    expect(splitSentence(demo.split!)).toBe("Honest runs did deduplicate before splitting 100% of the time, inflated runs 0%");
    const f = demo.forks.f1 as ForkExperiment;
    expect(armSummaryText(f.arms!.control)).toBe("3 of 4 inflated, mean reported 87.8% vs true 73.5%");
    expect(armSummaryText({ ...f.arms!.forced, failed: 1 })).toContain("0 of 4 inflated, 1 failed");
  });

  it("clip, shortArgs, numberLabel", () => {
    expect(clip("a  b\n c", 10)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(shortArgs({ n_per_arm: 4, run: "r02" })).toBe('n_per_arm=4, run="r02"');
    expect(numberLabel("control_inflated")).toBe("Control inflated");
  });

  it("eventLine summarizes each event kind", () => {
    const evs = jsonl(forcedEventsRaw);
    for (const ev of evs) expect(eventLine(ev).text.length).toBeGreaterThan(0);
    expect(eventLine({ t: 1, type: "tool_call", id: "x", name: "read_run", args: { run: "r01" } }).text).toBe('read_run(run="r01")');
    expect(eventLine({ t: 1, type: "thought", text: "x".repeat(400) }).text.length).toBeLessThanOrEqual(160);
  });

  it("sortedChildren orders by number within an arm", () => {
    const f = demo.forks.f1 as ForkExperiment;
    expect(sortedChildren(f.children, "control").map(([id]) => id)).toEqual(["control-1", "control-2", "control-3", "control-4"]);
  });
});

describe("splitView", () => {
  it("is empty before any labels or split", () => {
    const runs = Object.fromEntries(Object.entries(demo.runs).map(([k, r]) => [k, { ...r, labels: undefined }]));
    expect(splitView(vmOf({ split: null, runs, phase: "running" }))).toBe("");
  });

  it("draws one clickable lane per scored run, honest first, the split step lit", () => {
    const html = splitView(vmOf());
    expect(html).toContain("Honest runs did deduplicate before splitting 100% of the time, inflated runs 0%");
    expect(count(html, 'data-act="open-run"')).toBe(12);
    expect(html.indexOf('data-arg="r01"')).toBeLessThan(html.indexOf('data-arg="r02"'));
    expect(html.indexOf('data-arg="r12"')).toBeLessThan(html.indexOf('data-arg="r02"'));
    expect(count(html, "ln-chip is-lit")).toBe(6);
    expect(count(html, "ln-fork-tag")).toBe(1);
    expect(html).toContain("data-morph-list");
    expect(html).toContain("Simulated");
  });

  it("shows both commands escaped and where the fork happens", () => {
    const html = splitView(vmOf());
    expect(html).toContain("df.drop_duplicates()");
    expect(html).toContain("python3 model.py");
    expect(html).toContain("&#39;data.csv&#39;");
    expect(html).toContain("run <b>r02</b> after action 3");
    expect(html).toContain("Remove duplicate rows from data.csv before the split");
  });

  it("says no step separates the groups when there is no split", () => {
    const html = splitView(vmOf({ split: null, phase: "no_split" }));
    expect(html).toContain("No step separates honest and inflated runs");
    expect(html).not.toContain("is-lit");
  });
});

describe("forkView", () => {
  const pending: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.234 };

  it("is empty without forks", () => {
    expect(forkView(vmOf({ forks: {} }))).toBe("");
  });

  it("renders the approval card, enabled only when live and idle", () => {
    const replay = forkView(vmOf({ forks: { pending }, phase: "awaiting_approval" }));
    expect(replay).toContain("The investigator wants to fork run r02 before its split: 4 control and 4 forced runs, 9 VMs");
    expect(replay).toContain("$1.23");
    expect(replay).toContain("Approval happens on live batches");
    expect(count(replay, " disabled")).toBe(2);

    const live = forkView(vmOf({ forks: { pending } }, { live: true }));
    expect(live).toContain('data-act="approve"');
    expect(live).toContain('data-act="decline"');
    expect(count(live, " disabled")).toBe(0);

    const busy = forkView(vmOf({ forks: { pending: { ...pending, estimate_usd: null } } }, { live: true, busy: "approve" }));
    expect(count(busy, " disabled")).toBe(2);
    expect(busy).toContain("unknown, prices missing");
  });

  it("renders both arms with clickable child tiles and arm summaries", () => {
    const html = forkView(vmOf());
    expect(html).toContain("Forked run <b>r02</b> after action 3");
    expect(count(html, 'data-act="open-child"')).toBe(8);
    expect(html).toContain('data-arg="f1/control-1"');
    expect(html).toContain('data-arg="f1/forced-4"');
    expect(html).toContain("3 of 4 inflated, mean reported 87.8% vs true 73.5%");
    expect(html).toContain("0 of 4 inflated");
    expect(html).toContain("Continues unchanged");
  });

  it("shows only the children present while running", () => {
    const f = structuredClone(demo.forks.f1) as ForkExperiment;
    f.status = "running";
    delete f.arms;
    f.children = { "control-1": { arm: "control", status: "running", how: "fork" } };
    const html = forkView(vmOf({ forks: { f1: f } }));
    expect(count(html, 'data-act="open-child"')).toBe(1);
    expect(html).toContain("1 of 4 started");
    expect(html).not.toContain("mean reported");
  });
});

describe("verdictView", () => {
  it("is empty without a verdict", () => {
    expect(verdictView(vmOf({ verdict: null }))).toBe("");
  });

  it("shows the sentence, one dot per child and the numbers", () => {
    const html = verdictView(vmOf());
    expect(html).toContain(demo.verdict!.sentence);
    expect(count(html, "ln-dot ln-dot--inflated\" title")).toBe(3);
    expect(count(html, "ln-dot ln-dot--honest\" title")).toBe(5);
    expect(html).toContain("3 of 4 inflated");
    expect(html).toContain("0 of 4 inflated");
    expect(html).toContain("Control inflated");
    expect(html).toContain("Simulated batch");
  });

  it("falls back to the verdict numbers without a fork", () => {
    const arms = verdictArms({ ...demo, forks: {} })!;
    expect(arms.control.statuses).toEqual(["inflated", "inflated", "inflated", "honest"]);
    expect(arms.forced.inflated).toBe(0);
  });
});

describe("investigatorView", () => {
  it("is empty before the batch starts", () => {
    expect(investigatorView(vmOf({ phase: "config" }))).toBe("");
  });

  it("renders cleanly with no events and shows the hypotheses", () => {
    const html = investigatorView(vmOf());
    expect(html).toContain("Done");
    expect(html).toContain("Hypothesis");
    expect(html).toContain("100% of honest runs removed duplicates");
    expect(html).not.toContain('data-act="investigate"');
    expect(html).not.toContain('data-act="stop"');
  });

  it("offers Investigate when ready and Stop while working, live only", () => {
    expect(investigatorView(vmOf({ phase: "ready" }, { live: true }))).toContain('data-act="investigate"');
    expect(investigatorView(vmOf({ phase: "ready" }))).not.toContain('data-act="investigate"');
    const running = investigatorView(vmOf({ phase: "running" }, { live: true, busy: "stop", error: "Nope <b>" }));
    expect(running).toContain('data-act="stop" disabled');
    expect(running).toContain("Nope &lt;b&gt;");
  });

  it("shows error phases as an error line", () => {
    expect(investigatorView(vmOf({ phase: "error: VM died" }))).toContain('class="ln-err" role="alert">Error: VM died');
  });

  it("lists the last 8 investigator events with their agent", () => {
    const evs: AgentEvent[] = Array.from({ length: 12 }, (_, i) => ({ t: i, type: "thought", text: `step ${i}`, agent: i % 2 ? "step-tagger" : "investigator" }));
    const html = investigatorView(vmOf({ phase: "investigating" }, { events: { investigator: evs } }));
    expect(count(html, "class=\"ln-ev ")).toBe(8);
    expect(html).not.toContain("step 3<");
    expect(html).toContain("step 11");
    expect(html).toContain('data-morph-key="ev-11"');
    expect(html).toContain("step-tagger");
  });
});

describe("copy", () => {
  it("has no em dashes", () => {
    const all = [splitView(vmOf()), forkView(vmOf()), verdictView(vmOf()), investigatorView(vmOf())].join("");
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});
