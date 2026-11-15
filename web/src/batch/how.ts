// "How it works" (`#/how`): a short guided tour of the loop. One stop is on screen at a time: a heading, two plain
// sentences, and a small picture drawn from a real batch, the recorded robot run (`robot-live-investigation`), loaded with the same
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
import { AGREE, DISAGREE, SUPPORTED_SCORE, isDone, pairs as childPairs } from "./evidence";
import { forkDiagram, harnessDiagram } from "./how-diagrams";
import { hypName, verdictEvidence, verdictText, forkExperiments, forkOutcome, forkOutcomeText, pickRuns } from "./lanes";
import { claimBars } from "./overview";
import { pct, pts } from "./format";
import { forkPairs, logShare, scoreText, suspectsOf } from "./suspects";
import { ACT, routeHash, type Loadable, type Route } from "./model";
import { trapOf } from "./trap";
import { claimHeadline } from "./wall";
import { capital, domainWords, stepText } from "./words";

/** The batch the page draws its numbers from. */
export const HOW_BATCH = "robot-live-investigation";

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

const theFork = (c: CaseFile) => forkExperiments(c).find((x) => x.kind !== "fix");

/** One suspect as the tour names it. */
interface Named { id: string; name: string; tested: boolean }

/** The suspects in plain words, the one the fork tested last (the bubble opens under it). Before the investigator has
 *  named any, the step the runs split on stands in as the only one. */
function suspectsNamed(c: CaseFile): Named[] {
  const words = domainWords(c.config);
  const trap = trapOf(c);
  const f = theFork(c);
  const hyps = c.hypotheses ?? [];
  const testedId = f?.suspect_id ?? f?.hypothesis_id ?? hyps.find((h) => f && (h.tested_by === f.id || (h.step_label && h.step_label === f.label)))?.id ?? null;
  const rows = suspectsOf(c).map((s): Named => {
    const h = hyps.find((x) => x.id === s.id);
    return { id: s.id, name: h ? hypName(h, words, trap) : capital(stepText(s.target, words, trap).name), tested: s.id === testedId };
  });
  if (!rows.length && c.split) rows.push({ id: "", name: capital(stepText(c.split.label, words, trap).name), tested: true });
  return [...rows.filter((r) => !r.tested), ...rows.filter((r) => r.tested)];
}

/** 3. The suspects the investigator named, the one that gets tested ringed. */
function suspectsPicture(c: CaseFile): string {
  const rows = suspectsNamed(c);
  if (!rows.length) return "";
  const any = rows.some((r) => r.tested);
  const li = (r: Named, i: number): string => {
    const on = any ? r.tested : i === rows.length - 1;
    return `<li class="hw-su"${on ? ` ${FOCUS}` : ""}>${r.id ? `<span class="hw-su-id">${esc(r.id)}</span>` : ""}`
      + `<span class="hw-su-t">${esc(r.name)}</span>${r.tested ? `<span class="hw-tag">Tested next</span>` : ""}</li>`;
  };
  return `<p class="hw-cap">What could explain the gap, as the investigator named it. Each one comes with a prediction, saved before any test.</p>`
    + `<ol class="hw-sus" aria-label="${attr(`${rows.length} ${rows.length === 1 ? "suspect" : "suspects"}`)}">${rows.map(li).join("")}</ol>`;
}
function suspectsTip(c: CaseFile): string {
  const n = suspectsNamed(c).length;
  return `${n} ${n === 1 ? "suspect" : "suspects"}, nothing proven yet. This one gets tested.`;
}

/** The fork's finished pairs: copy number, the two gaps, whether the pair went the predicted way, and whether each
 *  copy came out inflated. */
