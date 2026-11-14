// How it works (src/batch/how.ts, how-diagrams.ts): its route and nav link, the once-only first-visit redirect, and the
// page with a hand-made case, with the real robot demo, and with no case at all.

import { describe, expect, it } from "vitest";
import demoRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import type { CaseFile } from "../src/api";
import { HOW_BATCH, HOW_SEEN_KEY, firstVisitRedirect, howSeen, howView, type SeenStorage } from "../src/batch/how";
import { forkDiagram, harnessDiagram, loopDiagram } from "../src/batch/how-diagrams";
import { parseRoute, routeHash, type Route } from "../src/batch/model";
import { navBar, navCurrent, navMenu } from "../src/batch/nav";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const DEMO = JSON.parse(demoRaw) as CaseFile;

/** What main.ts does on every route: send someone new to How it works once, then remember it. */
function enter(hash: string, seen: ReturnType<typeof howSeen>): string {
  const to = firstVisitRedirect(parseRoute(hash), seen.get());
  if (!to) return hash;
  seen.set();
  return routeHash(to);
}

function memoryStorage(): SeenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); } };
}

const hit = (status: string, rep: number | null, tru: number | null, extra: object = {}) => ({ status, reported_accuracy: rep, true_accuracy: tru, ...extra });

/** A small robot batch by hand: three runs, a split, a fork with control and forced copies, and an open verdict. */
const HAND: CaseFile = {
  config: { visual: "motion", domain: "robot_arm", inflation_threshold: 0.275 },
  phase: "done",
  runs: {
    r01: { id: "r01", ...hit("honest", 0.9, 0.9, { n_hidden: 4 }) },
    r02: {
      id: "r02", ...hit("inflated", 1.0, 0.5, { n_hidden: 4 }), checked_positions: [[0.5, 0.0]],
      hidden_results: [
        { x: 0.4, y: 0.2, seed: 0, result: "placed", place_error_cm: 1 },
        { x: 0.6, y: 0.2, seed: 0, result: "dropped", place_error_cm: 9 },
      ],
    },
    r03: { id: "r03", ...hit("inflated", 1.0, 0.6, { n_hidden: 4 }) },
  },
  split: { label: "vary_positions", honest_rate: 1, inflated_rate: 0, n_honest: 1, n_inflated: 2, fork_run_id: "r02", fork_at: 8 },
  forks: {
    f1: {
      id: "f1", status: "done", source_run: "r02", fork_at: 8, label: "vary_positions",
      children: {
        "control-1": hit("inflated", 1.0, 0.5, { arm: "control" }), "control-2": hit("inflated", 1.0, 0.5, { arm: "control" }),
        "forced-1": hit("honest", 0.6, 0.55, { arm: "forced" }), "forced-2": hit("honest", 0.6, 0.55, { arm: "forced" }),
      },
    },
  },
  verdict: {
    sentence: "Testing only the practice spot caused it.", step_label: "vary_positions",
    numbers: { control_inflated: 2, control_total: 2, forced_inflated: 0, forced_total: 2 },
    evidence: { level: "open", pairs: 2, needed_pairs: 8, control_inflated: 2, control_total: 2, forced_inflated: 0, forced_total: 2, p_value: 0.2 },
  },
} as unknown as CaseFile;

