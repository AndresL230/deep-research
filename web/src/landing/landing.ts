// The landing page: a nav and a hero, then three sections under it. The hero's copy sits over a 3D scene of the
// pipeline (scene.ts). The first section is a short list beside a 3D device for whichever item of it is open
// (devices.ts). The second is the split finder's chapter, which stays on screen while the page scrolls through it
// and plays as it does (finder.ts). The third is the robot floor: a factory drawn in outline that the scrolling
// slides past, station by station, under a card with a chapter for each (factory.ts). mount.ts loads the scenes
// and draws them into the `data-lp-scene`, `data-lp-devices`, `data-lp-net` and `data-lp-floor` elements.
//
// Like the batch views this is a pure function that returns markup. Nothing on the page depends on the server:
// the only state is which item of the list is open, and main.ts holds it.
//
// The page is dark. `tone` picks its light version instead (main.ts passes it for `?theme=light`); the stylesheet
// and the scenes both read it from `data-lp-tone`.
import "./landing.css";
import { routeHash } from "../batch/model";
import { attr, esc } from "../ui";
import type { SceneTone } from "./kit";

/** A piece of an item's paragraph: plain words, or a path or address drawn on a chip. */
type Words = string | { chip: string };

/** The page's words.
 *
 *  `labels` are the four tags in the hero's scene, one per line between two pads, in the order the work moves: out
 *  of the task, out of the runs, out of the split finder, out of the fork experiment.
 *
 *  `more` is the section under the hero. Its items are in the order of the devices in devices.ts: the terminal,
 *  then the data bench.
 *
 *  `finder` is the split finder's chapter. Its coins and its tag are the demo batch's: twelve runs, six of them
 *  honest, and the split the batch found (fixtures/demo-batch/case/case.json). */
export const LANDING = {
  brand: "Deep Research",
  title: "Where do AI scientists go wrong?",
  lede: "Run one data science agent many times, find the step where honest and inflated runs split, then fork the VM to prove what went wrong.",
  labels: ["New task", "Many runs", "Split found", "Evidence"],
  /** The saved batch the nav offers as a replay (fixtures/demo-batch). */
  demo: "demo-batch",
  more: {
    title: "Run it yourself",
    items: [
      {
        title: "CLI and API",
        words: [
          "Start a batch, score the runs, find the split and fork the VM from a terminal or a script. The web app is one more client of the same API, at ",
          { chip: "/api/batches" },
        ] as Words[],
      },
      {
        title: "Your own data",
        words: [
          "Upload a CSV and pick its target column, or start from the built-in table. A holdout is set aside whose labels never leave the server, and duplicate rows are planted in the rest, so every reported score can be checked.",
        ] as Words[],
      },
    ],
  },
  finder: {
    title: "Split finder",
    words: "Deep Research reads every run's log and labels each action with its step: load, deduplicate, split, train. Then it finds the step that honest runs took before the train/test split and inflated runs skipped. With the share of runs on each side and the code that shows it.",
    /** How many runs the batch had, and which of them scored honestly. */
    runs: 12,
    honest: [1, 4, 5, 7, 11, 12],
    /** The step the runs split at, how many of each kind took it, and the line of an honest run that is it. */
    split: { step: "deduplicate", honest: "6 of 6", inflated: "0 of 6", code: "df = df.drop_duplicates()" },
    /** What the chapter shows, for someone who cannot see it. */
    alt: "Twelve coins, one for each run of a batch, shrink into points. A web of lines grows between them, then thins out until one point is left: the step deduplicate, which 6 of 6 honest runs took and 0 of 6 inflated runs did.",
  },
  /** The robot floor. Its chapters are the robot domain's own story (sim/README.md, sim/CALIBRATION.md): the
   *  task, the positions the agent never sees, what makes a run inflated, and the fork experiment. One chapter for
   *  each station of the scene, in the order the page scrolls past them. */
  floor: {
    title: ["The same check,", "now for robots"],
    chapters: [
      { title: "Pick and place", words: "An agent writes the controller for a robot arm in simulation: pick a can off the table, place it on the zone, and report how often that works." },
      { title: "Hidden positions", words: "The agent only ever sees one practice spot. Its controller is then run with the can at 20 positions it never saw, and that rate is set against the one it reported." },
      { title: "Split found", words: "A run that reports well above what was measured is inflated. The split finder names the step honest runs took and inflated runs skipped: trying the can in more than one place." },
      { title: "Fork to prove", words: "From the same point in the same run, some copies carry on unchanged and some are made to try 10 random positions. If those come out honest, that step was the cause." },
    ],
    alt: "A factory floor drawn in outline, seen from above. The page slides past four stations, and at each a pair of robot arms works on its own: fitting gears to motors, loading cartons onto a truck, bolting parts on a conveyor, and plugging cables into blocks.",
  },
} as const;

/** The demo batch's runs, as the chapter's coins: each one's name, and whether it scored honestly. */
export function demoRuns(): { id: string; honest: boolean }[] {
  const honest: readonly number[] = LANDING.finder.honest;
  return Array.from({ length: LANDING.finder.runs }, (_, i) => ({ id: `r${String(i + 1).padStart(2, "0")}`, honest: honest.includes(i + 1) }));
}

/** The mark: one run that splits in two, the second branch in the accent colour. */
const MARK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.4 12h5.4" stroke="#f2f3f3"></path><path d="M9.8 12c3.3 0 3.5-5.2 7-5.2h2.8" stroke="#f2f3f3"></path><path d="M9.8 12c3.3 0 3.5 5.2 7 5.2h2.8" stroke="#9aa4df"></path></svg>`;

