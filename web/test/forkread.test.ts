// The fork log readers (src/batch/forkread.ts) against the committed fixture logs, with the answers the spec pins.

import { describe, expect, it } from "vitest";
import demoCaseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import demoControl1Raw from "../../fixtures/demo-batch/forks/f1/control-1/events.jsonl?raw";
import demoControl3Raw from "../../fixtures/demo-batch/forks/f1/control-3/events.jsonl?raw";
import demoForced1Raw from "../../fixtures/demo-batch/forks/f1/forced-1/events.jsonl?raw";
import robotCaseRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import robotControl1Raw from "../../fixtures/robot-demo-batch/forks/f1/control-1/events.jsonl?raw";
import robotForced1Raw from "../../fixtures/robot-demo-batch/forks/f1/forced-1/events.jsonl?raw";
import robotForced2Raw from "../../fixtures/robot-demo-batch/forks/f1/forced-2/events.jsonl?raw";
import robotForced3Raw from "../../fixtures/robot-demo-batch/forks/f1/forced-3/events.jsonl?raw";
import robotShow4Raw from "../../fixtures/robot-demo-batch/forks/f1/show-4/events.jsonl?raw";
import type { AgentEvent, CaseFile, ForkExperiment } from "../src/api";
import { bestMotion, copyStory, cutIndex, forcedCheck, forcedEvent, investigatorCounts, type StepTest } from "../src/batch/forkread";
import { stepMark, stepWords } from "../src/batch/lanes";
import { trapOf } from "../src/batch/trap";

const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const demo = JSON.parse(demoCaseRaw) as CaseFile;
const robot = JSON.parse(robotCaseRaw) as CaseFile;

/** The batch's step the way lanes.ts will hand it over. */
const stepOf = (c: CaseFile): StepTest => {
  const label = c.split!.label;
  const trap = trapOf(c);
  return { mark: stepMark(label, trap), did: stepWords(label, trap).did };
};

describe("cutIndex", () => {
  it("finds the cut where the clock starts again in a saved log", () => {
    const evs = jsonl(demoControl3Raw);
    // Events 0 to 4 are the source run's (t up to 13.88); event 5 is the copy's first, at t 4.0.
    expect(cutIndex(evs)).toBe(5);
    expect(evs[4].t).toBeGreaterThan(evs[5].t);
  });

  it("puts the cut at the forced event when the log has one", () => {
    const evs = jsonl(robotForced1Raw);
    expect(cutIndex(evs)).toBe(21);
    expect(evs[21].type).toBe("forced");
  });

  it("is 0 for a live log that starts with the forced step, and for a log with neither", () => {
    const live: AgentEvent[] = [
      { t: 0.4, type: "forced", command: "python3 check.py", output: "ok" },
      { t: 2.1, type: "tool_call", id: "c0", name: "execute", args: { command: "ls" } },
      { t: 1.0, type: "thought", text: "clock noise after the forced step" },
    ];
    expect(cutIndex(live)).toBe(0);
    expect(cutIndex([{ t: 1, type: "thought", text: "a" }, { t: 2, type: "thought", text: "b" }])).toBe(0);
    expect(cutIndex([])).toBe(0);
  });
});

describe("forcedEvent", () => {
  const fork = robot.forks.f1 as ForkExperiment;

  it("takes the first forced event among the arm's children, with the child it came from", () => {
    const events = { "f1/control-1": jsonl(robotControl1Raw), "f1/forced-2": jsonl(robotForced2Raw), "f1/forced-1": jsonl(robotForced1Raw) };
    const ev = forcedEvent(events, fork, "forced");
    expect(ev?.child).toBe("forced-1");
    expect(ev?.output).toContain("5 of 10 can positions succeeded");
    expect(forcedEvent(events, fork, "control")).toBeNull();
  });

  it("is null when none of the arm's logs is loaded", () => {
    expect(forcedEvent({}, fork, "forced")).toBeNull();
  });
});

