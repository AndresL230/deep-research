// The fork page's three charts (src/batch/trial-charts.ts): what each one draws and what it tells a screen reader.

import { describe, expect, it } from "vitest";
import { type CheckPoint, scoreStep, sourceStrip, tableMap } from "../src/batch/trial-charts";

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const label = (html: string): string => /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";

// The robot fixture's forced check in forced-1: 10 positions, 5 placed.
const POINTS: CheckPoint[] = [
  { x: 0.3, y: -0.15, ok: true, cm: 0.48 }, { x: 0.35, y: 0, ok: true, cm: 0.49 }, { x: 0.3, y: 0.1, ok: true, cm: 0.58 },
  { x: 0.35, y: -0.25, ok: true, cm: 0.47 }, { x: 0.4, y: 0.15, ok: true, cm: 0.54 }, { x: 0.282, y: 0.42, ok: false, cm: 108.07 },
  { x: 0.7, y: -0.4, ok: false, cm: 39.66 }, { x: 0.75, y: 0.3, ok: false, cm: 41.2 }, { x: 0.65, y: 0.45, ok: false, cm: 37.1 },
  { x: 0.6, y: -0.45, ok: false, cm: 33.02 },
];

describe("scoreStep", () => {
  const html = scoreStep([1.9, 3.61, 6.859, 13.0321], [true, true, true, true]);

  it("says the last score in its label", () => {
    expect(html).toContain('role="img"');
    expect(label(html)).toContain("13.03");
    expect(label(html)).toContain("of the 20 needed");
  });

  it("draws the rule at 20, the dashed rule at 1 and a line that draws in", () => {
    expect(html).toContain("ln-evc-rule--hi");
    // The axis words are HTML over the drawing, so they stay 11px at any width.
    expect(html).toContain(">20</span>");
    expect(html).toContain(">supported</span>");
    expect(html).not.toContain(">100<");
    expect(html).toContain("ln-evc-rule--one");
    expect(html).toMatch(/<path class="ln-evc-line ds-draw" pathLength="1" d="M[^"]+"/);
    expect(html).toContain('width="100%"');
  });

  it("colours each pair's dot by whether it agreed, and keys each step by its pair and value", () => {
    const mixed = scoreStep([1.9, 3.61, 6.859, 0.6859], [true, true, true, false], { id: "f1" });
    expect(count(mixed, "ln-evc-dot--ok")).toBe(3);
    expect(count(mixed, "ln-evc-dot--bad")).toBe(1);
    // The chart is keyed to its experiment, so a new pair adds a step instead of redrawing the chart.
    expect(mixed).toContain('data-morph-key="ev-chart:f1:4"');
    expect(mixed).toContain('data-morph-key="pair:4:0.6859:0"');
    expect(mixed).not.toBe(html);
  });

  it("runs the x axis over every pair the experiment has room for, so the steps drawn stay where they are", () => {
    const two = scoreStep([1.9, 3.61], [true, true], { total: 4, id: "f1" });
    const three = scoreStep([1.9, 3.61, 6.859], [true, true, true], { total: 4, id: "f1" });
    const firstStep = (html: string): string => /<path [^>]*d="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(firstStep(two)).toBe(firstStep(three));
    expect(count(two, "ln-evc-ax--todo")).toBe(2);
  });

  it("keeps scores under the floor readable and draws nothing with no pair", () => {
    expect(label(scoreStep([0.1, 0.01, 0.001, 0.0001], [false, false, false, false]))).toContain("0.0001");
    expect(scoreStep([], [])).toBe("");
  });
});

describe("sourceStrip", () => {
  const ticks = ["load_data", "inspect", "", "score"];

  it("marks the fork point and fades what came after it", () => {
    const html = sourceStrip(ticks, 3, { src: "r02" });
    expect(html).toContain('class="ln-src-mark ln-src-mark--end" style="left:75.00%"');
    expect(count(html, '<g class="ln-src-tick">')).toBe(3);
    expect(count(html, "ln-src-tick--next")).toBe(1);
    expect(html).toContain("inherited by every copy");
    expect(html).toContain("what r02 did next");
    expect(html).toContain("<title>action 3: no label</title>");
    expect(label(html)).toContain("forked after action 3, before score");
  });

  it("ends at the marker when the fork comes after everything, and beams while replaying", () => {
    const html = sourceStrip(ticks, 4, { rebuilding: true });
    expect(html).toContain("forked after everything the run did");
    expect(html).not.toContain("ln-src-tick--next");
    expect(html).toContain("ds-beam");
  });
});

describe("tableMap", () => {
  const html = tableMap(POINTS);

  it("draws exactly the points it is given and spells out the count", () => {
    expect(count(html, 'class="ln-map-pt ')).toBe(10);
    expect(count(html, "ln-map-pt--ok")).toBe(5);
    expect(count(html, "ln-map-pt--fail")).toBe(5);
    expect(label(html)).toContain("5 of 10 succeeded");
    expect(html).toContain("<title>can at (0.282, 0.42): fail, 108.07 cm off</title>");
    expect(html).toContain("practice spot");
  });

  it("has nothing named hidden in it", () => {
    expect(html.toLowerCase()).not.toContain("hidden");
    expect(count(tableMap([]), 'class="ln-map-pt ')).toBe(0);
  });
});
