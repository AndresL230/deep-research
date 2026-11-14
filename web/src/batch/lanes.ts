// OWNER: subagent C. What changed (the split), the fork experiment, the verdict, the investigator's panel, the
// diagnosis (where in the code a failure comes from) and the proposed fix.
//
// Every export is a pure `(vm) => html` function that returns "" until its state is reached, so main.ts can stack
// them unconditionally. Classes are prefixed `ln-`; the look lives in lanes.css. The notebooks in "What changed" are
// notebook.ts cells and wear its `nb-` classes.
import "./lanes.css";
import {
  batchFileUrl, isPendingForks, type AgentEvent, type ArmSummary, type BatchConfig, type CaseFile, type ForkArm, type ForkChild,
  type ForkExperiment, type PendingForks, type ProposedFix, type RunRecord, type SplitFinding, type TrapInfo,
} from "../api";
import { askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { duration, pct, pts, usd } from "./format";
import { ACT, childKey, type BatchVm } from "./model";
import { codeKind, highlightLines } from "./highlight";
import { LABEL_PATTERNS, cellView, chartUrl, counts, logOf, notebookCells, parseCommand, type NbCell } from "./notebook";
import { evidenceParts, trapMark, trapOf, trapWords, type Mark } from "./trap";

// ── pure helpers (exported for the tests) ────────────────────────────────────

/** The phase in words for the investigator panel. `blocked: x` and `error: x` keep their reason. */
export function phaseText(phase: string): string {
  const m = /^(blocked|error):\s*(.*)$/s.exec(phase);
  if (m) return `${m[1] === "blocked" ? "Blocked" : "Error"}: ${m[2] || "no reason given"}`;
  switch (phase) {
    case "config": return "Not started";
    case "running": return "Agents are running";
    case "analyzing": return "Scoring runs and finding the split";
    case "ready": return "Split found. Ready to investigate";
    case "no_split": return "No step separates honest and inflated runs";
    case "investigating": return "The investigator is working";
    case "awaiting_approval": return "Waiting for approval to fork";
    case "forking": return "Forking the run into control and forced arms";
    case "forked": return "Forks finished. Writing the verdict";
    case "done": return "Done";
    case "stopped": return "Stopped";
    default: return phase;
  }
}

/** True for `blocked: ...` and `error: ...` phases. */
export const isProblemPhase = (phase: string): boolean => /^(blocked|error):/.test(phase);

/** The index of a run's first action that splits the data, or the action count when it never splits. */
export function splitIndex(labels: readonly (readonly string[])[]): number {
  const i = labels.findIndex((a) => a.includes("split"));
  return i < 0 ? labels.length : i;
}

/** "3 of 4 inflated, mean reported 87.8% vs true 73.5%" (plus failed runs when any). */
export function armSummaryText(a: ArmSummary): string {
  const failed = a.failed ? `, ${a.failed} failed` : "";
  const means = a.mean_reported != null || a.mean_true != null
    ? `, mean reported ${pct(a.mean_reported)} vs true ${pct(a.mean_true)}` : "";
  return `${a.inflated} of ${a.scored} inflated${failed}${means}`;
}

/** One line, at most `n` characters: whitespace collapsed, an ellipsis when cut. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/** A tool call's args in short: `command="cd x && python3 a.py", n=4`. */
export function shortArgs(args: Record<string, unknown>, n = 90): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const val = typeof v === "string" ? `"${clip(v, 60)}"` : clip(JSON.stringify(v) ?? String(v), 40);
    return `${k}=${val}`;
  });
  return clip(parts.join(", "), n);
}

/** An investigator event as one compact line: what kind it is and its text. */
export function eventLine(ev: AgentEvent): { kind: string; text: string } {
  switch (ev.type) {
    case "thought": return { kind: "thought", text: clip(ev.text, 160) };
    case "tool_call": return { kind: "call", text: `${ev.name}(${shortArgs(ev.args)})` };
    case "tool_result": return { kind: "result", text: clip(`${ev.name ? `${ev.name}: ` : ""}${ev.content}`, 120) };
    case "todos": {
      const done = ev.todos.filter((t) => t.status === "completed").length;
      return { kind: "plan", text: `Plan: ${done} of ${ev.todos.length} done` };
    }
    case "forced": return { kind: "forced", text: clip(`Forced: ${ev.command}`, 120) };
  }
}

/** "3 of 4 succeeded on the hidden positions, mean true 72.0% vs control 45.0%": a fix experiment's arm, where what
 *  matters is the true success rate, not the inflation. `control` is the arm it is measured against (left out for the
 *  control arm itself, or when there is none). */
export function fixSummaryText(a: ArmSummary, control: ArmSummary | null = null): string {
  const failed = a.failed ? `, ${a.failed} failed` : "";
  const vs = control && control !== a && control.mean_true != null ? ` vs control ${pct(control.mean_true)}` : "";
  return `${a.honest} of ${a.scored} succeeded on the hidden positions${failed}, mean true ${pct(a.mean_true)}${vs}`;
}

/** True for a fix experiment: the fork that tests the investigator's patch rather than which step. */
export const isFixFork = (f: Pick<ForkExperiment, "kind"> | Pick<PendingForks, "kind">): boolean => f.kind === "fix";

/** What each arm is called on screen. */
const ARM_TITLE: Record<ForkArm, string> = { control: "Control", placebo: "Placebo", show: "Shown", forced: "Forced", fixed: "Fixed" };

/** The arms this experiment ran, in order. Batches saved before the extra arms existed ran these two. */
export function armNames(f: Pick<ForkExperiment, "arm_steps" | "kind">): ForkArm[] {
  const named = Object.keys(f.arm_steps ?? {}) as ForkArm[];
  return named.length ? named : isFixFork(f) ? ["control", "fixed"] : ["control", "forced"];
}

/** Child ids in arm order and by number: control-1, control-2, ..., forced-1, ... */

/** The step an arm runs before it continues, in words, or null when it continues unchanged. */
export function armStep(f: Pick<ForkExperiment, "arm_steps" | "intervention">, arm: ForkArm): string | null {
  if (f.arm_steps) return f.arm_steps[arm] ?? null;
  return arm === "control" ? null : f.intervention;
}

export function sortedChildren(children: Record<string, ForkChild>, arm: ForkArm): [string, ForkChild][] {
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return Object.entries(children).filter(([, c]) => c.arm === arm).sort((a, b) => num(a[0]) - num(b[0]));
}

/** The pending fork request, or null. */
export function pendingForks(c: CaseFile): PendingForks | null {
  const p = c.forks?.pending;
  return p && isPendingForks(p) ? p : null;
}

