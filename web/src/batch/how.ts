// "How it works" (`#/how`): a short guided tour of the loop. One stop is on screen at a time: a heading, two plain
// sentences, and a small picture drawn from a real batch, the robot demo (`robot-demo-batch`), loaded with the same
// case file fetch the batch pages use. On each picture one part is ringed and a bubble says the one thing to read there
// (tour.ts places the ring and the bubble). Five stops are the loop's steps; the sixth hands over: open the demo batch,
// or start one. How Orro is built is folded at the foot. Without the case file (still loading, or the server could not
// give it) the stops read as text alone.
//
// It is also the app's first screen for someone new: the first time a person enters the app (the landing's links,
// `#/start`, any app page but a batch's own), main.ts sends them here once (`firstVisitRedirect`), and remembers it
// in this browser (`howSeen`). A link straight to a batch is never sent anywhere.
//
// Pure like every view here: main.ts loads the case, keeps the stop, and handles the clicks.

import "./how.css";
import type { CaseFile, RunRecord } from "../api";
import { attr, esc } from "../ui";
import { forkDiagram, harnessDiagram } from "./how-diagrams";
import { verdictEvidence, verdictText, forkExperiments, forkOutcome, forkOutcomeText, pickRuns, splitCounts, splitHeadline } from "./lanes";
import { claimBars } from "./overview";
import { pct } from "./format";
import { ACT, routeHash, type Loadable, type Route } from "./model";
import { trapOf } from "./trap";
import { claimHeadline } from "./wall";
import { capital, domainWords, stepText } from "./words";

/** The batch the page draws its numbers from. */
export const HOW_BATCH = "robot-demo-batch";

// ── the first visit ──────────────────────────────────────────────────────────

/** Where this browser remembers that the page was seen. */
export const HOW_SEEN_KEY = "orro.how.seen";

/** The page's link and the one way out of it that marks it seen. */
export const HOW_HASH = "#/how";

/**
 * Where to send a person who enters the app, or null to stay. Only someone who has never seen this page, and only
 * from an app page of its own (home, costs): never from the landing page, never from a link to a batch, a run or a
 * fork child, and never from this page.
 */
export function firstVisitRedirect(r: Route, seen: boolean): Route | null {
  if (seen) return null;
  return r.name === "home" || r.name === "costs" ? { name: "how" } : null;
}

export interface SeenStore {
  get(): boolean;
  /** Remember it: in memory at once, and in storage when storage works. */
  set(): void;
}

/** Enough of `localStorage` for `howSeen` (a test's stand-in, or one that throws). */
export type SeenStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether the page was seen, kept in `storage` under HOW_SEEN_KEY. Every read and write is guarded: storage that
 * throws (a private window, storage off) or is missing reads as not seen until `set`, after which the memory says
 * seen for the rest of the session, so the redirect happens at most once per page load and never loops.
 */
export function howSeen(storage: () => SeenStorage | null | undefined): SeenStore {
  let mem = false;
  return {
    get() {
      if (mem) return true;
      try { mem = storage()?.getItem(HOW_SEEN_KEY) === "1"; } catch { /* storage off: memory only */ }
      return mem;
    },
    set() {
      mem = true;
      try { storage()?.setItem(HOW_SEEN_KEY, "1"); } catch { /* storage off: remembered for this session only */ }
    },
  };
}

// ── the pictures ─────────────────────────────────────────────────────────────

const byId = (a: RunRecord, b: RunRecord): number => a.id.localeCompare(b.id, undefined, { numeric: true });
const share = (x: number | null | undefined): number => (x == null || !Number.isFinite(x) ? 0 : Math.max(0, Math.min(1, x)) * 100);
const bar = (cls: string, x: number | null | undefined, label: string): string =>
  `<span class="hw-bar ${cls}" role="img" aria-label="${attr(label)}"><i style="width:${share(x).toFixed(1)}%"></i></span>`;

/** The one run the first two stops follow: the inflated run the batch's own pages show, else the first run. */
const followed = (c: CaseFile): RunRecord | null => {
  const id = pickRuns(c).inflated;
  return (id ? c.runs?.[id] : null) ?? Object.values(c.runs ?? {}).sort(byId)[0] ?? null;
};
/** The mark on the part of a picture the tour rings (tour.ts finds it by the stop's `focus` selector). */
const FOCUS = "data-how-focus";
const FOCUS_SEL = `[${FOCUS}]`;

