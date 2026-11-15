// A batch a server restart cut off (deep_research/batch.py `recover_interrupted`) says why it stopped, and an
// investigation cut off offers to continue on its saved thread instead of saying "The investigator is working" forever.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/tabular-live-investigation/case/case.json?raw";
import type { CaseFile } from "../src/api";
import { cutText, investigatorView } from "../src/batch/lanes";
import type { BatchVm } from "../src/batch/model";
import { investigatorPanelView } from "../src/batch/suspects";

const full = JSON.parse(caseRaw) as CaseFile;
const REASON = "The server restarted, so nothing is running it any more.";
// The tabular recording cut off while its investigator worked: no verdict yet.
const cut = { ...full, verdict: null, phase: "stopped", interrupted: { at: 0, phase: "investigating", reason: REASON } } as CaseFile;
const vm = (o: Partial<BatchVm> = {}): BatchVm =>
  ({ id: "1115-113059-f55e", live: false, resumable: true, case: cut, events: {}, replay: null, busy: null, error: null, now: 0, open: {}, role: "admin", ...o }) as BatchVm;

describe("a batch a restart cut off", () => {
  it("says it stopped and why, and offers to continue the investigation", () => {
    const html = investigatorView(vm());
    expect(html).toContain('data-act="continue-investigation"');
    expect(html).toContain("Continue investigation");
    expect(html).toContain(`Stopped while the investigator was working. ${REASON} Continue picks the investigator up on its saved thread, where it stopped.`);
    expect(html).not.toContain("The investigator is working");
    // Not the button a fresh batch gets.
    expect(html).not.toContain('data-act="investigate"');
  });

  it("offers nothing to continue when the server cannot resume it, or to someone who cannot act", () => {
    const off = investigatorView(vm({ resumable: false }));
    expect(off).not.toContain("continue-investigation");
    expect(off).toContain(`Stopped while the investigator was working. ${REASON}`);
    expect(off).not.toContain("Continue picks");
    expect(investigatorView(vm({ role: "viewer" }))).not.toContain("continue-investigation");
  });

  it("says what each phase was doing when it was cut off", () => {
    expect(cutText({ phase: "running", reason: REASON }, false)).toBe(`Stopped while the agents were running. ${REASON}`);
    expect(cutText({ phase: "forking", reason: REASON }, true)).toMatch(/^Stopped while the experiment copies were running\. .* Continue picks/);
    expect(cutText({ phase: "odd", reason: REASON }, false)).toBe(`Stopped while it was odd. ${REASON}`);
  });

  it("never says an investigation cut off finished", () => {
    // The deployed batch's own state: its plan's first step under way, and its data lens running when it stopped.
    const investigator = { thread_id: "t", subagent: "lens-data", todos: [{ content: "Observe: read case.json, skill, runs", status: "in_progress" }],
      subagent_calls: { "step-tagger": 4, "lens-data": 1 } };
    const panel = investigatorPanelView(vm({ case: { ...cut, investigator } as unknown as CaseFile }));
    expect(panel).toContain("It was cut off before a verdict.");
    expect(panel).not.toContain("It finished without a verdict.");
  });

  it("shows nothing of it once the batch runs again", () => {
    expect(investigatorView(vm({ case: { ...cut, phase: "investigating" } as CaseFile }))).not.toContain("ln-cut");
  });
});
