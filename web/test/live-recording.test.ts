// The real recording (fixtures/robot-live-investigation, scripts/make_live_fixture.py): what the page shows must be
// what the case file recorded. Nothing here is a hand-made fixture.
import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/robot-live-investigation/case/case.json?raw";
import type { AgentEvent, CaseFile } from "../src/api";
import { fixView, forkView, investigatorView, verdictView } from "../src/batch/lanes";
import type { BatchVm } from "../src/batch/model";
import { caseAt, replaySchedule } from "../src/batch/replay";

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
    for (const id of ["h1", "h2", "h3"]) expect(html).toContain(`<span class="ln-tag">${id}</span>`);
    expect(html).toContain("Inconclusive");
    // All 16 copies were rebuilt by replay (Daytona refused to fork): the page must not call them forks.
    expect(html).toContain("Each copy is a fresh VM that replayed the run");
    expect(html).toContain("0 of 16 forked, 16 rebuilt by replay");
    expect(html).not.toContain("Each copy is a copy-on-write fork");
  });

  it("lists every competing hypothesis on the investigator's page, the code one too, with what tested it", () => {
    // h3 is a code hypothesis: it names a run and no step label.
    const h3 = live.hypotheses.find((h) => h.id === "h3")!;
    expect([h3.kind, h3.step_label, h3.run_id]).toEqual(["code", null, "r06"]);
    const html = investigatorView(vm);
    for (const id of ["h1", "h2", "h3"]) expect(html).toContain(`Hypothesis ${id}`);
    for (const s of ["Predicts", "Falsified if", "Inconclusive", "Untested", "Contradicted", "Fork f1", "The measured fix"]) expect(html).toContain(s);
    // Competing hypotheses have no example commands: no empty code boxes.
    expect(html).not.toContain("No example");
  });

  it("replays each hypothesis's state and the fork's outcome in time, never ahead of the fork", () => {
    const s = replaySchedule(live, events);
    const slot = s.forks[0];
    const at = (t: number) => caseAt(live, events, t);
    const h = (t: number, id: string) => at(t).hypotheses.find((x) => x.id === id);
    expect(h(slot.approvalStart, "h1")?.status).toBe("untested");
    expect(h(slot.approvalStart, "h1")?.tested_by).toBeUndefined();
    expect(h(slot.runningAt, "h1")?.status).toBe("testing");
    expect((at(slot.runningAt).forks.f1 as { outcome?: string }).outcome).toBeUndefined();
    expect(h(slot.doneAt, "h1")?.status).toBe("inconclusive");
    expect((at(slot.doneAt).forks.f1 as { outcome?: string }).outcome).toBe("inconclusive");
    // h3 was tested by the fix, which the replay shows at its end.
    expect(h(slot.doneAt, "h3")?.status).toBe("untested");
    expect(h(s.duration, "h3")?.status).toBe("contradicted");
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
    expect(html).toContain("The evidence level counts honest reports only.");
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
