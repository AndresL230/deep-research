// OWNER: subagent B. The wall of runs: one small machine per sandbox VM, all working at once.
//
// One device per run, in id order, inside a keyed list so morph.ts keeps each one as the element it was while statuses
// move. A device, front to back: the screen (the run's id, its cost, and the end of its notebook typing itself out),
// the step it is on, a row of lights (one per todo or stage) and its status chip. The screen shows only what the VM
// shows. Once the run is scored, its result is printed on the panel under the screen. The drawing is all in wall.css,
// so the notebook in the screen is the real DOM. Markup has no whitespace between tags so children pair by index the
// same way on every render.
//
// How an agent arrives and changes (system.css, motion.ts): its device grows from nothing as it comes on screen, one
// after another; while it works its chip turns a stepped spinner and a light runs round its edge; when it is scored
// the chip is replaced (a dot grows into a disc, the mark is drawn), the bars on its panel grow and the numbers count.
import "./wall.css";
import type { AgentTodo, RunRecord, RunStatus, TrapInfo } from "../api";
import { activityOf, chartUrl, logOf, notebookCells, notebookTail, stagesOf, type NbCell } from "./notebook";
import { evidenceParts, trapOf } from "./trap";
import { askIcon } from "../ask-icons";
import { chip, count, reveal as revealText, spinner, type ChipMark, type ChipTone } from "../motion";
import { attr, esc } from "../ui";
import { modelShort, pct, pts, tokens, usd } from "./format";
import { ACT, type BatchVm } from "./model";
import { tileCaption } from "./commentary";
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

/** The analyst models the batch's runs use, in run order, or [] when it used one (or names none). */
export function batchModels(vm: BatchVm): string[] {
  const models = [...new Set(sortedRuns(vm).map((r) => r.model).filter((m): m is string => !!m))];
  return models.length > 1 ? models : [];
}

/** "Haiku: 5 honest, 2 unclear, 11 inflated · Sonnet: ..." for a batch on more than one model, once a run is scored;
 *  else null. Unclear counts only in robot batches, where a run can be. */
