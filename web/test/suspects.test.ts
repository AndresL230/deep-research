// The investigator's science views (batch/suspects.ts) and their replay (batch/replay-science.ts), against the
// simulated fixture made for them (fixtures/suspects-demo-batch, scripts/make_suspects_fixture.py) and the demo batch,
// which has none of the new sections.
import { afterEach, describe, expect, it, vi } from "vitest";
import caseRaw from "../../fixtures/suspects-demo-batch/case/case.json?raw";
import demoRaw from "../../fixtures/demo-batch/case/case.json?raw";
import invRaw from "../../fixtures/suspects-demo-batch/investigator/events.jsonl?raw";
import { postDecision, postLesson, type AgentEvent, type CaseFile, type ForkExperiment, type PendingForks } from "../src/api";
import { childKey, type BatchVm, type EventKey } from "../src/batch/model";
import { caseAt, replayDuration, replaySchedule } from "../src/batch/replay";
import {
  CLEARED_AFTER, SUPPORTED_AT, approvalView, askedPairs, changeText, clampPairs, interactionView, investigatorPanelView, investigatorState,
  levelOf, lessonsView, logShare, pairsEstimate, scoreOf, scoreText, suspectBoardView, suspectPending, suspectRows, suspectVerdictView,
  sxTagsView, type SuspectPending, type SxCase,
} from "../src/batch/suspects";
import { forkView } from "../src/batch/lanes";

