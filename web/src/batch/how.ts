// "How it works" (`#/how`): a diagram of the loop, then the loop in five steps, each a heading, two plain sentences
// and a small picture drawn from a real batch, the robot demo (`robot-demo-batch`), loaded with the same case file
// fetch the batch pages use; then how Orro is built, with a diagram of the harness (how-diagrams.ts). Every picture of
// a result puts a claim next to the truth, the rule of the whole app. Without the case file (still loading, or the
// server could not give it) the steps read as text alone, and the diagrams that need no numbers stay.
//
// It is also the app's first screen for someone new: the first time a person enters the app (the landing's links,
// `#/start`, any app page but a batch's own), main.ts sends them here once (`firstVisitRedirect`), and remembers it
// in this browser (`howSeen`). A link straight to a batch is never sent anywhere.
//
// Pure like every view here: main.ts loads the case and handles the clicks.

import "./how.css";
import type { CaseFile, RunRecord } from "../api";
import { attr, esc } from "../ui";
import { checkedView } from "./checked";
import { forkDiagram, harnessDiagram, loopDiagram } from "./how-diagrams";
import { verdictEvidence, verdictText, forkExperiments, forkOutcome, forkOutcomeText, pickRuns, splitCounts, splitHeadline } from "./lanes";
import { claimBars } from "./overview";
import { pct } from "./format";
import { routeHash, type Loadable, type Route } from "./model";
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

/** 1. Every agent's claim, as it reported it. The truth is the next step's. */
function runPicture(c: CaseFile): string {
  const runs = Object.values(c.runs ?? {}).sort(byId);
  if (!runs.length) return "";
  const words = domainWords(c.config);
  const tiles = runs.map((r) => {
    const has = typeof r.reported_accuracy === "number";
    const v = has ? pct(r.reported_accuracy, 0) : "No claim";
    return `<li class="hw-agent${has ? "" : " is-none"}"><span class="hw-agent-id">${esc(r.id)}</span>`
      + `<span class="hw-agent-v">${esc(v)}</span>${bar("hw-bar--claim", has ? r.reported_accuracy : 0, `${r.id} ${words.claim_label.toLowerCase()} ${v}`)}</li>`;
  }).join("");
  return `<ul class="hw-agents" aria-label="${attr(`${runs.length} agents and what each claimed`)}">${tiles}</ul>`
    + `<p class="hw-cap">${esc(`${words.claim_label}, as each agent reported it. ${words.truth_label} is not known yet.`)}</p>`;
}

/** 2. The batch's claim against its truth, and one run's map of what it checked against what it is judged on. */
function measurePicture(c: CaseFile): string {
  const head = claimHeadline(c);
  const run = pickRuns(c).inflated;
  const map = run ? checkedView(HOW_BATCH, run, c.runs?.[run], c.config) : "";
  if (!head && !map) return "";
  return (head ? `<p class="hw-head">${esc(head)}</p>` : "")
    + `<div class="hw-chart">${claimBars(c)}</div>`
    + (map ? `<div class="hw-map">${map}</div>` : "");
}

/** 3. The step honest runs took and inflated ones skipped, as two counts. */
function stepPicture(c: CaseFile): string {
  const s = c.split;
  if (!s) return "";
  const words = domainWords(c.config);
  const trap = trapOf(c);
  const name = stepText(s.label, words, trap).name;
  const { honest, inflated } = splitHeadline(s, trap, words);
  const did = (rate: number, n: number): number => Math.round(rate * n);
  const row = (who: string, cls: string, rate: number, n: number): string =>
    `<div class="hw-row"><span class="hw-row-n">${esc(who)}</span>${bar(cls, rate, `${did(rate, n)} of ${n} ${who.toLowerCase()}`)}`
    + `<span class="hw-row-v">${did(rate, n)} of ${n}</span></div>`;
  return `<p class="hw-step-name"><span class="hw-tag">The step</span>${esc(capital(name))}</p>`
    + row("Honest runs", "hw-bar--ok", s.honest_rate, s.n_honest)
    + row("Inflated runs", "hw-bar--bad", s.inflated_rate, s.n_inflated)
    + `<p class="hw-cap">${esc(`${honest} ${inflated}`)}</p>`
    + `<span class="hw-sr">${esc(splitCounts(s))}</span>`;
}

/** 4. The fork: an inflated run cut before the step into four arms, each copy marked inflated or honest, and what
 *  the step did to the claim and to the work. */
function forkPicture(c: CaseFile): string {
  const f = forkExperiments(c).find((x) => x.kind !== "fix");
  const o = f ? forkOutcome(f) : null;
  if (!f || !o) return "";
  const words = domainWords(c.config);
  const name = c.split ? stepText(c.split.label, words, trapOf(c)).name : "the step";
  return `<div class="hw-fork">${forkDiagram(name, f.source_run ?? c.split?.fork_run_id ?? null, f)}</div>`
    + `<ul class="hw-keys" aria-hidden="true"><li><i class="hw-sw hw-sw--bad"></i>Copy came out inflated</li><li><i class="hw-sw hw-sw--ok"></i>Copy came out honest</li></ul>`
    + `<p class="hw-head hw-head--sm">${esc(forkOutcomeText(o, words.subject))}</p>`;
}

