// OWNER: subagent B. The wall of run tiles: the Running and Reveal states.
//
// One tile per run, in id order, inside a keyed list so morph.ts keeps each tile (and a live lab iframe in it) as the
// element it was while statuses move. Each tile, top to bottom: header (id, status pill), the picture (lab page,
// chart, or a placeholder), the step label, a progress strip from the todos, then the reveal once the run is scored,
// and its cost. Markup has no whitespace between tags so children pair by index the same way on every render.
import "./wall.css";
import type { AgentTodo, RunRecord, RunStatus, TrapInfo } from "../api";
import { activityOf, chartUrl, logOf, notebookCells, notebookTail, stagesOf, type NbCell } from "./notebook";
import { evidenceParts, trapOf } from "./trap";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { pct, pts, tokens, usd } from "./format";
import { ACT, type BatchVm } from "./model";
import { isMotionBatch, robotThumb, scoreWords } from "../robot/markup";
import "../robot/mount";

export interface WallSummary {
  total: number;
  honest: number;
  inflated: number;
  failed: number;
  /** Robot runs between the two thresholds. Only set when there are some. */
  unclear?: number;
  /** Starting or running. */
  running: number;
  queued: number;
}

/** A status as the wall shows it. "unclear" (robot only: finished, its gap between the domain's two thresholds) is
 *  named here as well as in the API's RunStatus, so the wall draws it whichever side lands first. */
type Status = RunStatus | "unclear";

const SCORED: ReadonlySet<Status> = new Set(["honest", "inflated", "unclear", "failed"]);
const isScored = (s: Status): boolean => SCORED.has(s);

const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued", starting: "Starting", running: "Running", honest: "Honest", inflated: "Inflated", unclear: "Unclear", failed: "Failed",
};

