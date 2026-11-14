// The replay timeline against the committed demo batch (fixtures/demo-batch/): every run and fork child log.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { AgentEvent, CaseFile, ForkExperiment, PendingForks } from "../src/api";
import { childKey, type EventKey } from "../src/batch/model";
import { caseAt, eventsAt, replayBar, replayDuration, replayPhaseAt, replaySchedule } from "../src/batch/replay";

const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const runLogs = import.meta.glob("../../fixtures/demo-batch/runs/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const forkLogs = import.meta.glob("../../fixtures/demo-batch/forks/*/*/events.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const full = JSON.parse(caseRaw) as CaseFile;
const frozen = JSON.parse(caseRaw) as CaseFile;
const events: Record<EventKey, AgentEvent[]> = {};
for (const [path, raw] of Object.entries(runLogs)) events[path.split("/").at(-2)!] = jsonl(raw);
for (const [path, raw] of Object.entries(forkLogs)) {
  const [fork, child] = path.split("/").slice(-3, -1);
  events[childKey(fork, child)] = jsonl(raw);
}
const D = replayDuration(full, events);
const s = replaySchedule(full, events);
const fork = (c: CaseFile): ForkExperiment | undefined => c.forks.f1 as ForkExperiment | undefined;

describe("the replay schedule", () => {
  it("loads every log", () => {
    expect(Object.keys(events)).toHaveLength(20);
  });

  it("plays the demo batch in about 60 to 90 s at 4x", () => {
    expect(D / 4).toBeGreaterThanOrEqual(55);
    expect(D / 4).toBeLessThanOrEqual(90);
    expect(s.runsEnd).toBeCloseTo(70, 1);
  });

  it("orders the segments", () => {
    const f = s.forks[0];
    const marks = [0, s.runsEnd, s.readyAt, s.investigateStart!, s.investigateEnd!, f.approvalStart, f.rebuildAt, f.runningAt, f.doneAt, s.forkedStart!, D];
    for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThanOrEqual(marks[i - 1]);
    expect(f.approvalStart).toBe(s.investigateEnd);
    expect(s.forkedStart).toBe(f.doneAt);
  });
});

describe("caseAt", () => {
  it("starts with every run queued and nothing scored", () => {
    const c = caseAt(full, events, 0);
    expect(c.phase).toBe("running");
    expect(Object.keys(c.runs)).toEqual(Object.keys(full.runs));
    for (const r of Object.values(c.runs)) {
      expect(r.status).toBe("queued");
      for (const k of ["reported_accuracy", "true_accuracy", "overlap_share", "gap", "reason", "n_actions", "labels"]) expect(r).not.toHaveProperty(k);
    }
    expect(c.split).toBeNull();
    expect(c.forks).toEqual({});
    expect(c.verdict).toBeNull();
    expect(c.costs.scopes?.runs.input_tokens).toBe(0);
    expect(c.costs.budget_usd).toBe(full.costs.budget_usd);
  });

  it("shows runs working mid-way, with their step and last tool", () => {
    const c = caseAt(full, events, 30);
    const runs = Object.values(c.runs);
    expect(runs.every((r) => r.status === "running")).toBe(true);
    for (const r of runs) {
      expect(typeof r.step).toBe("string");
      expect(r.todos?.length).toBeGreaterThan(0);
      expect(r).not.toHaveProperty("reported_accuracy");
    }
    expect(runs.some((r) => r.last_tool)).toBe(true);
    // r02's todos at t=30: "Train a random forest" in progress (its 29.35 todos event).
    expect(c.runs.r02.step).toBe("Train a random forest");
    expect(c.runs.r02.last_tool).toBe("write_file");
    const tok = c.costs.scopes!.runs.input_tokens;
    expect(tok).toBeGreaterThan(0);
    expect(tok).toBeLessThan(full.costs.scopes!.runs.input_tokens);
  });

  it("scores each run at its end: some honest or inflated while others still run", () => {
    const c = caseAt(full, events, 50);
    expect(c.runs.r02.status).toBe("inflated");
    expect(c.runs.r02.reported_accuracy).toBe(full.runs.r02.reported_accuracy);
    expect(c.runs.r12.status).toBe("running");
  });

  it("matches every final status once the runs end, then reveals the split", () => {
    const c = caseAt(full, events, s.runsEnd);
    for (const [id, r] of Object.entries(full.runs)) expect(c.runs[id]).toEqual(r);
    expect(c.phase).toBe("analyzing");
    expect(c.split).toBeNull();
    const ready = caseAt(full, events, s.readyAt);
    expect(ready.phase).toBe("ready");
    expect(ready.split).toEqual(full.split);
    expect(ready.hypotheses).toEqual([]);
  });

  it("investigates, and the hypothesis appears before the approval card", () => {
    expect(replayPhaseAt(full, events, s.investigateStart!)).toBe("investigating");
    expect(caseAt(full, events, s.investigateStart!).hypotheses).toEqual([]);
    const late = caseAt(full, events, s.investigateEnd! - 0.1);
    expect(late.hypotheses).toEqual(full.hypotheses);
    expect(late.forks).toEqual({});
  });

  it("shows a pending fork for the approval beat, then removes it", () => {
    const f = s.forks[0];
    const c = caseAt(full, events, f.approvalStart + 1);
    expect(c.phase).toBe("awaiting_approval");
    const p = c.forks.pending as PendingForks;
    expect(p).toEqual({ id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: null });
    expect(c.forks.f1).toBeUndefined();
    const after = caseAt(full, events, f.rebuildAt);
    expect(after.forks.pending).toBeUndefined();
    expect(after.phase).toBe("forking");
    expect(fork(after)?.status).toBe("rebuilding");
    expect(fork(after)?.children).toEqual({});
  });

  it("runs the fork children in parallel and sets arms only when all are done", () => {
    const f = s.forks[0];
    const early = caseAt(full, events, f.runningAt);
    expect(fork(early)?.status).toBe("running");
    expect(fork(early)?.children).toEqual({});
    const mid = caseAt(full, events, f.runningAt + 20);
    const kids = Object.values(fork(mid)!.children);
    expect(kids).toHaveLength(8);
    for (const k of kids) {
      expect(k.status).toBe("running");
      expect(k).not.toHaveProperty("reported_accuracy");
    }
    expect(fork(mid)?.arms).toBeUndefined();
    const almost = caseAt(full, events, f.doneAt - 0.01);
    expect(fork(almost)?.arms).toBeUndefined();
    expect(Object.values(fork(almost)!.children).some((k) => k.status !== "running")).toBe(true);
    const done = caseAt(full, events, f.doneAt);
    expect(fork(done)).toEqual(full.forks.f1);
    expect(done.phase).toBe("forked");
    expect(done.verdict).toBeNull();
  });

  it("ends on the final case file, verdict included, and never mutates its inputs", () => {
    expect(caseAt(full, events, D)).toEqual(full);
    expect(caseAt(full, events, D + 100)).toEqual(full);
    expect(replayPhaseAt(full, events, D)).toBe("done");
    for (const t of [0, 10, 40, 80, 120, 170, 200, D - 1]) caseAt(full, events, t);
    expect(full).toEqual(frozen);
  });

  it("moves through the phases in order", () => {
    const order = ["running", "analyzing", "ready", "investigating", "awaiting_approval", "forking", "forked", "done"];
    const seen: string[] = [];
    for (let t = 0; t <= D; t += 0.5) {
      const p = replayPhaseAt(full, events, t);
      expect(p).toBe(caseAt(full, events, t).phase);
      if (seen.at(-1) !== p) seen.push(p);
    }
    if (seen.at(-1) !== "done") seen.push(replayPhaseAt(full, events, D));
    expect(seen).toEqual(order);
  });
});

describe("eventsAt", () => {
  it("grows each log monotonically from empty to whole", () => {
    const at0 = eventsAt(full, events, 0);
    for (const evs of Object.values(at0)) expect(evs).toHaveLength(0);
    let prev = at0;
    for (let t = 0.5; t <= D + 1; t += 0.5) {
      const now = eventsAt(full, events, t);
      for (const k of Object.keys(events)) expect(now[k].length).toBeGreaterThanOrEqual(prev[k].length);
      prev = now;
    }
    for (const k of Object.keys(events)) expect(prev[k]).toEqual(events[k]);
  });

  it("starts fork child logs when the child starts, with the copied history at once", () => {
    const f = s.forks[0];
    const key = childKey("f1", "forced-1");
    expect(eventsAt(full, events, f.children["forced-1"].start - 0.01)[key]).toHaveLength(0);
    expect(eventsAt(full, events, f.children["forced-1"].start)[key]).toHaveLength(5);
    expect(eventsAt(full, events, f.children["forced-1"].end)[key]).toHaveLength(events[key].length);
  });

  it("cuts run logs at their own clock", () => {
    const r02 = eventsAt(full, events, 12)["r02"];
    expect(r02.map((e) => e.t)).toEqual([1.47, 5.74, 7.92, 11.89]);
  });
});

describe("replayBar", () => {
  const html = replayBar({ t: 63.4, duration: D, playing: true, speed: 4 });

  it("has the controls", () => {
    expect(html).toContain('data-act="replay-toggle"');
    expect(html).toContain('aria-label="Pause replay"');
    expect(html).toContain('data-act="replay-restart"');
    expect(html).toContain('data-act="replay-end"');
    expect(html).toMatch(/<input[^>]*type="range"[^>]*data-replay-seek[^>]*min="0"[^>]*step="0.1"[^>]*value="63.4"/);
    expect(html).toContain(`max="${(Math.ceil(D * 10) / 10).toFixed(1)}"`);
    expect(html).toContain("1m 03s");
    expect(html).toContain("Replay");
  });

  it("marks the active speed", () => {
    expect(html).toContain('data-arg="4" aria-pressed="true"');
    expect(html).toContain('data-arg="1" aria-pressed="false"');
    expect(html).toContain('data-arg="16" aria-pressed="false"');
  });

  it("offers play when paused and disables skip at the end", () => {
    const end = replayBar({ t: D, duration: D, playing: false, speed: 1 });
    expect(end).toContain('aria-label="Play replay"');
    expect(end).toMatch(/data-act="replay-end"[^>]*disabled/);
    expect(end).not.toMatch(/[\u2014\u2013]/);
  });
});
