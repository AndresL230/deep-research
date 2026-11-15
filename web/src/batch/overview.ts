// The top of a batch's pages. The first page opens on what the batch came to in one line, the pipeline as steps on a
// folder-shaped line, the numbers as tiles, how many agents are scored as a ring, and every agent's reported accuracy
// against its true one as a row of bars. Every later page (one per stage after the agents) opens on the batch's name
// and the same steps, the one it is on marked; every page ends in a Back / Next bar (`pagerView`). A pure `(vm) => html` view like the others; the look is in overview.css and the motion in
// system.css (motion.ts writes the animated markup).
import "./overview.css";
import type { BatchConfig, CaseFile, RunRecord } from "../api";
import { attr, esc } from "../ui";
import { badge, chip, count, reveal, spinner } from "../motion";
import { pct, pts } from "./format";
import { barShare, forkExperiments, isProblemPhase, pendingForks, phaseText } from "./lanes";
import { ACT, STEP_LABEL, type BatchStep, type BatchVm } from "./model";
import { claimStatus, wallSummary } from "./wall";
import { isMotionBatch, scoreWords } from "../robot/markup";
import { domainWords } from "./words";

// ── the pipeline ─────────────────────────────────────────────────────────────

export type StageState = "pending" | "active" | "done";

export interface Stage {
  /** The page this step is (main.ts `batchBody`): the step's button opens it. */
  key: BatchStep;
  label: string;
  state: StageState;
  /** Its page has something on it yet, so the step can be pressed. */
  there: boolean;
  /** How far along, 0 to 1, when that is known (the agents: scored of total). */
  share: number | null;
}

/** The batch as steps, each not started, working or finished: five always, and a robot batch's diagnosis and fix once it has them. */
export function stages(vm: BatchVm): Stage[] {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  const s = wallSummary(vm);
  const scored = s.honest + s.inflated + s.failed + (s.unclear ?? 0);
  const allScored = s.total > 0 && scored === s.total;
  const exps = forkExperiments(c);
  const fix = c.fix ?? null;
  const pending = pendingForks(c);
  const hasSplit = !!c.split || phase === "no_split";
  const forksOver = exps.length > 0 && exps.every((f) => f.status === "done" || f.status === "stopped");
  const state = (done: boolean, active: boolean): StageState => (done ? "done" : active ? "active" : "pending");
  return [
    { key: "wall", label: STEP_LABEL.wall, state: state(allScored, phase === "running" && s.total > 0), there: true, share: s.total ? scored / s.total : null },
    { key: "split", label: STEP_LABEL.split, state: state(hasSplit, phase === "analyzing"), there: hasSplit, share: null },
    {
      key: "phase", label: STEP_LABEL.phase, there: phase !== "config", share: null,
      state: state(exps.length > 0 || !!c.verdict || ["forking", "forked", "done"].includes(phase), phase === "investigating" || phase === "awaiting_approval"),
    },
    { key: "fork", label: STEP_LABEL.fork, state: state(forksOver && phase !== "forking", phase === "forking" || (exps.length > 0 && !forksOver)), there: !!pending || exps.length > 0, share: null },
    { key: "verdict", label: STEP_LABEL.verdict, state: state(!!c.verdict, phase === "forked"), there: !!c.verdict, share: null },
    ...((c.trace ?? []).length ? [{ key: "diagnosis", label: STEP_LABEL.diagnosis, state: "done", there: true, share: null } as Stage] : []),
    ...(fix ? [{ key: "fix", label: STEP_LABEL.fix, state: state(fix.status === "tested" || fix.status === "rejected", fix.status === "testing"), there: true, share: null } as Stage] : []),
  ];
}

/** The folder line's curve, from its tab down to the line the rest of the row sits on (the reference's own path). */
const CURVE = "M0 .5C14.494 .5 28.559 5.42 39.893 14.455L80.149 46.545C91.483 55.58 105.548 60.5 120.043 60.5";