const full = JSON.parse(caseRaw) as SxCase;
const demo = JSON.parse(demoRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const inv = jsonl(invRaw);
const runLogs = import.meta.glob("../../fixtures/suspects-demo-batch/runs/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const forkLogs = import.meta.glob("../../fixtures/suspects-demo-batch/forks/*/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const events: Record<EventKey, AgentEvent[]> = { investigator: inv };
for (const [path, raw] of Object.entries(runLogs)) events[path.split("/").at(-2)!] = jsonl(raw);
for (const [path, raw] of Object.entries(forkLogs)) { const [f, k] = path.split("/").slice(-3, -1); events[childKey(f, k)] = jsonl(raw); }

const vmOf = (c: CaseFile, over: Partial<BatchVm> = {}): BatchVm =>
  ({ id: "suspects-demo-batch", live: false, case: c, events: { investigator: inv }, replay: null, busy: null, error: null, now: 0, ...over });
const pending: SuspectPending = {
  id: "pending", status: "awaiting_approval", n_per_arm: 3, vm_count: 7, estimate_usd: 0.6,
  suspect_id: "s3", change: "force_step:deduplicate", anchor: "before_split", prediction: "smaller_gap", pairs: 3, source_run: "r02",
};
const withPending = (p: PendingForks): CaseFile => ({ ...full, phase: "awaiting_approval", forks: { ...full.forks, pending: p } });

describe("the evidence rule", () => {
  it("multiplies 1.9 per agreeing pair and 0.1 per other, from 1", () => {
    expect(scoreOf([])).toBe(1);
    expect(scoreOf([true, true, true, true])).toBeCloseTo(13.0321, 4);
    expect(scoreOf([true, false])).toBeCloseTo(0.19, 6);
  });
  it("is supported at 20, cleared after 5 pairs under 1, open otherwise", () => {
    expect(levelOf(SUPPORTED_AT, 2)).toBe("supported");
    expect(levelOf(13.03, 4)).toBe("open");
    expect(levelOf(0.01, CLEARED_AFTER - 1)).toBe("open");
    expect(levelOf(0.01, CLEARED_AFTER)).toBe("cleared");
  });
  it("puts scores on a log axis with 1 in the middle", () => {
    expect(logShare(1)).toBeCloseTo(0.5);
    expect(logShare(1000)).toBe(1);
    expect(logShare(0)).toBe(0);
    expect(logShare(20)).toBeGreaterThan(0.7);
    expect(scoreText(169.8356)).toBe("169.8");
    expect(scoreText(13.0321)).toBe("13.03");
    expect(scoreText(0.0036)).toBe("0.0036");
  });
});

describe("the fixture is simulated and consistent", () => {
  it("marks itself and every added record simulated", () => {
    expect((full.config as { simulated?: boolean }).simulated).toBe(true);
    for (const s of full.suspects ?? []) expect(s.simulated).toBe(true);
    for (const l of full.lessons ?? []) expect(l.simulated).toBe(true);
    expect((full.interaction as { simulated?: boolean }).simulated).toBe(true);
  });
  it("scores each suspect from its forks' pairs", () => {
    for (const r of suspectRows(full)) {
      if (!r.pairs.length) continue;
      expect(r.score).toBeCloseTo(scoreOf(r.pairs.map((p) => p.agree)), 3);
    }
    const [s1, s2, s3] = ["s1", "s2", "s3"].map((id) => suspectRows(full).find((r) => r.s.id === id)!);
    expect([s1.status, s2.status, s3.status]).toEqual(["supported", "cleared", "proposed"]);
    expect(s1.nPairs).toBe(8);
    expect(s3.score).toBeNull();
  });
});

describe("the suspect board", () => {
  const html = suspectBoardView(vmOf(full));
  it("shows each suspect with its proposer, prediction, score, bar, dots and status", () => {
    for (const s of ["s1", "s2", "s3", "lens-omission", "lens-data", "skeptic", "the change shrinks the gap", "169.8", "Supported", "Cleared", "Proposed"]) expect(html).toContain(s);
    expect(html).toContain('class="sx-bar-bar"');
    expect(html.match(/sx-dot--agree/g)?.length).toBe(8 + 2);
    expect(html.match(/sx-dot--disagree/g)?.length).toBe(3);
    expect(html).toContain("no spend (simulated)");
  });
  it("puts the supported suspect first", () => {
    expect(html.indexOf("sx-sus--supported")).toBeLessThan(html.indexOf("sx-sus--cleared"));
  });
  it("is empty without suspects or hypotheses", () => {
    expect(suspectBoardView(vmOf({ ...demo, hypotheses: [] }))).toBe("");
  });
  it("reads hypotheses with an id when there is no suspects list, and never calls one supported without a score", () => {
    const c: CaseFile = { ...demo, hypotheses: [{ ...demo.hypotheses[0], id: "h1", status: "supported", tested_by: "nope" }] };
    const rows = suspectRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBeNull();
    expect(rows[0].status).not.toBe("supported");
  });
});

describe("the approval card", () => {
  it("shows the suspect, change, prediction, pairs and estimate, and takes over from lanes.ts's card", () => {
    const c = withPending(pending);
    const html = approvalView(vmOf(c, { live: true }));
    for (const s of ["s3", "evaluate", "force_step:deduplicate", "Run a step: deduplicate", "the change shrinks the gap", "$0.60", 'data-act="approve"', 'data-act="sx-pairs"']) expect(html).toContain(s);
    expect(forkView(vmOf(c, { live: true }))).not.toContain("ln-approval");
  });
  it("scales the estimate with edited pairs and says so on the button", () => {
    const html = approvalView(vmOf(withPending(pending), { live: true, pairs: 5 }));
    expect(html).toContain("$1.00");
    expect(html).toContain("Approve 5 pairs");
    expect(html).toContain("edited from 3");
    expect(pairsEstimate({ ...pending, cost_per_pair_usd: 0.25 }, 4)).toBe(1);
  });
  it("holds pairs to 1..6", () => {
    expect(clampPairs(0)).toBe(1);
    expect(clampPairs(9)).toBe(6);
    expect(askedPairs({ ...pending, pairs: null, n_per_arm: 4 })).toBe(4);
  });
  it("leaves an older request to lanes.ts", () => {
    const old: PendingForks = { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: null };
    expect(suspectPending(withPending(old))).toBeNull();
    expect(approvalView(vmOf(withPending(old)))).toBe("");
  });
  it("words changes", () => {
    expect(changeText("swap_model:claude-sonnet-5-5")).toBe("Swap the model: claude-sonnet-5-5");
    expect(changeText(null)).toBe("–");
  });
});

describe("the verdict by suspect", () => {
  const html = suspectVerdictView(vmOf(full));
  it("groups suspects with their score and pairs", () => {
    expect(html).toContain("Supported causes");
    expect(html).toMatch(/s1.*deduplicate.*score <b>169\.8<\/b> over 8 pairs/s);
    expect(html).toMatch(/s2.*score <b>0\.0036<\/b> over 5 pairs/s);
  });
  it("draws the two-factor grid and the audit sheet", () => {
    expect(html).toContain('class="sx-grid"');
    expect(html).toContain("14.2 pts");
    expect(html).toContain("Audit sheet");
    expect(html).toContain("Test touched training?");
    expect(html).toContain("r01");
  });
  it("is empty with nothing scored, no grid and no audit", () => {
    expect(suspectVerdictView(vmOf({ ...demo, audit: undefined }))).toBe("");
    expect(interactionView(null)).toBe("");
  });
});

describe("the investigator panel", () => {
  it("shows its plan and the subagent of the latest event while it works", () => {
    const cut = inv.slice(0, inv.findIndex((e) => e.agent === "lens-data") + 1);
    const c: CaseFile = { ...full, phase: "investigating", investigator: undefined } as SxCase;
    const st = investigatorState(c, cut);
    expect(st.subagent).toBe("lens-data");
    expect(st.todos.find((t) => t.status === "in_progress")?.content).toBe("Ask the lenses for suspects");
    const html = investigatorPanelView(vmOf(c, { events: { investigator: cut } }));
    expect(html).toContain("lens-data");
    expect(html).toContain("sx-todo--now");
  });
  it("reads the investigator section when written", () => {
    const html = investigatorPanelView(vmOf(full));
    expect(html).toContain("6 of 6 done");
    expect(html).toContain("the investigator itself");
  });
  it("is empty with no plan and no subagents", () => {
    expect(investigatorPanelView(vmOf(demo, { events: {} }))).toBe("");
  });
});

describe("lessons and tags", () => {
  it("lists proposed rules with approve and reject", () => {
    const html = lessonsView(vmOf(full, { live: true }));
    expect(html.match(/data-act="sx-lesson-approve"/g)).toHaveLength(2);
    expect(html).toContain("dedupe-before-split");
    expect(html).toContain("Approved");
    expect(lessonsView(vmOf(demo))).toBe("");
  });
  it("tags a simulated batch and the investigator assist", () => {
    expect(sxTagsView(vmOf(full))).toContain("Simulated batch");
    expect(sxTagsView(vmOf(full))).not.toContain("assist");
    const on = { ...full, config: { ...full.config, investigator_assist: "baseline" } } as unknown as CaseFile;
    expect(sxTagsView(vmOf(on))).toContain("Investigator assist on");
    const real = { ...demo, config: { ...demo.config, simulated: false }, costs: {} } as unknown as CaseFile;
    expect(sxTagsView(vmOf(real))).toBe("");
  });
});

describe("the replay", () => {
  const s = replaySchedule(full, events);
  const D = replayDuration(full, events);
  const [f1, f2] = s.forks;
  it("ends on the final case file", () => {
    const end = caseAt(full, events, D) as SxCase;
    expect(end.suspects).toEqual(full.suspects);
    expect(end.lessons).toEqual(full.lessons);
    expect(end.interaction).toEqual(full.interaction);
  });
  it("asks for each experiment with its suspect, change and prediction", () => {
    const c = caseAt(full, events, f2.approvalStart + 1);
    const p = suspectPending(c);
    expect(p?.suspect_id).toBe("s2");
    expect(p?.change).toBe("swap_model:claude-sonnet-5-5");
    expect(askedPairs(p!)).toBe(5);
  });
  it("tests, then scores, each suspect in turn", () => {
    const mid = caseAt(full, events, f1.runningAt + 1) as SxCase;
    expect(mid.suspects?.find((x) => x.id === "s1")?.status).toBe("testing");
    expect(mid.evidence?.s1).toBeUndefined();
    expect((mid.forks.f1 as ForkExperiment).score).toBeUndefined();
    const after = caseAt(full, events, f1.doneAt + 0.1) as SxCase;
    expect(after.evidence?.s1?.level).toBe("supported");
    expect(after.suspects?.find((x) => x.id === "s2")?.status).toBe("proposed");
    expect(after.lessons).toBeUndefined();
  });
});

describe("the decision body", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = () => { const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }))); vi.stubGlobal("fetch", f); return f; };
  const body = (f: ReturnType<typeof stub>, i = 0) => JSON.parse(String((f.mock.calls[i] as unknown as [string, RequestInit])[1].body));
  it("stays {approve} unless pairs were edited", async () => {
    const f = stub();
    await postDecision("b1", true);
    await postDecision("b1", true, {}, 5);
    expect(body(f, 0)).toEqual({ approve: true });
    expect(body(f, 1)).toEqual({ approve: true, pairs: 5 });
  });
  it("posts a lesson decision", async () => {
    const f = stub();
    await postLesson("b1", "l1", false);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("/api/batches/b1/lessons/l1");
    expect(body(f)).toEqual({ approve: false });
  });
});
