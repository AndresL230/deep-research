// The top of a batch's page: what the batch is doing in one line, the pipeline as steps on a folder-shaped line, the
// numbers as tiles, how many agents are scored as a ring, and every agent's reported accuracy against its true one
// as a row of bars. A pure `(vm) => html` view like the others; the look is in overview.css and the motion in
// system.css (motion.ts writes the animated markup).
import "./overview.css";
import type { BatchConfig, RunRecord } from "../api";
import { attr, esc } from "../ui";
import { badge, chip, count, reveal, spinner } from "../motion";
import { pct, pts, tokens, usd } from "./format";
import { costGroups } from "./home";
import { barShare, forkExperiments, isProblemPhase, isSimulated, pendingForks, phaseText, scoreStats } from "./lanes";
import { ACT, type BatchVm } from "./model";
import { sortedRuns, wallSummary } from "./wall";

// ── the pipeline ─────────────────────────────────────────────────────────────

export type StageState = "pending" | "active" | "done";

export interface Stage {
  /** The page section this step is (main.ts `batchBody`): the step's button scrolls to it. */
  key: "wall" | "split" | "phase" | "fork" | "verdict";
  label: string;
  state: StageState;
  /** Its section is on the page, so the step can be pressed. */
  there: boolean;
  /** How far along, 0 to 1, when that is known (the agents: scored of total). */
  share: number | null;
}

/** The batch as five steps, each not started, working or finished. */
export function stages(vm: BatchVm): Stage[] {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  const s = wallSummary(vm);
  const scored = s.honest + s.inflated + s.failed;
  const allScored = s.total > 0 && scored === s.total;
  const exps = forkExperiments(c);
  const pending = pendingForks(c);
  const hasSplit = !!c.split || phase === "no_split";
  const forksOver = exps.length > 0 && exps.every((f) => f.status === "done" || f.status === "stopped");
  const state = (done: boolean, active: boolean): StageState => (done ? "done" : active ? "active" : "pending");
  return [
    { key: "wall", label: "Agents", state: state(allScored, phase === "running" && s.total > 0), there: true, share: s.total ? scored / s.total : null },
    { key: "split", label: "What changed", state: state(hasSplit, phase === "analyzing"), there: hasSplit, share: null },
    {
      key: "phase", label: "Investigator", there: phase !== "config", share: null,
      state: state(exps.length > 0 || !!c.verdict || ["forking", "forked", "done"].includes(phase), phase === "investigating" || phase === "awaiting_approval"),
    },
    { key: "fork", label: "Fork", state: state(forksOver && phase !== "forking", phase === "forking" || (exps.length > 0 && !forksOver)), there: !!pending || exps.length > 0, share: null },
    { key: "verdict", label: "Verdict", state: state(!!c.verdict, phase === "forked"), there: !!c.verdict, share: null },
  ];
}

/** The folder line's curve, from its tab down to the line the rest of the row sits on (the reference's own path). */
const CURVE = "M0 .5C14.494 .5 28.559 5.42 39.893 14.455L80.149 46.545C91.483 55.58 105.548 60.5 120.043 60.5";

function steps(vm: BatchVm): string {
  const list = stages(vm);
  const one = (st: Stage, i: number): string => {
    const lead = st.state === "done" ? badge("check", 16) : st.state === "active" ? spinner(14) : `<i class="ov-step-box"></i>`;
    const share = st.state === "active" && st.share != null
      ? `<span class="ov-step-p">${count(st.share, "pct0", pct(st.share, 0))}</span>` : "";
    // The line into a step fills when the step before it is finished.
    const line = i > 0 ? `<i class="ov-step-line" data-morph-key="line:${st.key}" style="--p:${list[i - 1].state === "done" ? 1 : 0}"></i>` : "";
    return line + `<button type="button" class="ov-step ov-step--${st.state}" data-morph-key="step:${st.key}" data-act="${ACT.goto}" data-arg="${st.key}"${st.there ? "" : " disabled"}>`
      + `<span class="ov-step-m" data-morph-key="m:${st.state}">${lead}</span><span class="ov-step-l">${esc(st.label)}</span>${share}</button>`;
  };
  return `<div class="ov-folder" data-io>`
    + `<nav class="ov-steps" aria-label="The batch, step by step" data-morph-list>${list.map(one).join("")}</nav>`
    + `<svg class="ov-curve" width="120" height="61" viewBox="0 0 120 61" aria-hidden="true"><path pathLength="1" d="${CURVE}"></path></svg>`
    + `<span class="ov-folder-r" aria-hidden="true"></span>`
    + `</div>`;
}

// ── the numbers ──────────────────────────────────────────────────────────────