interface TourPair { i: number; base: number; changed: number; agree: boolean; baseBad: boolean; changedBad: boolean }
function tourPairs(c: CaseFile): TourPair[] {
  const f = theFork(c);
  if (!f) return [];
  const bad = (id: string): boolean => f.children?.[id]?.status === "inflated";
  const own = childPairs(f, "control", "forced").filter(isDone);
  if (own.length) return own.map((p) => ({ i: p.i, base: p.baseGap, changed: p.changedGap, agree: p.agree, baseBad: bad(p.base), changedBad: bad(p.changed) }));
  return forkPairs(f).map((p) => ({ i: p.i, base: p.control_gap, changed: p.changed_gap, agree: p.agree, baseBad: bad(`control-${p.i}`), changedBad: bad(`forced-${p.i}`) }));
}

/** 4. The experiment: one inflated run copied in pairs, one copy left alone and one with a single change, and whether
 *  each pair went the way the investigator predicted. Without scored pairs, the fork's own diagram. */
function forkPicture(c: CaseFile): string {
  const f = theFork(c);
  const o = f ? forkOutcome(f) : null;
  if (!f || !o) return "";
  const words = domainWords(c.config);
  // The step the fork tested, which need not be the split's (in the recorded robot run the split is tune_params, which
  // no fork can force, and the fork tested test_table_edges).
  const label = f.label ?? c.split?.label;
  const name = label ? stepText(label, words, trapOf(c)).name : "the step";
  const run = f.source_run ?? c.split?.fork_run_id ?? null;
  const ps = tourPairs(c);
  if (!ps.length) {
    return `<p class="hw-head hw-head--sm">${esc(forkOutcomeText(o, words.subject))}</p>`
      + `<ul class="hw-keys" aria-hidden="true"><li><i class="hw-sw hw-sw--bad"></i>Copy came out inflated</li><li><i class="hw-sw hw-sw--ok"></i>Copy came out honest</li></ul>`
      + `<div class="hw-fork">${forkDiagram(name, run, f)}</div>`;
  }
  // "+35.0 pts", and a plain "0 pts" for a copy whose claim matched what was measured.
  const cell = (gap: number, isBad: boolean): string =>
    `<span class="hw-pr-c"><i class="hw-sw hw-sw--${isBad ? "bad" : "ok"}"></i>${esc(Math.abs(gap) < 0.0005 ? "0 pts" : pts(gap))}</span>`;
  const rows = ps.map((p) => `<li class="hw-pr"><span class="hw-pr-i">${p.i}</span>${cell(p.base, p.baseBad)}${cell(p.changed, p.changedBad)}`
    + `<span class="hw-pr-a${p.agree ? " is-yes" : ""}">${p.agree ? "as predicted" : "not as predicted"}</span></li>`).join("");
  const extra = Object.keys(f.children ?? {}).some((id) => !/^(control|forced)-/.test(id));
  // The ringed table comes last: the bubble opens under it, over nothing.
  return `<p class="hw-step-name"><span class="hw-tag">The change</span>${esc(capital(name))}</p>`
    + `<p class="hw-cap">${esc(`${run ? `Run ${run}` : "One inflated run"}, copied in pairs${extra ? ", with two more groups of copies as checks" : ""}. `
      + "Each number is how far a copy's claim came out above what was measured.")}</p>`
    + `<ul class="hw-keys" aria-hidden="true"><li><i class="hw-sw hw-sw--bad"></i>Copy came out inflated</li><li><i class="hw-sw hw-sw--ok"></i>Copy came out honest</li></ul>`
    + `<div class="hw-prs" ${FOCUS}><div class="hw-pr hw-pr--h" aria-hidden="true"><span>Pair</span><span>Left alone</span><span>With the change</span><span></span></div>`
    + `<ol class="hw-pr-l" aria-label="${attr(`${ps.length} pairs of copies`)}">${rows}</ol></div>`;
}
function forkTip(c: CaseFile): string {
  const ps = tourPairs(c);
  if (ps.length) {
    const yes = ps.filter((p) => p.agree).length;
    return `${yes} of ${ps.length} pairs went the way the investigator predicted.`;
  }
  const a = theFork(c)?.arms?.forced;
  return a && a.scored
    ? `Same run, copied just before the step. Made to do it, ${a.inflated} of ${a.scored} copies came out inflated.`
    : "Same run, copied just before the step. Only the copies made to do it stop overclaiming.";
}
const forkFocus = (c: CaseFile): string => (tourPairs(c).length ? FOCUS_SEL : `[data-how-arm="forced"]`);