/** 1. Every agent's claim, as it reported it. The truth is the next step's. */
function runPicture(c: CaseFile): string {
  const runs = Object.values(c.runs ?? {}).sort(byId);
  if (!runs.length) return "";
  const words = domainWords(c.config);
  const on = followed(c)?.id;
  const tiles = runs.map((r) => {
    const has = typeof r.reported_accuracy === "number";
    const v = has ? pct(r.reported_accuracy, 0) : "No claim";
    return `<li class="hw-agent${has ? "" : " is-none"}"${r.id === on ? ` ${FOCUS}` : ""}><span class="hw-agent-id">${esc(r.id)}</span>`
      + `<span class="hw-agent-v">${esc(v)}</span>${bar("hw-bar--claim", has ? r.reported_accuracy : 0, `${r.id} ${words.claim_label.toLowerCase()} ${v}`)}</li>`;
  }).join("");
  return `<ul class="hw-agents" aria-label="${attr(`${runs.length} agents and what each claimed`)}">${tiles}</ul>`
    + `<p class="hw-cap">${esc(`${words.claim_label}, as each agent reported it. ${words.truth_label} is not known yet.`)}</p>`;
}
function runTip(c: CaseFile): string {
  const r = followed(c);
  return r && typeof r.reported_accuracy === "number"
    ? `${r.id} claims ${pct(r.reported_accuracy, 0)}. Nobody has checked that yet.`
    : "Each agent reports its own score. Nobody has checked it yet.";
}

/** 2. The batch's claim against its truth: the headline and one bar per agent. */
function measurePicture(c: CaseFile): string {
  const head = claimHeadline(c);
  if (!head && !Object.keys(c.runs ?? {}).length) return "";
  return (head ? `<p class="hw-head">${esc(head)}</p>` : "") + `<div class="hw-chart">${claimBars(c)}</div>`;
}
function measureTip(c: CaseFile): string {
  const r = followed(c);
  if (!r || typeof r.reported_accuracy !== "number" || typeof r.true_accuracy !== "number") return "The solid part is what an agent scored. The part above it is what it claimed on top.";
  const n = typeof r.n_hidden === "number" && r.n_hidden > 0 ? `On ${r.n_hidden} cases it never saw` : "On cases it never saw";
  return `${r.id} claimed ${pct(r.reported_accuracy, 0)}. ${n}, it scored ${pct(r.true_accuracy, 0)}.`;
}
const measureFocus = (c: CaseFile): string => {
  const r = followed(c);
  return r ? `.ov-bar[data-morph-key="bar:${r.id}"]` : ".ov-bars";
};

const did = (rate: number, n: number): number => Math.round(rate * n);

/** 3. The step honest runs took and inflated ones skipped, as two counts. */
function stepPicture(c: CaseFile): string {
  const s = c.split;
  if (!s) return "";
  const words = domainWords(c.config);
  const trap = trapOf(c);
  const name = stepText(s.label, words, trap).name;
  const { honest, inflated } = splitHeadline(s, trap, words);
  const row = (who: string, cls: string, rate: number, n: number, focus = false): string =>
    `<div class="hw-row"${focus ? ` ${FOCUS}` : ""}><span class="hw-row-n">${esc(who)}</span>${bar(cls, rate, `${did(rate, n)} of ${n} ${who.toLowerCase()}`)}`
    + `<span class="hw-row-v">${did(rate, n)} of ${n}</span></div>`;
  // The ringed row comes last in each picture: the bubble opens under it, over nothing.
  return `<p class="hw-step-name"><span class="hw-tag">The step</span>${esc(capital(name))}</p>`
    + `<p class="hw-cap">${esc(`${honest} ${inflated}`)}</p>`
    + row("Honest runs", "hw-bar--ok", s.honest_rate, s.n_honest)
    + row("Inflated runs", "hw-bar--bad", s.inflated_rate, s.n_inflated, true)
    + `<span class="hw-sr">${esc(splitCounts(s))}</span>`;
}
function stepTip(c: CaseFile): string {
  const s = c.split;
  if (!s) return "";
  return `${did(s.inflated_rate, s.n_inflated)} of ${s.n_inflated} inflated runs took this step. ${did(s.honest_rate, s.n_honest)} of ${s.n_honest} honest runs did.`;
}