function tile(key: string, label: string, value: string, sub: string, hi = false): string {
  return `<div class="ov-kpi${hi ? " ov-kpi--hi" : ""} ds-pop" data-io data-morph-key="kpi:${key}">`
    + `<span class="ov-kpi-k">${esc(label)}</span><span class="ov-kpi-v">${value}</span><span class="ov-kpi-s">${esc(sub)}</span></div>`;
}

function tiles(vm: BatchVm): string {
  const c = vm.case;
  const s = wallSummary(vm);
  const runs = Object.values(c.runs ?? {});
  const gap = scoreStats(runs.filter((r) => r.status === "inflated")).gap;
  const working = s.running + s.queued;
  const groups = costGroups(c.costs ?? {});
  const tok = groups.reduce((n, g) => n + g.tokens, 0);
  const simulated = isSimulated(c);
  const dollars = !simulated && c.costs?.prices_missing !== true && c.costs?.spent_usd != null;
  const budget = c.costs?.budget_usd;
  const cost = dollars
    ? tile("cost", "Spent", count(c.costs.spent_usd, "usd", usd(c.costs.spent_usd)), budget != null ? `of a ${usd(budget)} budget` : `${tokens(tok)} tokens`)
    : tile("cost", "Tokens", count(tok, "tokens", tokens(tok)), simulated ? "simulated, so no real spend" : tok ? "prices missing" : "nothing spent yet");
  return `<div class="ov-kpis">`
    + tile("agents", "Agents", count(s.total, "int", String(s.total)), !s.total ? "none started yet" : working ? `${s.running} working, ${s.queued} waiting` : "all scored")
    + tile("honest", "Honest", count(s.honest, "int", String(s.honest)), "reported what they scored")
    + tile("inflated", "Inflated", count(s.inflated, "int", String(s.inflated)), "reported more than they scored", true)
    + tile("gap", "Mean inflation", count(gap, "pts", pts(gap)), "reported minus true, inflated runs")
    + cost
    + `</div>`;
}

// ── scored so far ────────────────────────────────────────────────────────────

function ring(vm: BatchVm): string {
  const s = wallSummary(vm);
  const scored = s.honest + s.inflated + s.failed;
  const share = s.total ? (scored / s.total) * 100 : 0;
  const rows: [string, string, number][] = [
    ["honest", "Honest", s.honest], ["inflated", "Inflated", s.inflated], ["failed", "Failed", s.failed],
    ["running", "Working", s.running], ["queued", "Waiting", s.queued],
  ];
  return `<div class="ov-card ov-card--ring ds-pop" data-io data-morph-key="ring">`
    + `<div class="ov-card-h"><h3 class="ov-card-t">Agents scored</h3><span class="ov-card-s">${esc(s.total ? `of ${s.total}` : "none yet")}</span></div>`
    + `<div class="ov-ring-row">`
    + `<div class="ov-ring" role="img" aria-label="${attr(`${scored} of ${s.total} agents scored`)}">`
    + `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ov-ring-t" cx="60" cy="60" r="50"></circle>`
    + `<circle class="ov-ring-p" cx="60" cy="60" r="50" pathLength="100" style="stroke-dasharray:${share.toFixed(2)} 100"></circle></svg>`
    + `<div class="ov-ring-n">${count(scored, "int", String(scored), { linear: true })}<small>scored</small></div>`
    + `</div>`
    + `<ul class="ov-legend">${rows.map(([k, label, n], i) =>
      `<li style="--i:${i}"><i class="ov-sw ov-sw--${k}"></i><span>${label}</span><b>${count(n, "int", String(n))}</b></li>`).join("")}</ul>`
    + `</div></div>`;
}

// ── reported against true, one bar per agent ─────────────────────────────────

function bar(r: RunRecord, i: number): string {
  const scored = (r.status === "honest" || r.status === "inflated") && r.true_accuracy != null && r.reported_accuracy != null;
  const tru = barShare(r.true_accuracy);
  const rep = barShare(r.reported_accuracy);
  const over = Math.max(0, rep - tru);
  const title = scored
    ? `${r.id}, ${r.status}: reported ${pct(r.reported_accuracy)}, true ${pct(r.true_accuracy)}`
    : `${r.id}, ${r.status === "failed" ? "failed" : "not scored yet"}`;
  const col = scored
    ? `<span class="ov-bar-col" data-morph-key="scored">`
      + `<span class="ov-bar-fill ds-grow-y"><i class="ov-bar-true" style="height:${Math.min(rep, tru)}%"></i>`
      + (over >= 0.6 ? `<i class="ov-bar-over" style="bottom:${tru}%;height:${over.toFixed(1)}%"></i>` : "") + `</span>`
      + `<span class="ds-tip" style="bottom:calc(${Math.max(rep, tru)}% + 8px)"><span><b>${esc(r.id)}</b> reported ${esc(pct(r.reported_accuracy))}, true ${esc(pct(r.true_accuracy))}</span></span>`
      + `</span>`
    : `<span class="ov-bar-col" data-morph-key="wait"><i class="ov-bar-wait"></i></span>`;
  return `<button type="button" class="ov-bar ov-bar--${scored ? r.status : "wait"}" data-morph-key="bar:${attr(r.id)}" data-act="${ACT.openRun}" data-arg="${attr(r.id)}" style="--mo-d:${i * 45}ms" aria-label="${attr(`${title}. Open the run.`)}">`
    + col + `<span class="ov-bar-id">${esc(r.id)}</span></button>`;
}

