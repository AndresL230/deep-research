// The real recording (fixtures/robot-live-investigation, scripts/make_live_fixture.py): what the page shows must be
// what the case file recorded. Nothing here is a hand-made fixture.
import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/robot-live-investigation/case/case.json?raw";
import type { AgentEvent, CaseFile } from "../src/api";
import { diagnosisView, fixView, forkView, investigatorView, verdictView } from "../src/batch/lanes";
import type { BatchVm } from "../src/batch/model";
import { caseAt, replaySchedule } from "../src/batch/replay";
import { investigatorPanelView, suspectBoardView, suspectVerdictView } from "../src/batch/suspects";

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
    // The server's "inconclusive" outcome is an open score, said as on the fork's own evidence.
    expect(html).toContain("chip:Open:");
    expect(html).not.toContain("Inconclusive");
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
    // The fold that holds them counts them.
    expect(html).toContain("its log and 3 hypotheses");
    // Closed, the page is one picture: the count in a line, a row for each explanation with its state and what tested
    // it, and a key for the marks drawn. The full cards wait behind the fold.
    expect(html).toContain("3 explanations. 2 tested. None confirmed yet.");
    expect(html.match(/class="ln-ip-row[ "]/g)).toHaveLength(3);
    for (const s of ["Open", "Untested", "Contradicted", "Fork f1 · score 13.03 of 20", "The measured fix"]) expect(html).toContain(s);
    // Open is the fork's level (4 of 4 pairs agree, short of 20), not the evidence level "inconclusive".
    expect(html).toContain("Open: tested, not enough pairs yet to decide");
    expect(html).not.toContain("Inconclusive");
    for (const s of ["inconclusive", "untested", "contradicted"]) expect(html).toContain(`ln-ip-mk--${s}`);
    const closed = investigatorView({ ...vm, open: { inv: false } });
    expect(closed).toContain("3 explanations. 2 tested. None confirmed yet.");
    expect(closed).not.toContain("ln-hyps");
    const open = investigatorView({ ...vm, open: { inv: true } });
    for (const s of ["Why", "Expects", "Wrong if", "Tested by"]) expect(open).toContain(`<span class="ln-q-k">${s}</span>`);
    // The grader speaks in JSON (the recording's own two lines): the log reads it out in words.
    const grader: AgentEvent[] = [
      { t: 68, type: "thought", agent: "RubricMiddleware.after_agent", text: '{"result":"needs_revision","explanation":"Criteria 1-4 and 6 pass.","failing":[]}' },
      { t: 86, type: "thought", agent: "RubricMiddleware.after_agent", text: '{"result":"satisfied","explanation":"The last recorded verdict names test_table_edges."}' },
    ] as AgentEvent[];
    const logged = investigatorView({ ...vm, events: { investigator: grader }, open: { inv: true } });
    expect(logged).not.toContain("{&quot;result&quot;");
    expect(logged).toContain("Sent the verdict back. Criteria 1-4 and 6 pass.");
    expect(logged).toContain("Passed the verdict. The last recorded verdict names test_table_edges.");
    expect(logged).not.toContain("RubricMiddleware");
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
    // The result in one line, from the computed level, and the counts in one short line under the bars.
    expect(html).toContain("The fix made it worse.");
    expect(html).toContain("Run on 20 hidden setups, no agent in between: 0 fixed, 8 broken.");
    expect(html).toContain("Worse:");
    expect(html).toContain("0 setups gained, 8 lost");
    expect(html).toContain("not the accuracy of any report");
    expect(html).not.toMatch(/fix (improved|worked)/i);
  });

  it("groups the diagnosis by run, the blamed line first, with quotes read as quotes", () => {
    const html = diagnosisView(vm);
    expect(html).toContain("3 runs traced. Partly the same cause.");
    expect(html.match(/class="ln-dx-run"/g)).toHaveLength(3);
    expect(html.match(/class="ln-card ln-dx-entry"/g)).toHaveLength(6);
    // r06's excerpts were saved with their quotes as HTML entities: they are drawn once, not twice.
    expect(html).toContain('(&quot;close&quot;, None, 0.8, GRIPPER_CLOSED),');
    expect(html).not.toContain("&amp;quot;");
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

describe("the live recording's Investigator page", () => {
  // It threw on h3, a code hypothesis with no step label and no quoted actions, so the page never rendered.
  it("renders every competing hypothesis, the code one included", () => {
    const hs = live.hypotheses;
    expect(hs.map((h) => h.id)).toEqual(["h1", "h2", "h3"]);
    expect(hs[2].step_label).toBeNull();
    let html = "";
    expect(() => { html = investigatorView(vm); }).not.toThrow();
    for (const id of ["h1", "h2", "h3"]) expect(html).toContain(`Hypothesis ${id}`);
    expect(html).toContain("A defect in run r06&#39;s code");
    expect(html).toContain('<span class="ln-q-k">Expects</span>');
    expect(html).toContain('<span class="ln-q-k">Wrong if</span>');
    // No empty "No example" boxes for hypotheses that never quoted actions.
    expect(html).not.toContain("No example");
  });

  it("draws the suspect cards for a hypothesis that names no step", () => {
    // h3 blames one run's code and has no step label; the Investigator and Verdict pages still have to render.
    let board = "";
    expect(() => { board = suspectBoardView(vm); }).not.toThrow();
    expect(board).toContain("code defect in r06");
    // h3 was tested by the measured fix: the card says so, and does not call it untested.
    expect(board).toContain("Tested by the measured fix: contradicted.");
    expect(board.match(/Not tested: the investigator reached its verdict first\./g)).toHaveLength(1);
    expect(investigatorPanelView(vm)).toContain("3 proposed · 2 tested");
    expect(() => suspectVerdictView(vm)).not.toThrow();
  });
});
