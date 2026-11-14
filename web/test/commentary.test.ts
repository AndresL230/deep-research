// The live commentary on screen (src/batch/commentary.ts): a tile's caption, the feed, the notebook's captions, and
// how a replay times them. Built on the committed robot fixture with captions and feed items added.

import { describe, expect, it } from "vitest";
import robotRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import r01Raw from "../../fixtures/robot-demo-batch/runs/r01/events.jsonl?raw";
import type { AgentEvent, CaseFile, FeedItem } from "../src/api";
import type { BatchVm, LogView } from "../src/batch/model";
import {
  captionPlacement, captionsOf, feedItems, feedLine, feedView, latestCaption, notebookWithCaptions, tileCaption, wallWithFeed,
} from "../src/batch/commentary";
import { caseAt, eventsAt } from "../src/batch/replay";
import { notebookCells } from "../src/batch/notebook";
import { eventLine } from "../src/batch/lanes";
import { wallView } from "../src/batch/wall";

const robot = JSON.parse(robotRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
const r01 = jsonl(r01Raw);
const end = r01[r01.length - 1].t;

/** r01's log with captions at 10 s, 40 s and a final one at its end, in time order. */
const captions: AgentEvent[] = [
  { t: 10, type: "caption", text: "Reading the template controller" },
  { t: 40, type: "caption", text: "Running the first practice episode" },
  { t: end, type: "caption", text: "Done: reports 100% success, reaches 35% on new can spots", final: true },
];
const r01Captioned: AgentEvent[] = [...r01, ...captions].sort((a, b) => a.t - b.t);

const FEED: FeedItem[] = [
  { t: 12, run: "r02", model: "Haiku", kind: "label", text: "started testing the can at new spots" },
  { t: 45, run: "r01", model: "Sonnet", kind: "first_success", text: "made the first clean pick and place of the batch" },
  { t: end, run: "r01", model: "Sonnet", kind: "finish", text: "finished: reports 100%, reaches 35% on new spots" },
];
const full: CaseFile = { ...robot, config: { ...robot.config, commentary: true } as CaseFile["config"], feed: FEED };

const vmOf = (c: CaseFile, over: Partial<BatchVm> = {}): BatchVm => ({
  id: "robot-demo-batch", live: true, case: c, events: {}, replay: null, busy: null, error: null, now: 0, ...over,
});

const tileOf = (html: string, id: string): string => {
  const key = html.indexOf(`data-morph-key="tile:${id}"`);
  const start = html.lastIndexOf(`<div class="bw-tile`, key);
  const next = html.indexOf(`<div class="bw-tile`, key);
  return html.slice(start, next < 0 ? undefined : next);
};

describe("captions", () => {
  it("reads a log's captions and its latest one", () => {
    expect(captionsOf(r01Captioned).map((c) => c.text)).toHaveLength(3);
    expect(latestCaption(r01Captioned)?.final).toBe(true);
    expect(latestCaption(r01)).toBeNull();
  });

  it("puts the latest caption under a tile's 3D picture, as one line that fades in when it changes", () => {
    const vm = vmOf(full, { events: { r01: r01Captioned } });
    const tile = tileOf(wallView(vm), "r01");
    const pic = tile.indexOf("bw-pic--robot");
    const cap = tile.indexOf(`class="cm-cap is-final"`);
    expect(pic).toBeGreaterThan(0);
    expect(cap).toBeGreaterThan(pic);
    expect(tile).toContain("Done: reports 100% success, reaches 35% on new can spots");
    // Keyed by the caption: a new caption is a new element, so its fade-in plays once.
    const i = r01Captioned.findIndex((e) => e.type === "caption" && e.final);
    expect(tileCaption(vm, vm.case.runs.r01)).toContain(`data-morph-key="cap:${i}"`);
  });

  it("keeps an empty line for a commentated run with no caption yet, and none in a batch without commentary", () => {
    expect(tileCaption(vmOf(full), full.runs.r02)).toContain("cm-cap is-empty");
    const off: CaseFile = { ...robot, feed: [] };
    expect(tileCaption(vmOf(off), off.runs.r02)).toBe("");
    expect(tileOf(wallView(vmOf(off)), "r02")).not.toContain("cm-cap");
  });

  it("shows only the captions a replay has reached", () => {
    const events = { r01: r01Captioned };
    const at = (t: number) => latestCaption(eventsAt(full, events, t).r01)?.text ?? null;
    expect(at(5)).toBeNull();
    expect(at(20)).toBe("Reading the template controller");
    expect(at(41)).toBe("Running the first practice episode");
  });

  it("is one line in the event list", () => {
    expect(eventLine({ t: 1, type: "caption", text: "Slowing the carry" })).toEqual({ kind: "caption", text: "Slowing the carry" });
  });
});

describe("the notebook", () => {
  const log = (clock: number): LogView => ({ events: r01Captioned, times: r01Captioned.map((e) => e.t), clock, lookahead: false });

  it("puts each caption after the cell of the step before it", () => {
    const { top, after } = captionPlacement(log(Infinity));
    const placed = [...top, ...[...after.values()].flat()].map((c) => c.text);
    expect(placed).toHaveLength(3);
    const html = notebookWithCaptions(notebookCells(log(Infinity)), log(Infinity));
    const a = html.indexOf("Reading the template controller");
    const b = html.indexOf("Running the first practice episode");
    const c = html.indexOf("Done: reports 100%");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(html).toContain("nb-cell"); // the cells are still there
  });

  it("leaves out captions after the clock", () => {
    const html = notebookWithCaptions(notebookCells(log(20)), log(20));
    expect(html).toContain("Reading the template controller");
    expect(html).not.toContain("Running the first practice episode");
  });
});

describe("the feed", () => {
  it("lists live items newest first, as run · model · text", () => {
    const vm = vmOf(full);
    expect(feedItems(vm).map((f) => f.kind)).toEqual(["finish", "first_success", "label"]);
    expect(feedLine(FEED[1])).toBe("r01 · Sonnet · made the first clean pick and place of the batch");
    const html = feedView(vm, false);
    expect(html).toContain(`aria-label="Live feed"`);
    expect(html).toContain(`data-open="false"`);
    expect(html.indexOf("finished: reports 100%")).toBeLessThan(html.indexOf("started testing the can"));
    // A finish takes its run's status for its dot; the run id opens the run.
    expect(html).toContain(`data-tone="${full.runs.r01.status}"`);
    expect(html).toContain(`data-act="open-run" data-arg="r02"`);
  });

  it("shows only what a replay has reached", () => {
    const events = { r01: r01Captioned };
    const vmAt = (t: number) => vmOf(caseAt(full, events, t), { events, live: false, replay: { t, duration: 999, playing: true, speed: 4 } });
    expect(feedItems(vmAt(5))).toEqual([]);
    expect(feedItems(vmAt(20)).map((f) => f.kind)).toEqual(["label"]);
    expect(feedItems(vmAt(50)).map((f) => f.kind)).toEqual(["first_success", "label"]);
    expect(feedView(vmAt(5), true)).toContain("cm-feed-empty");
  });

  it("is absent from a batch without commentary, and sits beside the wall with it", () => {
    const off: CaseFile = { ...robot, feed: [] };
    expect(feedView(vmOf(off), false)).toBe("");
    expect(wallWithFeed("<wall>", "")).toBe("<wall>");
    expect(wallWithFeed("<wall>", "<feed>")).toBe(`<div class="cm-wrap"><wall><feed></div>`);
  });
});