/** The fork experiments (not the pending request), in id order. */
export function forkExperiments(c: CaseFile): ForkExperiment[] {
  return Object.values(c.forks ?? {})
    .filter((f): f is ForkExperiment => !isPendingForks(f))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Simulated fixtures (scripts/make_fixture.py): the agents' choices are scripted. */
export const isSimulated = (c: CaseFile): boolean =>
  (c.config as { simulated?: boolean }).simulated === true || c.costs?.simulated === true;

/** "control_inflated" -> "Control inflated". */
export const numberLabel = (k: string): string => {
  const t = k.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const numberValue = (x: number): string => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));

// ── small pieces ─────────────────────────────────────────────────────────────

type Tone = "honest" | "inflated" | "failed" | "running" | "muted";

const toneOf = (status: string): Tone =>
  status === "honest" || status === "inflated" || status === "failed" ? status
    : status === "running" || status === "starting" ? "running" : "muted";

const pill = (status: string, text = status, tone: Tone = toneOf(status)): string =>
  `<span class="ln-pill ln-pill--${tone}">${tone === "running" ? askSpinner(10) : `<i class="ln-pill-dot"></i>`}${esc(text)}</span>`;

const simTag = (c: CaseFile): string =>
  isSimulated(c) ? `<span class="ln-sim" title="The agents' choices in this batch are scripted, not real agent runs">Simulated</span>` : "";

const head = (title: string, c: CaseFile, extra = ""): string =>
  `<div class="ln-head"><h2 class="ln-h">${esc(title)}</h2>${simTag(c)}${extra}</div>`;

const code = (label: string, text: string | null, tone: Tone): string =>
  `<figure class="ln-code ln-code--${tone}"><figcaption class="ln-code-cap"><i class="ln-pill-dot"></i>${esc(label)}</figcaption>` +
  `<pre class="ln-code-pre">${text ? esc(text) : `<span class="ln-muted">No example</span>`}</pre></figure>`;

const runLabels = (c: CaseFile, r: RunRecord): string[][] => (r.labels ?? c.step_labels?.[r.id] ?? []) as string[][];

// ── 1. what changed ──────────────────────────────────────────────────────────

interface StepWords {
  /** Past tense, after "Honest runs": "removed duplicate rows". */
  did: string;
  /** The empty slot on the side that skipped the step. */
  missing: string;
}

/** A step label in plain words. Labels are the backend's (deep_research/analysis.py). */
const STEP_WORDS: Record<string, StepWords> = {
  load: { did: "loaded the data", missing: "No data loaded here" },
  inspect: { did: "looked at the data", missing: "No look at the data here" },
  deduplicate: { did: "removed duplicate rows", missing: "No duplicate removal here" },
  deduplicate_near: { did: "removed near-duplicate rows", missing: "No near-duplicate removal here" },
  clean: { did: "cleaned up missing values", missing: "No cleaning here" },
  split: { did: "split the data", missing: "No split here" },
  preprocess: { did: "scaled or imputed the features", missing: "No preprocessing here" },
  train: { did: "trained a model", missing: "No model trained here" },
  evaluate: { did: "scored a model", missing: "No scoring here" },
  plot: { did: "drew a chart", missing: "No chart here" },
  predict: { did: "read the holdout rows", missing: "No holdout rows read here" },
  report: { did: "wrote the report", missing: "No report written here" },
};

/**
 * The words for a step label: the batch trap's own when the label is its step, else this file's, else generic ones
 * for a label nobody describes.
 */
export function stepWords(label: string, trap: TrapInfo | null = null): StepWords {
  return trapWords(trap, label) ?? STEP_WORDS[label] ?? { did: `did the ${label} step`, missing: `No ${label} step here` };
}

/** What marks a step in code, for the highlight: the batch trap's pattern for its own step, else the table's. */
export function stepMark(label: string, trap: TrapInfo | null = null): Mark | null {
  return trapMark(trap, label) ?? LABEL_PATTERNS[label] ?? null;
}

const ALL = 0.995;
const NONE = 0.005;

/** "Honest runs removed duplicate rows before splitting. Inflated runs did not." */
export function splitHeadline(s: Pick<SplitFinding, "label" | "honest_rate" | "inflated_rate">, trap: TrapInfo | null = null): { honest: string; inflated: string } {
  const h = s.honest_rate;
  const i = s.inflated_rate;
  const who = h >= ALL ? "Honest runs" : h > 0.5 ? "Most honest runs" : h > NONE ? "Some honest runs" : "No honest run";
  const too = h > NONE ? " too" : "";
  const inflated = i <= NONE ? (h > NONE ? "Inflated runs did not." : "Neither did inflated runs.")
    : i < 0.5 ? "Most inflated runs did not."
      : i < ALL ? `Most inflated runs did${too}.` : `Inflated runs did${too}.`;
  return { honest: `${who} ${stepWords(s.label, trap).did} before splitting.`, inflated };
}

/** "6 of 6 honest runs, 0 of 6 inflated". */
export function splitCounts(s: Pick<SplitFinding, "honest_rate" | "inflated_rate" | "n_honest" | "n_inflated">): string {
  return `${Math.round(s.honest_rate * s.n_honest)} of ${s.n_honest} honest runs, ${Math.round(s.inflated_rate * s.n_inflated)} of ${s.n_inflated} inflated`;
}

const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * The two runs to show side by side. Inflated: the run the fork copies, else the first that skipped the step.
 * Honest: the first that did the step before its split, else the first that did it at all, else the first.
 */
export function pickRuns(c: CaseFile): { honest: string | null; inflated: string | null } {
  const label = c.split?.label;
  const runs = Object.values(c.runs ?? {}).sort(byId);
  const before = (r: RunRecord): boolean => {
    const l = runLabels(c, r);
    return label != null && l.slice(0, splitIndex(l)).some((a) => a.includes(label));
  };
  const ever = (r: RunRecord): boolean => label != null && runLabels(c, r).some((a) => a.includes(label));
  const honest = runs.filter((r) => r.status === "honest");
  const inflated = runs.filter((r) => r.status === "inflated");
  const forked = c.split?.fork_run_id ? c.runs?.[c.split.fork_run_id] : undefined;
  return {
    honest: (honest.find(before) ?? honest.find(ever) ?? honest[0])?.id ?? null,
    inflated: (forked ?? inflated.find((r) => !before(r)) ?? inflated[0])?.id ?? null,
  };
}

/**
 * The line ranges `[from, to)` worth showing of `n` lines: `context` lines around each hit, ranges that touch or
 * leave one line between them merged, at most about `max` lines in all. A short text, or one without hits, is shown
 * from its start.
 */