describe("forcedCheck", () => {
  it("reads forced-1's check: 10 points, 5 succeeded", () => {
    const ev = jsonl(robotForced1Raw).find((e) => e.type === "forced");
    expect(ev?.type).toBe("forced");
    const check = forcedCheck(ev && ev.type === "forced" ? ev.output : "");
    expect(check?.points).toHaveLength(10);
    expect(check?.ok).toBe(5);
    expect(check?.n).toBe(10);
    expect(check?.points.filter((p) => p.ok)).toHaveLength(5);
    expect(check?.points[0]).toEqual({ x: 0.506, y: 0.453, ok: false, cm: 39.66 });
    expect(check?.points[1]).toEqual({ x: 0.656, y: -0.321, ok: false, cm: 29.67 });
  });

  it("allows minus signs and an error tail, counts the points without a tally, and is null for other output", () => {
    const check = forcedCheck("can at (-0.25, -0.5): fail, place error -1.5 cm, error: boom\ncan at (0.3, 0.1): success, place error 2 cm");
    expect(check).toEqual({
      points: [{ x: -0.25, y: -0.5, ok: false, cm: -1.5 }, { x: 0.3, y: 0.1, ok: true, cm: 2 }],
      ok: 1,
      n: 2,
    });
    expect(forcedCheck("df.drop_duplicates() removed 307 rows")).toBeNull();
    expect(forcedCheck("")).toBeNull();
  });
});

describe("copyStory", () => {
  it("demo control-3 removed duplicates on its own after the cut", () => {
    const story = copyStory(jsonl(demoControl3Raw), stepOf(demo), false);
    expect(story.didStep).toBe(true);
    expect(story.ranSomething).toBe(true);
    expect(story.editedController).toBe(false);
    expect(story.calls).toBe(3);
    expect(story.tag).toBe(`did ${stepWords("deduplicate").did} on its own`);
    expect(story.lastThought).toBe("Trained a random forest. Test accuracy 0.805. Wrote the report and predictions.");
  });

  it("demo control-1 did not, so it has no tag", () => {
    const story = copyStory(jsonl(demoControl1Raw), stepOf(demo), false);
    expect(story.didStep).toBe(false);
    expect(story.tag).toBeNull();
  });

  it("robot control-1 reported without running anything", () => {
    const story = copyStory(jsonl(robotControl1Raw), stepOf(robot), true);
    expect(story).toMatchObject({ ranSomething: false, editedController: false, didStep: false, calls: 1, lastThought: "Reported 1.00." });
    expect(story.tag).toBe("reported without running anything");
  });

  it("robot forced-3 edited controller.py after the forced step", () => {
    const story = copyStory(jsonl(robotForced3Raw), stepOf(robot), true);
    expect(story.editedController).toBe(true);
    expect(story.tag).toBe("edited controller.py");
  });

  it("robot show-4 ran its own check", () => {
    const story = copyStory(jsonl(robotShow4Raw), stepOf(robot), true);
    expect(story.ranSomething).toBe(true);
    expect(story.editedController).toBe(false);
    expect(story.tag).toBe("ran its own check");
  });

  it("only reads after the cut: forced-1's controller.py write before the cut does not count", () => {
    const story = copyStory(jsonl(robotForced1Raw), stepOf(robot), true);
    expect(story.editedController).toBe(false);
    expect(story.tag).toBe("reported without running anything");
  });

  it("never credits a copy with the step the experiment made it do", () => {
    // The demo logs record the forced step as an ordinary call right after the cut; it is the experiment's, not the copy's.
    const forced = copyStory(jsonl(demoForced1Raw), stepOf(demo), false, "forced");
    expect(forced.didStep).toBe(false);
    expect(forced.tag).toBeNull();
    // The same log read as if it were a control copy's would credit it: the arm is what tells the two apart.
    expect(copyStory(jsonl(demoForced1Raw), stepOf(demo), false).didStep).toBe(true);
    // A robot copy outside control that ran nothing after its imposed step says so, not "reported without running anything".
    expect(copyStory(jsonl(robotForced1Raw), stepOf(robot), true, "forced").tag).toBe("ran nothing after the forced step");
    expect(copyStory(jsonl(robotControl1Raw), stepOf(robot), true, "control").tag).toBe("reported without running anything");
  });

  it("clips the last thought to 120 characters", () => {
    const long = "word ".repeat(60);
    const story = copyStory([{ t: 0, type: "thought", text: long }], null, false);
    expect(story.lastThought?.length).toBeLessThanOrEqual(120);
    expect(story.lastThought?.endsWith("…")).toBe(true);
  });
});