/** Runs in id order ("r02" before "r10"). */
export function sortedRuns(vm: BatchVm): RunRecord[] {
  return Object.values(vm.case.runs ?? {}).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Counts by status, for the line above the grid. */
export function wallSummary(vm: BatchVm): WallSummary {
  const s: WallSummary = { total: 0, honest: 0, inflated: 0, failed: 0, running: 0, queued: 0 };
  for (const r of Object.values(vm.case.runs ?? {})) {
    const st = r.status as Status;
    s.total++;
    if (st === "honest") s.honest++;
    else if (st === "inflated") s.inflated++;
    else if (st === "failed") s.failed++;
    else if (st === "unclear") s.unclear = (s.unclear ?? 0) + 1;
    else if (st === "queued") s.queued++;
    else s.running++;
  }
  return s;
}

/** "12 runs: 6 honest, 6 inflated, 0 failed" once every run is scored, else "4 of 12 running, 3 scored". */
export function summaryLine(s: WallSummary): string {
  if (s.total === 0) return "No runs yet";
  if (s.running + s.queued === 0) {
    const unclear = s.unclear ? `, ${s.unclear} unclear` : "";
    return `${s.total} ${s.total === 1 ? "run" : "runs"}: ${s.honest} honest, ${s.inflated} inflated${unclear}, ${s.failed} failed`;
  }
  return `${s.running} of ${s.total} running, ${s.honest + s.inflated + (s.unclear ?? 0) + s.failed} scored`;
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
  const st = run.status as Status;
  switch (st) {
    case "queued": return "Queued";
    case "starting": return "Starting the VM";
    case "honest":
    case "inflated":
    case "unclear": return "Done";
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

function pill(status: Status): string {
  const lead = status === "running" || status === "starting" ? askSpinner(11) : `<span class="bw-dot" aria-hidden="true"></span>`;
  return `<span class="bw-pill bw-pill--${status}">${lead}<span>${STATUS_LABEL[status]}</span></span>`;
}

/** The tile's screen: the end of the run's notebook, code typing itself out, then its output and charts. */
function picture(vm: BatchVm, run: RunRecord, step: string, cells: NbCell[]): string {
  // A robot run that has recorded its episodes: the arm moving, its last episode on a loop.
  const motion = run.motion_files ?? [];
  if (isMotionBatch(vm.case.config) && motion.length) {
    return `<div class="bw-pic bw-pic--robot" data-morph-key="robot">${robotThumb(vm.id, motion[motion.length - 1])}</div>`;
  }
  if (cells.length) {
    return `<div class="bw-pic bw-pic--nb" data-morph-key="nb">${notebookTail(cells, { image: (name) => chartUrl(vm, run.id, name) })}</div>`;
  }
  const text = run.status === "queued" ? "Waiting to start"
    : run.status === "starting" ? "Starting the VM"
    : run.status === "running" ? "Waiting for the first step"
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

function reveal(run: RunRecord, trap: TrapInfo | null, config: unknown): string {
  const motion = isMotionBatch(config);
  const w = scoreWords(config);
  const st = run.status as Status;
  if (st === "failed") {
    const reason = run.reason?.trim() || "The run failed before it was scored.";
    return `<div class="bw-rev bw-rev--failed" title="${attr(reason)}">${esc(truncate(reason, 140))}</div>`;
  }
  // An unclear run has its numbers too: they are why it is neither honest nor inflated.
  if (st !== "honest" && st !== "inflated" && st !== "unclear") return "";
  // The trap's evidence sentence. Left out when the run has no number or the trap has none to give.
  // A robot run's overlap share is the share of the can positions it tried that were the practice spot.
  const ev = evidenceParts(run.overlap_share, trap, motion ? "of tested can positions were the practice spot" : "of test rows were in training");
  const bar = (label: string, title: string, x: number | null | undefined, cls: string): string =>
    `<div class="bw-acc" title="${attr(title)}"><span class="bw-k">${esc(label)}</span><span class="bw-track" aria-hidden="true"><span class="bw-fill ${cls}" style="width:${barWidth(x).toFixed(1)}%"></span></span><span class="bw-v">${pct(x)}</span></div>`;
  return `<div class="bw-rev${motion ? " bw-rev--robot" : ""}">`
    + bar(w.reported, w.reportedTitle, run.reported_accuracy, "bw-fill--rep")
    + bar(w.true, w.trueTitle, run.true_accuracy, "bw-fill--true")
    + `<div class="bw-foot"><span class="bw-gap" title="${attr(w.gapTitle)}">${pts(run.gap)}${w.gapSuffix(run.gap)}</span>${ev ? `<span class="bw-ovl-t">${esc(`${ev.share} ${ev.text}`)}</span>` : ""}</div>`
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
  return `<div class="bw-tile bw-tile--${run.status}" data-morph-key="tile:${attr(run.id)}" role="button" tabindex="0" data-act="${ACT.openRun}" data-arg="${attr(run.id)}" aria-label="${attr(label)}">`
    + `<div class="bw-hd"><span class="bw-id">${esc(run.id)}</span>${pill(run.status)}</div>`
    + picture(vm, run, step, cells)
    + `<div class="bw-step${run.status === "failed" ? " bw-step--failed" : ""}" title="${attr(step)}">${esc(truncate(step, 120))}</div>`
    + strip(run, todos, cells)
    + reveal(run, trapOf(vm.case), vm.case.config)
    + (cost ? `<div class="bw-cost">${esc(cost)}</div>` : "")
    + `</div>`;
}

/** One tile per run: its notebook, step label, progress strip; once scored, reported vs true and overlap. */
export function wallView(vm: BatchVm): string {
  const runs = sortedRuns(vm);
  const s = wallSummary(vm);
  const simulated = (vm.case.config as { simulated?: boolean }).simulated === true || vm.case.costs?.simulated === true;
  const head = `<div class="bw-head">`
    + `<p class="bw-sum" aria-live="polite">${esc(summaryLine(s))}</p>`
    + (s.total ? `<div class="bw-mix" aria-hidden="true">${(["honest", "inflated", "unclear", "failed", "running", "queued"] as const)
      .filter((k) => (s[k] ?? 0) > 0).map((k) => `<span class="bw-mix-s bw-mix-s--${k}" data-morph-key="${k}" style="flex-grow:${s[k]}"></span>`).join("")}</div>` : "")
    + (s.total ? `<p class="bw-explain">${esc(scoreWords(vm.case.config).explainer)}</p>` : "")
    + (simulated ? `<p class="bw-sim"><strong>Simulated batch:</strong> the agents' choices are scripted, the scores and charts are real</p>` : "")
    + `</div>`;
  const grid = runs.length
    ? `<div class="bw-grid" data-morph-key="grid" data-morph-list>${runs.map((r) => tile(vm, r)).join("")}</div>`
    : `<div class="bw-empty" data-morph-key="empty">Runs appear here once the batch starts.</div>`;
  return `<section class="bw" data-morph-key="wall" aria-label="Runs">${head}${grid}</section>`;
}