function bars(vm: BatchVm): string {
  const runs = sortedRuns(vm);
  const threshold = (vm.case.config as Partial<BatchConfig>).inflation_threshold;
  const body = runs.length
    ? `<div class="ov-bars" data-morph-key="bars" data-morph-list>${runs.map(bar).join("")}</div>`
    : `<p class="ov-none" data-morph-key="none">The bars appear as agents are scored.</p>`;
  return `<div class="ov-card ov-card--bars ds-pop" data-io data-morph-key="bars-card">`
    + `<div class="ov-card-h"><h3 class="ov-card-t">Reported against true accuracy</h3>`
    + `<div class="ov-keys"><span><i class="ov-sw ov-sw--true"></i>True</span><span><i class="ov-sw ov-sw--over"></i>Reported above true</span></div></div>`
    + body
    + `<p class="ov-foot">One bar per agent, from 50% to 100%.${threshold != null ? ` A run counts as inflated when it reports ${esc(pts(threshold).replace(/^\+/, ""))} or more above its true score.` : ""}</p>`
    + `</div>`;
}

// ── the view ─────────────────────────────────────────────────────────────────

/** Phases in which something is working, so the title says what. */
const WORKING = new Set(["running", "analyzing", "investigating", "awaiting_approval", "forking", "forked"]);

/**
 * The title: what is happening while something is, the reason when the batch is blocked, and otherwise what the
 * scored agents came to.
 */
export function headline(vm: BatchVm): string {
  const phase = String(vm.case.phase ?? "config");
  if (WORKING.has(phase) || isProblemPhase(phase)) return phaseText(phase);
  const s = wallSummary(vm);
  const scored = s.honest + s.inflated;
  if (!scored) return phaseText(phase);
  if (!s.inflated) return scored === 1 ? "The one scored agent reported what it scored" : `All ${scored} scored agents reported what they scored`;
  return `${s.inflated} of ${scored} agents reported more than they scored`;
}

/** The phase as a chip beside the batch's name. */
function phaseChip(phase: string): string {
  if (isProblemPhase(phase)) return chip(phase.startsWith("blocked") ? "Blocked" : "Error", "bad", "alert");
  if (WORKING.has(phase)) return chip(phaseText(phase), "live", phase === "awaiting_approval" ? "dot" : "spin");
  if (phase === "done") return chip("Done", "ok", "check");
  return chip(phaseText(phase), "idle", "dot");
}

/** One line under the title: what the batch is. */
function lede(vm: BatchVm): string {
  const n = Object.keys(vm.case.runs ?? {}).length;
  if (!n) return "Agents appear here once the batch starts.";
  return `${n} ${n === 1 ? "agent" : "agents"} on the same task, each in its own sandbox. Orro scores every one, finds the step that separates the honest runs from the inflated ones, and forks a run to prove it.`;
}

export function overviewView(vm: BatchVm): string {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  const kind = vm.live ? chip("Live", "live", "dot") : chip("Saved batch", "idle", "dot");
  const sim = isSimulated(c) ? chip("Simulated", "warn", "dot") : "";
  return `<section class="ov" data-morph-key="ov" aria-label="Overview">`
    + `<div class="ds-aurora" aria-hidden="true"><i></i><i></i><i></i></div>`
    + `<header class="ov-head" data-io>`
    + `<div class="ov-eyebrows"><span class="ds-eyebrow">Batch <b>${esc(vm.id)}</b></span>${kind}${sim}${phaseChip(phase)}</div>`
    + `<h1 class="ov-title${isProblemPhase(phase) ? " ov-title--bad" : ""}">${reveal(headline(vm))}</h1>`
    + `<p class="ov-sub">${esc(lede(vm))}</p>`
    + `</header>`
    + steps(vm)
    + tiles(vm)
    + `<div class="ov-cards">${ring(vm)}${bars(vm)}</div>`
    + `</section>`;
}
