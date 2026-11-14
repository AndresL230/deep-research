// The real recording (fixtures/robot-live-investigation, scripts/make_live_fixture.py): what the page shows must be
// what the case file recorded. Nothing here is a hand-made fixture.
import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/robot-live-investigation/case/case.json?raw";
import type { AgentEvent, CaseFile } from "../src/api";
import { fixView, forkView, verdictView } from "../src/batch/lanes";
import type { BatchVm } from "../src/batch/model";

const live = JSON.parse(caseRaw) as CaseFile & { config: { recording?: { kind: string } } };
const logs = import.meta.glob("../../fixtures/robot-live-investigation/forks/f1/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const events: Record<string, AgentEvent[]> = Object.fromEntries(Object.entries(logs).map(([p, raw]) =>
  [`f1/${p.split("/").at(-2)}`, raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent)]));
const vm: BatchVm = { id: "robot-live-investigation", live: false, case: live, events, replay: null, busy: null, error: null, now: 0, open: "all" } as BatchVm;

describe("the live robot recording", () => {
  it("is a recording of a real run, not a simulated fixture", () => {
    expect(live.config.recording?.kind).toBe("live");
    expect((live.config as { simulated?: boolean }).simulated).toBeFalsy();
  });

  it("shows the tested hypothesis, its pre-registered prediction, the competing ones and the computed outcome", () => {
    const html = forkView(vm);
    const f1 = live.forks.f1 as { prediction: string; outcome: string; hypothesis_id: string };
    expect(f1.hypothesis_id).toBe("h1");
    expect(html).toContain("Hypothesis h1");
    expect(html).toContain("Saved before any copy ran:");
    for (const id of ["h1", "h2", "h3"]) expect(html).toContain(`<b>${id}</b>`);
    expect(html).toContain("Inconclusive");
    // All 16 copies were rebuilt by replay (Daytona refused to fork): the page must not call them forks.
    expect(html).toContain("Each copy is a fresh VM that replayed the run");
    expect(html).toContain("0 of 16 forked, 16 rebuilt by replay");
    expect(html).not.toContain("Each copy is a copy-on-write fork");
  });

  it("shows the measured fix as worse, with its sign test, and the investigator's sentence", () => {
    const html = fixView(vm);
    const m = live.fix!.measured!;
    expect([m.before.true_accuracy, m.after.true_accuracy, m.gained, m.lost]).toEqual([0.65, 0.25, 0, 8]);
    expect(html).toContain("Worse:");
    expect(html).toContain("0 setups gained, 8 lost");
    expect(html).toContain("not the accuracy of any report");
    expect(html).not.toMatch(/fix (improved|worked)/i);
  });

  it("shows a verdict that is open and claims no cause, and says what the fork measures", () => {
    const html = verdictView(vm);
    expect(html).toContain("Copies built by VM fork: 0; by replaying the run on a fresh VM: 16.");
    expect(html).toContain("measures whether the reports became accurate, not whether the controller works better");
    expect(live.verdict!.evidence!.level).toBe("open");
    expect(live.verdict!.sentence).not.toMatch(/\bcaus(e|ed|es)\b/i);
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("the live recording's forced arm", () => {
  it("says the robot got better, because every forced copy rewrote its controller and measured 90-100%", () => {
    const html = forkView(vm);
    expect(html).toContain("The robot got better by 30.0 pts. Its claim is honest now.");
    expect(html).not.toContain("can change the report more than the controller");
  });
});