export function lineWindows(n: number, hits: readonly number[], context = 2, max = 16): [number, number][] {
  if (n <= 0) return [];
  const at = [...new Set(hits)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  if (!at.length || n <= 2 * context + 4) return [[0, Math.min(n, at.length ? n : 8)]];
  const out: [number, number][] = [];
  let shown = 0;
  for (const i of at) {
    const from = Math.max(0, i - context);
    const to = Math.min(n, i + context + 1);
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) {
      shown += Math.max(0, to - last[1]);
      last[1] = Math.max(last[1], to);
    } else {
      if (shown >= max) break;
      out.push([from, to]);
      shown += to - from;
    }
  }
  return out;
}

const IMPORT_LINE = /^\s*(?:from\s+\S+\s+import|import)\s/;

/** The lines a pattern matches, leaving out import lines when it also matches real code. */
function matchLines(lines: readonly string[], re: Mark | null): number[] {
  if (!re) return [];
  const all = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  const code = all.filter((i) => !IMPORT_LINE.test(lines[i]));
  return code.length ? code : all;
}

const cellText = (c: NbCell): string => `${c.code}\n${c.then ?? ""}`;

/**
 * Where a run's notebook splits the data and where it does the step under test. `split` is the first code cell that
 * splits (by its code, else by the backend's labels); `step` is that cell when it also does the step (one big
 * script), else the last cell before it that does. Indexes into `code`; -1 when there is none.
 */
export function planCells(cells: readonly NbCell[], mark: Mark | null, labels: readonly (readonly string[])[] = []): { code: NbCell[]; split: number; step: number } {
  const code = cells.filter((c) => c.kind !== "note" && c.state !== "typing");
  let split = code.findIndex((c) => LABEL_PATTERNS.split.test(c.code));
  if (split < 0) {
    const at = splitIndex(labels);
    if (at < labels.length) split = code.findIndex((c) => c.action === at);
  }
  let step = -1;
  if (mark) {
    for (let i = split < 0 ? code.length - 1 : split; i >= 0; i--) {
      if (mark.test(cellText(code[i]))) { step = i; break; }
    }
  }
  return { code, split, step };
}

type Group = "honest" | "inflated";

interface Side {
  id: string | null;
  rec: RunRecord | null;
  code: NbCell[];
  /** Execution counts, as on the run's own page. */
  num: Map<string, number>;
  split: number;
  step: number;
}

function sideOf(vm: BatchVm, id: string | null, mark: Mark | null): Side {
  const log = id ? logOf(vm, id) : null;
  const cells = log ? notebookCells(log) : [];
  const rec = id ? vm.case.runs?.[id] ?? null : null;
  return { id, rec, num: counts(cells), ...planCells(cells, mark, rec ? runLabels(vm.case, rec) : []) };
}

/** A whole cell is short enough to show as it is. */
const SHORT_CELL = 9;

/** A cell's code cut to the lines that matter: the step's lines (highlighted) and the line that splits. */
function snippet(c: Pick<NbCell, "key" | "title" | "lang" | "code">, n: number | null, mark: Mark | null, at: RegExp | null): string {
  const code = c.code.replace(/\s+$/, "");
  const lines = code.split("\n");
  const colored = highlightLines(code, codeKind(c.lang, c.title, code));
  const splits = new Set(matchLines(lines, at));
  const wins = lineWindows(lines.length, [...matchLines(lines, mark), ...splits]);
  const more = (k: number, where: string): string => `<span class="nb-more">… ${k} line${k === 1 ? "" : "s"}${where}</span>`;
  const parts: string[] = [];
  let prev = 0;
  wins.forEach(([from, to], w) => {
    if (from > prev) parts.push(more(from - prev, w === 0 ? " above" : ""));
    for (let i = from; i < to; i++) {
      const cls = mark?.test(lines[i]) ? " nb-hl" : splits.has(i) ? " ln-at" : "";
      parts.push(`<span class="nb-ln${cls}">${colored[i] ?? esc(lines[i])}</span>`);
    }
    prev = to;
  });
  if (prev < lines.length) parts.push(more(lines.length - prev, " below"));
  return `<div class="nb nb--compact"><div class="nb-cell nb-cell--code is-done" data-morph-key="c:${attr(c.key)}">` +
    (n != null ? `<span class="nb-gut" aria-hidden="true">[${n}]</span>` : "") +
    `<div class="nb-body">${c.title ? `<div class="nb-head"><span class="nb-file">${esc(c.title)}</span></div>` : ""}` +
    `<pre class="nb-code nb-lang-${c.lang}">${parts.join("\n")}</pre></div></div></div>`;
}

/** A command from the split finding as a cell, for when the run's log is not loaded. */
function exampleSnippet(key: string, command: string, mark: Mark | null): string {
  const p = parseCommand(command);
  return snippet({ key, title: p.title, lang: p.lang, code: p.code }, null, mark, LABEL_PATTERNS.split);
}

const skipped = (n: number, where: "earlier" | "later" | "between"): string =>
  n > 0 ? `<p class="ln-skip">${n} ${where === "between" ? "more" : where} cell${n === 1 ? "" : "s"}</p>` : "";

const GROUP_NAME: Record<Group, string> = { honest: "Honest", inflated: "Inflated" };

/**
 * One run as a column of six rows, so the two columns line up: its name, the cells before, the step (or the empty
 * slot), the cells between, the cell that splits, the cells after.
 */