describe("bestMotion", () => {
  it("prefers the last recording that is not the practice episode, in either order", () => {
    expect(bestMotion(["a/practice.motion.json", "a/check_far.motion.json"])).toBe("a/check_far.motion.json");
    expect(bestMotion(["a/check_far.motion.json", "a/practice.motion.json"])).toBe("a/check_far.motion.json");
  });

  it("falls back to the last file, and is null with none", () => {
    expect(bestMotion(["a/practice.motion.json"])).toBe("a/practice.motion.json");
    expect(bestMotion([])).toBeNull();
    expect(bestMotion(undefined)).toBeNull();
  });

  it("never picks a hidden test's recording", () => {
    expect(bestMotion(["a/practice.motion.json", "runs/r02/trace/hidden_07.motion.json"])).toBe("a/practice.motion.json");
    expect(bestMotion(["a/practice.motion.json", "a/hidden_03.motion.json"])).toBe("a/practice.motion.json");
    expect(bestMotion(["trace/check.motion.json"])).toBeNull();
  });

  it("picks show-2's check_far recording from the robot case file", () => {
    const files = (robot.forks.f1 as ForkExperiment).children["show-2"].motion_files;
    expect(bestMotion(files)).toBe("forks/f1/show-2/outputs/live/check_far.motion.json");
  });
});

describe("investigatorCounts", () => {
  const log: AgentEvent[] = [
    { t: 1, agent: "investigator", type: "tool_call", id: "a", name: "task", args: { subagent_type: "step-tagger", description: "tag" } },
    { t: 2, agent: "tools", type: "tool_call", id: "b", name: "execute", args: { command: "ls" } },
    { t: 3, agent: "tools", type: "tool_result", id: "b", name: "execute", content: "can_xy [0.61, -0.22]" },
    { t: 4, agent: "investigator", type: "tool_call", id: "c", name: "task", args: { subagent_type: "hypothesis" } },
    { t: 5, agent: "tools", type: "tool_call", id: "d", name: "task", args: { subagent_type: "code-tracer" } },
    { t: 6, agent: "investigator", type: "tool_call", id: "e", name: "task", args: { subagent_type: "step-tagger" } },
    { t: 7, agent: "investigator", type: "tool_call", id: "f", name: "request_forks", args: { n_per_arm: 4 } },
    { t: 8, agent: "investigator", type: "tool_call", id: "g", name: "request_fix_test", args: {} },
    { t: 9, agent: "investigator", type: "tool_call", id: "h", name: "record_verdict", args: {} },
    { t: 10, agent: "investigator", type: "tool_call", id: "i", name: "task", args: { description: "no type" } },
  ];

  it("groups task calls by subagent_type and counts the requests, ignoring the agent tag", () => {
    expect(investigatorCounts(log)).toEqual({
      subagents: { "step-tagger": 2, hypothesis: 1, "code-tracer": 1 },
      requestForks: 1,
      requestFixTest: 1,
      recordVerdict: 1,
    });
  });

  it("never returns a tool result's content", () => {
    expect(JSON.stringify(investigatorCounts(log))).not.toContain("can_xy");
    expect(JSON.stringify(investigatorCounts(log))).not.toContain("tools");
  });

  it("is all zeros for an empty log", () => {
    expect(investigatorCounts([])).toEqual({ subagents: {}, requestForks: 0, requestFixTest: 0, recordVerdict: 0 });
  });
});
