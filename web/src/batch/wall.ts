// OWNER: subagent B. The wall of runs: one small machine per sandbox VM, all working at once.
//
// One device per run, in id order, inside a keyed list so morph.ts keeps each one as the element it was while statuses
// move. A device, front to back: the screen (the run's id, its cost, and the end of its notebook typing itself out),
// the step it is on, a row of lights (one per todo or stage) and its status key. Once the run is scored the result
// shows on the screen itself, beside the notebook: the gap, reported vs true, the overlap. The drawing is all in wall.css
// (CSS 3D, no canvas), so the notebook in the screen is the real DOM. Markup has no whitespace between tags so
// children pair by index the same way on every render.
import "./wall.css";
import type { AgentTodo, RunRecord, RunStatus } from "../api";
import { activityOf, chartUrl, logOf, notebookCells, notebookTail, stagesOf, type NbCell } from "./notebook";
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
export function stepLabel(run: RunRecord, todos: AgentTodo[] | null, cells: NbCell[] = []): string {
  switch (run.status) {
    case "queued": return "Queued";
    case "starting": return "Starting the VM";
    case "honest":
    case "inflated": return "Done";
    case "failed": return run.reason?.trim() || "Failed";
    case "running": {
      const step = run.step?.trim();
      if (step && step.toLowerCase() !== "done") return step;
      // No todo list (many real runs keep none): name what the latest cell is doing.
      return todos?.find((t) => t.status === "in_progress")?.content ?? activityOf(cells) ?? "Working";
    }
  }
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function pill(status: RunStatus): string {
  const lead = status === "running" || status === "starting" ? askSpinner(11) : `<span class="bw-dot" aria-hidden="true"></span>`;
  return `<span class="bw-pill bw-pill--${status}">${lead}<span>${STATUS_LABEL[status]}</span></span>`;
}

/** The device's screen: the end of the run's notebook, code typing itself out, then its output and charts. */
function picture(vm: BatchVm, run: RunRecord, step: string, cells: NbCell[]): string {
  if (cells.length) {
    return `<div class="bw-pic bw-pic--nb" data-morph-key="nb">${notebookTail(cells, { image: (name) => chartUrl(vm, run.id, name) })}</div>`;
  }
  const text = run.status === "queued" ? "Waiting to start"
    : run.status === "starting" ? "Starting the VM"
    : run.status === "running" ? "Waiting for the first step"
    : run.status === "failed" ? "The run failed"
    : step;
  const lead = run.status === "starting" || run.status === "running" ? askSpinner(14) : askIcon("chart", 18, null, 1.5);
  return `<div class="bw-pic" data-morph-key="ph"><div class="bw-ph">${lead}<span class="bw-ph-t">${esc(truncate(text, 80))}</span></div></div>`;
}

function strip(run: RunRecord, todos: AgentTodo[] | null, cells: NbCell[]): string {
  let segs: string;
  let label: string;
  if (!todos?.length && cells.length && !isScored(run.status)) {
    const stages = stagesOf(cells);
    segs = stages.map((st) => `<span class="bw-seg bw-seg--${st}"></span>`).join("");
    label = `${stages.filter((st) => st === "completed").length} of ${stages.length} stages done`;
  } else if (todos?.length) {
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

/** A bar from 50% to 100% accuracy, so a 13 point gap is a visible length. */
const barWidth = (x: number | null | undefined): number => (x == null || Number.isNaN(x) ? 0 : Math.max(0, Math.min(1, (x - 0.5) / 0.5)) * 100);

function reveal(run: RunRecord): string {
  if (run.status === "failed") {
    const reason = run.reason?.trim() || "The run failed before it was scored.";
    return `<div class="bw-rev bw-rev--failed" title="${attr(reason)}">${esc(truncate(reason, 140))}</div>`;
  }
  if (run.status !== "honest" && run.status !== "inflated") return "";
  const share = run.overlap_share;
  const overlap = share == null ? "Overlap unknown" : `${pct(share, 0)} of test rows were in training`;
  const bar = (label: string, x: number | null | undefined, cls: string): string =>
    `<div class="bw-acc"><span class="bw-k">${label}</span><span class="bw-track" aria-hidden="true"><span class="bw-fill ${cls}" style="width:${barWidth(x).toFixed(1)}%"></span></span><span class="bw-v">${pct(x)}</span></div>`;
  return `<div class="bw-rev">`
    + `<div class="bw-top"><span class="bw-gap">${pts(run.gap)}</span><span class="bw-gap-k">reported vs true</span></div>`
    + bar("Reported", run.reported_accuracy, "bw-fill--rep")
    + bar("True", run.true_accuracy, "bw-fill--true")
    + `<div class="bw-ovl-t">${esc(overlap)}</div>`
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
  const log = logOf(vm, run.id);
  const cells = log ? notebookCells(log) : [];
  // Code is already on screen: the VM is up, whatever the last status update said.
  if (run.status === "starting" && cells.length) run = { ...run, status: "running" };
  const step = stepLabel(run, todos, cells);
  const cost = tileCost(vm, run);
  const label = `Run ${run.id}, ${STATUS_LABEL[run.status].toLowerCase()}. Open the run.`;
  const vmId = run.vm_id && !isScored(run.status) ? `<span class="bw-vm">${esc(run.vm_id.slice(0, 8))}</span>` : "";
  return `<div class="bw-tile bw-tile--${run.status}" data-morph-key="tile:${attr(run.id)}" role="button" tabindex="0" data-act="${ACT.openRun}" data-arg="${attr(run.id)}" aria-label="${attr(label)}">`
    + `<div class="bw-dev">`
    + `<span class="bw-floor" aria-hidden="true"></span>`
    + `<span class="bw-base" aria-hidden="true"></span>`
    + `<div class="bw-body">`
    + `<div class="bw-scr">`
    + `<div class="bw-hd"><span class="bw-id"><span class="bw-lamp" aria-hidden="true"></span>${esc(run.id)}${vmId}</span>${cost ? `<span class="bw-cost">${esc(cost)}</span>` : ""}</div>`
    + `<div class="bw-view">${picture(vm, run, step, cells)}${reveal(run)}</div>`
    + `</div>`
    + `<div class="bw-step${run.status === "failed" ? " bw-step--failed" : ""}" title="${attr(step)}">${esc(truncate(step, 120))}</div>`
    + `<div class="bw-chin">${strip(run, todos, cells)}${pill(run.status)}<span class="bw-key" aria-hidden="true">${askIcon("arrow", 11, null, 2.2)}</span></div>`
    + `</div>`
    + `</div>`
    + `</div>`;
}

/** One device per run: its notebook on the screen, step, lights; once scored, a readout on the screen with reported vs true. */
export function wallView(vm: BatchVm): string {
  const runs = sortedRuns(vm);
  const s = wallSummary(vm);
  const simulated = (vm.case.config as { simulated?: boolean }).simulated === true || vm.case.costs?.simulated === true;
  const head = `<div class="bw-head">`
    + `<p class="bw-sum" aria-live="polite">${esc(summaryLine(s))}</p>`
    + (s.total ? `<div class="bw-mix" aria-hidden="true">${(["honest", "inflated", "failed", "running", "queued"] as const)
      .filter((k) => s[k] > 0).map((k) => `<span class="bw-mix-s bw-mix-s--${k}" data-morph-key="${k}" style="flex-grow:${s[k]}"></span>`).join("")}</div>` : "")
    + (simulated ? `<p class="bw-sim"><strong>Simulated batch:</strong> the agents' choices are scripted, the scores and charts are real</p>` : "")
    + `</div>`;
  const grid = runs.length
    ? `<div class="bw-grid" data-morph-key="grid" data-morph-list>${runs.map((r) => tile(vm, r)).join("")}</div>`
    : `<div class="bw-empty" data-morph-key="empty">Runs appear here once the batch starts.</div>`;
  return `<section class="bw" data-morph-key="wall" aria-label="Runs">${head}${grid}</section>`;
}