function column(vm: BatchVm, s: Side, group: Group, split: SplitFinding, splitInBand: boolean): string {
  const trap = trapOf(vm.case);
  const mark = stepMark(split.label, trap);
  const words = stepWords(split.label, trap);
  const { code } = s;
  const n = (c: NbCell): number | null => s.num.get(c.key) ?? null;
  const id = s.id;

  const scores = s.rec && (s.rec.reported_accuracy != null || s.rec.true_accuracy != null)
    ? `<span class="ln-col-n">reported <b>${esc(pct(s.rec.reported_accuracy))}</b>, true <b>${esc(pct(s.rec.true_accuracy))}</b></span>` : "";
  const headHtml = id
    ? `<button type="button" class="ln-col-h" data-act="${ACT.openRun}" data-arg="${attr(id)}" title="${attr(`Open run ${id}`)}">` +
      `<span class="ln-col-t"><i class="ln-pill-dot"></i>${GROUP_NAME[group]} run <b>${esc(id)}</b></span>${scores}</button>`
    : `<div class="ln-col-h"><span class="ln-col-t"><i class="ln-pill-dot"></i>No ${group} run to show</span></div>`;

  const hasStep = s.step >= 0;
  const selfMerged = hasStep && s.step === s.split;
  const splitCell = s.split >= 0 ? code[s.split] : null;
  const splitHtml = splitCell ? snippet(splitCell, n(splitCell), mark, LABEL_PATTERNS.split) : "";
  const example = group === "honest" ? split.honest_example : split.inflated_example;

  let band: string;
  let splitRow = selfMerged ? "" : splitHtml;
  if (hasStep) {
    const c = code[s.step];
    const whole = !selfMerged && c.code.split("\n").length <= SHORT_CELL;
    band = `<p class="ln-cap">This run ${esc(words.did)}${selfMerged ? ", then split, in one script" : ""}</p>` +
      (whole
        ? `<div class="nb nb--compact">${cellView(c, n(c) ?? 0, { compact: true, mark, image: (name) => chartUrl(vm, id ?? "", name) })}</div>`
        : snippet(c, n(c), mark, selfMerged ? LABEL_PATTERNS.split : null));
  } else if (group === "honest") {
    // The step is not in the code we have (log not loaded, or a label without a pattern): the finder's example.
    band = `<p class="ln-cap">This run ${esc(words.did)}</p>` +
      (example ? exampleSnippet("ex-honest", example, mark) : `<p class="ln-skip">Open the run to see where.</p>`);
  } else {
    band = `<div class="ln-missing"><b class="ln-missing-t">${esc(words.missing)}</b>` +
      `<span class="ln-missing-s">This run went straight to splitting the data.</span></div>`;
    if (splitInBand) { band += splitHtml; splitRow = ""; }
    else if (!code.length && example) splitRow = exampleSnippet("ex-inflated", example, mark);
  }

  const first = hasStep ? s.step : s.split >= 0 ? s.split : code.length;
  const last = Math.max(s.step, s.split);
  const between = hasStep && s.split > s.step ? s.split - s.step - 1 : 0;
  const row = (kind: string, html: string): string => `<div class="ln-row ln-row--${kind}">${html}</div>`;
  return `<div class="ln-col ln-col--${group}" data-morph-key="col-${group}">` +
    row("head", headHtml) +
    row("skip", skipped(first, "earlier")) +
    row("band", band) +
    row("skip", skipped(between, "between")) +
    row("split", splitRow ? `<p class="ln-cap">Then it split into train and test</p>${splitRow}` : "") +
    row("skip", skipped(last >= 0 ? code.length - last - 1 : 0, "later")) +
    `</div>`;
}

/** The two notebooks as a diff: lined up at the step one did and the other skipped. */
function diffView(vm: BatchVm, split: SplitFinding, pick: { honest: string | null; inflated: string | null }): string {
  const mark = stepMark(split.label, trapOf(vm.case));
  const honest = sideOf(vm, pick.honest, mark);
  const inflated = sideOf(vm, pick.inflated, mark);
  const merged = honest.step >= 0 && honest.step === honest.split;
  return `<div class="ln-diff" role="group" aria-label="An honest run and an inflated run, side by side">` +
    `<div class="ln-band" aria-hidden="true"></div>` +
    column(vm, honest, "honest", split, false) + column(vm, inflated, "inflated", split, merged) +
    `</div>`;
}

// ── the score as a picture ───────────────────────────────────────────────────

export interface ScoreStats {
  n: number;
  reported: number | null;
  true: number | null;
  /** Mean reported minus mean true. */
  gap: number | null;
  /** Mean share of test rows that were also in training. */
  overlap: number | null;
}

