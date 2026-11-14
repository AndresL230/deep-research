// OWNER: subagent B. The wall of run tiles: the Running and Reveal states.
//
// One tile per run, in id order, inside a keyed list so morph.ts keeps each tile (and a live lab iframe in it) as the
// element it was while statuses move. Each tile, top to bottom: header (id, status pill), the picture (lab page,
// chart, or a placeholder), the step label, a progress strip from the todos, then the reveal once the run is scored,
// and its cost. Markup has no whitespace between tags so children pair by index the same way on every render.
import "./wall.css";
import { batchFileUrl, labPageUrl, type AgentTodo, type RunRecord, type RunStatus } from "../api";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { pct, pts, tokens, usd } from "./format";
import { ACT, type BatchVm } from "./model";

export interface WallSummary {
  total: number;
  honest: number;
  inflated: number;
  failed: number;
  /** Starting or running. */
  running: number;
  queued: number;
}

const SCORED: ReadonlySet<RunStatus> = new Set(["honest", "inflated", "failed"]);
const isScored = (s: RunStatus): boolean => SCORED.has(s);

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued", starting: "Starting", running: "Running", honest: "Honest", inflated: "Inflated", failed: "Failed",
};

/** Runs in id order ("r02" before "r10"). */
export function sortedRuns(vm: BatchVm): RunRecord[] {
  return Object.values(vm.case.runs ?? {}).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Counts by status, for the line above the grid. */
export function wallSummary(vm: BatchVm): WallSummary {
  const s: WallSummary = { total: 0, honest: 0, inflated: 0, failed: 0, running: 0, queued: 0 };
  for (const r of Object.values(vm.case.runs ?? {})) {
    s.total++;
    if (r.status === "honest") s.honest++;
    else if (r.status === "inflated") s.inflated++;
    else if (r.status === "failed") s.failed++;
    else if (r.status === "queued") s.queued++;
    else s.running++;
  }
  return s;
}

/** "12 runs: 6 honest, 6 inflated, 0 failed" once every run is scored, else "4 of 12 running, 3 scored". */
export function summaryLine(s: WallSummary): string {
  if (s.total === 0) return "No runs yet";
  if (s.running + s.queued === 0) {
    return `${s.total} ${s.total === 1 ? "run" : "runs"}: ${s.honest} honest, ${s.inflated} inflated, ${s.failed} failed`;
  }
  return `${s.running} of ${s.total} running, ${s.honest + s.inflated + s.failed} scored`;
}

/** The run's todos: its own, else the latest `todos` event in its loaded log. */
export function runTodos(vm: BatchVm, run: RunRecord): AgentTodo[] | null {
  if (run.todos?.length) return run.todos;
  const evs = vm.events[run.id];
  if (!evs) return null;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === "todos") return e.todos;
  }
  return null;
}

/** The step label under the picture. */
export function stepLabel(run: RunRecord, todos: AgentTodo[] | null): string {
  switch (run.status) {
    case "queued": return "Queued";
    case "starting": return "Starting the VM";
    case "honest":
    case "inflated": return "Done";
    case "failed": return run.reason?.trim() || "Failed";
    case "running": {
      const step = run.step?.trim();
      if (step && step.toLowerCase() !== "done") return step;
      return todos?.find((t) => t.status === "in_progress")?.content ?? "Working";
    }
  }
}