/** The steps on the folder line, each a button to its page; `current` is the page open. */
function steps(vm: BatchVm, current: BatchStep): string {
  const list = stages(vm);
  const one = (st: Stage, i: number): string => {
    const here = st.key === current;
    const lead = st.state === "done" ? badge("check", 16) : st.state === "active" ? spinner(14) : `<i class="ov-step-box"></i>`;
    const share = st.state === "active" && st.share != null
      ? `<span class="ov-step-p">${count(st.share, "pct0", pct(st.share, 0))}</span>` : "";
    // The line into a step fills when the step before it is finished.
    const line = i > 0 ? `<i class="ov-step-line" data-morph-key="line:${st.key}" style="--p:${list[i - 1].state === "done" ? 1 : 0}"></i>` : "";
    return line + `<button type="button" class="ov-step ov-step--${st.state}${here ? " is-here" : ""}" data-morph-key="step:${st.key}" data-act="${ACT.goto}" data-arg="${st.key}"${here ? ` aria-current="step"` : ""}${st.there ? "" : " disabled"}>`
      + `<span class="ov-step-m" data-morph-key="m:${st.state}">${lead}</span><span class="ov-step-l">${esc(st.label)}</span>${share}</button>`;
  };
  return `<div class="ov-folder" data-io>`
    + `<nav class="ov-steps" aria-label="The batch, step by step" data-morph-list>${list.map(one).join("")}</nav>`
    + `<svg class="ov-curve" width="120" height="61" viewBox="0 0 120 61" aria-hidden="true"><path pathLength="1" d="${CURVE}"></path></svg>`
    + `<span class="ov-folder-r" aria-hidden="true"></span>`
    + `</div>`;
}

// ── the numbers ──────────────────────────────────────────────────────────────

// ── reported against true, one bar per agent ─────────────────────────────────

/** A bar's height, 0 to 100. Accuracy on two classes starts at a coin flip, so those bars run from 50%; a robot's
 *  success rate can be anything, so those run from 0%. */
const barHeight = (x: number | null | undefined, robot: boolean): number =>
  robot ? (x == null || Number.isNaN(x) ? 0 : Number((Math.max(0, Math.min(1, x)) * 100).toFixed(1))) : barShare(x);

function bar(r: RunRecord, i: number, robot: boolean, words: [string, string]): string {
  const st = r.status as string;
  const scored = (st === "honest" || st === "inflated" || st === "unclear") && r.true_accuracy != null && r.reported_accuracy != null;
  const tru = barHeight(r.true_accuracy, robot);
  const rep = barHeight(r.reported_accuracy, robot);
  const over = Math.max(0, rep - tru);
  const title = scored
    ? `${r.id}, ${st}: ${words[0]} ${pct(r.reported_accuracy)}, ${words[1]} ${pct(r.true_accuracy)}`
    : `${r.id}, ${st === "failed" ? "failed" : "not scored yet"}`;
  const col = scored
    ? `<span class="ov-bar-col" data-morph-key="scored">`
      + `<span class="ov-bar-fill ds-grow-y"><i class="ov-bar-true" style="height:${Math.min(rep, tru)}%"></i>`
      + (over >= 0.6 ? `<i class="ov-bar-over" style="bottom:${tru}%;height:${over.toFixed(1)}%"></i>` : "") + `</span>`
      + `<span class="ds-tip" style="bottom:calc(${Math.max(rep, tru)}% + 8px)"><span><b>${esc(r.id)}</b> ${esc(words[0])} ${esc(pct(r.reported_accuracy))}, ${esc(words[1])} ${esc(pct(r.true_accuracy))}</span></span>`
      + `</span>`
    : `<span class="ov-bar-col" data-morph-key="wait"><i class="ov-bar-wait"></i></span>`;
  return `<button type="button" class="ov-bar ov-bar--${scored ? st : "wait"}" data-morph-key="bar:${attr(r.id)}" data-act="${ACT.openRun}" data-arg="${attr(r.id)}" style="--mo-d:${i * 45}ms" aria-label="${attr(`${title}. Open the run.`)}">`
    + col + `<span class="ov-bar-id">${esc(r.id)}</span></button>`;
}

/** The "Claimed against measured" card, one bar per agent. A case file is all it needs, so How it works (how.ts)
 *  draws the same card for the robot demo. Each bar opens its run (ACT.openRun). */
export function claimBars(c: Pick<CaseFile, "runs" | "config">): string {
  const runs = Object.values(c.runs ?? {}).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const threshold = (c.config as Partial<BatchConfig>).inflation_threshold;
  const robot = isMotionBatch(c.config);
  const w = scoreWords(c.config);
  const words: [string, string] = [w.reported.toLowerCase(), w.true.toLowerCase()];
  const body = runs.length
    ? `<div class="ov-bars" data-morph-key="bars" data-morph-list>${runs.map((r, i) => bar(r, i, robot, words)).join("")}</div>`
    : `<p class="ov-none" data-morph-key="none">The bars appear as agents are scored.</p>`;
  return `<div class="ov-card ov-card--bars ds-pop" data-io data-morph-key="bars-card">`
    + `<div class="ov-card-h"><h3 class="ov-card-t">${esc(`${w.reported} vs ${words[1]}`)}</h3>`
    + `<div class="ov-keys"><span><i class="ov-sw ov-sw--true"></i>${esc(w.true)}</span><span><i class="ov-sw ov-sw--over"></i>${esc(`${w.reported} above ${words[1]}`)}</span></div></div>`
    + body
    + `<p class="ov-foot">Scale ${robot ? "0" : "50"}–100%.${threshold != null ? ` Inflated: ${esc(words[0])} ${esc(pts(threshold).replace(/^\+/, ""))} or more above ${esc(words[1])}.` : ""}</p>`
    + `</div>`;
}