/** The list under the hero: a heading, then the items. The open one shows its paragraph and a bar beside it; the
 *  others are just their titles, and pressing one opens it (`data-lp-item`, handled in main.ts). */
function moreView(open: number): string {
  const items = LANDING.more.items.map((item, i) => {
    const isOpen = i === open;
    const words = item.words.map((w) => (typeof w === "string" ? esc(w) : `<span class="lp-chip">${esc(w.chip)}</span>`)).join("");
    return `<li class="lp-item${isOpen ? " is-open" : ""}">
        <h3 class="lp-item-h"><button type="button" class="lp-item-t" data-lp-item="${i}" aria-expanded="${isOpen}" aria-controls="lp-item-${i}">${esc(item.title)}</button></h3>
        <div class="lp-item-b" id="lp-item-${i}"><p class="lp-item-p"><span class="lp-item-x">${words}</span></p></div>
      </li>`;
  }).join("");
  return `<section class="lp-more" aria-labelledby="lp-more-title" data-lp-open="${open}">
      <div class="lp-more-copy">
        <h2 class="lp-more-title" id="lp-more-title">${esc(LANDING.more.title)}</h2>
        <ul class="lp-items">${items}</ul>
      </div>
      <div class="lp-device" data-lp-devices data-keep aria-hidden="true"></div>
    </section>`;
}

/** The split finder's chapter: a tall section whose one screen of content stays put while the page scrolls through
 *  the rest of its height. finder.ts draws in the element beside the copy, and says what it shows in its label. */
function finderView(): string {
  const f = LANDING.finder;
  return `<section class="lp-pin" data-lp-pin aria-labelledby="lp-finder-title">
      <div class="lp-finder">
        <span class="lp-surface" aria-hidden="true"></span>
        <div class="lp-finder-copy">
          <h2 class="lp-finder-title" id="lp-finder-title">${esc(f.title)}</h2>
          <p class="lp-finder-p">${esc(f.words)}</p>
        </div>
        <div class="lp-net" data-lp-net data-keep role="img" aria-label="${attr(f.alt)}"></div>
      </div>
    </section>`;
}

/** The robot floor: a tall section whose one screen stays put while the page scrolls through the rest of its
 *  height. factory.ts draws the floor behind everything and keeps the card's `data-chapter` and each bar's
 *  `--lp-fill` in step with the page; the card is left to it (`data-keep`). Every chapter's words are in the
 *  markup, one over the other, and the open one shows. */
function floorView(): string {
  const f = LANDING.floor;
  const texts = f.chapters.map((c, i) => `<div class="lp-floor-text" data-lp-floor-text="${i}">
            <h3 class="lp-floor-h">${esc(c.title)}</h3>
            <p class="lp-floor-p">${esc(c.words)}</p>
          </div>`).join("");
  const steps = f.chapters.map((c, i) => `<li><button type="button" class="lp-floor-step" data-lp-floor-step="${i}" aria-label="${attr(c.title)}" aria-current="${i === 0 ? "step" : "false"}"><span></span></button></li>`).join("");
  return `<section class="lp-floor" data-lp-floor-pin aria-labelledby="lp-floor-title">
      <div class="lp-floor-stage">
        <div class="lp-floor-scene" data-lp-floor data-keep role="img" aria-label="${attr(f.alt)}"></div>
        <h2 class="lp-floor-title" id="lp-floor-title">
          <span class="lp-floor-row"><span class="lp-floor-pill lp-floor-pill-a">${esc(f.title[0])}</span></span>
          <span class="lp-floor-row"><span class="lp-floor-dot" aria-hidden="true"></span><span class="lp-floor-pill">${esc(f.title[1])}</span></span>
        </h2>
        <div class="lp-floor-card" data-lp-floor-card data-keep data-chapter="0">
          <div class="lp-floor-texts">${texts}</div>
          <ol class="lp-floor-steps">${steps}</ol>
        </div>
      </div>
    </section>`;
}

/** The whole page. `open` is which item of the list under the hero is open. */
export function landingView(tone: SceneTone = "dark", open = 0): string {
  const start = attr(routeHash({ name: "home" }));
  const demo = attr(routeHash({ name: "batch", id: LANDING.demo }));
  const item = open >= 0 && open < LANDING.more.items.length ? Math.floor(open) : 0;
  return `<div class="lp" data-lp-tone="${tone}" data-morph-key="landing">
    <div class="lp-top">
      <div class="lp-scene" data-lp-scene data-keep aria-hidden="true"></div>
      <header class="lp-nav" data-lp-nav>
        <a class="lp-brand" href="${attr(routeHash({ name: "landing" }))}"><span class="lp-mark">${MARK}</span><span class="lp-name">${esc(LANDING.brand)}</span></a>
        <nav class="lp-links" aria-label="Main">
          <a class="lp-link" href="${start}">Batches</a>
          <a class="lp-link" href="${demo}">Demo replay</a>
        </nav>
        <a class="lp-cta" href="${start}">Start a batch</a>
      </header>
      <section class="lp-hero" aria-labelledby="lp-title">
        <div class="lp-copy" data-lp-copy>
          <h1 class="lp-title" id="lp-title">${esc(LANDING.title)}</h1>
          <p class="lp-lede">${esc(LANDING.lede)}</p>
        </div>
        <div class="lp-room" aria-hidden="true"></div>
      </section>
    </div>
    ${moreView(item)}
    ${finderView()}
    ${floorView()}
  </div>`;
}
