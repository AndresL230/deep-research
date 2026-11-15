// The replay bar's timeline is for demo batches and committed recordings only: a batch run live on the platform is
// never played back, running or finished.

import { describe, expect, it } from "vitest";
import liveRecordingRaw from "../../fixtures/robot-live-investigation/case/case.json?raw";
import demoRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { CaseFile } from "../src/api";
import { replayable } from "../src/batch/replay";

const liveRecording = JSON.parse(liveRecordingRaw) as CaseFile;
const demo = JSON.parse(demoRaw) as CaseFile;

describe("which batches play on a timeline", () => {
  it("plays a demo batch", () => {
    expect(demo.config.mode).toBe("replay");
    expect(replayable(demo)).toBe(true);
  });

  it("plays a committed recording of a live batch", () => {
    expect(liveRecording.config.mode).toBe("live");
    expect(replayable(liveRecording)).toBe(true);
  });

  it("never plays a batch run live on the platform", () => {
    const { recording: _, ...config } = liveRecording.config;
    expect(replayable({ config: { ...config, mode: "live" } as CaseFile["config"] })).toBe(false);
    expect(replayable({ config: { ...config, mode: "live", recording: null } as CaseFile["config"] })).toBe(false);
  });
});
