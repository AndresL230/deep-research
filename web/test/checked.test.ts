// "What it checked vs what it is judged on" (src/batch/checked.ts), on hand-built runs: the robot map before and after
// scoring, its legend, the dots as keyboard reachable buttons that replay their own episode, nothing chosen for the
// reader, and the tabular bars with their fallbacks.

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { CaseFile, DomainWords, HiddenResult } from "../src/api";
import {
  ROBOT_WORDS, TABULAR_WORDS, checkedView, countsText, dotLabel, episodeView, hiddenDots, judgedOn, outcomeCounts, pressDot,
  toPercent, wireChecked, wordsOf, type CheckedSubject, type DotEl,
} from "../src/batch/checked";
import { runSummaryView } from "../src/batch/run";
import type { BatchVm } from "../src/batch/model";

const ROBOT_W: DomainWords = {
  ...ROBOT_WORDS,
  steps: { vary_positions: { name: "testing other can positions", did: "ran the can at other positions", missing: "Only the practice spot was run here" } },
};
const robotCfg = { visual: "motion", domain: "robot_arm", domain_info: { name: "robot_arm", title: "Robot", description: "", visual: "motion", output_files: [], output_globs: [], words: ROBOT_W } };
const tabCfg = { domain: "tabular", visual: "charts" };

const hr = (i: number, x: number, y: number, result: HiddenResult["result"], err: number | null, seed = 0): HiddenResult => ({
  x, y, seed, result, place_error_cm: err, motion: `runs/r02/hidden/${String(i).padStart(2, "0")}-s${seed}.motion.json`,
});

const HIDDEN: HiddenResult[] = [
  hr(0, 0.37, 0.2, "placed", 1.2),
  hr(1, 0.39, 0.46, "tipped", 4.1),
  hr(2, 0.71, 0.29, "missed", null),
  hr(3, 0.54, 0.44, "placed", 0.8),
  hr(4, 0.34, -0.41, "dropped", null),
  hr(5, 0.66, 0.19, "tipped", 6.0),
  hr(6, 0.53, 0.2, "placed", 2.0),
];

const scoredRobot: CheckedSubject = {
  status: "inflated", reported_accuracy: 1, true_accuracy: 3 / 7, gap: 1 - 3 / 7, overlap_share: 1,
  n_hidden: 7, checked_positions: [[0.5, 0]], hidden_results: HIDDEN,
};

/** Every `<tag ...>` opening tag in `html` whose attributes contain `needle`. */
const tags = (html: string, tag: string, needle = ""): string[] =>
  (html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? []).filter((t) => t.includes(needle));
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");

describe("words", () => {
  it("come from the domain, with a fallback by kind for older batches", () => {
    expect(wordsOf(robotCfg)).toMatchObject({ ...ROBOT_W, steps: expect.any(Object) });
    expect(wordsOf({ visual: "motion" })).toEqual(ROBOT_WORDS);
    expect(wordsOf({})).toEqual(TABULAR_WORDS);
    expect(wordsOf(null)).toEqual(TABULAR_WORDS);
  });

  it("say one run's 'they' as 'it' and fill the count", () => {
    expect(judgedOn(ROBOT_W, 20)).toBe("at 20 positions it never tested");
    expect(judgedOn(TABULAR_WORDS, 154)).toBe("on 154 rows it never saw");
    expect(judgedOn(ROBOT_W, null)).toBe("at positions it never tested");
  });
});