const LEVEL_WORD: Record<string, string> = { supported: "Supported", cleared: "Cleared", open: "Open", inconclusive: "Inconclusive" };

/** 5. The verdict as the batch words it, and the score it stands on against the 20 it needs. */
function verdictPicture(c: CaseFile): string {
  const ev = verdictEvidence(c);
  if (!ev) return "";
  const ps = tourPairs(c);
  const score = ev.score ?? null;
  const sum = ps.length && ps.length <= 8 && score != null
    ? `<p class="hw-cap hw-sum">${esc(`Score: 1 ${ps.map((p) => `× ${p.agree ? AGREE : DISAGREE}`).join(" ")} = ${scoreText(score)}`)}</p>`
    : "";
  const meter = score == null ? "" :
    `<span class="hw-meter" role="img" aria-label="${attr(`Score ${scoreText(score)} of the ${SUPPORTED_SCORE} it needs`)}">`
    + `<i style="width:${(logShare(score) * 100).toFixed(1)}%"></i><b style="left:${(logShare(SUPPORTED_SCORE) * 100).toFixed(1)}%"></b></span>`
    + `<span class="hw-row-v">${esc(scoreText(score))} of ${SUPPORTED_SCORE}</span>`;
  // The ringed meter comes last: the bubble opens under it, over nothing.
  return `<p class="hw-quote">${esc(verdictText(c))}</p>`
    + sum
    + `<div class="hw-pairs"><span class="hw-level" data-level="${attr(ev.level)}">${LEVEL_WORD[ev.level] ?? "Open"}</span>${meter}</div>`;
}
function verdictTip(c: CaseFile): string {
  const ev = verdictEvidence(c);
  if (!ev) return "";
  const score = ev.score == null ? "" : scoreText(ev.score);
  if (ev.level === "supported") return `Score ${score}, past ${SUPPORTED_SCORE}: the verdict may name the cause.`;
  if (ev.level === "cleared") return `Score ${score} after ${ev.pairs} pairs: this suspect is cleared.`;
  if (ev.level === "inconclusive") return "None of the control copies reproduced the inflation, so the experiment says nothing either way.";
  return score ? `Score ${score}. It needs ${SUPPORTED_SCORE}, so the verdict stays open.` : `${ev.pairs} pairs so far, so the verdict stays open.`;
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
    key: "suspects", title: "Name the suspects", rail: "Suspects",
    text: "An investigator agent reads every run without being told the answer. It lists the suspects: each thing that could explain the gap, with what a test of it should show.",
    picture: suspectsPicture, tip: suspectsTip, focus: () => FOCUS_SEL,
  },
  {
    key: "fork", title: "Fork to test one", rail: "Fork",
    text: "Once a person approves, Orro copies one inflated run from just before it reported, in pairs. One copy of each pair is left alone and the other gets a single change.",
    picture: forkPicture, tip: forkTip, focus: forkFocus,
  },
  {
    key: "verdict", title: "The verdict follows the score", rail: "Verdict",
    text: `Each pair that goes the predicted way multiplies a score by ${AGREE}, and each one that does not by ${DISAGREE}. At ${SUPPORTED_SCORE} the verdict may name a cause; a suspect still under 1 after five pairs is cleared.`,
    picture: verdictPicture, tip: verdictTip, focus: () => ".hw-pairs",
  },
];

/** The last stop, after the five steps. */
const START = {
  key: "start", title: "Your turn",
  text: "Walk the same five steps on a real batch's own screens, or start a batch of your own.",
  tip: "Start here.",
};