// ── the view ─────────────────────────────────────────────────────────────────

/** Phases in which something is working, so the title says what. */
const WORKING = new Set(["running", "analyzing", "investigating", "awaiting_approval", "forking", "forked"]);

/**
 * The title, the batch's one headline. The reason when the batch is blocked; once every agent is in, the claim against
 * the truth ("6 of 12 agents claimed 99%. Measured at 20 positions they never tested: 59%.", wall.ts `claimHeadline`),
 * which stays the title through the investigation, the fork and the verdict while the phase chip says what is working;
 * before that, what is happening.
 */
export function headline(vm: BatchVm): string {
  const phase = String(vm.case.phase ?? "config");
  if (isProblemPhase(phase)) return phaseText(phase);
  const claim = claimStatus(vm.case);
  if (claim) return claim;
  if (WORKING.has(phase)) return phaseText(phase);
  // Rarely reached: everything finished but no run has both numbers to show.
  const s = wallSummary(vm);
  const scored = s.honest + s.inflated + (s.unclear ?? 0);
  if (!scored) return phaseText(phase);
  const w = domainWords(vm.case.config);
  const [said, truth] = [w.claim_label.toLowerCase(), w.truth_label.toLowerCase()];
  if (!s.inflated) {
    if (s.unclear) return `No agent was clearly inflated, ${s.unclear} of ${scored} ${s.unclear === 1 ? "is" : "are"} unclear`;
    return scored === 1 ? `The one scored agent ${said} what was ${truth}` : `All ${scored} scored agents ${said} what was ${truth}`;
  }
  // "of 11 scored agents" when some of the batch's agents failed and so have no score to count.
  return `${s.inflated} of ${scored}${scored < s.total ? " scored" : ""} agents ${said} more than was ${truth}`;
}

/** The phase as a chip beside the batch's name. */
function phaseChip(phase: string): string {
  if (isProblemPhase(phase)) return chip(phase.startsWith("blocked") ? "Blocked" : "Error", "bad", "alert");
  if (WORKING.has(phase)) return chip(phaseText(phase), "live", phase === "awaiting_approval" ? "dot" : "spin");
  if (phase === "done") return chip("Done", "ok", "check");
  return chip(phaseText(phase), "idle", "dot");
}

// ── the pages ────────────────────────────────────────────────────────────────

export interface PageNav {
  /** The page open, and where it is in the list of steps (1-based) of how many. */
  at: number;
  of: number;
  /** The page before, or null on the first. */
  prev: Stage | null;
  /** The next page when it can be opened, else null. */
  next: Stage | null;
  /** When there is no next page yet: the step that comes next, to name it, and why it is not open. */
  waiting: { label: string; why: string } | null;
}

/**
 * Where a page sits among the batch's steps. The first page (the agents) opens onto the next only once every agent
 * is scored; a later page opens onto the next step as soon as that step has something to show.
 */
export function pageNav(vm: BatchVm, current: BatchStep): PageNav {
  const list = stages(vm);
  const i = Math.max(0, list.findIndex((s) => s.key === current));
  const prev = [...list.slice(0, i)].reverse().find((s) => s.there) ?? null;
  const agentsDone = list[0].state === "done";
  const after = list.slice(i + 1);
  const open = current === "wall" && !agentsDone ? undefined : after.find((s) => s.there);
  let waiting: PageNav["waiting"] = null;
  if (!open && after.length) {
    const why = current === "wall" && !agentsDone ? "once every agent is scored"
      : String(vm.case.phase ?? "") === "no_split" || isProblemPhase(String(vm.case.phase ?? "")) ? "if the batch gets there"
        : "once the batch gets there";
    waiting = { label: after[0].label, why };
  }
  return { at: i + 1, of: list.length, prev, next: open ?? null, waiting };
}

const BACK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5"></path></svg>`;
const NEXT = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5"></path></svg>`;