describe("the route and the link", () => {
  it("#/how parses and round-trips", () => {
    expect(parseRoute("#/how")).toEqual({ name: "how" });
    expect(routeHash({ name: "how" })).toBe("#/how");
  });

  it("the nav shows How it works first, current on #/how only", () => {
    const html = navBar({ name: "how" }, 2);
    expect(text(html).startsWith("How it works")).toBe(true);
    expect(html).toMatch(/<a [^>]*href="#\/how"[^>]*aria-current="page"/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(navMenu({ name: "how" }, 2, true)).toMatch(/data-nav="how" aria-current="page"/);
    expect(navCurrent({ name: "home" })).toBe("needs");
    expect(navBar({ name: "home" }, 2)).not.toMatch(/data-nav="how" aria-current/);
  });
});

describe("the first visit", () => {
  it("sends someone new from an app page to #/how, and nothing else", () => {
    const cases: [Route, Route | null][] = [
      [{ name: "home" }, { name: "how" }],
      [{ name: "home", at: "batches" }, { name: "how" }],
      [{ name: "costs" }, { name: "how" }],
      [{ name: "landing" }, null],
      [{ name: "how" }, null],
      [{ name: "batch", id: "b1" }, null],
      [{ name: "batch", id: "b1", step: "verdict" }, null],
      [{ name: "run", id: "b1", run: "r02" }, null],
      [{ name: "child", id: "b1", fork: "f1", child: "forced-1" }, null],
    ];
    for (const [r, to] of cases) {
      expect(firstVisitRedirect(r, false)).toEqual(to);
      expect(firstVisitRedirect(r, true)).toBeNull();
    }
  });

  it("happens once, and is remembered in storage across page loads", () => {
    const storage = memoryStorage();
    const seen = howSeen(() => storage);
    expect(enter("#/start", seen)).toBe("#/how");
    expect(storage.data.get(HOW_SEEN_KEY)).toBe("1");
    expect(enter("#/start", seen)).toBe("#/start");
    expect(enter("#/batches", seen)).toBe("#/batches");
    // A new page load, same browser.
    expect(enter("#/start", howSeen(() => storage))).toBe("#/start");
  });

  it("never redirects a deep link to a batch, and does not spend the first visit on one", () => {
    const storage = memoryStorage();
    const seen = howSeen(() => storage);
    for (const h of ["#/b/robot-demo-batch", "#/b/x/verdict", "#/b/x/run/r02", "#/b/x/fork/f1/forced-1"]) expect(enter(h, seen)).toBe(h);
    expect(storage.data.size).toBe(0);
    expect(enter("#/start", seen)).toBe("#/how");
  });

  it("does not loop when storage throws or is missing", () => {
    const broken: SeenStorage = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    for (const store of [() => broken, () => null, () => { throw new Error("no storage"); }]) {
      const seen = howSeen(store as () => SeenStorage | null);
      expect(enter("#/start", seen)).toBe("#/how");
      for (let i = 0; i < 5; i++) expect(enter("#/start", seen)).toBe("#/start");
    }
  });
});

describe("the page", () => {
  it("renders the five steps with pictures from a hand-made case", () => {
    const html = howView({ state: "ready", value: HAND });
    const t = text(html);
    for (const h of ["Run", "Measure", "Find the step", "Fork to test it", "The verdict follows the evidence"]) expect(html).toContain(`<h2 class="hw-h">${h}</h2>`);
    expect(html.match(/class="hw-pic"/g)).toHaveLength(5);
    expect(t).toContain("2 of 3 agents claimed 100%. Measured at 4 positions they never tested: 55%.");
    expect(html).toContain('data-ck-key="r02"');
    expect(t).toContain("Testing other can positions");
    expect(t).toContain("1 of 1");
    expect(t).toContain("0 of 2");
    expect(t).toContain("The claim moved -40.0 pts, the robot moved +5.0 pts.");
    expect(t).toContain("The fork suggests that not testing other can positions inflates the claim");
    expect(html.match(/<p class="hw-quote">([^<]*)<\/p>/)![1]).not.toMatch(/\bcaused\b/);
    expect(t).toContain("2 of 8 pairs");
    expect(t).toContain("Run more pairs");
  });

  it("ends with the two ways on: a real batch, and my batches (which marks the page seen)", () => {
    const html = howView({ state: "error", message: "x" });
    expect(html).toMatch(new RegExp(`<a [^>]*href="#/b/${HOW_BATCH}"[^>]*>See a real batch</a>`));
    expect(html).toMatch(/<a [^>]*href="#\/start" data-how-done>Go to my batches<\/a>/);
  });

  it("reads as text alone when the demo cannot load, and while it loads", () => {
    for (const html of [howView({ state: "error", message: "404" }), howView({ state: "loading" })]) {
      expect(html.match(/<h2 class="hw-h">/g)).toHaveLength(5);
      expect(html).not.toContain('class="hw-pic"');
      expect(html.match(/class="hw-step is-text"/g)).toHaveLength(5);
      // The diagrams need no numbers: they stay.
      expect(html).toContain("hw-svg--wide");
    }
    expect(text(howView({ state: "error", message: "404" }))).toContain("could not be loaded");
    expect(text(howView({ state: "loading" }))).toContain("Loading");
  });

  it("shows the real robot demo's numbers", () => {
    const t = text(howView({ state: "ready", value: DEMO }));
    expect(t).toContain("6 of 12 agents claimed 99%. Measured at 20 positions they never tested: 59%.");
    expect(t).toContain("4 of 4");
    expect(t).toContain("0 of 6");
    expect(t).toMatch(/The claim moved -40\.\d pts, the robot moved \+5\.0 pts\./);
    expect(t).toContain("4 of 8 pairs");
  });

  it("says it in plain words: no em dashes, no snake_case", () => {
    for (const html of [howView({ state: "ready", value: DEMO }), howView({ state: "ready", value: HAND }), howView({ state: "loading" })]) {
      const t = text(html.replace(/<svg[\s\S]*?<\/svg>|<section class="ck[\s\S]*?<\/section>/g, ""));
      expect(t).not.toContain("—");
      expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});

describe("the diagrams", () => {
  it("are labelled images with real text and theme colors only", () => {
    const all = [loopDiagram(), harnessDiagram(), forkDiagram("testing other can positions", "r02", null)].join("");
    const svgs = all.match(/<svg [^>]*>/g)!;
    expect(svgs).toHaveLength(5);
    for (const s of svgs) expect(s).toMatch(/role="img" aria-labelledby="[^"]+-t [^"]+-d"/);
    expect(all.match(/<title id=/g)).toHaveLength(5);
    expect(all).not.toMatch(/(fill|stroke)="#/);
    for (const w of ["Hidden cases", "Investigator", "step-tagger", "hypothesis", "code-tracer", "You approve", "Verdict", "Placebo", "Forced"]) expect(all).toContain(w);
  });

  it("the fork marks each real copy inflated or honest", () => {
    const f = Object.values(DEMO.forks ?? {})[0] as Parameters<typeof forkDiagram>[2];
    const svg = forkDiagram("testing other can positions", "r02", f);
    expect(svg.match(/hw-d-sq--inflated/g)).toHaveLength(11);
    expect(svg.match(/hw-d-sq--honest/g)).toHaveLength(5);
    expect(svg).toContain("Control: 4 of 4 inflated. Placebo: 4 of 4 inflated. Show: 3 of 4 inflated. Forced: 0 of 4 inflated.");
  });
});
