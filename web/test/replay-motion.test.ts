// A robot run's motion files in a replay: each appears at its `motion` event (the server logs one when it pulls the
// file from the VM mid-run), newest last. Batches saved before those events (the committed robot fixture) fall back to
// showing them when the run ends.

import { afterEach, describe, expect, it, vi } from "vitest";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import r01Raw from "../../fixtures/robot-demo-batch/runs/r01/events.jsonl?raw";
import show2Raw from "../../fixtures/robot-demo-batch/forks/f1/show-2/events.jsonl?raw";
import type { AgentEvent, CaseFile, ForkExperiment } from "../src/api";
import { childKey, type BatchVm, type EventKey } from "../src/batch/model";
import { caseAt, motionAt, replayDuration, replaySchedule } from "../src/batch/replay";
import { wallView } from "../src/batch/wall";
import { fetchMotion, motionChanged } from "../src/robot/data";

const robot = JSON.parse(robotRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const r01 = jsonl(r01Raw);
const show2 = jsonl(show2Raw);
const [practice, farLeft, farLeftTuned] = robot.runs.r01.motion_files!;
const SHOW2 = childKey("f1", "show-2");
const [childPractice, childFar] = (robot.forks.f1 as ForkExperiment).children["show-2"].motion_files!;

/** `evs` with motion events added at times `at` (seconds on the log's clock), kept in time order. */
function withMotion(evs: AgentEvent[], at: [number, string][]): AgentEvent[] {
  const out = [...evs, ...at.map(([t, path]): AgentEvent => ({ t, type: "motion", path }))];
  return out.sort((a, b) => a.t - b.t);
}

const child = (c: CaseFile, cid: string) => (c.forks.f1 as ForkExperiment | undefined)?.children[cid];

describe("motion files in a replay", () => {
  it("still holds them back until the run ends for a batch saved without motion events", () => {
    const events: Record<EventKey, AgentEvent[]> = { r01, [SHOW2]: show2 };
    const s = replaySchedule(robot, events);
    expect(r01.some((e) => e.type === "motion")).toBe(false);
    expect(caseAt(robot, events, 5).runs.r01.motion_files).toBeUndefined();
    expect(caseAt(robot, events, s.runs.r01.end - 1).runs.r01.motion_files).toBeUndefined();
    expect(caseAt(robot, events, s.runs.r01.end).runs.r01.motion_files).toEqual(robot.runs.r01.motion_files);

    const slot = s.forks[0].children["show-2"];
    const mid = caseAt(robot, events, (slot.start + slot.end) / 2);
    expect(child(mid, "show-2")?.status).toBe("running");
    expect(child(mid, "show-2")?.motion_files).toBeUndefined();
    expect(child(caseAt(robot, events, slot.end), "show-2")?.motion_files).toEqual([childPractice, childFar]);
  });

  it("shows each file from its event on, newest last, while the run is going", () => {
    const evs = withMotion(r01, [[40, practice], [80.5, farLeft], [120, farLeftTuned]]);
    const events = { r01: evs };
    const end = replaySchedule(robot, events).runs.r01.end;
    expect(end).toBeGreaterThan(120);
    const at = (t: number) => caseAt(robot, events, t).runs.r01;
    expect(at(39).motion_files).toBeUndefined();
    expect(at(39).status).toBe("running");
    expect(at(40).motion_files).toEqual([practice]);
    expect(at(80).motion_files).toEqual([practice]);
    expect(at(81).motion_files).toEqual([practice, farLeft]);
    expect(at(121).motion_files).toEqual([practice, farLeft, farLeftTuned]);
    expect(at(121)).not.toHaveProperty("true_accuracy"); // still running: no score yet
    expect(at(end).motion_files).toEqual(robot.runs.r01.motion_files);
    expect(replayDuration(robot, events)).toBe(replayDuration(robot, { r01 }));
  });

  it("moves a file saved again to the end, and ignores a path the final record does not list", () => {
    const evs = withMotion(r01, [[40, practice], [60, farLeft], [70, practice], [75, "runs/r01/outputs/live/gone.motion.json"]]);
    expect(motionAt(robot.runs.r01.motion_files, evs, evs.map((e) => e.t), 65)).toEqual([practice, farLeft]);
    expect(motionAt(robot.runs.r01.motion_files, evs, evs.map((e) => e.t), 80)).toEqual([farLeft, practice]);
    expect(motionAt(undefined, evs, evs.map((e) => e.t), 80)).toBeNull();
    expect(motionAt(robot.runs.r01.motion_files, r01, r01.map((e) => e.t), 1e9)).toBeNull();
  });

  it("does the same for a fork child, on the child's own clock", () => {
    const evs = withMotion(show2, [[10, childPractice], [30, childFar]]);
    const events: Record<EventKey, AgentEvent[]> = { r01, [SHOW2]: evs };
    const slot = replaySchedule(robot, events).forks[0].children["show-2"];
    const at = (t: number) => child(caseAt(robot, events, slot.start + t), "show-2");
    expect(at(9)?.motion_files).toBeUndefined();
    expect(at(11)?.motion_files).toEqual([childPractice]);
    expect(at(31)?.motion_files).toEqual([childPractice, childFar]);
    expect(at(31)?.status).toBe("running");
  });

  it("puts the newest episode on the run's tile as it arrives", () => {
    const events = { r01: withMotion(r01, [[40, practice], [80.5, farLeft]]) };
    const tile = (t: number): string | undefined => {
      const vm: BatchVm = { id: "robot-demo-batch", live: false, case: caseAt(robot, events, t), events: {}, replay: null, busy: null, error: null, now: 0 };
      const html = wallView(vm);
      const m = /data-robot-thumb data-batch="robot-demo-batch" data-file="(runs\/r01\/[^"]+)"/.exec(html);
      return m?.[1];
    };
    expect(tile(30)).toBeUndefined();
    expect(tile(50)).toBe(practice);
    expect(tile(90)).toBe(farLeft);
  });
});

describe("a motion file saved again on a live run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is fetched again, past any cache", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ n: urls.length }) };
    });
    expect(motionChanged("b", "runs/r01/outputs/live/new.motion.json")).toBe(false); // never fetched: nothing to redo
    await fetchMotion("b", practice);
    await fetchMotion("b", practice);
    expect(urls).toHaveLength(1);
    expect(motionChanged("b", practice)).toBe(true);
    const again = await fetchMotion("b", practice);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("&rev=1");
    expect(again).toEqual({ n: 2 });
  });
});