/** 5. The verdict as the batch words it, and how many pairs of copies it stands on out of the number it needs. */
function verdictPicture(c: CaseFile): string {
  const ev = verdictEvidence(c);
  if (!ev) return "";
  const needed = Math.max(ev.needed, ev.pairs);
  const supported = ev.level === "supported";
  const slots = Array.from({ length: needed }, (_, i) => `<i class="${i < ev.pairs ? "is-on" : ""}"></i>`).join("");
  return `<div class="hw-pairs"><span class="hw-level" data-level="${ev.level}">${supported ? "Supported" : "Open"}</span>`
    + `<span class="hw-slots" role="img" aria-label="${attr(`${ev.pairs} of ${ev.needed} pairs`)}">${slots}</span>`
    + `<span class="hw-row-v">${ev.pairs} of ${ev.needed} pairs</span></div>`
    + `<p class="hw-quote">${esc(verdictText(c))}</p>`;
}

// ── the page ─────────────────────────────────────────────────────────────────

interface Step {
  key: string;
  title: string;
  /** Two plain sentences, true of any batch. The numbers are the picture's. */
  text: string;
  picture: (c: CaseFile) => string;
}

export const HOW_STEPS: readonly Step[] = [
  {
    key: "run", title: "Run",
    text: "Many AI agents get the same task, each in a sandbox of its own. When one finishes, it reports how well its work did.",
    picture: runPicture,
  },
  {
    key: "measure", title: "Measure",
    text: "Orro then scores each agent's work on cases it never saw. An agent whose claim sits well above that truth is marked inflated.",
    picture: measurePicture,
  },
  {
    key: "step", title: "Find the step",
    text: "Orro reads every run's work and looks for a step the honest runs took and the inflated ones skipped. That step is a lead, not yet a cause.",
    picture: stepPicture,
  },
  {
    key: "fork", title: "Fork to test it",
    text: "Orro copies an inflated run just before that step and sends the copies four ways: unchanged, with a step that changes nothing, told about the step, and with the step done. If only the copies that do the step stop overclaiming while the work stays the same, the step is what made the claim too high.",
    picture: forkPicture,
  },
  {
    key: "verdict", title: "The verdict follows the evidence",
    text: "With few pairs of copies the verdict only says the step suggests the cause, and the batch waits in Needs you, where Run more pairs adds more. Orro says caused only once the pairs support it.",
    picture: verdictPicture,
  },
];

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
    + "helper that compares honest and inflated runs, and a code tracer that reruns failing code and points at a line. "
    + "It reads the case, the runs and its skills through read-only views, with a notebook kept for each kind of task, "
    + "and it can never read the hidden results. "
    + "It records what it finds through typed tools, a grader checks its verdict and can send it back twice, and a fork "
    + "request waits until you approve it."],
  ["The live commentary", "A small model, Claude Haiku, captions each run every 20 to 30 seconds from only what that agent did. "
    + "Notable moments go into a feed beside the runs."],
];

function underTheHood(): string {
  return `<section class="hw-hood" aria-labelledby="hw-hood-h" data-morph-key="how:hood">`
    + `<h2 class="hw-h2" id="hw-hood-h">Under the hood</h2>`
    + `<p class="hw-lead">A server runs the agents in sandboxes, scores them where they cannot look, and hands the evidence to an investigator agent.</p>`
    + `<figure class="hw-fig">${harnessDiagram()}</figure>`
    + `<div class="hw-parts">${PARTS.map(([h, p]) => `<div class="hw-part"><h3 class="hw-h3">${esc(h)}</h3><p class="hw-p">${esc(p)}</p></div>`).join("")}</div>`
    + `</section>`;
}

/** The page. `demo` is the robot demo's case file, as far as it has loaded. */
export function howView(demo: Loadable<CaseFile>): string {
  const c = demo.state === "ready" ? demo.value : null;
  const note = demo.state === "loading"
    ? `<p class="hw-note" role="status">Loading the numbers from the robot demo batch…</p>`
    : demo.state === "error"
      ? `<p class="hw-note" role="status">The robot demo batch could not be loaded, so the steps are shown without its numbers.</p>`
      : `<p class="hw-note">${esc(`Every number and picture below comes from a real batch: ${Object.keys(c?.runs ?? {}).length} agents each writing a controller for a robot arm that picks up a can and places it.`)}</p>`;
  const steps = HOW_STEPS.map((s, i) => {
    const pic = c ? s.picture(c) : "";
    return `<li class="hw-step${pic ? "" : " is-text"}" data-morph-key="how:${s.key}">`
      + `<div class="hw-step-l"><span class="hw-n" aria-hidden="true">${i + 1}</span>`
      + `<div><h2 class="hw-h">${esc(s.title)}</h2><p class="hw-p">${esc(s.text)}</p></div></div>`
      + (pic ? `<div class="hw-pic">${pic}</div>` : "")
      + `</li>`;
  }).join("");
  return `<div class="hw" data-morph-key="how">`
    + `<header class="hw-top"><p class="hw-eyebrow">How it works</p>`
    + `<h1 class="hw-title">Orro catches wrong claims, not bad robots.</h1>`
    + `<p class="hw-lead">Each agent says how well it did. Orro checks that claim against the truth, finds the step that made the difference, and tests it.</p>`
    + note + `</header>`
    + `<figure class="hw-fig hw-fig--loop">${loopDiagram()}</figure>`
    + `<ol class="hw-steps" data-morph-list>${steps}</ol>`
    + underTheHood()
    + `<div class="hw-go">`
    + `<a class="ask-btn hw-btn ds-primary" href="${attr(routeHash({ name: "batch", id: HOW_BATCH }))}">See a real batch</a>`
    + `<a class="ask-btn hw-btn" href="${attr(routeHash({ name: "home" }))}" data-how-done>Go to my batches</a>`
    + `</div></div>`;
}