const mean = (xs: readonly (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

type Scored = Pick<RunRecord, "reported_accuracy" | "true_accuracy" | "overlap_share">;

/** Means over a group of runs or fork children. */
export function scoreStats(items: readonly Scored[]): ScoreStats {
  const reported = mean(items.map((r) => r.reported_accuracy));
  const tru = mean(items.map((r) => r.true_accuracy));
  return {
    n: items.length, reported, true: tru,
    gap: reported != null && tru != null ? reported - tru : null,
    overlap: mean(items.map((r) => r.overlap_share)),
  };
}

/** Bars start at 50% (a coin flip on two classes) so the gap between reported and true is visible. */
const AXIS_MIN = 0.5;
/** A share of the bar track, 0 to 100, for an accuracy between 50% and 100%. */
export const barShare = (x: number | null | undefined): number =>
  x == null || Number.isNaN(x) ? 0 : Number((Math.max(0, Math.min(1, (x - AXIS_MIN) / (1 - AXIS_MIN))) * 100).toFixed(1));

/**
 * Reported against true accuracy as two bars on one 50% to 100% axis. The part of the reported bar past the true
 * value is hatched: that is the part that is not real.
 */
function scoreBars(s: Pick<ScoreStats, "reported" | "true" | "gap">, group: Group): string {
  const rep = barShare(s.reported);
  const tru = barShare(s.true);
  const solid = s.true == null ? rep : Math.min(rep, tru);
  const over = Math.max(0, rep - solid);
  const gap = s.gap;
  const word = gap == null ? "" : gap >= 0.005 ? "reported above true" : gap <= -0.005 ? "reported below true" : "reported matches true";
  const label = `Reported ${pct(s.reported)}, true ${pct(s.true)}${gap != null ? `, gap ${pts(gap)}` : ""}`;
  return `<div class="ln-score ln-score--${group}">` +
    `<div class="ln-bars" role="img" aria-label="${attr(label)}">` +
    `<span class="ln-bar-k">Reported</span><span class="ln-track" title="${attr(`Reported ${pct(s.reported)}`)}">` +
    `<i class="ln-fill" style="width:${solid}%"></i>${over > 0 ? `<i class="ln-over" style="left:${solid}%;width:${over.toFixed(1)}%"></i>` : ""}</span>` +
    `<span class="ln-bar-v">${esc(pct(s.reported))}</span>` +
    `<span class="ln-bar-k">True</span><span class="ln-track" title="${attr(`True ${pct(s.true)}`)}"><i class="ln-fill ln-fill--true" style="width:${tru}%"></i></span>` +
    `<span class="ln-bar-v">${esc(pct(s.true))}</span>` +
    `<span class="ln-axis" aria-hidden="true"><span>50%</span><span>100%</span></span>` +
    `</div>` +
    (gap != null ? `<p class="ln-gap"><b class="ln-gap-n">${esc(pts(gap))}</b><span class="ln-gap-w">${word}</span></p>` : "") +
    `</div>`;
}

/** What the step did to the score: per group, reported against true, and how much of the test set leaked. */
function consequence(c: CaseFile): string {
  const runs = Object.values(c.runs ?? {});
  const group = (g: Group): string => {
    const s = scoreStats(runs.filter((r) => r.status === g));
    if (!s.n) return "";
    // Left out when there is no number: the trap has no evidence, or these runs did not keep what it is read from.
    const ev = evidenceParts(s.overlap, trapOf(c), "of test rows were also in training");
    const leak = ev ? `<p class="ln-leak"><b>${esc(ev.share)}</b> ${esc(ev.text)}</p>` : "";
    return `<div class="ln-grp ln-grp--${g}" data-morph-key="grp-${g}">` +
      `<div class="ln-grp-h"><i class="ln-pill-dot"></i><span class="ln-grp-t">${GROUP_NAME[g]} runs</span><span class="ln-muted">${s.n}</span></div>` +
      scoreBars(s, g) + leak + `</div>`;
  };
  const html = group("honest") + group("inflated");
  return html ? `<h3 class="ln-h3">What it did to the score</h3><div class="ln-cons">${html}</div>` : "";
}

/** Every run as one small bar (reported accuracy, with a line at the true one). The two shown above are outlined. */
function runStrip(c: CaseFile, shown: readonly (string | null)[]): string {
  const runs = Object.values(c.runs ?? {}).sort(byId);
  if (!runs.length) return "";
  const groups: { tone: Tone; title: string; runs: RunRecord[] }[] = [
    { tone: "honest", title: "Honest", runs: runs.filter((r) => r.status === "honest") },
    { tone: "inflated", title: "Inflated", runs: runs.filter((r) => r.status === "inflated") },
    { tone: "failed", title: "Failed", runs: runs.filter((r) => r.status === "failed") },
    { tone: "muted", title: "Not scored", runs: runs.filter((r) => !["honest", "inflated", "failed"].includes(r.status)) },
  ];
  const one = (r: RunRecord, tone: Tone): string => {
    const is = shown.includes(r.id);
    const scored = r.reported_accuracy != null || r.true_accuracy != null;
    const title = `${r.id}, ${r.status}${scored ? `: reported ${pct(r.reported_accuracy)}, true ${pct(r.true_accuracy)}` : ""}${is ? ". Shown above" : ""}`;
    return `<button type="button" class="ln-run ln-run--${tone}${is ? " is-shown" : ""}" data-morph-key="run-${attr(r.id)}" data-act="${ACT.openRun}" data-arg="${attr(r.id)}" title="${attr(title)}" aria-label="${attr(`${title}. Open the run.`)}">` +
      `<span class="ln-run-track">` +
      (r.reported_accuracy != null ? `<i class="ln-run-bar" style="height:${barShare(r.reported_accuracy)}%"></i>` : "") +
      (r.true_accuracy != null ? `<i class="ln-run-true" style="bottom:${barShare(r.true_accuracy)}%"></i>` : "") +
      `</span><span class="ln-run-id">${esc(r.id)}</span></button>`;
  };
  const body = groups.filter((g) => g.runs.length).map((g) =>
    `<div class="ln-strip-g ln-strip-g--${g.tone}" data-morph-key="strip-${g.tone}">` +
    `<span class="ln-strip-t"><i class="ln-pill-dot"></i>${g.title} <span class="ln-muted">${g.runs.length}</span></span>` +
    `<div class="ln-strip-runs" data-morph-list>${g.runs.map((r) => one(r, g.tone)).join("")}</div></div>`).join("");
  const marked = shown.some((id) => id != null) ? " The outlined runs are the two shown above." : "";
  return `<h3 class="ln-h3">All ${runs.length} runs</h3>` +
    `<div class="ln-strip" data-morph-list>${body}</div>` +
    `<p class="ln-legend-t">Bar: reported accuracy. Line: true accuracy. Both from 50% to 100%.${marked}</p>`;
}

/** What happens next: which run the fork copies and what the forced arm adds. */
function nextLine(s: SplitFinding): string {
  if (!s.fork_run_id || s.fork_at == null) return `<p class="ln-note">No inflated run skipped the ${esc(s.label)} step, so there is no run to fork.</p>`;
  const forced = s.intervention
    ? `once unchanged, and once with one step added first: <span class="ln-iv">${esc(s.intervention)}</span>.`
    : `but no intervention is defined for the ${esc(s.label)} step yet, so the forced arm cannot run.`;
  return `<p class="ln-note">Next, to prove the step is the cause: the fork copies run <b>${esc(s.fork_run_id)}</b> just before it splits the data and runs it both ways, ${forced}</p>`;
}

/**
 * What changed: the finding in one line, an honest and an inflated notebook lined up at the step one of them skipped,
 * what that did to the score, and every run one click away.
 */
export function splitView(vm: BatchVm): string {
  const c = vm.case;
  const split = c.split;
  const noSplit = c.phase === "no_split";
  if (!split && !noSplit) return "";

  if (!split) {
    return `<section class="ln-sec ln-split" data-morph-key="ln-split" aria-label="What changed">` +
      head("What changed", c) +
      `<p class="ln-headline">No step separates honest and inflated runs.</p>` +
      `<p class="ln-sub">Both groups did the same steps before splitting the data, so there is nothing to fork.</p>` +
      consequence(c) + runStrip(c, []) +
      `</section>`;
  }

  const line = splitHeadline(split, trapOf(c));
  const pick = pickRuns(c);
  return `<section class="ln-sec ln-split" data-morph-key="ln-split" aria-label="What changed">` +
    head("What changed", c) +
    `<p class="ln-headline"><span class="ln-headline-a">${esc(line.honest)}</span> <span class="ln-headline-b">${esc(line.inflated)}</span></p>` +
    `<p class="ln-sub">${esc(splitCounts(split))} did this before splitting into train and test.</p>` +
    diffView(vm, split, pick) +
    consequence(c) +
    runStrip(c, [pick.honest, pick.inflated]) +
    nextLine(split) +
    `</section>`;
}

// ── 2. the fork experiment ───────────────────────────────────────────────────

const FORK_STATUS: Record<ForkExperiment["status"], string> = {
  rebuilding: "Rebuilding the VM",
  running: "Running",
  done: "Done",
  // A resumed batch: the old server was still running this experiment when it stopped.
  stopped: "Stopped before it finished",
};

/** The fork experiment: the approval card (forks.pending), then control and forced arms fanning out. */
export function forkView(vm: BatchVm): string {
  const c = vm.case;
  const pending = pendingForks(c);
  const exps = forkExperiments(c);
  if (!pending && !exps.length) return "";
  const threshold = (c.config as Partial<BatchConfig>).inflation_threshold ?? 0.08;
  return `<section class="ln-sec ln-forks" data-morph-key="ln-forks" aria-label="Fork experiment">` +
    head("Fork experiment", c) +
    `<div class="ln-stack" data-morph-list>${exps.map((f) => experiment(f, threshold, c.fix ?? null)).join("")}${pending ? approvalCard(pending, vm) : ""}</div>` +
    `</section>`;
}

/** How many arms the pending experiment would run, from the VMs it asks for (one base, then n per arm). */
export function armCount(p: Pick<PendingForks, "n_per_arm" | "vm_count">): number {
  if (!(p.n_per_arm > 0) || !(p.vm_count > 1)) return 2;
  return Math.max(2, Math.round((p.vm_count - 1) / p.n_per_arm));
}

function approvalCard(p: PendingForks, vm: BatchVm): string {
  const src = vm.case.split?.fork_run_id;
  const est = p.estimate_usd != null ? usd(p.estimate_usd) : "unknown, prices missing";
  const disabled = !vm.live || vm.busy != null;
  const btn = (act: string, label: string, primary: boolean): string =>
    `<button type="button" class="${primary ? "ask-btn ln-approve" : "ask-ghostbtn ask-ghostbtn--outline"}" data-act="${act}"${disabled ? " disabled" : ""}>` +
    `${vm.busy === act ? askSpinner(12) : ""}${esc(label)}</button>`;
  const size = `${p.n_per_arm} ${p.n_per_arm === 1 ? "run" : "runs"} in each of ${armCount(p)} arms, ${p.vm_count} VMs.`;
  const ask = isFixFork(p)
    ? `The investigator wants to test its fix on run ${esc(vm.case.fix?.run_id ?? src ?? "?")}: ${size}`
    : `The investigator wants to fork run ${esc(src ?? "?")} before its split: ${size}`;
  return `<div class="ln-card ln-approval" data-morph-key="pending" role="group" aria-label="Approve the fork">` +
    `<p class="ln-approval-t">${ask}</p>` +
    `<p class="ln-approval-est">Estimated cost <b>${esc(est)}</b></p>` +
    `<div class="ln-actions">${btn(ACT.approve, "Approve", true)}${btn(ACT.decline, "Decline", false)}` +
    (vm.live ? "" : `<span class="ln-muted">Approval happens on live batches.</span>`) + `</div>` +
    (vm.live && vm.error ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    `</div>`;
}

/** An arm's mean reported and true accuracy: from its summary when the fork is done, else from the children scored so far. */
export function armStats(f: ForkExperiment, arm: ForkArm): ScoreStats {
  const kids = sortedChildren(f.children ?? {}, arm).map(([, k]) => k).filter((k) => k.status === "honest" || k.status === "inflated");
  const s = scoreStats(kids);
  const sum = f.arms?.[arm];
  if (!sum || (sum.mean_reported == null && sum.mean_true == null)) return s;
  const gap = sum.mean_reported != null && sum.mean_true != null ? sum.mean_reported - sum.mean_true : null;
  return { ...s, n: sum.scored, reported: sum.mean_reported, true: sum.mean_true, gap };
}

/** A mean true accuracy is "up" against the control's when it is over it by more than rounding. */
const UP = 0.005;

function experiment(f: ForkExperiment, threshold: number, fix: ProposedFix | null = null): string {
  const statusPill = pill(f.status, FORK_STATUS[f.status] ?? f.status, f.status === "done" ? "muted" : "running");
  const fixing = isFixFork(f);
  const control = fixing ? armStats(f, "control") : null;
  const arm = (a: ForkArm): string => {
    const kids = sortedChildren(f.children ?? {}, a);
    const summary = f.arms?.[a];
    const step = armStep(f, a);
    const sub = step === null ? "Continues unchanged" : `Runs first: ${step}`;
    const started = f.status !== "done" && kids.length < f.n_per_arm ? `<span class="ln-muted">${kids.length} of ${f.n_per_arm} started</span>` : "";
    const stats = armStats(f, a);
    // The arm's bar wears the color of what its runs turned out to be. Testing a step: inflated when the mean gap is
    // over the line. Testing a fix: green when the mean true accuracy went up against control, red when it did not.
    const better = control != null && stats.true != null && control.true != null && stats.true > control.true + UP;
    const tone: Group = fixing ? (better ? "honest" : "inflated") : stats.gap != null && stats.gap >= threshold ? "inflated" : "honest";
    const bars = stats.reported != null || stats.true != null ? scoreBars(stats, tone) : "";
    const sum = summary ? (fixing ? fixSummaryText(summary, a === "control" ? null : f.arms?.control ?? null) : armSummaryText(summary)) : "";
    return `<div class="ln-arm ln-arm--${a}" data-morph-key="arm-${a}">` +
      `<div class="ln-arm-h"><span class="ln-arm-t">${esc(ARM_TITLE[a] ?? a)}</span>${started}</div>` +
      `<p class="ln-arm-sub">${esc(sub)}</p>` +
      bars +
      `<div class="ln-kids" data-morph-list>${kids.map(([id, k]) => childTile(f.id, id, k)).join("")}</div>` +
      (sum ? `<p class="ln-arm-sum">${esc(sum)}</p>` : "") +
      `</div>`;
  };
  // The fix this fork tests: the case file's, unless that one names another fork.
  const tested = fix && (!fix.fork_id || fix.fork_id === f.id) ? fix : null;
  const headline = fixing
    ? `Fork <b>${esc(f.id)}</b> from run <b>${esc(f.source_run)}</b> at the same moment, with the proposed fix applied in the fixed arm.` +
      (tested ? ` Tests: <b class="ln-lit-word">${esc(tested.description)}</b>.` : "")
    : `Forked run <b>${esc(f.source_run)}</b> after action ${f.fork_at}, just before its split. Step under test: <b class="ln-lit-word">${esc(f.label)}</b>.`;
  return `<div class="ln-card ln-exp" data-morph-key="exp-${attr(f.id)}">` +
    `<div class="ln-exp-h"><span class="ln-exp-id">Fork ${esc(f.id)}</span>${statusPill}</div>` +
    `<p class="ln-exp-t">${headline}</p>` +
    (f.status === "rebuilding" ? `<p class="ln-sub">Replaying the run's first ${f.fork_at} actions on a fresh VM.</p>` : "") +
    `<div class="ln-arms" data-arms="${armNames(f).length}">${armNames(f).map(arm).join("")}</div>` +
    `</div>`;
}

function childTile(forkId: string, id: string, k: ForkChild): string {
  const scored = k.status !== "running";
  const vals = scored && (k.reported_accuracy != null || k.true_accuracy != null)
    ? `<span class="ln-kid-v"><span class="ln-muted">reported</span> ${esc(pct(k.reported_accuracy))} <span class="ln-muted">true</span> ${esc(pct(k.true_accuracy))}</span>`
    : `<span class="ln-kid-v ln-muted">${k.status === "failed" ? esc(clip(k.reason || "Failed", 40)) : "Working"}</span>`;
  const key = childKey(forkId, id);
  return `<button type="button" class="ln-kid ln-kid--${toneOf(k.status)}" data-morph-key="${attr(key)}" data-act="${ACT.openChild}" data-arg="${attr(key)}" aria-label="${attr(`${id}, ${k.status}. Open the run.`)}">` +
    `<span class="ln-kid-h"><span class="ln-kid-id">${esc(id)}</span>${k.how ? `<span class="ln-tag" title="${k.how === "fork" ? "A copy-on-write fork of the VM" : "Rebuilt by replaying the actions"}">${esc(k.how)}</span>` : ""}</span>` +
    `${pill(k.status)}${vals}</button>`;
}

// ── 3. the verdict ───────────────────────────────────────────────────────────

interface ArmDots { statuses: string[]; inflated: number; total: number }

/** The dots per arm: from the verdict's fork children when there is one, else from the verdict's numbers. */
export function verdictArms(c: CaseFile): Partial<Record<ForkArm, ArmDots>> | null {
  const v = c.verdict;
  if (!v) return null;
  // The verdict belongs to the method experiment: a fix fork (which tests the investigator's patch) is never its source.
  const exps = forkExperiments(c).filter((e) => !isFixFork(e));
  const f = [...exps].reverse().find((e) => e.label === v.step_label && e.status === "done") ?? exps[exps.length - 1];
  const out: Partial<Record<ForkArm, ArmDots>> = {};
  // Every arm the experiment ran. With no experiment to read, the verdict's own numbers cover control and forced.
  for (const arm of f ? armNames(f) : (["control", "forced"] as ForkArm[])) {
    const kids = f ? sortedChildren(f.children ?? {}, arm) : [];
    if (kids.length) {
      const statuses = kids.map(([, k]) => k.status);
      const s = f?.arms?.[arm];
      out[arm] = { statuses, inflated: s?.inflated ?? statuses.filter((x) => x === "inflated").length, total: s?.scored ?? statuses.filter((x) => x !== "failed" && x !== "running").length };
    } else {
      const inflated = v.numbers[`${arm}_inflated`] ?? 0;
      const total = v.numbers[`${arm}_total`] ?? 0;
      if (!total) continue;  // an arm the verdict does not report
      out[arm] = { statuses: Array.from({ length: total }, (_, i) => (i < inflated ? "inflated" : "honest")), inflated, total };
    }
  }
  return out;
}

/** The verdict: dots per arm colored by outcome, plus the one sentence. */
export function verdictView(vm: BatchVm): string {
  const c = vm.case;
  const v = c.verdict;
  if (!v) return "";
  const arms = verdictArms(c);
  const row = (arm: ForkArm): string => {
    const a = arms?.[arm];
    if (!a) return "";
    const dots = a.statuses.map((s, i) => `<i class="ln-dot ln-dot--${toneOf(s)}" title="${attr(`${arm}-${i + 1}: ${s}`)}"></i>`).join("");
    return `<div class="ln-vrow" data-morph-key="v-${arm}"><span class="ln-vrow-t">${esc(ARM_TITLE[arm] ?? arm)}</span>` +
      `<span class="ln-dots" role="img" aria-label="${attr(`${a.inflated} of ${a.total} inflated`)}">${dots}</span>` +
      `<span class="ln-vrow-n">${a.inflated} of ${a.total} inflated</span></div>`;
  };
  const nums = Object.entries(v.numbers ?? {});
  return `<section class="ln-sec ln-verdict" data-morph-key="ln-verdict" aria-label="Verdict">` +
    head("Verdict", c) +
    `<p class="ln-sentence">${esc(v.sentence)}</p>` +
    `<div class="ln-vrows">${(Object.keys(arms ?? {}) as ForkArm[]).map(row).join("")}</div>` +
    `<div class="ln-legend" aria-hidden="true"><span><i class="ln-dot ln-dot--honest"></i>honest</span><span><i class="ln-dot ln-dot--inflated"></i>inflated</span><span><i class="ln-dot ln-dot--failed"></i>failed</span></div>` +
    (nums.length ? `<dl class="ln-stats">${nums.map(([k, n]) => `<div class="ln-stat"><dt>${esc(numberLabel(k))}</dt><dd>${esc(numberValue(n))}</dd></div>`).join("")}</dl>` : "") +
    (isSimulated(c) ? `<p class="ln-note ln-note--sim">Simulated batch: the agents' choices were scripted to show the method. These are not real agent runs.</p>` : "") +
    `</section>`;
}

// ── 4. the investigator ──────────────────────────────────────────────────────

const STOPPABLE = new Set(["running", "investigating", "forking"]);
const RECENT = 8;

/** The investigator: what it is doing (its events, hypotheses) and the live-only Investigate / Stop actions. */
export function investigatorView(vm: BatchVm): string {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  if (phase === "config") return "";
  const problem = isProblemPhase(phase);
  const working = ["running", "analyzing", "investigating", "forking"].includes(phase);

  let actions = "";
  const dis = vm.busy != null ? " disabled" : "";
  // A saved batch that stopped at its split can be investigated too: the server brings it back live first.
  if (phase === "ready" && (vm.live || vm.resumable)) {
    actions += `<button type="button" class="ask-btn ln-approve" data-act="${ACT.investigate}"${dis}>${vm.busy === ACT.investigate ? askSpinner(12) : ""}Investigate</button>`;
  }
  if (vm.live) {
    if (STOPPABLE.has(phase)) {
      actions += `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.stop}"${dis}>${vm.busy === ACT.stop ? askSpinner(12) : ""}Stop</button>`;
    }
  }

  const all = vm.events?.investigator ?? [];
  const start = Math.max(0, all.length - RECENT);
  const recent = all.slice(start);
  const events = recent.length
    ? `<ol class="ln-evs" data-morph-list>${recent.map((ev, j) => {
      const { kind, text } = eventLine(ev);
      const who = ev.agent && ev.agent !== "investigator" ? `<span class="ln-tag">${esc(ev.agent)}</span>` : "";
      return `<li class="ln-ev ln-ev--${kind}" data-morph-key="ev-${start + j}"><span class="ln-ev-t">${esc(duration(ev.t))}</span>` +
        `<span class="ln-ev-k">${esc(kind)}</span>${who}<span class="ln-ev-x">${esc(text)}</span></li>`;
    }).join("")}</ol>`
    : "";

  const hyps = c.hypotheses ?? [];
  const hypHtml = hyps.length
    ? `<div class="ln-hyps" data-morph-list>${hyps.map((h, i) =>
      `<div class="ln-card ln-hyp" data-morph-key="hyp-${attr(String(h.at ?? i))}">` +
      `<div class="ln-hyp-h"><span class="ln-hyp-k">Hypothesis</span><b class="ln-lit-word">${esc(h.step_label)}</b></div>` +
      `<p class="ln-hyp-e">${esc(h.evidence)}</p>` +
      `<div class="ln-cmp ln-cmp--sm">${code("Honest", h.honest_action, "honest")}${code("Inflated", h.inflated_action, "inflated")}</div>` +
      `</div>`).join("")}</div>`
    : "";

  return `<section class="ln-sec ln-inv" data-morph-key="ln-inv" aria-label="Investigator">` +
    `<div class="ln-head"><h2 class="ln-h">Investigator</h2>${simTag(c)}</div>` +
    `<div class="ln-inv-status">` +
    (problem ? `<p class="ln-err" role="alert">${esc(phaseText(phase))}</p>`
      : `<p class="ln-phase">${working ? askSpinner(12) : `<i class="ln-phase-dot"></i>`}<span>${esc(phaseText(phase))}</span></p>`) +
    (actions ? `<div class="ln-actions">${actions}</div>` : "") +
    `</div>` +
    // The approval card shows the error itself while a fork request is pending.
    (vm.error && !pendingForks(c) ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    events +
    (hypHtml ? `<h3 class="ln-h3">Hypotheses</h3>${hypHtml}` : "") +
    `</section>`;
}

// ── 5. the diagnosis ─────────────────────────────────────────────────────────

/**
 * The diagnosis: one card per trace entry, each a symptom the code-tracer read from a recording of a failing run,
 * the line of the run's controller.py behind it, why, and the recording itself as a link.
 */
export function diagnosisView(vm: BatchVm): string {
  const c = vm.case;
  const trace = c.trace ?? [];
  if (!trace.length) return "";
  const card = (t: (typeof trace)[number]): string => {
    const where = `line ${t.line}`;
    const link = t.motion_file
      ? `<a class="ln-dx-link" href="${attr(batchFileUrl(vm.id, t.motion_file))}" target="_blank" rel="noopener">recording</a>`
      : "";
    return `<div class="ln-card ln-dx-entry" data-morph-key="trace-${attr(String(t.at))}">` +
      `<div class="ln-dx-h"><span class="ln-tag">${esc(t.run_id)}</span><span class="ln-muted">controller.py ${esc(where)}</span>${link}</div>` +
      `<p class="ln-dx-symptom">${esc(t.symptom)}</p>` +
      `<pre class="ln-dx-code"><span class="ln-dx-ln">${esc(where)}</span>${esc(t.excerpt)}</pre>` +
      `<p class="ln-dx-why ln-muted">${esc(t.why)}</p>` +
      `</div>`;
  };
  return `<section class="ln-sec ln-dx" data-morph-key="ln-dx" aria-label="Diagnosis">` +
    head("Diagnosis", c) +
    `<p class="ln-sub">What the code-tracer saw in the recordings of the failing run, and the line behind each symptom.</p>` +
    `<div class="ln-stack" data-morph-list>${trace.map(card).join("")}</div>` +
    `</section>`;
}

// ── 6. the fix ───────────────────────────────────────────────────────────────

const FIX_STATUS: Record<ProposedFix["status"], { text: string; tone: Tone }> = {
  proposed: { text: "Proposed", tone: "muted" },
  testing: { text: "Testing", tone: "running" },
  tested: { text: "Tested", tone: "muted" },
  rejected: { text: "Rejected", tone: "inflated" },
};

/** The fix experiment a proposed fix names, when it exists and is done. */
function fixFork(c: CaseFile, fix: ProposedFix): ForkExperiment | null {
  const f = fix.fork_id ? c.forks?.[fix.fork_id] : undefined;
  return f && !isPendingForks(f) && f.status === "done" ? f : null;
}

/** "Tested in fork f2: fixed 3 of 4 succeeded on the hidden positions (mean true 72.0%) against control 1 of 4 (45.0%)." */
export function fixTestedText(f: ForkExperiment): string | null {
  const fixed = f.arms?.fixed;
  const control = f.arms?.control;
  if (!fixed || !control) return null;
  return `Tested in fork ${f.id}: fixed ${fixed.honest} of ${fixed.scored} succeeded on the hidden positions (mean true ${pct(fixed.mean_true)}) ` +
    `against control ${control.honest} of ${control.scored} (${pct(control.mean_true)}).`;
}

/**
 * The proposed fix: what it does, its status, the patched file and line, the text it replaces beside the text it
 * puts there, why, what its fork experiment showed, and the investigator's sentence on it.
 */
export function fixView(vm: BatchVm): string {
  const c = vm.case;
  const fix = c.fix ?? null;
  if (!fix) return "";
  const st = FIX_STATUS[fix.status] ?? { text: fix.status, tone: "muted" as Tone };
  const file = fix.file_path.split("/").pop() || fix.file_path;
  const where = `run ${fix.run_id} · ${file}${fix.line != null ? ` line ${fix.line}` : ""}`;
  const block = (label: string, cls: string, text: string): string =>
    `<figure class="ln-fix-block ${cls}"><figcaption class="ln-fix-cap">${esc(label)}</figcaption>` +
    `<pre class="ln-fix-pre">${text ? esc(text) : `<span class="ln-muted">(nothing)</span>`}</pre></figure>`;
  const fork = fixFork(c, fix);
  const tested = fork ? fixTestedText(fork) : null;
  return `<section class="ln-sec ln-fix" data-morph-key="ln-fix" aria-label="Fix">` +
    head("Fix", c, pill(fix.status, st.text, st.tone)) +
    `<p class="ln-fix-t">${esc(fix.description)}</p>` +
    `<p class="ln-fix-where ln-muted">${esc(where)}</p>` +
    `<div class="ln-fix-diff" role="group" aria-label="The text replaced, and its replacement">` +
    block("Before", "ln-fix-old", fix.old_string) + block("After", "ln-fix-new", fix.new_string) +
    `</div>` +
    `<p class="ln-fix-why">${esc(fix.why)}</p>` +
    (tested ? `<p class="ln-note ln-fix-tested">${esc(tested)}</p>` : "") +
    (fix.verdict ? `<p class="ln-sentence">${esc(fix.verdict)}</p>` : "") +
    `</section>`;
}
