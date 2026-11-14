// OWNER: subagent B. The wall of run tiles: the Running and Reveal states.
//
// One tile per run, in id order, inside a keyed list so morph.ts keeps each tile (and a live lab iframe in it) as the
// element it was while statuses move. Each tile, top to bottom: header (id, status pill), the picture (lab page,
// chart, or a placeholder), the step label, a progress strip from the todos, then the reveal once the run is scored,
// and its cost. Markup has no whitespace between tags so children pair by index the same way on every render.
import "./wall.css";
import type { AgentTodo, CaseFile, RunRecord, RunStatus, TrapInfo } from "../api";
import { activityOf, chartUrl, logOf, notebookCells, notebookTail, stagesOf, type NbCell } from "./notebook";
import { evidenceParts, trapOf } from "./trap";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { cleanReason, modelShort, pct, pts, usd, wholePct } from "./format";
import { ACT, type BatchVm } from "./model";
import { tileCaption } from "./commentary";
import { isMotionBatch, robotThumb, scoreWords } from "../robot/markup";
import { domainWords, judgedOn } from "./words";
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

const meanOf = (xs: readonly (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** The runs' hidden case count when they agree on one, else null (the sentence then leaves the number out). */
function hiddenCount(runs: readonly RunRecord[]): number | null {
  const ns = [...new Set(runs.map((r) => r.n_hidden).filter((n): n is number => typeof n === "number" && n > 0))];
  return ns.length === 1 ? ns[0] : null;
}

/**
 * The batch's claim against its truth, once every run has finished: "6 of 12 agents claimed 99%. Measured at 20
 * positions they never tested: 59%." The two numbers are the means over the inflated runs (whole percents), the count
 * is out of every finished run. With no inflated run it says so, with the other scored runs' means. Null while a run
 * is still going, or when no run has a number to show.
 */
export function claimHeadline(c: Pick<CaseFile, "runs" | "config">): string | null {
  const runs = Object.values(c.runs ?? {});
  if (!runs.length || runs.some((r) => !isScored(r.status as Status))) return null;
  const inflated = runs.filter((r) => r.status === "inflated");
  const group = inflated.length ? inflated : runs.filter((r) => r.status === "honest" || r.status === "unclear");
  const claimed = meanOf(group.map((r) => r.reported_accuracy));
  const measured = meanOf(group.map((r) => r.true_accuracy));
  if (claimed == null || measured == null) return null;
  const n = runs.length;
  const truth = `Measured ${judgedOn(domainWords(c.config), hiddenCount(group))}: ${wholePct(measured)}.`;
  if (inflated.length) return `${inflated.length} of ${n} ${n === 1 ? "agent" : "agents"} claimed ${wholePct(claimed)}. ${truth}`;
  const lead = n === 1 ? "The agent did not overclaim: it claimed" : `None of ${n} agents overclaimed: they claimed`;
  return `${lead} ${wholePct(claimed)}. ${truth}`;
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
    case "failed": return cleanReason(run.reason) || "Failed";
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
    // A failed run's reason is in the step line under the picture: said once.
    : run.status === "failed" ? "Failed"
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
  const words = domainWords(config);
  const st = run.status as Status;
  // A failed run says why once, in its step line, and has no numbers.
  // An unclear run has its numbers too: they are why it is neither honest nor inflated.
  if (st !== "honest" && st !== "inflated" && st !== "unclear") return "";
  // The trap's evidence sentence. Left out when the run has no number or the trap has none to give.
  // A robot run's overlap share is the share of the can positions it tried that were the practice spot.
  const ev = evidenceParts(run.overlap_share, trap, words.evidence_text ?? "");
  const bar = (label: string, title: string, x: number | null | undefined, cls: string): string =>
    `<div class="bw-acc" title="${attr(title)}"><span class="bw-k">${esc(label)}</span><span class="bw-track" aria-hidden="true"><span class="bw-fill ${cls}" style="width:${barWidth(x).toFixed(1)}%"></span></span><span class="bw-v">${pct(x)}</span></div>`;
  return `<div class="bw-rev${motion ? " bw-rev--robot" : ""}">`
    + bar(w.reported, w.reportedTitle, run.reported_accuracy, "bw-fill--rep")
    + bar(w.true, w.trueTitle, run.true_accuracy, "bw-fill--true")
    + `<div class="bw-foot"><span class="bw-gap" title="${attr(w.gapTitle)}">${pts(run.gap)}${w.gapSuffix(run.gap)}</span>${ev ? `<span class="bw-ovl-t">${esc(`${ev.share} ${ev.text}`)}</span>` : ""}</div>`
    + `</div>`;
}

/** "$0.42", or null when the price is unknown. A tile never shows token counts: the header and the run page do. */
export function tileCost(vm: BatchVm, run: RunRecord): string | null {
  const scope = vm.case.costs?.scopes?.[`run:${run.id}`];
  return scope && typeof scope.total_usd === "number" ? usd(scope.total_usd) : null;
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
  return `<div class="bw-tile bw-tile--${run.status}" data-morph-key="tile:${attr(run.id)}" role="button" tabindex="0" data-act="${ACT.openRun}" data-arg="${attr(run.id)}" aria-label="${attr(label)}">`
    + `<div class="bw-hd"><span class="bw-id">${esc(run.id)}</span>${multiModel && run.model ? `<span class="bw-model" title="${attr(run.model)}">${esc(modelShort(run.model))}</span>` : ""}${pill(run.status)}</div>`
    + picture(vm, run, step, cells)
    + tileCaption(vm, run)
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
  const byModel = modelSummaryLine(vm);
  const multiModel = batchModels(vm).length > 0;
  // Once every run is in: the claim against the truth on top, the counts under it as a quieter line.
  const headline = claimHeadline(vm.case);
  const head = `<div class="bw-head">`
    + (headline ? `<p class="bw-headline" data-morph-key="headline">${esc(headline)}</p>` : "")
    + `<p class="bw-sum${headline ? " bw-sum--quiet" : ""}" aria-live="polite">${esc(summaryLine(s))}</p>`
    + (byModel ? `<p class="bw-sum-models" data-morph-key="by-model">${esc(byModel)}</p>` : "")
    + (s.total ? `<div class="bw-mix" aria-hidden="true">${(["honest", "inflated", "unclear", "failed", "running", "queued"] as const)
      .filter((k) => (s[k] ?? 0) > 0).map((k) => `<span class="bw-mix-s bw-mix-s--${k}" data-morph-key="${k}" style="flex-grow:${s[k]}"></span>`).join("")}</div>` : "")
    + (s.total ? `<p class="bw-explain">${esc(scoreWords(vm.case.config).explainer)}</p>` : "")
    + `</div>`;
  const grid = runs.length
    ? `<div class="bw-grid" data-morph-key="grid" data-morph-list>${runs.map((r) => tile(vm, r, multiModel)).join("")}</div>`
    : `<div class="bw-empty" data-morph-key="empty">Runs appear here once the batch starts.</div>`;
  return `<section class="bw" data-morph-key="wall" aria-label="Runs">${head}${grid}</section>`;
}