const theFork = (c: CaseFile) => forkExperiments(c).find((x) => x.kind !== "fix");

/** 4. The fork: an inflated run cut before the step into four arms, each copy marked inflated or honest, and what
 *  the step did to the claim and to the work. */
function forkPicture(c: CaseFile): string {
  const f = theFork(c);
  const o = f ? forkOutcome(f) : null;
  if (!f || !o) return "";
  const words = domainWords(c.config);
  const name = c.split ? stepText(c.split.label, words, trapOf(c)).name : "the step";
  return `<p class="hw-head hw-head--sm">${esc(forkOutcomeText(o, words.subject))}</p>`
    + `<ul class="hw-keys" aria-hidden="true"><li><i class="hw-sw hw-sw--bad"></i>Copy came out inflated</li><li><i class="hw-sw hw-sw--ok"></i>Copy came out honest</li></ul>`
    + `<div class="hw-fork">${forkDiagram(name, f.source_run ?? c.split?.fork_run_id ?? null, f)}</div>`;
}
function forkTip(c: CaseFile): string {
  const a = theFork(c)?.arms?.forced;
  return a && a.scored
    ? `Same run, copied just before the step. Made to do it, ${a.inflated} of ${a.scored} copies came out inflated.`
    : "Same run, copied just before the step. Only the copies made to do it stop overclaiming.";
}

/** 5. The verdict as the batch words it, and how many pairs of copies it stands on out of the number it needs. */
function verdictPicture(c: CaseFile): string {
  const ev = verdictEvidence(c);
  if (!ev) return "";
  const needed = Math.max(ev.needed, ev.pairs);
  const supported = ev.level === "supported";
  const slots = Array.from({ length: needed }, (_, i) => `<i class="${i < ev.pairs ? "is-on" : ""}"></i>`).join("");
  return `<p class="hw-quote">${esc(verdictText(c))}</p>`
    + `<div class="hw-pairs"><span class="hw-level" data-level="${ev.level}">${supported ? "Supported" : "Open"}</span>`
    + `<span class="hw-slots" role="img" aria-label="${attr(`${ev.pairs} of ${ev.needed} pairs`)}">${slots}</span>`
    + `<span class="hw-row-v">${ev.pairs} of ${ev.needed} pairs</span></div>`;
}
function verdictTip(c: CaseFile): string {
  const ev = verdictEvidence(c);
  if (!ev) return "";
  return ev.level === "supported"
    ? `${ev.pairs} of ${ev.needed} pairs: enough for the verdict to name the step as the cause.`
    : `${ev.pairs} of ${ev.needed} pairs so far, so the verdict stays open.`;
}

/** 6. The way on: the demo batch (ringed), or a batch of one's own (the header's dialog). */
const startPicture = (): string =>
  `<div class="hw-start">`
  + `<a class="ask-btn hw-btn hw-btn--big ds-primary" ${FOCUS} href="${attr(routeHash({ name: "batch", id: HOW_BATCH }))}">See a real batch</a>`
  + `<button type="button" class="ask-btn hw-btn hw-btn--big" data-act="${ACT.newBatch}">Start my own batch</button>`
  + `</div>`;

// ── the page ─────────────────────────────────────────────────────────────────

interface Step {
  key: string;
  title: string;
  /** The stop's name on the rail, when the title is too long for it. */
  rail?: string;
  /** Two plain sentences, true of any batch. The numbers are the picture's. */
  text: string;
  picture: (c: CaseFile) => string;
  /** The bubble: the one thing to read on the picture, in this batch's numbers. */
  tip: (c: CaseFile) => string;
  /** A selector, inside the picture, for the part the bubble points at. */
  focus: (c: CaseFile) => string;
}