/** Which chart to show, or null. Live batches: the latest. Replays: only what had happened by now. */
export function tileChart(vm: BatchVm, run: RunRecord, todos: AgentTodo[] | null): string | null {
  const charts = run.charts ?? [];
  if (!charts.length) return null;
  if (!vm.replay || isScored(run.status)) return charts[charts.length - 1];
  const progressed = run.status === "running" && (
    (todos?.some((t) => t.status === "completed") ?? false) ||
    (run.n_actions ?? 0) > 0 ||
    (vm.events[run.id]?.some((e) => e.type === "tool_result") ?? false)
  );
  return progressed ? charts[0] : null;
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function pill(status: RunStatus): string {
  const lead = status === "running" || status === "starting" ? askSpinner(11) : `<span class="bw-dot" aria-hidden="true"></span>`;
  return `<span class="bw-pill bw-pill--${status}">${lead}<span>${STATUS_LABEL[status]}</span></span>`;
}

function picture(vm: BatchVm, run: RunRecord, todos: AgentTodo[] | null, step: string): string {
  if (run.lab_url) {
    // Through our proxy, not the raw preview URL: Daytona would show its warning page in every tile.
    const src = labPageUrl(vm.id, run.id);
    return `<div class="bw-pic bw-pic--lab"><iframe data-morph-key="lab:${attr(run.vm_id ?? run.id)}" class="bw-frame" src="${attr(src)}" title="${attr(`Lab page of run ${run.id}`)}" sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer" tabindex="-1"></iframe></div>`;
  }
  const chart = tileChart(vm, run, todos);
  if (chart) {
    const src = batchFileUrl(vm.id, chart);
    return `<div class="bw-pic"><img data-morph-key="img:${attr(src)}" class="bw-img" src="${attr(src)}" alt="${attr(`Latest chart of run ${run.id}`)}" loading="lazy" decoding="async"></div>`;
  }
  const quiet = run.status === "queued" || (vm.replay !== null && (run.charts?.length ?? 0) > 0);
  const text = quiet ? (run.status === "queued" ? "Waiting to start" : "No chart yet") : step;
  return `<div class="bw-pic"><div data-morph-key="ph" class="bw-ph">${askIcon("chart", 18, null, 1.5)}<span class="bw-ph-t">${esc(truncate(text, 80))}</span></div></div>`;
}

function strip(run: RunRecord, todos: AgentTodo[] | null): string {
  let segs: string;
  let label: string;
  if (todos?.length) {
    const done = todos.filter((t) => t.status === "completed").length;
    segs = todos.map((t) => `<span class="bw-seg bw-seg--${t.status}"></span>`).join("");
    label = `${done} of ${todos.length} steps done`;
  } else if (isScored(run.status)) {
    segs = `<span class="bw-seg bw-seg--completed"></span>`;
    label = "Finished";
  } else {
    segs = `<span class="bw-seg bw-seg--pending"></span>`;
    label = "No steps yet";
  }
  return `<div class="bw-strip" role="img" aria-label="${attr(label)}">${segs}</div>`;
}

function reveal(run: RunRecord): string {
  if (run.status === "failed") {
    const reason = run.reason?.trim() || "The run failed before it was scored.";
    return `<div class="bw-rev bw-rev--failed" title="${attr(reason)}">${esc(truncate(reason, 140))}</div>`;
  }
  if (run.status !== "honest" && run.status !== "inflated") return "";
  const share = run.overlap_share;
  const width = share == null || Number.isNaN(share) ? 0 : Math.max(0, Math.min(1, share)) * 100;
  const overlap = share == null ? "Overlap unknown" : `${pct(share, 0)} of test rows were in training`;
  return `<div class="bw-rev">`
    + `<div class="bw-nums">`
    + `<div class="bw-num"><span class="bw-k">Reported</span><span class="bw-v">${pct(run.reported_accuracy)}</span></div>`
    + `<div class="bw-num"><span class="bw-k">True</span><span class="bw-v">${pct(run.true_accuracy)}</span></div>`
    + `<div class="bw-num"><span class="bw-k">Gap</span><span class="bw-v bw-gap">${pts(run.gap)}</span></div>`
    + `</div>`
    + `<div class="bw-ovl"><div class="bw-bar" aria-hidden="true"><span class="bw-fill" style="width:${width.toFixed(1)}%"></span></div><span class="bw-ovl-t">${esc(overlap)}</span></div>`
    + `</div>`;
}

/** "$0.42", or tokens when the price is unknown; null when nothing is known. */
export function tileCost(vm: BatchVm, run: RunRecord): string | null {
  const scope = vm.case.costs?.scopes?.[`run:${run.id}`];
  if (scope) {
    if (typeof scope.total_usd === "number") return usd(scope.total_usd);
    return `${tokens(scope.input_tokens + scope.output_tokens)} tokens`;
  }
  if (run.tokens) return `${tokens(run.tokens.input + run.tokens.output)} tokens`;
  return null;
}

function tile(vm: BatchVm, run: RunRecord): string {
  const todos = runTodos(vm, run);
  const step = stepLabel(run, todos);
  const cost = tileCost(vm, run);
  const label = `Run ${run.id}, ${STATUS_LABEL[run.status].toLowerCase()}. Open the run.`;
  return `<div class="bw-tile bw-tile--${run.status}" data-morph-key="tile:${attr(run.id)}" role="button" tabindex="0" data-act="${ACT.openRun}" data-arg="${attr(run.id)}" aria-label="${attr(label)}">`
    + `<div class="bw-hd"><span class="bw-id">${esc(run.id)}</span>${pill(run.status)}</div>`
    + picture(vm, run, todos, step)
    + `<div class="bw-step${run.status === "failed" ? " bw-step--failed" : ""}" title="${attr(step)}">${esc(truncate(step, 120))}</div>`
    + strip(run, todos)
    + reveal(run)
    + (cost ? `<div class="bw-cost">${esc(cost)}</div>` : "")
    + `</div>`;
}

/** One tile per run: lab page or charts, step label, progress strip; once scored, reported vs true and overlap. */
export function wallView(vm: BatchVm): string {
  const runs = sortedRuns(vm);
  const s = wallSummary(vm);
  const simulated = (vm.case.config as { simulated?: boolean }).simulated === true || vm.case.costs?.simulated === true;
  const head = `<div class="bw-head">`
    + `<p class="bw-sum" aria-live="polite">${esc(summaryLine(s))}</p>`
    + (simulated ? `<p class="bw-sim"><strong>Simulated batch:</strong> the agents' choices are scripted, the scores and charts are real</p>` : "")
    + `</div>`;
  const grid = runs.length
    ? `<div class="bw-grid" data-morph-key="grid" data-morph-list>${runs.map((r) => tile(vm, r)).join("")}</div>`
    : `<div class="bw-empty" data-morph-key="empty">Runs appear here once the batch starts.</div>`;
  return `<section class="bw" data-morph-key="wall" aria-label="Runs">${head}${grid}</section>`;
}