describe("hidden dots", () => {
  it("number positions in order and label each with its real result", () => {
    const dots = hiddenDots(HIDDEN);
    expect(dots.map((d) => d.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dots[1].label).toBe("Position 2: tipped over, 4.1 cm from center");
    expect(dots[2].label).toBe("Position 3: missed");
    expect(dotLabel(7, null, { result: "tipped", place_error_cm: 4.1 })).toBe("Position 7: tipped over, 4.1 cm from center");
  });

  it("map each dot to its own episode's motion file", () => {
    const dots = hiddenDots(HIDDEN);
    dots.forEach((d, i) => expect(d.motion).toBe(HIDDEN[i].motion));
    expect(dots.map((d) => d.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("name the seed and spread the dots when a position ran more than once", () => {
    const dots = hiddenDots([hr(0, 0.4, 0.1, "placed", 1, 0), hr(0, 0.4, 0.1, "tipped", 5, 1), hr(1, 0.6, 0, "missed", null, 0)]);
    expect(dots.map((d) => d.position)).toEqual([1, 1, 2]);
    expect(dots[0].label).toBe("Position 1, seed 0: placed, 1.0 cm from center");
    expect(dots[1].label).toBe("Position 1, seed 1: tipped over, 5.0 cm from center");
    expect(dots[2].label).toBe("Position 2: missed");
    expect(dots.map((d) => d.offset)).toEqual([-0.5, 0.5, 0]);
  });

  it("skip entries without a position or a known result", () => {
    const bad = [{ ...HIDDEN[0], x: Number.NaN }, { ...HIDDEN[1], result: "exploded" as never }, HIDDEN[2]];
    expect(hiddenDots(bad).map((d) => d.i)).toEqual([2]);
  });

  it("put the robot at the bottom middle and forward up the page", () => {
    const base = toPercent(0, 0);
    expect(base.left).toBeCloseTo(50);
    expect(base.top).toBeGreaterThan(80);
    const ahead = toPercent(0.7, 0);
    expect(ahead.top).toBeLessThan(base.top);
    expect(toPercent(0.5, 0.3).left).toBeLessThan(50); // +y is the robot's left
  });
});

describe("legend counts", () => {
  it("count each result and say them in a fixed order, zeros left out", () => {
    const c = outcomeCounts(HIDDEN);
    expect(c).toEqual({ placed: 3, tipped: 2, missed: 1, dropped: 1 });
    expect(countsText(c)).toBe("3 placed, 2 tipped, 1 missed, 1 dropped");
    expect(countsText({ placed: 14, tipped: 3, missed: 0, dropped: 3 })).toBe("14 placed, 3 tipped, 3 dropped");
  });

  it("show in the scored map's key", () => {
    const html = checkedView("b1", "r02", scoredRobot, robotCfg);
    const t = text(html);
    expect(t).toContain("3 placed");
    expect(t).toContain("2 tipped");
    expect(t).toContain("1 missed");
    expect(t).toContain("1 dropped");
    expect(html).toContain('aria-label="Table seen from above: 3 placed, 2 tipped, 1 missed, 1 dropped"');
  });
});

describe("the robot map, scored", () => {
  const html = checkedView("b1", "r02", scoredRobot, robotCfg);

  it("puts the claim next to the truth in the domain's words", () => {
    const t = text(html);
    expect(t).toContain("Claimed 100.0% from the practice spot");
    expect(t).toContain("Measured 42.9% at 7 positions it never tested");
    expect(t).not.toMatch(/test rows|training|accuracy/i);
  });

  it("draws the practice spot it ran, distinct from the hidden dots", () => {
    expect(html).toContain("ck-checked");
    expect(text(html)).toContain("Practice spot");
    expect(tags(html, "g", "ck-checked")).toHaveLength(1);
  });

  it("makes every hidden episode a labelled button, keyboard reachable", () => {
    const buttons = tags(html, "button", "data-ck-dot");
    expect(buttons).toHaveLength(HIDDEN.length);
    for (const b of buttons) {
      expect(b).toContain('type="button"');
      expect(b).not.toContain("tabindex=\"-1\"");
      expect(b).not.toContain("disabled");
      expect(b).toMatch(/aria-label="Position \d+: (placed|tipped over|missed|dropped)/);
    }
    expect(buttons[1]).toContain('aria-label="Position 2: tipped over, 4.1 cm from center"');
    expect(buttons[1]).toContain(`data-ck-motion="runs/r02/hidden/01-s0.motion.json"`);
  });

  it("gives each result its own shape, not only its color", () => {
    const shapeOf = (r: string): string => tags(html, "button", `ck-dot--${r}`)[0] ? html.split(`ck-dot--${r}`)[1].split("</button>")[0] : "";
    const shapes = ["placed", "tipped", "missed", "dropped"].map(shapeOf).map((s) => s.match(/<(circle|path)[^>]*>/)?.[0]);
    expect(new Set(shapes).size).toBe(4);
  });

  it("chooses nothing: no dot pressed, no episode playing", () => {
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain("data-robot-view");
    expect(html).toContain('<div class="ck-player" data-ck-player aria-live="polite"></div>');
    expect(text(html)).toContain("7 hidden episodes, each a real recording. Press one to replay it in 3D.");
  });

  it("is kept by morph and replaced when what it shows changes", () => {
    expect(html).toMatch(/^<section class="ck ck--robot" data-keep/);
    const again = checkedView("b1", "r02", { ...scoredRobot }, robotCfg);
    const key = (h: string): string => h.match(/data-morph-key="([^"]+)"/)?.[1] ?? "";
    expect(key(again)).toBe(key(html));
    expect(key(checkedView("b1", "r02", { ...scoredRobot, hidden_results: HIDDEN.slice(1) }, robotCfg))).not.toBe(key(html));
  });

  it("has no snake case or em dash in what it says", () => {
    expect(text(html)).not.toMatch(/[a-z]_[a-z]/);
    expect(html).not.toContain("\u2014");
  });
});

describe("the robot map, before scoring", () => {
  it("shows only what it checked and says the hidden positions come later", () => {
    const running: CheckedSubject = { ...scoredRobot, status: "running", true_accuracy: null };
    const html = checkedView("b1", "r02", running, robotCfg);
    expect(tags(html, "button", "data-ck-dot")).toHaveLength(0);
    expect(html).not.toContain("data-ck-player");
    expect(html).toContain("ck-checked");
    expect(text(html)).toContain("The hidden positions show once the run is scored.");
    expect(text(html)).not.toContain("42.9%");
  });

  it("draws no dots for a failed run either", () => {
    const html = checkedView("b1", "r02", { ...scoredRobot, status: "failed" }, robotCfg);
    expect(tags(html, "button", "data-ck-dot")).toHaveLength(0);
  });

  it("says when a scored run has no hidden results, and is empty on a batch with neither", () => {
    const html = checkedView("b1", "r02", { ...scoredRobot, hidden_results: undefined }, robotCfg);
    expect(tags(html, "button", "data-ck-dot")).toHaveLength(0);
    expect(text(html)).toContain("The hidden positions were not recorded for this run.");
    expect(checkedView("b1", "r02", { status: "inflated", reported_accuracy: 1, true_accuracy: 0.55 }, robotCfg)).toBe("");
  });

  it("names several checked positions as positions it ran", () => {
    const html = checkedView("b1", "r02", { ...scoredRobot, checked_positions: [[0.5, 0], [0.6, 0.2], [0.4, -0.2]] }, robotCfg);
    expect(text(html)).toContain("from 3 positions it ran");
    expect(tags(html, "g", "ck-checked")).toHaveLength(3);
  });
});

describe("pressing a dot", () => {
  /** A map with its dots and its player, as plain objects. */
  function fakeMap(html: string) {
    const player = { innerHTML: "" };
    const dots: (DotEl & { attrs: Record<string, string> })[] = [];
    const map = {
      dataset: { batch: "b1", ckKey: "r02" },
      querySelectorAll: () => dots,
      querySelector: (sel: string) => (sel === "[data-ck-player]" ? player : null),
    };
    for (const b of tags(html, "button", "data-ck-dot")) {
      const get = (n: string): string => b.match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? "";
      const attrs: Record<string, string> = { "aria-label": get("aria-label"), "aria-pressed": get("aria-pressed") };
      dots.push({
        attrs,
        dataset: { ckDot: get("data-ck-dot"), ckMotion: get("data-ck-motion"), ckResult: get("data-ck-result") },
        getAttribute: (n) => attrs[n] ?? null,
        setAttribute: (n, v) => { attrs[n] = v; },
        closest: (sel) => (sel === "[data-ck]" ? map : null),
      });
    }
    return { player, dots };
  }

  it("replays that dot's own episode, labelled with its real result, and marks only it", () => {
    const { player, dots } = fakeMap(checkedView("b1", "r02", scoredRobot, robotCfg));
    expect(pressDot(dots[1])).toBe("runs/r02/hidden/01-s0.motion.json");
    expect(dots.map((d) => d.attrs["aria-pressed"])).toEqual(["false", "true", "false", "false", "false", "false", "false"]);
    expect(player.innerHTML).toContain("data-robot-view");
    expect(player.innerHTML).toContain('data-batch="b1"');
    expect(player.innerHTML).toContain(`data-files="${'["runs/r02/hidden/01-s0.motion.json"]'.replace(/"/g, "&quot;")}"`);
    expect(text(player.innerHTML)).toContain("Position 2: tipped over, 4.1 cm from center");

    pressDot(dots[4]);
    expect(dots.map((d) => d.attrs["aria-pressed"])).toEqual(["false", "false", "false", "false", "true", "false", "false"]);
    expect(player.innerHTML).toContain("04-s0.motion.json");
    expect(player.innerHTML).not.toContain("01-s0.motion.json");
  });

  it("says so when the episode has no recording", () => {
    const html = episodeView("b1", "r02", { label: "Position 3: missed", result: "missed", motion: null });
    expect(html).not.toContain("data-robot-view");
    expect(text(html)).toContain("No recording was saved for this episode.");
  });

  it("listens for clicks on the root, so Enter and Space on the native buttons press too", () => {
    const { player, dots } = fakeMap(checkedView("b1", "r02", scoredRobot, robotCfg));
    let handler: ((e: Event) => void) | null = null;
    const root = {
      addEventListener: (_t: string, h: (e: Event) => void) => { handler = h; },
      removeEventListener: () => { handler = null; },
    } as unknown as Document;
    const off = wireChecked(root);
    const target = { closest: (sel: string) => (sel === "[data-ck-dot]" ? dots[2] : null) };
    handler!({ target } as unknown as Event);
    expect(dots[2].attrs["aria-pressed"]).toBe("true");
    expect(player.innerHTML).toContain("02-s0.motion.json");
    off();
    expect(handler).toBeNull();
  });
});

describe("the tabular bars", () => {
  const tab: CheckedSubject = { status: "inflated", reported_accuracy: 0.987, true_accuracy: 0.759, overlap_share: 0.34, n_test: 154, n_test_copies: 53, n_hidden: 154 };

  it("show the test set with its copies next to the holdout, claim against measured", () => {
    const html = checkedView("demo", "r03", tab, tabCfg);
    const t = text(html);
    expect(t).toContain("Its test set, 154 rows");
    expect(t).toContain("53 of 154 test rows were also in training");
    expect(t).toContain("Holdout, 154 rows it never saw");
    // An older tabular batch keeps the labels it always had (words.ts TABULAR_WORDS).
    expect(t).toContain("Reported 98.7%");
    expect(t).toContain("True 75.9%");
    expect(html).toMatch(/class="ck-bar-c" style="width:34\.42%"/);
    expect(html).not.toContain("data-ck-dot");
    expect(html).not.toContain("\u2014");
  });

  it("fall back to the overlap share when the test set size is missing", () => {
    const html = checkedView("demo", "r03", { status: "inflated", reported_accuracy: 0.98, true_accuracy: 0.76, overlap_share: 0.52 }, tabCfg);
    expect(text(html)).toContain("52% of test rows were also in training");
    expect(html).toMatch(/class="ck-bar-c" style="width:52%"/);
  });

  it("render nothing without either number, or before scoring", () => {
    expect(checkedView("demo", "r03", { status: "honest", reported_accuracy: 0.76, true_accuracy: 0.76, overlap_share: null }, tabCfg)).toBe("");
    expect(checkedView("demo", "r03", { ...tab, status: "running" }, tabCfg)).toBe("");
  });
});

describe("on the run page", () => {
  const demo = JSON.parse(caseRaw) as CaseFile;
  const vmOf = (c: CaseFile): BatchVm => ({ id: "demo-batch", live: false, case: c, events: {}, replay: null, busy: null, error: null, now: 0 });

  it("sits under a scored run's numbers", () => {
    const html = runSummaryView(vmOf(demo), "r03");
    // The fixture's r03 counts its own test rows and their copies of training rows: 89 of 185.
    expect(html).toContain('class="ck ck--tab"');
    expect(html.indexOf("</dl>")).toBeLessThan(html.indexOf('class="ck ck--tab"'));
    expect(text(html)).toContain("89 of 185 test rows were also in training");
    expect(text(html)).toContain("Holdout, 154 rows it never saw");
  });

  it("shows a fork child's own hidden results on its page", () => {
    const robot: CaseFile = {
      ...demo,
      config: { ...demo.config, ...robotCfg } as CaseFile["config"],
      forks: {
        f1: {
          id: "f1", status: "done", source_run: "r02", fork_at: 4, label: "tune_params", intervention: "x", n_per_arm: 1,
          children: { "forced-1": { arm: "forced", status: "honest", reported_accuracy: 0.5, true_accuracy: 0.55, ...{ n_hidden: 7, checked_positions: [[0.5, 0]], hidden_results: HIDDEN.map((h) => ({ ...h, motion: h.motion!.replace("runs/r02", "forks/f1/forced-1") })) } } },
        },
      },
    };
    const html = runSummaryView(vmOf(robot), "f1/forced-1");
    expect(tags(html, "button", "data-ck-dot")).toHaveLength(HIDDEN.length);
    expect(html).toContain('data-ck-key="f1/forced-1"');
    expect(html).toContain("forks/f1/forced-1/hidden/01-s0.motion.json");
  });
});
