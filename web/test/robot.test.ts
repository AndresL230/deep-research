// The robot viewer's markup (robot/markup.ts) and where the views put it: a robot batch's tiles and run page show
// the arm moving, a tabular batch's stay as they were.

import { describe, expect, it } from "vitest";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import demoRaw from "../../fixtures/demo-batch/case/case.json?raw";
import r01Raw from "../../fixtures/robot-demo-batch/runs/r01/events.jsonl?raw";
import type { AgentEvent, CaseFile } from "../src/api";
import { caseAt, replayDuration } from "../src/batch/replay";
import type { BatchVm } from "../src/batch/model";
import { wallView } from "../src/batch/wall";
import { runSummaryView } from "../src/batch/run";
import { episodeError, isMotionBatch, motionName, resultFacts, resultText, resultTone, robotThumb, robotView, summaryErrorText, xy } from "../src/robot/markup";
import { ServerError } from "../src/robot/data";

const robot = JSON.parse(robotRaw) as CaseFile;
const demo = JSON.parse(demoRaw) as CaseFile;
const vmOf = (c: CaseFile, id: string): BatchVm => ({ id, live: false, case: c, events: {}, replay: null, busy: null, error: null, now: 0 });

describe("markup helpers", () => {
  it("names a motion file by its file name", () => {
    expect(motionName("runs/r01/outputs/live/far_left_tuned.motion.json")).toBe("far_left_tuned");
    expect(motionName("forks/f1/forced-1/outputs/motion_3.json")).toBe("motion_3");
    // A hidden episode's recording reads as the position it was, like its dot on the map.
    expect(motionName("runs/r02/hidden/00-s0.motion.json")).toBe("Hidden position 1");
    expect(motionName("forks/f1/forced-1/hidden/07-s1.motion.json")).toBe("Hidden position 8, seed 1");
  });

  it("says plainly why an episode cannot be loaded", () => {
    const notOnHub = "This episode's recording isn't on the hub: the batch was run before recordings were shared, or is still uploading";
    expect(episodeError(new ServerError(notOnHub, 404))).toBe(notOnHub);
    // A batch whose page loaded is never "no batch".
    expect(episodeError(new ServerError("no batch 1114-050000-abcd", 404))).not.toMatch(/no batch/);
    expect(episodeError(new ServerError("cannot replay this file: bad frames", 422))).toBe("Couldn't load this episode: cannot replay this file: bad frames");
    expect(episodeError(new TypeError("Failed to fetch"))).toBe("Couldn't load this episode: Failed to fetch");
    expect(summaryErrorText(notOnHub)).toBe("not on the hub yet");
    expect(summaryErrorText("no such motion file")).toBe("can't be read");
  });

  it("says how an episode ended", () => {
    expect(resultText({ success: true, place_error_cm: 0.81 })).toBe("Placed 0.8 cm from center");
    expect(resultText({ success: false, dropped: true, place_error_cm: 20 })).toBe("Dropped the can");
    expect(resultText({ success: false, upright: false })).toBe("Can tipped over");
    expect(resultText({ success: false, upright: true, place_error_cm: 12.3 })).toBe("Missed by 12 cm");
    expect(resultText({ success: false, upright: true, place_error_cm: 1.1, resting: false, released: true, end_reason: "max_time" })).toBe("Ran out of time");
    expect(resultText({ success: false, exception: "ValueError: x" })).toBe("Controller error");
    expect(resultText(null)).toBe("");
    expect(resultTone({ success: true })).toBe("ok");
    expect(resultTone({ success: false })).toBe("bad");
    expect(resultTone({})).toBe("none");
  });

  it("lists the facts, leaving out the usual ending", () => {
    expect(resultFacts({ success: true, place_error_cm: 0.81, upright: true, max_height_cm: 12.88, end_reason: "controller_done" }))
      .toEqual(["0.8 cm from center", "upright", "lifted 13 cm"]);
    expect(resultFacts({ upright: false, tilt_deg: 88.6, dropped: true, end_reason: "max_time" })).toEqual(["dropped", "tipped 89°", "max time"]);
    expect(xy([0.5, -0.1])).toBe("(0.50, -0.10)");
  });

  it("draws placeholders morph.ts leaves alone, keyed by what they show", () => {
    const files = ["runs/r01/outputs/live/a.motion.json", "runs/r01/outputs/live/b.motion.json"];
    const view = robotView("robot-demo-batch", "r01", files);
    expect(view).toContain("data-keep");
    expect(view).toContain("data-robot-view");
    expect(view).toContain(`data-morph-key="rb:r01:2:runs/r01/outputs/live/b.motion.json"`);
    expect(view).toContain("&quot;runs/r01/outputs/live/a.motion.json&quot;");
    expect(robotView("b", "r01", [])).toContain("No motion files");
    const thumb = robotThumb("b", files[1]);
    expect(thumb).toContain("data-robot-thumb");
    expect(thumb).toContain('data-file="runs/r01/outputs/live/b.motion.json"');
  });

  it("tells a robot batch from a tabular one", () => {
    expect(isMotionBatch(robot.config)).toBe(true);
    expect(isMotionBatch(demo.config)).toBe(false);
    expect(isMotionBatch(null)).toBe(false);
  });
});

describe("the views", () => {
  it("shows each robot run's last episode moving on its tile", () => {
    const html = wallView(vmOf(robot, "robot-demo-batch"));
    const thumbs = [...html.matchAll(/data-robot-thumb data-batch="robot-demo-batch" data-file="([^"]+)"/g)].map((m) => m[1]);
    expect(thumbs).toHaveLength(Object.keys(robot.runs).length);
    expect(thumbs[0]).toBe(robot.runs.r01.motion_files!.at(-1));
  });

  it("shows the 3D player on a robot run's page, and on a fork child's", () => {
    const vm = vmOf(robot, "robot-demo-batch");
    expect(runSummaryView(vm, "r01")).toContain("data-robot-view");
    expect(runSummaryView(vm, "f1/show-2")).toContain("forks/f1/show-2/outputs/live/check_far.motion.json");
  });

  it("leaves a tabular batch as it was", () => {
    const vm = vmOf(demo, "demo-batch");
    expect(wallView(vm)).not.toContain("data-robot");
    const run = runSummaryView(vm, "r01");
    expect(run).not.toContain("data-robot");
    expect(run).toContain("rn-charts");
  });

  it("keeps a run's motion files back mid-replay until it has finished", () => {
    const events = { r01: r01Raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent) };
    const end = replayDuration(robot, events);
    expect(caseAt(robot, events, 5).runs.r01.motion_files).toBeUndefined();
    expect(caseAt(robot, events, end).runs.r01.motion_files).toEqual(robot.runs.r01.motion_files);
  });
});