/**
 * The bar at the end of every page: back to the page before, and Next to the page after. While the next page has
 * nothing to show yet, the bar says what comes next and when, with a spinner if the batch is working towards it; the
 * button arrives the moment it can be pressed. On the last page it offers the way back to the start.
 */
export function pagerView(vm: BatchVm, current: BatchStep): string {
  const nav = pageNav(vm, current);
  const prev = nav.prev
    ? `<button type="button" class="pgr-prev" data-act="${ACT.goto}" data-arg="${nav.prev.key}" data-morph-key="prev:${nav.prev.key}"><span class="pgr-ic">${BACK}</span>${esc(nav.prev.label)}</button>`
    : "";
  const phase = String(vm.case.phase ?? "");
  const working = ["running", "analyzing", "investigating", "forking", "forked"].includes(phase);
  let right: string;
  if (nav.next) {
    right = `<button type="button" class="pgr-next ds-primary ds-pop" data-act="${ACT.goto}" data-arg="${nav.next.key}" data-morph-key="next:${nav.next.key}">`
      + `<span class="pgr-next-k">Next</span><span class="pgr-next-l">${esc(nav.next.label)}</span><span class="pgr-ic pgr-go">${NEXT}</span></button>`;
  } else if (nav.waiting) {
    right = `<span class="pgr-wait" data-morph-key="wait:${attr(nav.waiting.label)}">${working ? spinner(14) : `<i class="pgr-wait-box"></i>`}`
      + `<span>Next: <b>${esc(nav.waiting.label)}</b>, ${esc(nav.waiting.why)}</span></span>`;
  } else {
    right = `<button type="button" class="pgr-prev pgr-again" data-act="${ACT.goto}" data-arg="wall" data-morph-key="again">That is the whole batch. Back to the agents</button>`;
  }
  return `<nav class="pgr" aria-label="Pages of this batch" data-io>`
    + `<div class="pgr-l">${prev}</div>`
    + `<div class="pgr-r"><span class="pgr-n">${nav.at} of ${nav.of}</span>${right}</div>`
    + `</nav>`;
}

/** A later page's head: the batch's name and state, and the steps with this page's marked. */
export function pageHeadView(vm: BatchVm, current: BatchStep): string {
  return `<section class="ov ov--page" data-morph-key="ov-page" aria-label="${attr(`${vm.id}, ${STEP_LABEL[current]}`)}">`
    + `<div class="ds-aurora" aria-hidden="true"><i></i><i></i><i></i></div>`
    + `<header class="ov-head ov-head--page" data-io>${eyebrows(vm)}</header>`
    + steps(vm, current)
    + `</section>`;
}

/** A later page whose stage the batch has not reached: what will be here, and when. */
export function notYetView(vm: BatchVm, current: BatchStep): string {
  const nav = pageNav(vm, current);
  return `<div class="pg-yet ds-rise" data-io>`
    + `<span class="ds-eyebrow">${esc(STEP_LABEL[current])}</span>`
    + `<p class="pg-yet-t">${reveal(`Nothing here yet`)}</p>`
    + `<p class="pg-yet-s">${esc(`The ${STEP_LABEL[current].toLowerCase()} appears here once the batch gets there.`)}</p>`
    + (nav.prev ? `<button type="button" class="pgr-prev" data-act="${ACT.goto}" data-arg="${nav.prev.key}"><span class="pgr-ic">${BACK}</span>${esc(nav.prev.label)}</button>` : "")
    + `</div>`;
}

/** The chips over a page's title: the batch's name, saved or live, and its phase. */
function eyebrows(vm: BatchVm): string {
  const phase = String(vm.case.phase ?? "config");
  const kind = vm.live ? chip("Live", "live", "dot") : chip("Saved batch", "idle", "dot");
  // A simulated batch says so once, in the page header (home.ts costBar).
  return `<div class="ov-eyebrows"><span class="ds-eyebrow">Batch <b>${esc(vm.id)}</b></span>${kind}${phaseChip(phase)}</div>`;
}

export function overviewView(vm: BatchVm): string {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  return `<section class="ov" data-morph-key="ov" aria-label="Overview">`
    + `<div class="ds-aurora" aria-hidden="true"><i></i><i></i><i></i></div>`
    + `<header class="ov-head" data-io>`
    + eyebrows(vm)
    + `<h1 class="ov-title${isProblemPhase(phase) ? " ov-title--bad" : ""}" data-morph-key="title">${reveal(headline(vm))}</h1>`
    + `</header>`
    + steps(vm, "wall")
    + claimBars(vm.case)
    + `</section>`;
}