/** Under the verdict stop: what comes after a verdict, and where to see whether it worked (#/lessons). */
export const HOW_LESSON_LINE = `<p class="hw-p hw-then"><a class="hw-then-a" href="${attr(routeHash({ name: "lessons" }))}">Then Orro writes a lesson; the fool rate shows whether it works.</a></p>`;

/** How many stops the tour has: the steps, then the way on. */
export const HOW_STOPS = HOW_STEPS.length + 1;
/** The stop a number names, kept inside the tour. */
export const howStop = (at: number): number => (Number.isFinite(at) ? Math.max(0, Math.min(HOW_STOPS - 1, Math.round(at))) : 0);

const railName = (i: number): string => (i < HOW_STEPS.length ? HOW_STEPS[i].rail ?? HOW_STEPS[i].title : START.title);

/** How Orro is built, from the code: deep_research/agents/, sandboxes.py, forks.py, experiments.py, evidence.py,
 *  batch.py, commentary.py. */
const PARTS: readonly [string, string][] = [
  ["The agents", "Each run is one LangChain Deep Agent on Claude Haiku 5.5; a robot batch can alternate it with Sonnet 5.5. "
    + "Its file tools and shell run inside its own Daytona VM, and it keeps its plan as a todo list. "
    + "It has no subagents, since a subagent would be one closed step that cannot be copied, and its history is never "
    + "summarized, so a copy replays exactly what the model saw."],
  ["The sandboxes", "Every VM starts from the lab image, and the task is loaded once it is up. "
    + "The server pulls each run's events and outputs, and scores the hidden cases itself, never inside a VM. "
    + "To copy a run, the server rebuilds it on a fresh VM by replaying its actions up to the cut, then copies that VM "
    + "once for each copy; a copy that cannot be made that way is rebuilt by replay as well. "
    + "The model picks up from the run's own messages, cut at the same point, or from a saved checkpoint that also keeps its plan."],
  ["The investigator", "A Deep Agent on Sonnet 5.5 that plans with a todo list. "
    + "Its helpers are a step tagger for each run, three lenses that look for a step skipped, a step done or something "
    + "in the data, and a skeptic that names the cheapest test that could prove a suspect wrong. "
    + "Where there is code to trace, a code tracer reruns failing code and points at a line. "
    + "It reads the case, the runs and its skills through read-only views, keeps a notebook for each kind of task and a "
    + "casebook across them, and can never read the hidden results or which flaw a batch was built with. "
    + "It records at least two suspects, and each experiment's prediction is saved before any copy starts. "
    + "Plain code, not the model, keeps the score and decides whether a suspect is supported, cleared or still open. "
    + "Every experiment waits for you to approve, edit or reject it, a grader checks the verdict and can send it back "
    + "twice, and a lesson for later agents is saved only once you approve it."],
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
      // `data-keep`: tour.ts owns the ring's place and its lit state, so a repaint leaves them as they are.
      + `<span class="hw-ring" data-how-ring data-keep aria-hidden="true"></span>`
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
    + `<p class="hw-lead">Each agent says how well it did. Orro checks that claim against the truth, names what could explain the gap, and tests it by rewinding a run.</p>`
    + `</header>`
    + `<section class="hw-tour" aria-label="The loop, stop by stop" data-morph-key="how:tour">`
    + rail(i)
    + `<div class="hw-stop${pic ? "" : " is-text"}" data-morph-key="how:stop">`
    + `<div class="hw-stop-l" data-morph-key="how:text:${s ? s.key : START.key}">`
    + `<p class="hw-count">${i + 1} of ${HOW_STOPS}</p>`
    + `<h2 class="hw-h">${esc(s ? s.title : START.title)}</h2><p class="hw-p">${esc(s ? s.text : START.text)}</p>`
    + (s?.key === "verdict" ? HOW_LESSON_LINE : "")
    + `<div class="hw-nav">${back}${next}</div></div>`
    + stage
    + `</div>`
    + note
    + `</section>`
    + underTheHood()
    + `</div>`;
}