export const HOW_STEPS: readonly Step[] = [
  {
    key: "run", title: "Run",
    text: "Many AI agents get the same task, each in a sandbox of its own. When one finishes, it reports how well its work did.",
    picture: runPicture, tip: runTip, focus: () => FOCUS_SEL,
  },
  {
    key: "measure", title: "Measure",
    text: "Orro scores each agent's work on cases it never saw. A claim well above that score is marked inflated.",
    picture: measurePicture, tip: measureTip, focus: measureFocus,
  },
  {
    key: "step", title: "Find the step",
    text: "Orro looks for a step the honest runs took and the inflated ones skipped. That step is a lead, not yet a cause.",
    picture: stepPicture, tip: stepTip, focus: () => FOCUS_SEL,
  },
  {
    key: "fork", title: "Fork to test it", rail: "Fork",
    text: "Orro copies an inflated run just before that step and sends the copies four ways. If only the copies that do the step stop overclaiming, the step made the claim too high.",
    picture: forkPicture, tip: forkTip, focus: () => `[data-how-arm="forced"]`,
  },
  {
    key: "verdict", title: "The verdict follows the evidence", rail: "Verdict",
    text: "With few pairs of copies the verdict only says the step suggests the cause. Run more pairs, in Needs you, adds evidence.",
    picture: verdictPicture, tip: verdictTip, focus: () => ".hw-pairs",
  },
];

/** The last stop, after the five steps. */
const START = {
  key: "start", title: "Your turn",
  text: "Walk the same five steps on a real batch's own screens, or start a batch of your own.",
  tip: "Start here.",
};

/** How many stops the tour has: the steps, then the way on. */
export const HOW_STOPS = HOW_STEPS.length + 1;
/** The stop a number names, kept inside the tour. */
export const howStop = (at: number): number => (Number.isFinite(at) ? Math.max(0, Math.min(HOW_STOPS - 1, Math.round(at))) : 0);

const railName = (i: number): string => (i < HOW_STEPS.length ? HOW_STEPS[i].rail ?? HOW_STEPS[i].title : START.title);

/** How Orro is built, from the code: deep_research/agents/, sandboxes.py, forks.py, batch.py, commentary.py. */
const PARTS: readonly [string, string][] = [
  ["The agents", "Each run is one LangChain Deep Agent on Claude Haiku 5.5 or Sonnet 5.5, the models taking turns across the batch. "
    + "Its file tools and shell run inside its own Daytona VM, and it keeps its plan as a todo list. "
    + "It has no subagents, since a subagent would be one closed step that cannot be forked, and its history is never "
    + "summarized, so a fork replays exactly what the model saw."],
  ["The sandboxes", "Every VM starts from a snapshot with the task loaded, and the server pulls each run's events and outputs. "
    + "The hidden cases are scored on the server, never inside a VM. "
    + "A fork is a copy on write of the VM, cut at a step with the model's history replayed up to it. "
    + "If a VM cannot be forked, the run's actions are replayed on a fresh one."],
  ["The investigator", "A Deep Agent on Sonnet 5.5 with three helpers: a step tagger that labels every run's steps, a hypothesis "
    + "helper that can draft explanations, and a code tracer that reruns failing code and points at a line. "
    + "It reads the case, the runs and its skills through read-only views, with a notebook kept for each kind of task, "
    + "and it can never read the hidden results or which flaw a batch was built with. "
    + "Before any experiment it records at least two competing hypotheses, each with a prediction and the result that "
    + "would falsify it; the outcome of each test is computed from the counts, not judged by the model. "
    + "It records what it finds through typed tools, a grader checks its verdict and can send it back twice, and a fork "
    + "request waits until you approve it."],
  ["The live commentary", "A small model, Claude Haiku, captions each run every 20 to 30 seconds from only what that agent did. "
    + "Notable moments go into the live feed in the page header."],
];

/** How Orro is built, folded: the tour is the page, this is for the person who asks. */
function underTheHood(): string {
  return `<details class="hw-hood" data-morph-key="how:hood"><summary class="hw-hood-s">How Orro is built</summary>`
    + `<div class="hw-hood-b"><p class="hw-sec-lead">A server runs the agents in sandboxes, scores them where they cannot look, and hands the evidence to an investigator agent.</p>`
    + `<figure class="hw-fig">${harnessDiagram()}</figure>`
    + `<div class="hw-parts">${PARTS.map(([h, p]) => `<div class="hw-part"><h3 class="hw-h3">${esc(h)}</h3><p class="hw-p">${esc(p)}</p></div>`).join("")}</div>`
    + `</div></details>`;
}