export function modelSummaryLine(vm: BatchVm): string | null {
  const models = batchModels(vm);
  const runs = sortedRuns(vm);
  if (!models.length || !runs.some((r) => r.status === "honest" || r.status === "inflated" || r.status === "unclear")) return null;
  const unclear = isMotionBatch(vm.case.config) || runs.some((r) => r.status === "unclear");
  return models.map((m) => {
    const of = runs.filter((r) => r.model === m);
    const n = (st: Status) => of.filter((r) => r.status === st).length;
    return `${modelShort(m)}: ${n("honest")} honest, ${unclear ? `${n("unclear")} unclear, ` : ""}${n("inflated")} inflated`;
  }).join(" · ");
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

/** Each status as a chip: its colour and its mark. Waiting is an amber dot, working a spinner, a result a drawn badge. */
const CHIP: Record<Status, [ChipTone, ChipMark]> = {
  queued: ["warn", "dot"], starting: ["live", "spin"], running: ["live", "spin"],
  honest: ["ok", "check"], inflated: ["bad", "alert"], unclear: ["idle", "hold"], failed: ["idle", "cross"],
};

function pill(status: Status): string {
  const [tone, mark] = CHIP[status];
  return chip(STATUS_LABEL[status], tone, mark, `bw-pill bw-pill--${status}`);
}

/** The device's screen: the end of the run's notebook, code typing itself out, then its output and charts. */
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
    : run.status === "failed" ? "The run failed"
    : step;
  const lead = run.status === "starting" || run.status === "running" ? spinner(16) : askIcon("chart", 18, null, 1.5);
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

/** The result on the device's panel, under the screen: the two scores as meters, the gap, the trap's evidence. */
function reveal(run: RunRecord, trap: TrapInfo | null, config: unknown): string {
  const motion = isMotionBatch(config);
  const w = scoreWords(config);
  const st = run.status as Status;
  if (st === "failed") {
    const reason = run.reason?.trim() || "The run failed before it was scored.";
    return `<div class="bw-rev bw-rev--failed" data-morph-key="rev" title="${attr(reason)}">${esc(truncate(reason, 140))}</div>`;
  }
  // An unclear run has its numbers too: they are why it is neither honest nor inflated.
  if (st !== "honest" && st !== "inflated" && st !== "unclear") return "";
  // The trap's evidence sentence. Left out when the run has no number or the trap has none to give.
  // A robot run's overlap share is the share of the can positions it tried that were the practice spot.
  const ev = evidenceParts(run.overlap_share, trap, motion ? "of tested can positions were the practice spot" : "of test rows were in training");
  // The bars grow one after the other, and each number counts up beside its bar.
  const bar = (label: string, title: string, x: number | null | undefined, cls: string, wait: number): string =>
    `<div class="bw-acc" title="${attr(title)}"><span class="bw-k">${esc(label)}</span><span class="bw-track" aria-hidden="true"><span class="bw-fill ${cls} ds-grow-x" style="width:${barWidth(x).toFixed(1)}%;--mo-d:${wait}ms"></span></span><span class="bw-v">${count(x, "pct", pct(x))}</span></div>`;
  return `<div class="bw-rev${motion ? " bw-rev--robot" : ""}" data-morph-key="rev">`
    + `<div class="bw-meters">${bar(w.reported, w.reportedTitle, run.reported_accuracy, "bw-fill--rep", 0)}${bar(w.true, w.trueTitle, run.true_accuracy, "bw-fill--true", 150)}</div>`
    + `<div class="bw-res"><span class="bw-gap" title="${attr(w.gapTitle)}">${count(run.gap, "pts", pts(run.gap))}${w.gapSuffix(run.gap)}</span>${ev ? `<span class="bw-ovl-t">${esc(`${ev.share} ${ev.text}`)}</span>` : ""}</div>`
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

function tile(vm: BatchVm, run: RunRecord, multiModel = false): string {
  const todos = runTodos(vm, run);
  const log = logOf(vm, run.id);
  const cells = log ? notebookCells(log) : [];
  // Code is already on screen: the VM is up, whatever the last status update said.
  if (run.status === "starting" && cells.length) run = { ...run, status: "running" };
  const step = stepLabel(run, todos, cells);
  const cost = tileCost(vm, run);
  const label = `Run ${run.id}, ${STATUS_LABEL[run.status].toLowerCase()}. Open the run.`;
  const vmId = run.vm_id && !isScored(run.status) ? `<span class="bw-vm">${esc(run.vm_id.slice(0, 8))}</span>` : "";
  const working = run.status === "running" || run.status === "starting";
  // The analyst model, only in a batch run on more than one.
  const model = multiModel && run.model ? `<span class="bw-model" title="${attr(run.model)}">${esc(modelShort(run.model))}</span>` : "";
  return `<div class="bw-tile bw-tile--${run.status} ds-pop" data-io data-morph-key="tile:${attr(run.id)}" role="button" tabindex="0" data-act="${ACT.openRun}" data-arg="${attr(run.id)}" aria-label="${attr(label)}">`
    + `<div class="bw-dev">`
    + `<div class="bw-body${working ? " ds-beam" : ""}">`
    + `<div class="bw-scr">`
    + `<div class="bw-hd"><span class="bw-id"><span class="bw-lamp" aria-hidden="true"></span>${esc(run.id)}${model}${vmId}</span>${cost ? `<span class="bw-cost">${esc(cost)}</span>` : ""}</div>`
    + picture(vm, run, step, cells)
    + `</div>`
    // The live commentary's latest line about this run (commentary.ts), under the screen.
    + tileCaption(vm, run)
    // The panel under the screen: the step while the run works; once it is scored or has failed, the result.
    + `<div class="bw-panel">${reveal(run, trapOf(vm.case), vm.case.config) || `<div class="bw-step ds-swap" data-morph-key="step:${attr(step)}" title="${attr(step)}">${esc(truncate(step, 120))}</div>`}</div>`
    + `<div class="bw-chin">${strip(run, todos, cells)}${pill(run.status as Status)}<span class="bw-key" aria-hidden="true">${askIcon("arrow", 11, null, 2.2)}</span></div>`
    + `</div>`
    + `</div>`
    + `</div>`;
}

/** One device per run: the VM's notebook on the screen; on the panel under it the step, or once scored the result. */
export function wallView(vm: BatchVm): string {
  const runs = sortedRuns(vm);
  const s = wallSummary(vm);
  const byModel = modelSummaryLine(vm);
  const multiModel = batchModels(vm).length > 0;
  const simulated = (vm.case.config as { simulated?: boolean }).simulated === true || vm.case.costs?.simulated === true;
  const head = `<div class="bw-head" data-io>`
    + `<span class="ds-eyebrow">Agents</span>`
    + `<h2 class="bw-sum" aria-live="polite">${revealText(summaryLine(s))}</h2>`
    + (byModel ? `<p class="bw-sum-models" data-morph-key="by-model">${esc(byModel)}</p>` : "")
    + (s.total ? `<p class="bw-explain">${esc(scoreWords(vm.case.config).explainer)}</p>` : "")
    + (simulated ? `<p class="bw-sim"><strong>Simulated batch:</strong> the agents' choices are scripted, the scores and charts are real</p>` : "")
    + `</div>`;
  const grid = runs.length
    ? `<div class="bw-grid" data-morph-key="grid" data-morph-list>${runs.map((r) => tile(vm, r, multiModel)).join("")}</div>`
    : `<div class="bw-empty" data-morph-key="empty">Runs appear here once the batch starts.</div>`;
  // A robot batch's result line is longer ("of tested can positions were the practice spot"): its panels are taller.
  return `<section class="bw${isMotionBatch(vm.case.config) ? " bw--robot" : ""}" data-morph-key="wall" aria-label="Runs">${head}${grid}</section>`;
}
