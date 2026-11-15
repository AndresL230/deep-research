// How it works (src/batch/how.ts, how-diagrams.ts): its route and nav link, the once-only first-visit redirect, and the
// page with a hand-made case, with the recorded robot run it links to (HOW_BATCH), and with no case at all.

import { describe, expect, it } from "vitest";
import demoRaw from "../../fixtures/robot-demo-batch/case/case.json?raw";
import liveRaw from "../../fixtures/robot-live-investigation/case/case.json?raw";
import type { CaseFile } from "../src/api";
import { HOW_BATCH, HOW_SEEN_KEY, HOW_STOPS, firstVisitRedirect, howSeen, howStop, howView, type SeenStorage } from "../src/batch/how";
import { forkDiagram, harnessDiagram, loopDiagram } from "../src/batch/how-diagrams";
import { parseRoute, routeHash, type Route } from "../src/batch/model";
import { navBar, navCurrent, navMenu } from "../src/batch/nav";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const DEMO = JSON.parse(demoRaw) as CaseFile;
/** The recorded robot run the page loads and links to (HOW_BATCH). */
const LIVE = JSON.parse(liveRaw) as CaseFile;

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

/** A small robot batch by hand: three runs, a split, two hypotheses, a fork with control and forced copies, and an
 *  open verdict. */
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
  hypotheses: [
    { id: "h1", kind: "method", step_label: "vary_positions", run_id: null, sentence: "They tested one spot.", status: "inconclusive", tested_by: "f1" },
    { id: "h2", kind: "code", step_label: null, run_id: "r02", sentence: "A bug in the grasp.", status: "untested" },
  ],
  forks: {
    f1: {
      id: "f1", status: "done", source_run: "r02", fork_at: 8, label: "vary_positions", hypothesis_id: "h1", n_per_arm: 2,
      children: {
        "control-1": hit("inflated", 1.0, 0.5, { arm: "control", gap: 0.5 }), "control-2": hit("inflated", 1.0, 0.5, { arm: "control", gap: 0.5 }),
        "forced-1": hit("honest", 0.6, 0.55, { arm: "forced", gap: 0.05 }), "forced-2": hit("honest", 0.6, 0.6, { arm: "forced", gap: 0 }),
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
  /** Every stop of the tour, in order. */
  const tour = (demo: Parameters<typeof howView>[0]): string[] => Array.from({ length: HOW_STOPS }, (_, i) => howView(demo, i));

  it("is a tour of six stops: the five steps, then the way on, one on screen at a time", () => {
    const stops = tour({ state: "ready", value: HAND });
    expect(stops).toHaveLength(6);
    const titles = ["Run", "Measure", "Name the suspects", "Fork to test one", "The verdict follows the score", "Your turn"];
    stops.forEach((html, i) => {
      expect(html.match(/<h2 class="hw-h">/g)).toHaveLength(1);
      expect(html).toContain(`<h2 class="hw-h">${titles[i]}</h2>`);
      expect(text(html)).toContain(`${i + 1} of 6`);
      // The rail names every stop and marks the one on screen.
      expect(html.match(/<button type="button" class="hw-stopb/g)).toHaveLength(6);
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`data-arg="${i}" aria-current="step"`));
    });
    // Next names the stop it goes to; the first stop has no Back and the last no Next.
    expect(stops[0]).toMatch(/data-how-next data-act="how-step" data-arg="1"><span class="hw-next-k">Next<\/span>Measure</);
    expect(stops[0]).not.toContain(">Back<");
    expect(stops[3]).toContain('data-act="how-step" data-arg="2">Back<');
    expect(stops[5]).not.toContain("data-how-next");
    // A stop out of range is the nearest one.
    expect(howView({ state: "ready", value: HAND }, 99)).toBe(stops[5]);
    expect(howView({ state: "ready", value: HAND }, -3)).toBe(stops[0]);
    expect(howStop(Number("x"))).toBe(0);
  });

  it("draws each step's picture from a hand-made case, with one part to point at and one bubble", () => {
    const stops = tour({ state: "ready", value: HAND });
    for (const html of stops) {
      expect(html.match(/class="hw-pic"/g)).toHaveLength(1);
      expect(html.match(/data-how-ring/g)).toHaveLength(1);
      expect(html.match(/data-how-tip/g)).toHaveLength(1);
      expect(html).toMatch(/data-how-stage data-how-target="[^"]+"/);
    }
    const t = stops.map(text);
    // 1 and 2 follow one inflated run: its claim, then its claim against what was measured.
    expect(stops[0]).toMatch(/<li class="hw-agent" data-how-focus><span class="hw-agent-id">r02</);
    expect(t[0]).toContain("r02 claims 100%. Nobody has checked that yet.");
    expect(t[1]).toContain("2 of 3 agents claimed 100%. Measured at 4 positions they never tested: 55%.");
    expect(stops[1]).toContain('data-how-target=".ov-bar[data-morph-key=&quot;bar:r02&quot;]"');
    expect(stops[1]).toContain('data-morph-key="bar:r02"');
    expect(t[1]).toContain("r02 claimed 100%. On 4 cases it never saw, it scored 50%.");
    // 3: the suspects in plain words, the one the fork tested last and pointed at.
    expect(t[2]).toContain("A defect in run r02&#39;s code");
    expect(stops[2]).toMatch(/<li class="hw-su" data-how-focus><span class="hw-su-id">h1<\/span><span class="hw-su-t">Testing other can positions<\/span><span class="hw-tag">Tested next</);
    expect(stops[2].indexOf(">h2<")).toBeLessThan(stops[2].indexOf(">h1<"));
    expect(t[2]).toContain("2 suspects, nothing proven yet. This one gets tested.");
    // 4: the fork as pairs of copies, one left alone and one changed, and whether each went the predicted way.
    expect(t[3]).toContain("The change Testing other can positions");
    expect(t[3]).toContain("Run r02, copied in pairs.");
    expect(stops[3].match(/<li class="hw-pr">/g)).toHaveLength(2);
    expect(stops[3]).toMatch(/<div class="hw-prs" data-how-focus>/);
    expect(t[3]).toContain("1 +50.0 pts +5.0 pts as predicted");
    expect(t[3]).toContain("2 +50.0 pts 0 pts as predicted");
    expect(t[3]).toContain("2 of 2 pairs went the way the investigator predicted.");
    // 5: the verdict, the score written out, and the score against the 20 it needs.
    expect(t[4]).toContain("The fork suggests that not testing other can positions inflates the claim");
    expect(stops[4].match(/<p class="hw-quote">([^<]*)<\/p>/)![1]).not.toMatch(/\bcaused\b/);
    expect(t[4]).toContain("Score: 1 × 1.9 × 1.9 = 3.61");
    expect(t[4]).toContain("3.61 of 20");
    expect(t[4]).toContain("Score 3.61. It needs 20, so the verdict stays open.");
    // After the verdict: the lesson, and the fool rate that shows whether it works (#/lessons). Only on that stop.
    expect(t[4]).toContain("Then Orro writes a lesson; the fool rate shows whether it works.");
    expect(stops[4]).toContain('<a class="hw-then-a" href="#/lessons">');
    expect(stops.filter((h) => h.includes("hw-then"))).toHaveLength(1);
    expect(t[4]).toContain("multiplies a score by 1.9");
  });

  it("falls back to the fork's own diagram when no pair of copies is scored, and to the split when no suspect is named", () => {
    const bare = { ...HAND, hypotheses: [], forks: { f1: { ...(HAND.forks as Record<string, object>).f1, n_per_arm: 0 } } } as unknown as CaseFile;
    const stops = tour({ state: "ready", value: bare });
    expect(text(stops[2])).toContain("Testing other can positions");
    expect(text(stops[2])).toContain("1 suspect, nothing proven yet.");
    expect(stops[3]).toContain('data-how-target="[data-how-arm=&quot;forced&quot;]"');
    expect(stops[3]).toContain('<g data-how-arm="forced">');
    expect(text(stops[3])).toContain("The claim moved -40.0 pts, the robot moved +7.5 pts.");
  });

  it("ends with the ways on: a real batch (pointed at), a batch of one's own, and my batches from any stop", () => {
    const last = howView({ state: "error", message: "x" }, HOW_STOPS - 1);
    expect(last).toMatch(new RegExp(`<a [^>]*data-how-focus href="#/b/${HOW_BATCH}"[^>]*>See a real batch</a>`));
    expect(last).toContain('data-act="new-batch">Start my own batch</button>');
    expect(text(last)).toContain("Start here.");
    for (const html of tour({ state: "error", message: "x" })) expect(html).toMatch(/<a [^>]*href="#\/start" data-how-done>Go to my batches<\/a>/);
  });

  it("reads as text alone when the demo cannot load, and while it loads", () => {
    for (const demo of [{ state: "error", message: "404" }, { state: "loading" }] as const) {
      const stops = tour(demo);
      for (const html of stops.slice(0, 5)) {
        expect(html.match(/<h2 class="hw-h">/g)).toHaveLength(1);
        expect(html).not.toContain('class="hw-pic"');
        expect(html).not.toContain("data-how-ring");
        expect(html).toContain('class="hw-stop is-text"');
      }
      // How Orro is built needs no numbers: it stays, folded.
      expect(stops[0]).toMatch(/<details class="hw-hood"[^>]*><summary class="hw-hood-s">How Orro is built<\/summary>/);
      expect(stops[0]).toContain("hw-svg--wide");
    }
    expect(text(howView({ state: "error", message: "404" }))).toContain("could not be loaded");
    expect(text(howView({ state: "loading" }))).toContain("Loading");
  });

  it("shows the real robot demo's numbers", () => {
    expect(HOW_BATCH).toBe("robot-live-investigation");
    const t = tour({ state: "ready", value: LIVE }).map(text);
    expect(t[0]).toContain("r06 claims 100%. Nobody has checked that yet.");
    expect(t[1]).toContain("5 of 12 agents claimed 100%. Measured at positions they never tested: 69%.");
    expect(t[1]).toContain("r06 claimed 100%. On cases it never saw, it scored 65%.");
    for (const name of ["Testing the table edges", "Tuning the controller", "A defect in run r06&#39;s code"]) expect(t[2]).toContain(name);
    expect(t[2]).toContain("3 suspects, nothing proven yet. This one gets tested.");
    expect(t[3]).toContain("Run r06, copied in pairs, with two more groups of copies as checks.");
    expect(t[3]).toContain("3 +35.0 pts +8.5 pts as predicted");
    expect(t[3]).toContain("4 of 4 pairs went the way the investigator predicted.");
    expect(t[4]).toContain("Score: 1 × 1.9 × 1.9 × 1.9 × 1.9 = 13.03");
    expect(t[4]).toContain("Score 13.03. It needs 20, so the verdict stays open.");
  });

  it("says it in plain words: no em dashes, no snake_case", () => {
    for (const demo of [{ state: "ready", value: LIVE }, { state: "ready", value: DEMO }, { state: "ready", value: HAND }, { state: "loading" }] as const) {
      for (const html of tour(demo)) {
        const t = text(html.replace(/<svg[\s\S]*?<\/svg>/g, ""));
        expect(t).not.toContain("—");
        expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      }
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
    for (const w of ["Hidden cases", "Investigator", "step-tagger", "lenses × 3", "skeptic", "each experiment", "You approve", "Verdict", "Placebo", "Forced"]) expect(all).toContain(w);
  });

  it("the fork marks each real copy inflated or honest", () => {
    const f = Object.values(DEMO.forks ?? {})[0] as Parameters<typeof forkDiagram>[2];
    const svg = forkDiagram("testing other can positions", "r02", f);
    expect(svg.match(/hw-d-sq--inflated/g)).toHaveLength(11);
    expect(svg.match(/hw-d-sq--honest/g)).toHaveLength(5);
    expect(svg).toContain("Control: 4 of 4 inflated. Placebo: 4 of 4 inflated. Show: 3 of 4 inflated. Forced: 0 of 4 inflated.");
  });
});