/** The rail: every stop by name, the one on screen marked, each a button to it. */
function rail(at: number): string {
  const stops = Array.from({ length: HOW_STOPS }, (_, i) =>
    `<li><button type="button" class="hw-stopb${i < at ? " is-done" : ""}" data-act="${ACT.howStep}" data-arg="${i}"${i === at ? ` aria-current="step"` : ""}>`
    + `<span class="hw-n" aria-hidden="true">${i + 1}</span><span class="hw-stopb-l">${esc(railName(i))}</span></button></li>`).join("");
  return `<ol class="hw-rail" aria-label="The tour, stop by stop">${stops}</ol>`;
}

/**
 * The page. `demo` is the robot demo's case file, as far as it has loaded; `at` is the stop on screen (0 is Run, the
 * last is the way on).
 */
export function howView(demo: Loadable<CaseFile>, at = 0): string {
  const c = demo.state === "ready" ? demo.value : null;
  const i = howStop(at);
  const s = i < HOW_STEPS.length ? HOW_STEPS[i] : null;
  const note = demo.state === "loading"
    ? `<p class="hw-note" role="status">Loading the numbers from the robot demo batch…</p>`
    : demo.state === "error"
      ? `<p class="hw-note" role="status">The robot demo batch could not be loaded, so the steps are shown without its numbers.</p>`
      : `<p class="hw-note">${esc(`Every number comes from a real batch: ${Object.keys(c?.runs ?? {}).length} agents each writing a controller for a robot arm that picks up a can and places it.`)}</p>`;
  const pic = s ? (c ? s.picture(c) : "") : startPicture();
  const tip = s ? (c && pic ? s.tip(c) : "") : START.tip;
  const target = s ? (c ? s.focus(c) : "") : FOCUS_SEL;
  // The stage stays the same element from stop to stop, so the ring glides from one part to the next; the picture in
  // it is replaced whole.
  const stage = pic
    ? `<div class="hw-stage" data-how-stage data-how-target="${attr(target)}">`
      + `<div class="hw-pic" data-morph-key="how:pic:${s ? s.key : START.key}">${pic}</div>`
      + `<span class="hw-ring" data-how-ring aria-hidden="true"></span>`
      + (tip ? `<p class="hw-tip" data-how-tip>${esc(tip)}</p>` : "")
      + `</div>`
    : "";
  const back = i > 0 ? `<button type="button" class="ask-btn hw-btn" data-act="${ACT.howStep}" data-arg="${i - 1}">Back</button>` : "";
  const next = s
    ? `<button type="button" class="ask-btn hw-btn ds-primary" data-how-next data-act="${ACT.howStep}" data-arg="${i + 1}"><span class="hw-next-k">Next</span>${esc(railName(i + 1))}</button>`
    : "";
  return `<div class="hw" data-morph-key="how">`
    + `<header class="hw-top" data-morph-key="how:intro"><div class="hw-top-r">`
    + `<a class="hw-skip" href="${attr(routeHash({ name: "home" }))}" data-how-done>Go to my batches</a></div>`
    + `<h1 class="hw-title">Orro catches wrong claims, not bad robots.</h1>`
    + `<p class="hw-lead">Each agent says how well it did. Orro checks that claim against the truth, finds the step that made the difference, and tests it.</p>`
    + `</header>`
    + `<section class="hw-tour" aria-label="The loop, stop by stop" data-morph-key="how:tour">`
    + rail(i)
    + `<div class="hw-stop${pic ? "" : " is-text"}" data-morph-key="how:stop">`
    + `<div class="hw-stop-l" data-morph-key="how:text:${s ? s.key : START.key}">`
    + `<p class="hw-count">${i + 1} of ${HOW_STOPS}</p>`
    + `<h2 class="hw-h">${esc(s ? s.title : START.title)}</h2><p class="hw-p">${esc(s ? s.text : START.text)}</p>`
    + `<div class="hw-nav">${back}${next}</div></div>`
    + stage
    + `</div>`
    + note
    + `</section>`
    + underTheHood()
    + `</div>`;
}
