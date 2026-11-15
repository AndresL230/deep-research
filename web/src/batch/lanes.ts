// OWNER: subagent C. What changed (the split), the fork experiment, the verdict, the investigator's panel, the
// diagnosis (where in the code a failure comes from) and the proposed fix.
//
// Every export is a pure `(vm) => html` function that returns "" until its state is reached, so main.ts can stack
// them unconditionally. Classes are prefixed `ln-`; the look lives in lanes.css. The notebooks in "What changed" are
// notebook.ts cells and wear its `nb-` classes.
import "./lanes.css";
import {
  batchFileUrl, isPendingForks, notebookUrl, type AgentEvent, type ArmSummary, type BatchConfig, type CaseFile, type ForkArm, type ForkChild,
  type Benchmark, type FixEvidence, type FixMeasured, type ForkExperiment, type ForkMode, type Hypothesis, type MeasuredRate, type PendingForks, type ProposedFix, type RubricCheck, type RunRecord, type SplitFinding, type TrapInfo,
  type Verdict,
} from "../api";
import { askIcon } from "../ask-icons";
import { badge, chip, count, reveal, spinner, type ChipMark, type ChipTone } from "../motion";
import { attr, esc } from "../ui";
import { duration, pct, pts, usd, wholePct } from "./format";
import { benchmarkMapView } from "./checked";
import { ACT, childKey, type BatchVm } from "./model";
import { codeKind, highlightLines } from "./highlight";
import { LABEL_PATTERNS, cellView, chartUrl, counts, logOf, notebookCells, parseCommand, type NbCell } from "./notebook";
import { evidenceParts, trapMark, trapOf, type Mark } from "./trap";
import { isMotionBatch, motionName, robotThumb, scoreWords, type ScoreWords } from "../robot/markup";
import {
  AGREE, DISAGREE, INCONCLUSIVE_NOTE, NEEDED_PAIRS, RULE, RULE_TEXT, SUPPORTED_SCORE, causeWords, ceilingText, compare, evidenceFrom, fmtFrac, forkEvidence, isDone, isDropped, isPending, kOfN, nHidden,
  verdictFork, type Comparison, type Evidence, type Level, type Pair,
} from "./evidence";
import { bestMotion, copyStory, forcedCheck, forcedEvent, investigatorCounts, type StepTest } from "./forkread";
import { scoreStep, sourceStrip, tableMap } from "./trial-charts";
import { TABULAR_WORDS, capital, domainWords, judgedOn, stepText } from "./words";
import type { DomainWords, TraceEntry } from "../api";
import { ADMIN_ONLY } from "../access";
import { changeText, pairDots, predictionText, scoreBar, scoreText, simTag, suspectPending } from "./suspects";

export { NEEDED_PAIRS } from "./evidence";

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

/** "3 of 4 inflated, mean reported 87.8% vs true 73.5%" (plus failed runs when any). `words` names the two numbers:
 *  a robot batch's say "claimed" and "measured". */
export function armSummaryText(a: ArmSummary, words: Pick<DomainWords, "claim_label" | "truth_label"> = TABULAR_WORDS): string {
  // Robot arms count unclear children on their own, outside `scored`.
  const nUnclear = (a as ArmSummary & { unclear?: number }).unclear;
  const failed = (nUnclear ? `, ${nUnclear} unclear` : "") + (a.failed ? `, ${a.failed} failed` : "");
  const means = a.mean_reported != null || a.mean_true != null
    ? `, mean ${words.claim_label.toLowerCase()} ${pct(a.mean_reported)} vs ${words.truth_label.toLowerCase()} ${pct(a.mean_true)}` : "";
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
    case "motion": return { kind: "motion", text: clip(`Saved an episode: ${ev.path.split("/").at(-1) ?? ev.path}`, 120) };
    case "caption": return { kind: "caption", text: clip(ev.text, 120) };
  }
}

/** "3 of 4 claims matched what was measured, mean measured 72.0% vs control 45.0%": a fix experiment's arm, where
 *  what matters is the measured rate, not the inflation. An honest copy is one whose claim matched what was measured,
 *  which is not the same as one that succeeded, so it is worded as that. `control` is the arm it is measured against
 *  (left out for the control arm itself, or when there is none). */
export function fixSummaryText(a: ArmSummary, control: ArmSummary | null = null): string {
  const failed = a.failed ? `, ${a.failed} failed` : "";
  const vs = control && control !== a && control.mean_true != null ? ` vs control ${pct(control.mean_true)}` : "";
  return `${a.honest} of ${a.scored} claims matched what was measured${failed}, mean measured ${pct(a.mean_true)}${vs}`;
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

// ── small pieces ─────────────────────────────────────────────────────────────

type Tone = "honest" | "inflated" | "unclear" | "failed" | "running" | "muted";

const toneOf = (status: string): Tone =>
  status === "honest" || status === "inflated" || status === "unclear" || status === "failed" ? status
    : status === "running" || status === "starting" ? "running" : "muted";

/** Each tone as a status chip (system.css): its colour and its mark. */
const TONE_CHIP: Record<Tone, [ChipTone, ChipMark]> = {
  honest: ["ok", "check"], inflated: ["bad", "alert"], unclear: ["idle", "hold"], failed: ["idle", "cross"], running: ["live", "spin"], muted: ["idle", "dot"],
};

const pill = (status: string, text = status, tone: Tone = toneOf(status)): string =>
  chip(capital(text), TONE_CHIP[tone][0], TONE_CHIP[tone][1], `ln-pill ln-pill--${tone}`);

/** The arrow on the one button to press next; it moves a little under the pointer. */
const GO = `<span class="ds-primary-go">${askIcon("arrow", 13, null, 2)}</span>`;

// A simulated batch says so once, in the page header (home.ts costBar), not on every section.
const head = (title: string, extra = ""): string =>
  `<div class="ln-head"><h2 class="ln-h">${esc(title)}</h2>${extra}</div>`;

// Each section shows its key points and keeps its detail folded until asked for. A fold has a key; the page keeps
// what the person opened or closed (`BatchVm.open`), and a fold nobody touched takes its own default.
const isOpen = (vm: BatchVm, key: string, byDefault = false): boolean =>
  vm.open === "all" ? true : vm.open?.[key] ?? byDefault;

/** A fold's button: "Show the 12 copies" / "Hide the 12 copies". The caller renders the folded part only when open.
 *  It is the outlined button the run page's "Show the agent's work" is (run.ts `workStrip`), with the chevron the New
 *  batch form's Advanced toggle turns (home.ts). */
const foldButton = (key: string, open: boolean, what: string): string =>
  `<button type="button" class="ln-fold ask-ghostbtn ask-ghostbtn--outline" data-morph-key="fold-${attr(key)}" data-act="${ACT.fold}" data-arg="${attr(key)}" aria-expanded="${open}">` +
  `${askIcon("chevRight", 13)}${esc(`${open ? "Hide" : "Show"} ${what}`)}</button>`;

const code = (label: string, text: string | null, tone: Tone): string =>
  `<figure class="ln-code ln-code--${tone}"><figcaption class="ln-code-cap"><i class="ln-pill-dot"></i>${esc(label)}</figcaption>` +
  `<pre class="ln-code-pre">${text ? esc(text) : `<span class="ln-muted">No example</span>`}</pre></figure>`;

const runLabels = (c: CaseFile, r: RunRecord): string[][] => (r.labels ?? c.step_labels?.[r.id] ?? []) as string[][];

// ── 0. the key points ────────────────────────────────────────────────────────

export interface KeyPoint {
  /** Which point it is, for the list's keys: "best", "step", "fails", "fix". */
  id: string;
  /** Its short name: "Best run". */
  label: string;
  text: string;
  /** Green for a result that went up, red for one that went down; muted otherwise. */
  tone: Tone;
}

const NOT_OVER = new Set(["queued", "starting", "running"]);
// A sentence cut short already ends in an ellipsis: no full stop after it.
const sentence = (s: string): string => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const idList = (ids: readonly string[]): string =>
  ids.length <= 2 ? ids.join(" and ") : `${ids.slice(0, 2).join(", ")} and ${ids.length - 2} more`;

/**
 * What the batch found, one line each, as far as it has got: the best run against where the runs started, the step
 * that separates honest from inflated runs and how far the fork backs it, where the code fails, and what the fix
 * did. Everything here is said in full, with its evidence, in the section below it.
 */
export function keyPoints(c: CaseFile): KeyPoint[] {
  const out: KeyPoint[] = [];
  const words = domainWords(c.config);
  const truth = words.truth_label.toLowerCase();
  const runs = Object.values(c.runs ?? {}).sort(byId);

  // The best run by what was measured, never by what it claimed. Only once every run is over.
  const measured = runs.filter((r) => r.true_accuracy != null);
  if (measured.length && !runs.some((r) => NOT_OVER.has(r.status))) {
    const best = Math.max(...measured.map((r) => r.true_accuracy as number));
    const ids = measured.filter((r) => (r.true_accuracy as number) >= best - 1e-9).map((r) => r.id);
    const base = c.baseline?.status === "scored" ? c.baseline.true_accuracy ?? null : null;
    const from = base == null ? "" : ` The runs started from ${c.baseline!.name} at ${wholePct(base)}.`;
    out.push({ id: "best", label: ids.length === 1 ? "Best run" : "Best runs", text: `${idList(ids)}: ${truth} ${wholePct(best)}.${from}`,
      tone: base != null && best > base + UP ? "honest" : base != null && best < base - UP ? "inflated" : "muted" });
  }

  // The step, and how far the fork experiment backs it as the cause.
  if (c.split) {
    const line = splitHeadline(c.split, trapOf(c), words);
    const ev = c.verdict ? verdictEvidence(c) : null;
    const backed = !ev ? "" : ev.level === "supported" ? " The fork experiment supports this as the cause." : " The fork experiment does not settle whether this is the cause.";
    out.push({ id: "step", label: "What differed", text: `${line.honest} ${line.inflated}${backed}`, tone: "muted" });
  } else if (c.phase === "no_split") {
    out.push({ id: "step", label: "What differed", text: "No step separates honest and inflated runs.", tone: "muted" });
  }

  // Where the code fails: the first traced symptom and its line.
  const trace = c.trace ?? [];
  if (trace.length) {
    const t = trace[0];
    const more = trace.length > 1 ? ` ${trace.length - 1} more below.` : "";
    out.push({ id: "fails", label: "Where it fails", text: `${sentence(clip(t.symptom, 160))} Run ${t.run_id}, line ${t.line}.${more}`, tone: "muted" });
  }

  // The same controllers on another test set, beside the hidden test.
  const bench = benchRows(c).filter((r) => r.kind === "run" && r.bench);
  if (bench.length) {
    const span = (xs: number[]): string => {
      const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
      return hi - lo < UP ? wholePct(hi) : `${wholePct(lo)} to ${wholePct(hi)}`;
    };
    const own = bench.filter((r) => r.measured != null).map((r) => r.measured as number);
    const n = bench[0].bench!.n;
    out.push({ id: "bench", label: BENCH_NAME.libero_pro, tone: "muted",
      text: `At ${n ?? "the"} positions LIBERO-PRO moves the object to, ${bench.length === 1 ? "the controller passes" : `the ${bench.length} controllers pass`} ` +
        `${span(bench.map((r) => r.bench!.true_accuracy))}.` + (own.length ? ` On the hidden test, over the whole table: ${span(own)}.` : "") });
  }

  // The fix and what it measured.
  const fix = c.fix;
  if (fix) {
    const what = sentence(fix.description || "A fix was proposed");
    const m = fix.measured;
    const fork = fixFork(c, fix);
    const [before, after] = m ? [m.before.true_accuracy, m.after.true_accuracy]
      : [fork?.arms?.control?.mean_true ?? null, fork?.arms?.fixed?.mean_true ?? null];
    const result = before != null && after != null
      ? `${capital(truth)} ${wholePct(before)} without it, ${wholePct(after)} with it${m ? "" : ", in fork copies"}.`
      : fix.status === "testing" ? "Being tested." : fix.status === "tested" ? "Tested: see the result below." : "Not tested yet.";
    const raised = m?.exceptions.length ? " The patched code raised an error." : "";
    const tone: Tone = raised || (before != null && after != null && after < before - UP) ? "inflated"
      : before != null && after != null && after > before + UP ? "honest" : "muted";
    out.push({ id: "fix", label: "Fix", text: `${what} ${result}${raised}`, tone });
  }
  return out;
}

// ── the other test sets ─────────────────────────────────────────────────────

/** A test set's name on the screens. */
export const BENCH_NAME: Record<string, string> = { libero_pro: "LIBERO-PRO" };

export interface BenchRow {
  kind: "start" | "run";
  /** The run's id, or the starting code's file name. */
  id: string;
  status: string | null;
  claimed: number | null;
  /** On the batch's own hidden test. */
  measured: number | null;
  bench: Benchmark | null;
}

/** The starting code and every scored run, each with its rate on the hidden test and on `name`'s test set. Empty
 *  when nothing in the batch was measured on it. */
export function benchRows(c: CaseFile, name = "libero_pro"): BenchRow[] {
  const rows: BenchRow[] = [];
  const b = c.baseline;
  if (b?.status === "scored") rows.push({ kind: "start", id: b.name, status: null, claimed: null, measured: b.true_accuracy ?? null, bench: b.benchmarks?.[name] ?? null });
  for (const r of Object.values(c.runs ?? {}).sort(byId)) {
    if (r.true_accuracy == null && !r.benchmarks?.[name]) continue;
    rows.push({ kind: "run", id: r.id, status: r.status, claimed: r.reported_accuracy ?? null, measured: r.true_accuracy ?? null, bench: r.benchmarks?.[name] ?? null });
  }
  return rows.some((r) => r.bench) ? rows : [];
}

/**
 * LIBERO-PRO beside the hidden test: one row per controller, its rate on the batch's own hidden test and at the
 * positions LIBERO-PRO moves LIBERO's object to. A second number: a run's status comes from the hidden test alone.
 */
export function benchmarkView(vm: BatchVm): string {
  const c = vm.case;
  const rows = benchRows(c);
  if (!rows.length) return "";
  const words = domainWords(c.config);
  const share = (x: number | null): string => (Math.max(0, Math.min(1, x ?? 0)) * 100).toFixed(1);
  const cell = (x: number | null, of: string, cls: string): string => x == null
    ? `<td class="ln-bm-c ln-muted">not measured</td>`
    : `<td class="ln-bm-c"><span class="ln-bm-bar"><span class="ln-track"><i class="ln-fill ${cls}" style="width:${share(x)}%"></i></span>` +
      `<b class="ln-bm-v">${esc(wholePct(x))}</b>${of ? `<span class="ln-muted">${esc(of)}</span>` : ""}</span></td>`;
  // One controller's episodes on the table at a time, each replayable in 3D: the first that has them, until the
  // person opens another (a fold per row).
  const first = rows.find((r) => r.bench?.results?.length);
  const row = (r: BenchRow): string => {
    const of = r.bench && r.bench.successes != null && r.bench.n != null ? `${r.bench.successes} of ${r.bench.n}` : "";
    const who = r.kind === "start" ? `<span class="ln-muted">Start</span> ${esc(r.id)}` : `<b>${esc(r.id)}</b>${r.status ? pill(r.status) : ""}`;
    const key = `bm:${r.kind}:${r.id}`;
    const has = !!r.bench?.results?.length;
    const open = has && isOpen(vm, key, r === first);
    return `<tr class="ln-bm-r" data-morph-key="bm-${attr(r.kind)}-${attr(r.id)}"><th scope="row" class="ln-bm-who">${who}</th>` +
      `<td class="ln-bm-c ln-bm-claim">${r.claimed == null ? "" : esc(wholePct(r.claimed))}</td>` +
      cell(r.measured, "", "ln-fill--true") + cell(r.bench?.true_accuracy ?? null, of, "") +
      `<td class="ln-bm-see">${has ? foldButton(key, open, "on the table") : ""}</td></tr>` +
      (open ? `<tr class="ln-bm-map" data-morph-key="bm-map-${attr(r.kind)}-${attr(r.id)}"><td colspan="5">` +
        benchmarkMapView(vm.id, key, r.bench, "LIBERO-PRO") + `</td></tr>` : "");
  };
  const sample = rows.find((r) => r.bench)!.bench!;
  const sources = Object.entries(sample.by_source ?? {}).map(([k, v]) => `${v.n} from its ${k}`).join(", ");
  return `<section class="ln-sec ln-bm" data-morph-key="ln-bm" aria-label="LIBERO-PRO">` +
    head("LIBERO-PRO positions") +
    `<p class="ln-sub">The same controllers with the can where the LIBERO-PRO benchmark moves LIBERO's object: ${sample.n ?? "its"} positions` +
    `${sources ? ` (${esc(sources)})` : ""}, placed in LIBERO's basket spot. A second number. Each run's status still comes from the hidden test, which covers the whole table.</p>` +
    `<table class="ln-bm-t"><thead><tr><th scope="col">Controller</th><th scope="col">${esc(words.claim_label)}</th>` +
    `<th scope="col">${esc(words.truth_label)}, hidden test</th><th scope="col">LIBERO-PRO</th><th scope="col"><span class="mo-sr">Watch</span></th></tr></thead>` +
    `<tbody data-morph-list>${rows.map(row).join("")}</tbody></table>` +
    `</section>`;
}

/** The key points as a short list under the runs. Empty until there is one to give. */
export function keyPointsView(vm: BatchVm): string {
  const points = keyPoints(vm.case);
  if (!points.length) return "";
  return `<section class="ln-sec ln-kp" data-morph-key="ln-kp" aria-label="Key points">` +
    head("Key points") +
    `<dl class="ln-kp-list" data-morph-list>${points.map((p) =>
      `<div class="ln-kp-row ln-kp-row--${p.tone}" data-morph-key="kp-${attr(p.id)}"><dt class="ln-kp-k"><i class="ln-pill-dot"></i>${esc(p.label)}</dt>` +
      `<dd class="ln-kp-v">${esc(p.text)}</dd></div>`).join("")}</dl>` +
    `</section>`;
}

// ── 1. what changed ──────────────────────────────────────────────────────────

interface StepWords {
  /** Past tense, after "Honest runs": "removed duplicate rows". */
  did: string;
  /** The empty slot on the side that skipped the step. */
  missing: string;
}

/**
 * The words for a step label: the batch trap's own when the label is its step, else the domain's (words.ts), else
 * generic ones for a label nobody describes. Never the raw label.
 */
export function stepWords(label: string, trap: TrapInfo | null = null, words: DomainWords = TABULAR_WORDS): StepWords {
  const { did, missing } = stepText(label, words, trap);
  return { did, missing };
}

/** What the run does at the anchor step, after "Then it": "split into train and test", "wrote the report". */
const anchorDid = (words: DomainWords): string =>
  (words.steps.split ?? words.steps.write_report ?? { did: "wrote the report" }).did;

/** What marks a step in code, for the highlight: the batch trap's pattern for its own step, else the table's. */
export function stepMark(label: string, trap: TrapInfo | null = null): Mark | null {
  return trapMark(trap, label) ?? LABEL_PATTERNS[label] ?? null;
}

const ALL = 0.995;
const NONE = 0.005;

/** "Honest runs removed duplicate rows before splitting into train and test. Inflated runs did not." */
export function splitHeadline(
  s: Pick<SplitFinding, "label" | "honest_rate" | "inflated_rate">, trap: TrapInfo | null = null, words: DomainWords = TABULAR_WORDS,
): { honest: string; inflated: string } {
  const h = s.honest_rate;
  const i = s.inflated_rate;
  const who = h >= ALL ? "Honest runs" : h > 0.5 ? "Most honest runs" : h > NONE ? "Some honest runs" : "No honest run";
  const too = h > NONE ? " too" : "";
  const inflated = i <= NONE ? (h > NONE ? "Inflated runs did not." : "Neither did inflated runs.")
    : i < 0.5 ? "Most inflated runs did not."
      : i < ALL ? `Most inflated runs did${too}.` : `Inflated runs did${too}.`;
  return { honest: `${who} ${stepWords(s.label, trap, words).did} ${words.step_when}.`, inflated };
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
  n > 0 ? `<p class="ln-skip">${n} ${where === "between" ? "more" : where} command${n === 1 ? "" : "s"}</p>` : "";

/** One block of a screen's detail: a heading, one grey line that says how to read the picture, then the picture. */
const block = (key: string, title: string, sub: string, body: string): string =>
  `<div class="ln-blk" data-morph-key="blk-${key}"><h3 class="ln-h3">${title}</h3>${sub ? `<p class="ln-h3-s">${sub}</p>` : ""}${body}</div>`;

const GROUP_NAME: Record<Group, string> = { honest: "Honest", inflated: "Inflated" };

/**
 * One run as a column of six rows, so the two columns line up: its name, the cells before, the step (or the empty
 * slot), the cells between, the cell that splits, the cells after.
 */
function column(vm: BatchVm, s: Side, group: Group, split: SplitFinding, splitInBand: boolean): string {
  const trap = trapOf(vm.case);
  const mark = stepMark(split.label, trap);
  const dw = domainWords(vm.case.config);
  const words = stepWords(split.label, trap, dw);
  const { code } = s;
  const n = (c: NbCell): number | null => s.num.get(c.key) ?? null;
  const id = s.id;

  const scores = s.rec && (s.rec.reported_accuracy != null || s.rec.true_accuracy != null)
    ? `<span class="ln-col-n">${esc(dw.claim_label.toLowerCase())} <b>${esc(pct(s.rec.reported_accuracy))}</b>, ${esc(dw.truth_label.toLowerCase())} <b>${esc(pct(s.rec.true_accuracy))}</b></span>` : "";
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
      `<span class="ln-missing-s">${esc(dw.skipped)}.</span></div>`;
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
    row("split", splitRow ? `<p class="ln-cap">Then it ${esc(anchorDid(dw))}</p>${splitRow}` : "") +
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

/** A share of the bar track, 0 to 100, for a success rate on the whole 0% to 100% axis. */
const rateShare = (x: number | null | undefined): number =>
  x == null || Number.isNaN(x) ? 0 : Number((Math.max(0, Math.min(1, x)) * 100).toFixed(1));

/**
 * Reported against true accuracy as two bars on one axis: 50% to 100% for accuracy ("acc"), where 50% is a coin flip,
 * and 0% to 100% for a robot's success rate ("rate"), which can be anywhere. The part of the reported bar past the
 * true value is hatched: that is the part that is not real.
 * `words`: the batch's labels for the two numbers (robot/markup.ts scoreWords): "Claimed" and "Measured".
 */
function scoreBars(s: Pick<ScoreStats, "reported" | "true" | "gap">, group: Group, words: { reported: string; true: string }, axis: "acc" | "rate" = "acc"): string {
  const kRep = words.reported;
  const kTrue = words.true;
  const share = axis === "rate" ? rateShare : barShare;
  const rep = share(s.reported);
  const tru = share(s.true);
  const solid = s.true == null ? rep : Math.min(rep, tru);
  const over = Math.max(0, rep - solid);
  const gap = s.gap;
  const [lr, lt] = [kRep.toLowerCase(), kTrue.toLowerCase()];
  const word = gap == null ? "" : gap >= 0.005 ? `${lr} above ${lt}` : gap <= -0.005 ? `${lr} below ${lt}` : `${lr} matches ${lt}`;
  const label = `${kRep} ${pct(s.reported)}, ${lt} ${pct(s.true)}${gap != null ? `, gap ${pts(gap)}` : ""}`;
  return `<div class="ln-score ln-score--${group}">` +
    `<div class="ln-bars" role="img" aria-label="${attr(label)}">` +
    `<span class="ln-bar-k">${esc(kRep)}</span><span class="ln-track" title="${attr(`${kRep} ${pct(s.reported)}`)}">` +
    `<i class="ln-fill ds-grow-x" style="width:${solid}%"></i>${over > 0 ? `<i class="ln-over" style="left:${solid}%;width:${over.toFixed(1)}%"></i>` : ""}</span>` +
    `<span class="ln-bar-v">${count(s.reported, "pct", pct(s.reported))}</span>` +
    `<span class="ln-bar-k">${esc(kTrue)}</span><span class="ln-track" title="${attr(`${kTrue} ${pct(s.true)}`)}"><i class="ln-fill ln-fill--true ds-grow-x" style="width:${tru}%;--mo-d:150ms"></i></span>` +
    `<span class="ln-bar-v">${count(s.true, "pct", pct(s.true))}</span>` +
    `<span class="ln-axis" aria-hidden="true"><span>${axis === "rate" ? "0%" : "50%"}</span><span>100%</span></span>` +
    `</div>` +
    (gap != null ? `<p class="ln-gap"><b class="ln-gap-n">${count(gap, "pts", pts(gap))}</b><span class="ln-gap-w">${word}</span></p>` : "") +
    `</div>`;
}

/** What the step did to the score: per group, reported against true, and how much of the test set leaked. */
function consequence(c: CaseFile): string {
  const runs = Object.values(c.runs ?? {});
  const words = domainWords(c.config);
  const sw = scoreWords(c.config);
  // A robot's success rate can be anywhere from 0% to 100%; an accuracy on two classes starts at 50%.
  const axis = isMotionBatch(c.config) ? "rate" : "acc";
  const stats = (g: Group): ScoreStats => scoreStats(runs.filter((r) => r.status === g));
  // Left out when there is no number: the trap has no evidence, or these runs did not keep what it is read from.
  const evidence = (g: Group) => evidenceParts(stats(g).overlap, trapOf(c), words.evidence_text ?? "");
  // The evidence line is there to tell the groups apart. When both groups show the same share it tells nothing.
  const [eh, ei] = [evidence("honest"), evidence("inflated")];
  const same = !!eh && !!ei && eh.share === ei.share;
  const group = (g: Group): string => {
    const s = stats(g);
    if (!s.n) return "";
    const ev = same ? null : g === "honest" ? eh : ei;
    const leak = ev ? `<p class="ln-leak"><b>${esc(ev.share)}</b> ${esc(ev.text)}</p>` : "";
    return `<div class="ln-grp ln-grp--${g}" data-io data-morph-key="grp-${g}">` +
      `<div class="ln-grp-h"><i class="ln-pill-dot"></i><span class="ln-grp-t">${GROUP_NAME[g]} runs</span><span class="ln-muted">${s.n}</span></div>` +
      scoreBars(s, g, sw, axis) + leak + `</div>`;
  };
  const html = group("honest") + group("inflated");
  const how = `${esc(sw.reported)} against ${esc(sw.true.toLowerCase())}, averaged over each group. The striped part was ${esc(sw.reported.toLowerCase())} and not ${esc(sw.true.toLowerCase())}.`;
  return html ? block("cons", "What it did to the score", how, `<div class="ln-cons">${html}</div>`) : "";
}

/** Every run as one small bar (reported accuracy, with a line at the true one). The two shown above are outlined. */
function runStrip(c: CaseFile, shown: readonly (string | null)[]): string {
  const runs = Object.values(c.runs ?? {}).sort(byId);
  if (!runs.length) return "";
  const words = domainWords(c.config);
  const [claim, truth] = [words.claim_label.toLowerCase(), words.truth_label.toLowerCase()];
  // An unclear run is scored: it is called Unclear here as on its tile. "Not scored" is only for runs with no score.
  const groups: { tone: Tone; title: string; runs: RunRecord[] }[] = [
    { tone: "honest", title: "Honest", runs: runs.filter((r) => r.status === "honest") },
    { tone: "inflated", title: "Inflated", runs: runs.filter((r) => r.status === "inflated") },
    { tone: "unclear", title: "Unclear", runs: runs.filter((r) => r.status === "unclear") },
    { tone: "failed", title: "Failed", runs: runs.filter((r) => r.status === "failed") },
    { tone: "muted", title: "Not scored", runs: runs.filter((r) => !["honest", "inflated", "unclear", "failed"].includes(r.status)) },
  ];
  let nth = 0;
  const motion = isMotionBatch(c.config);
  const share = motion ? rateShare : barShare;
  const one = (r: RunRecord, tone: Tone): string => {
    const is = shown.includes(r.id);
    const scored = r.reported_accuracy != null || r.true_accuracy != null;
    const title = `${r.id}, ${r.status}${scored ? `: ${claim} ${pct(r.reported_accuracy)}, ${truth} ${pct(r.true_accuracy)}` : ""}${is ? ". Shown above" : ""}`;
    return `<button type="button" class="ln-run ln-run--${tone}${is ? " is-shown" : ""}" data-morph-key="run-${attr(r.id)}" data-act="${ACT.openRun}" data-arg="${attr(r.id)}" title="${attr(title)}" aria-label="${attr(`${title}. Open the run.`)}">` +
      `<span class="ln-run-track">` +
      (r.reported_accuracy != null ? `<i class="ln-run-bar ds-grow-y" style="height:${share(r.reported_accuracy)}%;--mo-d:${nth++ * 40}ms"></i>` : "") +
      (r.true_accuracy != null ? `<i class="ln-run-true" style="bottom:${share(r.true_accuracy)}%"></i>` : "") +
      `</span><span class="ln-run-id">${esc(r.id)}</span></button>`;
  };
  const body = groups.filter((g) => g.runs.length).map((g) =>
    `<div class="ln-strip-g ln-strip-g--${g.tone}" data-morph-key="strip-${g.tone}">` +
    `<span class="ln-strip-t"><i class="ln-pill-dot"></i>${g.title} <span class="ln-muted">${g.runs.length}</span></span>` +
    `<div class="ln-strip-runs" data-morph-list>${g.runs.map((r) => one(r, g.tone)).join("")}</div></div>`).join("");
  const marked = shown.some((id) => id != null) ? " The two outlined runs are the ones shown above." : "";
  const how = `One bar for each run. Bar: ${esc(claim)}. Line across it: ${esc(truth)}. Scale ${motion ? "0%" : "50%"} to 100%.${marked}`;
  return block("strip", `All ${runs.length} runs`, how, `<div class="ln-strip" data-io data-morph-list>${body}</div>`);
}

/** One step of the tracks: how many honest and inflated runs took it, out of how many. */
export interface StepRow {
  label: string;
  honest: [did: number, of: number];
  inflated: [did: number, of: number];
  /** "split": the step the finding names. "differs": another step most of one group took and most of the other
   *  did not. "shared": both groups took it, or neither did. */
  kind: "split" | "differs" | "shared";
}

/**
 * Every step the honest and inflated runs took, in the order the runs reached them (a step's place is where it first
 * comes in a run, averaged over the runs that have it), with how many runs of each group took it. The step the
 * finding names carries the finding's own counts, which only count the step done in time (`step_when`).
 */
export function stepRows(c: CaseFile): StepRow[] {
  const split = c.split;
  const runs = Object.values(c.runs ?? {});
  const groups: Record<Group, RunRecord[]> = { honest: runs.filter((r) => r.status === "honest"), inflated: runs.filter((r) => r.status === "inflated") };
  const place = new Map<string, { sum: number; n: number }>();
  for (const r of [...groups.honest, ...groups.inflated]) {
    const labels = runLabels(c, r);
    const first = new Map<string, number>();
    labels.forEach((a, i) => a.forEach((l) => { if (!first.has(l)) first.set(l, labels.length > 1 ? i / (labels.length - 1) : 0); }));
    for (const [l, at] of first) {
      const p = place.get(l) ?? { sum: 0, n: 0 };
      place.set(l, { sum: p.sum + at, n: p.n + 1 });
    }
  }
  // A finding whose step no saved run carries a label for (labels absent from the case) still gets its row.
  if (split && !place.has(split.label)) place.set(split.label, { sum: 0.5, n: 1 });
  const took = (g: Group, label: string): [number, number] =>
    [groups[g].filter((r) => runLabels(c, r).some((a) => a.includes(label))).length, groups[g].length];
  const share = ([k, n]: [number, number]): number => (n ? k / n : 0);
  return [...place.entries()]
    .sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n)
    .map(([label]) => {
      if (split && label === split.label) {
        return {
          label, kind: "split" as const,
          honest: [Math.round(split.honest_rate * split.n_honest), split.n_honest] as [number, number],
          inflated: [Math.round(split.inflated_rate * split.n_inflated), split.n_inflated] as [number, number],
        };
      }
      const honest = took("honest", label);
      const inflated = took("inflated", label);
      return { label, honest, inflated, kind: Math.abs(share(honest) - share(inflated)) >= 0.5 ? "differs" as const : "shared" as const };
    });
}

/** The most marks one stop draws: a run each, up to this many. */
const LANE_MARKS = 24;

/**
 * What changed, as one picture: two tracks, one per group, running from the first step to the last. Every step is a
 * dot with no words (its name is one hover away), filled when most of that group took it. The step the finding names
 * is the one stop drawn large on both tracks: one mark per run, filled when the run took the step, and the count.
 * Its name is said once, over the stop.
 */
function stepLanes(c: CaseFile, words: DomainWords, trap: TrapInfo | null): string {
  const rows = stepRows(c);
  const at = rows.findIndex((r) => r.kind === "split");
  if (at < 0) return "";
  const focus = rows[at];
  const name = (label: string): string => capital(stepText(label, words, trap).did);
  const dots = (g: Group, part: StepRow[]): string =>
    `<span class="ln-lane-seg">${part.map((r) => {
      const [k, n] = r[g];
      const on = n > 0 && k / n >= 0.5;
      const tip = `${name(r.label)}: ${k} of ${n} ${g} runs`;
      return `<i class="ln-lane-dot${on ? "" : " is-off"}" title="${attr(tip)}"></i>`;
    }).join("")}</span>`;
  const stop = (g: Group): string => {
    const [k, n] = focus[g];
    const marks = n <= LANE_MARKS ? `<span class="ln-lane-marks" aria-hidden="true">${`<i class="is-on"></i>`.repeat(k)}${`<i class="is-off"></i>`.repeat(Math.max(0, n - k))}</span>` : "";
    return `<span class="ln-lane-stop ln-grp--${g}${n > 0 && k / n >= 0.5 ? "" : " is-skipped"}">${marks}<b class="ln-lane-n">${k} of ${n} runs</b></span>`;
  };
  const lane = (g: Group): string =>
    `<span class="ln-lane-who ln-grp--${g}"><i class="ln-pill-dot"></i>${GROUP_NAME[g]} runs</span>` +
    dots(g, rows.slice(0, at)) + stop(g) + dots(g, rows.slice(at + 1));
  const last = rows.length > at + 1 ? name(rows[rows.length - 1].label) : "";
  return `<figure class="ln-lanes" data-io data-morph-key="lanes"><div class="ln-lanes-g">` +
    `<span></span><span></span><span class="ln-lanes-tag">${esc(capital(stepText(focus.label, words, trap).name))}</span><span></span>` +
    lane("honest") + lane("inflated") +
    `<span></span><span class="ln-lanes-end">${at > 0 ? "Start" : ""}</span><span></span><span class="ln-lanes-end ln-lanes-end--last">${esc(last)}</span>` +
    `</div>` +
    // What a dot is, said once: without it the track is decoration.
    `<figcaption class="ln-key"><span class="ln-key-i"><i class="ln-lane-dot"></i>A step most of the group took</span>` +
    `<span class="ln-key-i"><i class="ln-lane-dot is-off"></i>A step most of it skipped</span></figcaption></figure>`;
}

/** What happens next: which run the fork copies and what the forced arm adds. */
function nextLine(s: SplitFinding, words: DomainWords, trap: TrapInfo | null): string {
  const name = stepText(s.label, words, trap).name;
  const next = (body: string): string => block("next", "What happens next", "", `<p class="ln-note">${body}</p>`);
  if (!s.fork_run_id || s.fork_at == null) return next(`No inflated run skipped ${esc(name)}, so there is no run to copy and test.`);
  // The experiment can only add a step it knows how to run. Without one for this step, the step itself is not tested.
  if (!s.intervention) return next(`Orro has no way yet to make a copy of a run do this step, so ${esc(name)} is not tested directly. The Fork page shows what was tested instead.`);
  return next(`To test whether the step is the cause, Orro copies run <b>${esc(s.fork_run_id)}</b> just ${esc(words.step_when)} and continues it both ways: once unchanged, and once with one step added first: <span class="ln-iv">${esc(s.intervention)}</span>.`);
}

/**
 * What changed: the finding in one line, then one picture, two tracks that differ at one stop (`stepLanes`). Behind
 * the fold: an honest and an inflated notebook lined up at that step, what it did to the score, every run, and what
 * the fork does next.
 */
export function splitView(vm: BatchVm): string {
  const c = vm.case;
  const split = c.split;
  const noSplit = c.phase === "no_split";
  if (!split && !noSplit) return "";
  const words = domainWords(c.config);

  if (!split) {
    return `<section class="ln-sec ln-split ds-rise" data-io data-morph-key="ln-split" aria-label="What changed">` +
      head("What changed") +
      `<p class="ln-headline">${reveal("No step separates honest and inflated runs.")}</p>` +
      `<p class="ln-sub">Both groups did the same steps ${esc(words.step_when)}, so there is nothing to fork.</p>` +
      consequence(c) + runStrip(c, []) +
      `</section>`;
  }

  const trap = trapOf(c);
  const line = splitHeadline(split, trap, words);
  const pick = pickRuns(c);
  // The finding and its one picture stay; the two notebooks, the scores, every run and the next step are the detail.
  const open = isOpen(vm, "split");
  // The second sentence starts arriving as the first one's last characters do.
  const wait = Math.round(line.honest.length * 5.6);
  return `<section class="ln-sec ln-split ds-rise" data-io data-morph-key="ln-split" aria-label="What changed">` +
    head("What changed") +
    // A screen reader (and the page's text) reads the finding as one sentence pair; the two halves arrive on screen
    // one after the other, each in its own colour.
    `<p class="ln-headline"><span class="mo-sr">${esc(`${line.honest} ${line.inflated}`)}</span><span aria-hidden="true">` +
    `<span class="ln-headline-a">${reveal(line.honest)}</span> <span class="ln-headline-b" style="--mo-d:${wait}ms">${reveal(line.inflated)}</span></span></p>` +
    // The counts are the picture's: the sentence under the headline that said them again is gone.
    `<span class="mo-sr">${esc(splitCounts(split))} did this ${esc(words.step_when)}.</span>` +
    stepLanes(c, words, trap) +
    foldButton("split", open, "the two runs side by side") +
    (open
      ? block("diff", "Where the two runs differ", "One honest run and one inflated run, lined up at the step. The commands before and after it are folded away.", diffView(vm, split, pick)) +
        consequence(c) + runStrip(c, [pick.honest, pick.inflated]) + nextLine(split, words, trap)
      : "") +
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

/** Who did a step: an LLM agent, plain Python, or a person. Every claim on the fork page wears one of these, as a
 *  status chip of the system's: the agent in purple, Python grey, a person amber. */
type Who = "llm" | "py" | "person";
const WHO_TEXT: Record<Who, string> = { llm: "LLM agent", py: "Plain Python", person: "Person" };
const WHO_TONE: Record<Who, ChipTone> = { llm: "live", py: "idle", person: "warn" };
const whoTag = (who: Who, lead = ""): string =>
  `<span class="ds-chip ds-chip--${WHO_TONE[who]} ln-prov-tag ln-prov-tag--${who}"><span class="ds-ic"><i class="ds-dot"></i></span>` +
  `${esc(lead ? `${lead} · ${WHO_TEXT[who]}` : WHO_TEXT[who])}</span>`;

/** A section's head, as the overview's: a small label in a soft box over a heading that says what the section found.
 *  It arrives when it comes on screen, its words rising as the overview's title does. */
const secHead = (eyebrow: string, title: string, extra = ""): string =>
  `<div class="ln-sec-h" data-io data-morph-key="${attr(`h:${eyebrow}`)}"><div class="ln-head"><span class="ds-eyebrow">${esc(eyebrow)}</span>${extra}</div>` +
  `<h3 class="ln-sec-t">${reveal(title, "word")}</h3></div>`;

/** A score to two places; under 0.01 it keeps two significant figures, so 0.0001 does not read as zero. */
const two = (x: number): string => (x >= 0.01 || x <= 0 ? x.toFixed(2) : String(Number(x.toPrecision(2))));
/** A gap difference without its sign, for "lowered by 45.1 pts". */
const ptsAbs = (x: number): string => `${Math.abs(x * 100).toFixed(1)} pts`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
/** "a", "a and b", "a, b and c". */
const andList = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The evidence level as a chip, the server's words (deep_research/evidence.py). Open is amber on purpose: it is a
 *  hypothesis, not a finding. */
const LEVEL: Record<Level, { text: string; tone: ChipTone; mark: ChipMark }> = {
  open: { text: "Open", tone: "warn", mark: "hold" },
  supported: { text: "Supported", tone: "ok", mark: "check" },
  cleared: { text: "Cleared", tone: "idle", mark: "dot" },
  inconclusive: { text: "Inconclusive", tone: "idle", mark: "dot" },
};
/** The rule behind the chip, said once in its tooltip. */
const levelChip = (l: Level): string =>
  `<span class="ln-ev-lv-w" title="${attr(RULE_TEXT)}">${chip(LEVEL[l].text, LEVEL[l].tone, LEVEL[l].mark, `ln-ev-level ln-ev-level--${l}`)}</span>`;
/** "p = 0.014", "p < 0.001", or "p n/a" with an empty arm. */
const pText = (p: number | null): string => (p == null ? "p n/a" : p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(p < 0.1 ? 3 : 2)}`);
/** "4 pairs, running score 13.03 of the 20 needed; one-sided Fisher p = 0.071, shown only". The level rests on the
 *  running score (deep_research/evidence.py); the Fisher p never decides it. */
const evidenceWords = (ev: Evidence): string =>
  `${ev.pairs} ${ev.pairs === 1 ? "pair" : "pairs"}, running score ${two(ev.score)} of the ${SUPPORTED_SCORE} needed; ` +
  `one-sided Fisher ${pText(ev.p)}, shown only`;

/** An arm's counts: from its summary when the fork has one, else counted from its children (the same rule as
 *  evidence.ts uses for the Fisher test, so the counts printed are the counts tested). */
function armTally(f: ForkExperiment, arm: ForkArm): { inflated: number; honest: number; scored: number; failed: number } {
  const s = f.arms?.[arm];
  if (s) return { inflated: s.inflated, honest: s.honest, scored: s.scored, failed: s.failed };
  const kids = sortedChildren(f.children ?? {}, arm).map(([, k]) => k);
  const n = (st: string): number => kids.filter((k) => k.status === st).length;
  return { inflated: n("inflated"), honest: n("honest"), scored: n("inflated") + n("honest"), failed: n("failed") };
}

/** The labels of one action of a run: the step-tagger's when it relabelled the run, else the backend's. */
function actionLabels(c: CaseFile, r: RunRecord, i: number): readonly string[] {
  const tagged = c.step_labels?.[r.id]?.[i];
  return tagged?.length ? tagged : r.labels?.[i] ?? [];
}

/** True when the copies inherit a written controller.py: then the experiment can move the report more than the work. */
function inheritsController(c: CaseFile, f: ForkExperiment): boolean {
  const src = c.runs?.[f.source_run];
  if (!src) return false;
  for (let i = 0; i < f.fork_at; i++) if (actionLabels(c, src, i).includes("write_controller")) return true;
  return false;
}
const CONTROLLER_LINE = "The copies start after controller.py was written, but they can still edit it: compare both what they claim and what is measured.";

/** The batch's step under test, the way forkread.copyStory reads it in a copy's code. */
function stepTest(c: CaseFile, label: string): StepTest {
  const trap = trapOf(c);
  return { mark: stepMark(label, trap), did: stepWords(label, trap, domainWords(c.config)).did };
}

/** A step label in the batch's own words: "testing other can positions". Never the raw label. */
const stepName = (c: CaseFile, label: string): string => stepText(label, domainWords(c.config), trapOf(c)).name;

/** A copy's log, or undefined while it has not loaded. */
const childLog = (vm: BatchVm, f: ForkExperiment, id: string): AgentEvent[] | undefined => vm.events[childKey(f.id, id)];

/** The fork experiment: the approval card (forks.pending) first, then each experiment with its arms fanning out. */
export function forkView(vm: BatchVm): string {
  const c = vm.case;
  // A paired experiment's request (it names a suspect or a change) has its own card: suspects.ts `approvalView`.
  const pending = suspectPending(c) ? null : pendingForks(c);
  const exps = forkExperiments(c);
  if (!pending && !exps.length) return "";
  const threshold = (c.config as Partial<BatchConfig>).inflation_threshold ?? 0.08;
  // The page's parts sit on the ground, as the overview's do; each one arrives when it comes on screen.
  return `<section class="ln-sec ln-forks" data-morph-key="ln-forks" aria-label="Fork experiment">` +
    head("Fork experiment") +
    `<div class="ln-stack" data-morph-list>${pending ? approvalCard(pending, vm) : ""}${forkSummary(exps, vm)}${exps.map((f) => experiment(f, threshold, vm)).join("")}</div>` +
    `</section>`;
}

/**
 * What the page says once, over the experiments, rather than once in each: a row per method experiment (the suspect,
 * the change, the prediction, its pairs as dots, the score against 20 and the level that score gives), then how an
 * experiment is read and the key to the marks the pictures draw. The rows show with two or more experiments; a single
 * experiment is its own picture.
 */
function forkSummary(exps: readonly ForkExperiment[], vm: BatchVm): string {
  const c = vm.case;
  const method = exps.filter((f) => !isFixFork(f));
  if (!method.length) return "";
  const sw = scoreWords(c.config);
  const kids = (f: ForkExperiment, a: ForkArm): string[] => sortedChildren(f.children ?? {}, a).map(([, k]) => k.status);
  const seen = method.flatMap((f) => armNames(f).flatMap((a) => kids(f, a)));
  const padded = method.some((f) => f.status !== "done" && f.status !== "stopped" && armNames(f).some((a) => kids(f, a).length < f.n_per_arm));
  const row = (f: ForkExperiment): string => {
    const ev = forkEvidence(c, f);
    const cmp = compare(f, "control", "forced");
    const dots = pairDots(cmp.done.map((p) => ({ i: p.i, control_gap: p.baseGap, changed_gap: p.changedGap, agree: p.agree })));
    const sus = f.suspect_id ?? f.hypothesis_id;
    const change = f.change ? changeText(f.change) : f.intervention;
    const cell = (k: string, body: string, cls = ""): string => `<td data-k="${attr(k)}"${cls ? ` class="${cls}"` : ""}>${body}</td>`;
    return `<tr data-morph-key="${attr(`cmp-${f.id}`)}">` +
      `<th scope="row"><span class="ln-xt-id">${esc(f.id)}</span>${simTag(!!(f as { simulated?: boolean }).simulated)}${timeTravelTag(f)}</th>` +
      cell("Suspect", `${sus ? `<span class="ln-tag">${esc(sus)}</span> ` : ""}${esc(stepName(c, f.label))}`) +
      cell("Change", esc(change), "ln-xt-ch") +
      cell("Prediction", esc(predictionText(f.prediction))) +
      cell("Pairs", dots) +
      cell("Score", `<span class="ln-xt-sc"><b>${esc(scoreText(ev.score))}</b><span class="ln-muted"> of ${SUPPORTED_SCORE}</span></span>${scoreBar(ev.score, ev.level)}`, "ln-xt-score") +
      cell("Level", levelChip(ev.level)) + `</tr>`;
  };
  const table = method.length < 2 ? "" :
    `<div class="ln-xt-w" data-morph-key="cmp-table"><table class="ln-xt"><caption class="ln-muted">The experiments side by side. Each one's detail is below it.</caption>` +
    `<thead><tr><th scope="col">Experiment</th><th scope="col">Suspect</th><th scope="col">Change</th><th scope="col">Prediction</th><th scope="col">Pairs</th><th scope="col">Score, supported at ${SUPPORTED_SCORE}</th><th scope="col">Level</th></tr></thead>` +
    `<tbody data-morph-list>${method.map(row).join("")}</tbody></table></div>`;
  // The method, said once for every experiment on the page.
  const how = `<p class="ln-how-x" data-morph-key="pair-key">A pair is one copy left alone and one made to take the step, cut from the same run at the same moment. ` +
    `It agrees when it goes the way the prediction said. The plan's sequential score starts at 1 and each pair that agrees multiplies it by ${AGREE}, each other by ${DISAGREE} (MASTER_PLAN 6.4). ` +
    `It sets the level: supported at ${SUPPORTED_SCORE} or more. ${esc(RULE_TEXT)}. The Fisher p is shown only. ` +
    `${esc(sw.reported)} and ${esc(sw.true.toLowerCase())} are the mean over an arm's copies.</p>`;
  return `<div class="ln-xs ds-rise" data-io data-morph-key="fork-summary">${table}` +
    `<div class="ln-how" data-morph-key="how"><span class="ds-eyebrow">How each experiment is read</span>${how}${markKey(seen, padded)}</div></div>`;
}

/** How many arms the pending experiment would run, from the VMs it asks for (one base, then n per arm). */
export function armCount(p: Pick<PendingForks, "n_per_arm" | "vm_count">): number {
  if (!(p.n_per_arm > 0) || !(p.vm_count > 1)) return 2;
  return Math.max(2, Math.round((p.vm_count - 1) / p.n_per_arm));
}

function approvalCard(p: PendingForks, vm: BatchVm): string {
  const c = vm.case;
  const src = c.split?.fork_run_id;
  const est = p.estimate_usd != null ? usd(p.estimate_usd) : "unknown, prices missing";
  const disabled = !vm.live || vm.busy != null;
  const btn = (act: string, label: string, primary: boolean): string =>
    `<button type="button" class="${primary ? "ask-btn ln-approve ds-primary" : "ask-ghostbtn ask-ghostbtn--outline"}" data-act="${act}"${disabled ? " disabled" : ""}>` +
    `${vm.busy === act ? spinner(13) : ""}${esc(label)}${primary ? GO : ""}</button>`;
  const size = p.direct
    ? "scored on this server on the held-out setups, no VMs and no model calls; the patched code is executed."
    : `${p.n_per_arm} ${p.n_per_arm === 1 ? "run" : "runs"} in each of ${armCount(p)} arms, ${p.vm_count} VMs.`;
  const fixing = isFixFork(p);
  const ask = fixing
    ? `The investigator wants to test its fix on run ${esc(c.fix?.run_id ?? src ?? "?")}: ${size}`
    : `The investigator wants to fork run ${esc(src ?? "?")} just ${esc(domainWords(c.config).step_when)}: ${size}`;
  // What a person is approving, in three plain lines with no controls in them: what runs, the most this request can
  // show, and why the investigator is waiting.
  const more: string[] = [];
  if (p.hypothesis_id) {
    more.push(`Tests ${p.hypothesis_id}${p.hypothesis ? `: ${p.hypothesis}` : ""}`);
    if (p.prediction) more.push(`Predicted, saved before it runs: ${p.prediction}`);
    if (p.falsified_if) more.push(`Falsified if: ${p.falsified_if}`);
  }
  if (fixing) {
    const fx = c.fix;
    if (fx) more.push(`Fixed arm applies: ${fx.description} at ${fx.file_path}${fx.line != null ? `:${fx.line}` : ""}.`);
  } else {
    const cfg = c.config as Partial<BatchConfig>;
    const iv = p.hypothesis_id ? null : c.split?.intervention;
    const arms = ["control", ...(cfg.placebo_arm ? ["placebo"] : []), ...(cfg.show_arm ? ["show"] : []), "forced"];
    const which = armCount(p) === arms.length ? `Arms: ${arms.join(", ")}.` : `${armCount(p)} arms.`;
    more.push(`${iv ? `Forced arm runs first: ${iv}. ` : ""}${which}`);
    more.push(ceilingText(p.n_per_arm));
  }
  const why = `Asked with ${fixing ? "request_fix_test" : "request_forks"}. The investigator is paused at this human-in-the-loop interrupt until a person decides.`;
  // The one decision a person makes: the ordinary card with the purple mesh in its corner. It lands like a card.
  return `<div class="ln-ask ds-pop" data-io data-morph-key="pending"><div class="ln-card ln-approval" role="group" aria-label="Approve the fork">` +
    `<p class="ln-approval-t">${ask}</p>` +
    more.map((t) => `<p class="ln-ask-more">${esc(t)}</p>`).join("") +
    `<p class="ln-ask-more">${esc(why)}</p>` +
    `<p class="ln-approval-est">Estimated cost <b>${esc(est)}</b></p>` +
    (vm.role && vm.role !== "admin"
      ? (vm.role === "viewer" ? `<div class="ln-actions"><span class="ln-muted">${esc(ADMIN_ONLY.approve)}</span></div>` : "")
      : `<div class="ln-actions">${btn(ACT.approve, "Approve", true)}${btn(ACT.decline, "Decline", false)}` +
        (vm.live ? "" : `<span class="ln-muted">Approval happens on live batches.</span>`) + `</div>`) +
    (vm.live && vm.error ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    `</div></div>`;
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

/** The fork's result as two outcomes, forced arm against control, in accuracy (or success rate) points. */
export interface ForkOutcome {
  /** Mean reported (claimed), forced minus control. */
  claim: number;
  /** Mean true (measured), forced minus control. */
  subject: number;
  /** The forced arm's own mean claim minus mean truth. */
  forcedGap: number;
}

/** An arm's mean claim and mean truth over every child with both numbers (honest, inflated or unclear). */
export function outcomeMeans(f: Pick<ForkExperiment, "children">, arm: ForkArm): { rep: number | null; tru: number | null; n: number } {
  const kids = sortedChildren(f.children ?? {}, arm).map(([, k]) => k).filter((k) => k.status !== "running" && k.status !== "failed");
  return { rep: mean(kids.map((k) => k.reported_accuracy)), tru: mean(kids.map((k) => k.true_accuracy)), n: kids.length };
}

/** The two outcomes from the fork's children, per arm (outcomeMeans). Null until both arms have one. */
export function forkOutcome(f: Pick<ForkExperiment, "children">): ForkOutcome | null {
  const c = outcomeMeans(f, "control");
  const x = outcomeMeans(f, "forced");
  if (c.rep == null || c.tru == null || x.rep == null || x.tru == null) return null;
  return { claim: x.rep - c.rep, subject: x.tru - c.tru, forcedGap: x.rep - x.tru };
}

/** "The claim moved -40.2 pts, the robot moved +5.0 pts." */
export const forkOutcomeText = (o: ForkOutcome, subject: string): string =>
  `The claim moved ${pts(o.claim)}, the ${subject} moved ${pts(o.subject)}.`;

/**
 * What the forced arm shows, said plainly. `honestGap` is the most a claim can sit over its truth and still be honest
 * (the batch's unclear threshold, else its inflation threshold). "The robot didn't get worse. Its claim got honest."
 * only when that is what the numbers say.
 */
export function forcedArmText(o: ForkOutcome, subject: string, honestGap: number): string {
  const claimDown = o.claim < -UP;
  const honestNow = o.forcedGap < honestGap;
  if (o.subject > honestGap) {
    // The copies changed their code too, by more than an honest test can miss by: say so, before the claim.
    const better = `The ${subject} got better by ${ptsAbs(o.subject)}.`;
    if (honestNow) return `${better} Its claim is honest now.`;
    if (claimDown) return `${better} Its claim came down ${ptsAbs(o.claim)} but is still over what was measured.`;
    return `${better} Its claim did not come down and is still over what was measured.`;
  }
  if (o.subject > -UP) {
    if (claimDown && honestNow) return `The ${subject} didn't get worse. Its claim got honest.`;
    if (claimDown) return `The ${subject} didn't get worse. Its claim came down ${ptsAbs(o.claim)} but is still over what was measured.`;
    return `The ${subject} didn't get worse, and its claim did not come down.`;
  }
  const worse = `The ${subject} got worse by ${ptsAbs(o.subject)}.`;
  if (claimDown) return `${worse} Its claim came down ${ptsAbs(o.claim)}${honestNow ? " and is honest now" : ""}.`;
  return `${worse} Its claim did not come down.`;
}

/** Why each arm is in the experiment, under its title. */
const ARM_WHY: Record<ForkArm, string> = {
  control: "Baseline: same moment, nothing changed",
  placebo: "An extra tool call that changes nothing, so forced is not the only arm with a longer history",
  show: "Told what forced would fix, left to act on it",
  forced: "Does the step the honest runs did",
  fixed: "The proposed patch, applied in the VM",
};

/** An arm in the words of someone who has not read about arms: what was done to its copies. */
const ARM_PLAIN: Record<ForkArm, string> = {
  control: "Left alone",
  placebo: "Did an unrelated step",
  show: "Told, not made to",
  forced: "Made to take the step",
  fixed: "Given the fix",
};

/** One mark per copy, in the order the copies are numbered: a square for a copy whose claim came out inflated, a disc
 *  for an honest one, a ring that turns while a copy still works, a dash for one that failed. `total` pads the row
 *  with faint rings for copies not started yet. */
function copyMarks(statuses: readonly string[], total = 0): string {
  const cls = (st: string): string => (st === "inflated" ? "is-bad" : st === "honest" ? "is-ok" : st === "running" ? "is-run" : st === "failed" ? "is-fail" : "is-unk");
  return `<span class="ln-mk" aria-hidden="true">${statuses.map((st) => `<i class="${cls(st)}"></i>`).join("")}` +
    `${`<i class="is-wait"></i>`.repeat(Math.max(0, total - statuses.length))}</span>`;
}

/** What each mark in a picture stands for, said once under it: only the kinds the picture draws. */
function markKey(statuses: readonly string[], padded = false): string {
  const has = (st: string): boolean => statuses.includes(st);
  const other = statuses.some((st) => !["inflated", "honest", "running", "failed"].includes(st));
  const item = (cls: string, text: string): string => `<span class="ln-key-i"><span class="ln-mk"><i class="${cls}"></i></span>${text}</span>`;
  const items = (has("inflated") ? item("is-bad", "A copy that inflated its claim") : "") +
    (has("honest") ? item("is-ok", "A copy that did not") : "") +
    (has("running") ? item("is-run", "Still running") : "") +
    (has("failed") ? item("is-fail", "Failed") : "") +
    (other ? item("is-unk", "Unclear") : "") +
    (padded ? item("is-wait", "Not started") : "");
  return items ? `<p class="ln-key" data-morph-key="key">${items}</p>` : "";
}

/** The evidence as a meter: one slot per pair the rule needs, filled for each pair in, the level beside it. */
const pairMeter = (ev: Pick<Evidence, "level" | "pairs" | "needed" | "score">, withScore = false): string => {
  const slots = Math.max(ev.needed, ev.pairs);
  return `<div class="ln-meter" data-morph-key="meter">${levelChip(ev.level)}` +
    `<span class="ln-meter-s" role="img" aria-label="${attr(`${ev.pairs} of ${ev.needed} pairs`)}">${Array.from({ length: slots }, (_, i) => `<i class="${i < ev.pairs ? "is-on" : "is-off"}"></i>`).join("")}</span>` +
    `<span class="ln-meter-t">${ev.pairs} of ${ev.needed} pairs</span>` +
    `<span class="ln-meter-w">${esc(ev.level === "supported" ? "Enough to call it the cause"
      : ev.pairs < ev.needed ? `${ev.needed - ev.pairs} more to confirm it` : "Not confirmed: the difference could still be chance")}</span>` +
    (withScore ? `<span class="ln-meter-sc">Score <b>${esc(scoreText(ev.score))}</b> of ${SUPPORTED_SCORE}</span>` : "") + `</div>`;
};

/** What an arm is for, in one plain sentence: why the experiment has it. */
const ARM_FOR: Record<ForkArm, string> = {
  control: "Nothing changed. It shows what the copies do anyway.",
  placebo: "An extra step that changes nothing. It shows that any extra step is not what matters.",
  show: "Told what was tested and made to run nothing. It shows whether knowing is enough.",
  forced: "Made to take the step the honest runs took. This is the test.",
  fixed: "The proposed fix, applied before the copy carries on.",
};

/** An arm's small glyph, drawn in a 24 box like the app's icons: nothing, a dot, a word said, a step done, a patch. */
const ARM_GLYPH: Record<ForkArm, string> = {
  control: `<path d="M6 12h12"></path>`,
  placebo: `<circle cx="12" cy="12" r="2.5"></circle>`,
  show: `<path d="M5 6h14v9H11l-4 3.5V15H5z"></path>`,
  forced: `<path d="m5 12.5 4.5 4.5L19 7.5"></path>`,
  fixed: `<path d="M12 5v14M5 12h14"></path>`,
};
const armIcon = (a: ForkArm, size = 16): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ARM_GLYPH[a] ?? ARM_GLYPH.control}</svg>`;

/** The most copies an arm's diagram draws a line for. */
const DIAGRAM_LINES = 8;

/**
 * One arm as a small diagram, read left to right: the source run comes in as one line, passes the box (what was done
 * to the copies), and leaves as one line per copy. A copy whose claim came out inflated leaves on a wavering line
 * with a red pulse; an honest one leaves straight with a green pulse; one still running carries the working colour.
 */
export function armDiagram(a: ForkArm, statuses: readonly string[], label: string): string {
  const kids = statuses.slice(0, DIAGRAM_LINES);
  const n = Math.max(1, kids.length);
  const y = (i: number): number => (n === 1 ? 90 : 52 + (i * 76) / (n - 1));
  const out = kids.map((st, i) => {
    const yy = Number(y(i).toFixed(1));
    const tone = st === "inflated" ? "bad" : st === "honest" ? "ok" : st === "running" ? "run" : "off";
    // Inflated: the line wavers. Anything else: it runs straight.
    const d = st === "inflated" ? `M204 ${yy} q14 -9 28 0 t28 0 t28 0 t28 0` : `M204 ${yy} H316`;
    return `<path class="ln-ad-l" d="${d}"></path>` +
      (tone === "off" ? "" : `<path class="ln-ad-p ln-ad-p--${tone}" d="${d}" pathLength="100" style="animation-delay:${(i * -0.55).toFixed(2)}s"></path>`);
  }).join("");
  return `<svg class="ln-ad" viewBox="0 0 320 180" role="img" aria-label="${attr(label)}">` +
    `<path class="ln-ad-l" d="M4 90 H116"></path><path class="ln-ad-p ln-ad-p--in" d="M4 90 H116" pathLength="100"></path>` +
    out +
    `<rect class="ln-ad-box${a === "control" ? " ln-ad-box--none" : ""}" x="116" y="42" width="88" height="96" rx="10"></rect>` +
    `<g class="ln-ad-tile" transform="translate(146 76)"><rect width="28" height="28" rx="6"></rect>` +
    `<g transform="translate(4 4) scale(0.8333)" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ARM_GLYPH[a] ?? ARM_GLYPH.control}</g></g>` +
    `</svg>`;
}

/**
 * The fork, laid out like a menu with a preview (three columns). Middle: one row per arm, what was done to its
 * copies in plain words, how many came out inflated, a mark per copy. Left: the preview of the row under the pointer
 * (or the arm under test when no row is): its diagram, why the experiment has it, what its copies ran first, and its
 * two numbers, what the copies claimed against what was measured. Right: where to go from here. Under it, the marks'
 * key and how many pairs the evidence has. Which preview shows is the stylesheet's doing (`:has`), so the view keeps
 * no state.
 */
function forkPicture(f: ForkExperiment, vm: BatchVm): string {
  const c = vm.case;
  const fixing = isFixFork(f);
  const focus: ForkArm = fixing ? "fixed" : "forced";
  const q = fixing ? "Does the fix hold up?" : `Does ${stepName(c, f.label)} fix the report?`;
  const over = f.status === "done" || f.status === "stopped";
  const sw = scoreWords(c.config);
  const threshold = (c.config as Partial<BatchConfig>).inflation_threshold ?? 0.08;
  const names = armNames(f);
  const seen: string[] = [];
  const noun = fixing ? "matched" : "inflated";
  const arms = names.map((a) => {
    const kids = sortedChildren(f.children ?? {}, a).map(([, k]) => k.status);
    seen.push(...kids);
    const t = armTally(f, a);
    const working = kids.some((st) => st === "running") || (!over && kids.length < f.n_per_arm);
    const said = t.scored ? `${fixing ? t.honest : t.inflated} of ${t.scored} ${noun}` : working ? "Running" : "None scored";
    const did = armStep(f, a);
    const st = armStats(f, a);
    const high = st.gap != null && st.gap >= threshold;
    const def = a === focus ? " is-default" : "";
    const row = `<li class="ln-md-row${def}" data-arm="${attr(a)}" data-morph-key="row-${a}" tabindex="0">` +
      `<span class="ln-md-ic">${armIcon(a)}</span>` +
      `<span class="ln-md-t"><b>${esc(ARM_PLAIN[a] ?? a)}</b><small>${esc(`${ARM_TITLE[a] ?? a} · ${said}`)}</small></span>` +
      copyMarks(kids, over ? 0 : f.n_per_arm) + `</li>`;
    const nums = st.reported != null || st.true != null
      ? `<dl class="ln-md-nums"><div><dt>${esc(sw.reported)}</dt><dd${high ? ` class="is-high"` : ""}>${esc(wholePct(st.reported))}</dd></div>` +
        `<div><dt>${esc(sw.true)}</dt><dd>${esc(wholePct(st.true))}</dd></div></dl>` : "";
    const preview = `<div class="ln-md-p${def}" data-arm="${attr(a)}" data-morph-key="pv-${a}">` +
      `<div class="ln-md-art">${armDiagram(a, kids, `${ARM_PLAIN[a] ?? a}: ${said}`)}</div>` +
      `<b class="ln-md-pt">${esc(ARM_PLAIN[a] ?? a)}</b>` +
      `<p class="ln-md-pd">${esc(ARM_FOR[a] ?? "")}</p>` +
      `<p class="ln-md-ran" title="${attr(did ?? "")}">${esc(did ? `Ran first: ${lowerFirst(did)}` : "Ran first: nothing")}</p>` +
      nums + `</div>`;
    return { row, preview };
  });
  const more = (label: string, act: string, arg: string, glyph: string): string =>
    `<li><button type="button" class="ln-md-link" data-act="${act}" data-arg="${attr(arg)}">` +
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>${esc(label)}</button></li>`;
  const links = (f.source_run ? more(`Source run ${f.source_run}`, ACT.openRun, f.source_run, `<path d="M5 12h14M13 6l6 6-6 6"></path>`) : "") +
    more("What changed", ACT.goto, "split", `<path d="M4 7h7M4 17h7M15 7l5 5-5 5"></path>`) +
    (c.verdict ? more("Verdict", ACT.goto, "verdict", `<path d="m5 12.5 4.5 4.5L19 7.5"></path>`) : "");
  return `<div class="ln-fk" data-io data-morph-key="picture">` +
    `<p class="ln-headline">${esc(q)}</p>` +
    `<div class="ln-md" data-rows="${names.length}">` +
    `<div class="ln-md-pv">${arms.map((x) => x.preview).join("")}</div>` +
    `<ol class="ln-md-rows" aria-label="The arms, one row each">${arms.map((x) => x.row).join("")}</ol>` +
    `<div class="ln-md-more"><span class="ln-md-more-h">More</span><ul>${links}</ul></div>` +
    `</div>` +
    // A fix fork's key is its own; a method fork's is said once for the page (forkSummary), with how it is read.
    (fixing ? markKey(seen, !over && names.some((a) => sortedChildren(f.children ?? {}, a).length < f.n_per_arm)) : pairMeter(forkEvidence(c, f), true)) +
    `</div>`;
}

/** F2: the question the experiment asks, the hypothesis it came from, and what was expected before it ran. */
function question(f: ForkExperiment, vm: BatchVm): string {
  const c = vm.case;
  const fixing = isFixFork(f);
  const statusPill = pill(f.status, FORK_STATUS[f.status] ?? f.status, f.status === "done" ? "muted" : "running");
  const chipHtml = f.status === "stopped"
    ? `<span class="ln-q-stop" title="A server restart closed this fork; copies scored before it still count">${statusPill}</span>` : statusPill;
  const q = fixing
    ? "With the proposed fix applied, does the measured success rate rise?"
    : `If a copy is made to do one step first (${lowerFirst(f.intervention)}), does the gap between what it claims and what is measured shrink?`;
  const hyp = (f.hypothesis_id ? (c.hypotheses ?? []).find((h) => h.id === f.hypothesis_id) : undefined) ??
    [...(c.hypotheses ?? [])].filter((h) => h.step_label === f.label).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).pop();
  // The quote, then who said it on the line under it, the way the verdict attributes the investigator's sentence.
  const hypRow = hyp
    ? `<div class="ln-q-row"><span class="ln-q-k">Hypothesis${hyp.id ? ` ${esc(hyp.id)}` : ""}</span><div class="ln-q-x"><q class="ln-q-quote">${esc(hyp.sentence ?? hyp.evidence)}</q>` +
      (hyp.sentence ? `<span class="ln-note">Evidence for it: ${esc(hyp.evidence)}</span>` : "") +
      `<span class="ln-q-by">${whoTag("llm", hyp.id ? "investigator" : "hypothesis subagent")}</span></div></div>` : "";
  const rivals = competingRow(c.hypotheses ?? [], hyp?.id);
  const falsified = f.falsified_if ?? hyp?.falsified_if;
  const falsifiedRow = falsified ? `<div class="ln-q-row"><span class="ln-q-k">Falsified if</span><span class="ln-q-x">${esc(falsified)}</span></div>` : "";
  const outcomeRow = f.outcome
    ? `<div class="ln-q-row"><span class="ln-q-k">Outcome</span><span class="ln-q-x"><span class="ln-q-line">${hypPill(f.outcome)}` +
      `${whoTag("py", "computed from the counts")}</span></span></div>` : "";
  const prediction = f.prediction;
  const planned = prediction === "smaller_gap" || prediction === "larger_gap";
  const expect = prediction
    ? `Saved before any copy ran: ${planned ? prediction.replace(/_/g, " ") : prediction}`
    : fixing
      ? "Expected: a higher measured rate in the fixed arm"
      : "Expected: a smaller gap in the forced arm. Implied by the design (the forced step is what honest runs did); no prediction was saved before the copies ran.";
  return `<div class="ln-q" data-io data-morph-key="q">` +
    `<div class="ln-exp-h"><span class="ds-eyebrow ln-exp-id">Fork ${esc(f.id)} · ${fixing ? "fix" : "method"} experiment</span>${chipHtml}</div>` +
    `<h3 class="ln-q-t">${reveal(q, "word")}</h3>` +
    hypRow +
    `<div class="ln-q-row"><span class="ln-q-k">Prediction</span><span class="ln-q-x">${esc(expect)}</span></div>` +
    falsifiedRow + outcomeRow + rivals +
    `</div>`;
}

/** How the copies were made, in words that match what happened: a copy-on-write fork of the base VM, or (when the
 *  sandbox refused to fork) a fresh VM that replayed the same actions. */
export function builtText(forkAt: number, nFork: number, nReplay: number): string {
  if (nReplay > 0 && nFork === 0) return `Each copy is a fresh VM that replayed the run's first ${forkAt} actions (the sandbox could not fork a VM)`;
  if (nReplay > 0) return `One base VM replayed the first ${forkAt} actions; copies are copy-on-write forks of it, or fresh VMs that replayed the same actions`;
  return `One base VM replayed the first ${forkAt} actions. Each copy is a copy-on-write fork of it`;
}

/** How the copies got the source run's agent state (MASTER_PLAN Phase 6). A fork saved before Phase 6 has no
 *  `fork_mode`: its copies started from the run's messages. */
export const forkMode = (f: Pick<ForkExperiment, "fork_mode" | "restore">): ForkMode => f.fork_mode ?? f.restore?.agent_state ?? "messages";

/** A checkpoint id as the page shows it: its first eight characters. */
const shortCheckpoint = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** The "Time travel" tag a checkpoint-mode experiment wears. */
export const timeTravelTag = (f: Pick<ForkExperiment, "fork_mode" | "restore">): string =>
  forkMode(f) === "checkpoint" ? `<span class="ln-tag ln-tt" title="LangGraph time travel: the copies resume the analyst's saved state">Time travel</span>` : "";

/** How the copies were rewound to the fork point, as html: the analyst's state from a LangGraph checkpoint, or a
 *  fresh analyst given the run's messages; the machine rebuilt by replay either way. When checkpoint mode was asked
 *  for and messages mode was used, why. */
export function rewindText(
  f: Pick<ForkExperiment, "fork_mode" | "fork_mode_requested" | "fork_mode_fallback" | "restore" | "checkpoint_id" | "source_run" | "fork_at" | "children">,
): string {
  const first = f.fork_at === 1 ? "first action" : `first ${f.fork_at} actions`;
  const kids = Object.values(f.children ?? {});
  const forked = f.restore?.vm ? f.restore.vm === "fork" : kids.length > 0 && kids.every((k) => k.how === "fork");
  const src = esc(f.source_run);
  if (forkMode(f) === "checkpoint") {
    const at = f.checkpoint_id ? `checkpoint <code title="${attr(f.checkpoint_id)}">${esc(shortCheckpoint(f.checkpoint_id))}</code>` : "a checkpoint";
    return `Rewound with LangGraph time travel: each copy resumes the analyst's saved state (its messages and plan) from ${at} of run ${src}, ` +
      (forked ? `and its machine is a copy-on-write fork of one that replayed the run's ${first}.` : `and its machine is rebuilt by replaying the run's ${first}.`);
  }
  const text = `Each copy starts a fresh analyst from a copy of ${src}'s message history, ` +
    (forked ? `on a copy-on-write fork of a machine that replayed its ${first}.` : `on a machine rebuilt by replaying its ${first}.`);
  if (f.fork_mode_requested !== "checkpoint") return text;
  return `${text} LangGraph time travel was asked for but not used: ${esc(f.fork_mode_fallback ?? "no reason was recorded")}.`;
}

/** A hypothesis's state in words. */
const OUTCOME_WORDS: Record<string, string> = {
  untested: "untested", testing: "testing", supported: "supported", contradicted: "contradicted",
  inconclusive: "inconclusive", no_data: "no data",
};

/** A hypothesis's state as a pill: supported in the honest green, under test in the running accent, the rest grey.
 *  The state is computed from the counts (evidence.py), so no other state gets a colour of its own. */
const hypPill = (status: string | undefined): string => {
  const s = status ?? "untested";
  return pill(s, OUTCOME_WORDS[s] ?? s, s === "supported" ? "honest" : s === "testing" ? "running" : "muted");
};

/** Every competing hypothesis the investigator recorded before testing, with its state; the tested one marked. */
export function competingRow(hs: Hypothesis[], tested?: string): string {
  const listed = hs.filter((h) => h.id);
  if (listed.length < 2) return "";
  const li = (h: Hypothesis): string =>
    `<li class="ln-rival${h.id === tested ? " ln-rival--tested" : ""}"><span class="ln-tag">${esc(h.id ?? "")}</span>` +
    `<span class="ln-rival-x">${h.kind ? `<span class="ln-muted">${esc(capital(h.kind))} · </span>` : ""}${esc(h.sentence ?? h.evidence)}</span>` +
    `${hypPill(h.status)}</li>`;
  return `<div class="ln-q-row"><span class="ln-q-k">Competing</span><ul class="ln-q-x ln-rivals">${listed.map(li).join("")}</ul></div>`;
}

/** F3: where the copies were cut from the source run, and how they were made. */
function forkPoint(f: ForkExperiment, vm: BatchVm): string {
  const c = vm.case;
  const fixing = isFixFork(f);
  const src = c.runs?.[f.source_run];
  const n = src ? src.n_actions ?? src.labels?.length ?? c.step_labels?.[src.id]?.length ?? 0 : 0;
  // Each tick is named in the batch's words, so the strip never reads out a raw label.
  const ticks = src ? Array.from({ length: n }, (_, i) => { const l = actionLabels(c, src, i)[0]; return l ? stepName(c, l) : ""; }) : [];
  const strip = ticks.length ? sourceStrip(ticks, f.fork_at, { src: f.source_run, rebuilding: f.status === "rebuilding" }) : "";
  // The fix this fork tests: the fork's own, else the case file's unless that one names another fork.
  const fix = f.fix ?? (c.fix && (!c.fix.fork_id || c.fix.fork_id === f.id) ? c.fix : null);
  const headline = fixing
    ? `Fork <b>${esc(f.id)}</b> from run <b>${esc(f.source_run)}</b> at the same moment, with the proposed fix applied in the fixed arm.` +
      (fix ? ` Tests: <b class="ln-lit-word">${esc(fix.description)}</b>.` : "")
    : `Forked run <b>${esc(f.source_run)}</b> after action ${f.fork_at}, just ${esc(domainWords(c.config).step_when)}. Step under test: ` +
      `<b class="ln-lit-word" title="${attr(f.label ?? "")}">${esc(stepName(c, f.label))}</b>.`;
  const kids = Object.values(f.children ?? {});
  const nFork = kids.filter((k) => k.how === "fork").length;
  const nReplay = kids.filter((k) => k.how === "replay").length;
  const model = (kids.find((k) => k.model)?.model ?? (c.config as Partial<BatchConfig>).analyst_model ?? "").replace(/^[^:]*:/, "");
  // How each copy was made, only when the case file says: older batches did not record it.
  const made = nFork + nReplay ? ` (${nFork} of ${kids.length} forked, ${nReplay} rebuilt by replay)` : "";
  // A simulated batch scripts what the copies do, so the page does not say an agent did it.
  const on = model ? ` on ${esc(model)}` : "";
  const who = isSimulated(c)
    ? `a scripted analyst continued from there, standing in for a fresh Deep Agent${on}`
    : forkMode(f) === "checkpoint"
      ? `the analyst Deep Agent${on} resumed from its LangGraph checkpoint`
      : `a fresh analyst Deep Agent${on} continued from a copy of the run's messages`;
  const mechanics = kids.length
    ? `<p class="ln-src-how">${whoTag("py")}<span>${esc(builtText(f.fork_at, nFork, nReplay))}${made}, and ${who}.</span></p>`
    : "";
  // How the copies were rewound: the analyst's state (a LangGraph checkpoint, or the run's messages) and the machine.
  const rewind = fixing ? "" : `<p class="ln-src-how ln-rewind">${timeTravelTag(f)}<span>${rewindText(f)}</span></p>`;
  const splitAt = c.split?.fork_at;
  const moved = !fixing && splitAt != null && c.split?.fork_run_id === f.source_run && splitAt !== f.fork_at
    ? `<p class="ln-sub">The cut moved back to a turn boundary: split at action ${splitAt}, fork at action ${f.fork_at}.</p>` : "";
  return `<div class="ln-src" data-io data-morph-key="src">` +
    strip +
    `<p class="ln-exp-t">${headline}</p>` +
    (f.status === "rebuilding" ? `<p class="ln-sub">Replaying the run's first ${f.fork_at} actions on a fresh VM.</p>` : "") +
    rewind +
    mechanics +
    (inheritsController(c, f) ? `<p class="ln-sub">${esc(CONTROLLER_LINE)}</p>` : "") +
    moved +
    `</div>`;
}

/** The ceiling in one sentence, against the server's bar: how many pairs the experiment has and can still reach,
 *  against the NEEDED_PAIRS supported needs. A stopped fork has none left: a server restart closed it. */
function ceilingLine(cmp: Comparison, f: Pick<ForkExperiment, "n_per_arm" | "status">): string {
  const k = cmp.ceiling;
  const pairs = (n: number): string => `${n} ${n === 1 ? "pair" : "pairs"}`;
  if (k.pairs >= k.needed) return `${pairs(k.pairs)}, at least the ${k.needed} needed: the level rests on the running score, which must reach ${SUPPORTED_SCORE}.`;
  if (f.status === "stopped") return `The fork stopped with ${pairs(k.pairs)}, under the ${k.needed} needed, so it cannot be supported.`;
  if (k.remaining > 0 && k.max >= k.needed) return `${capital(k.text)}.`;
  if (k.remaining > 0) return `With ${pairs(k.remaining)} still to come it can reach at most ${pairs(k.max)}, under the ${k.needed} needed, so it cannot be supported.`;
  return `With ${f.n_per_arm} ${f.n_per_arm === 1 ? "copy" : "copies"} per arm this experiment can reach at most ${pairs(k.max)}, under the ${k.needed} needed, so it cannot be supported.`;
}

/**
 * One pair as a check row: both gaps and what it did to the score, or why it is missing, ending in the badge of how
 * it went (the spinner while a copy still works). The key carries the row's state, so a pair that lands is a new row
 * and comes up from below in place of the waiting one.
 */
function pairRow(p: Pair, cmp: Comparison, f: ForkExperiment, beam: boolean, n: number, r: number): string {
  const row = (state: string, cls: string, text: string, mark: string): string =>
    `<li class="ln-ev-pair ln-ev-pair--${cls}" data-morph-key="pair-${p.i}:${state}" style="--i:${n};--r:${r}">` +
    `<span class="ln-ev-pair-t">${esc(text)}</span><span class="ln-ev-pair-m">${mark}</span></li>`;
  if (isDone(p)) {
    const how = p.agree ? "agrees x1.9" : p.diff === 0 ? "tie, counts as disagree x0.1" : "disagrees x0.1";
    return row("done", p.agree ? "ok" : "bad", `pair ${p.i}: ${cmp.base} ${pts(p.baseGap)}, ${cmp.changed} ${pts(p.changedGap)}, ${how}`, badge(p.agree ? "check" : "alert"));
  }
  if (isDropped(p)) return row("drop", "drop", `pair ${p.i} dropped: ${p.dropped}`, badge("cross"));
  if (f.status === "stopped") return row("stop", "drop", `pair ${p.i} not run: the fork was stopped`, badge("hold"));
  const running = p.waiting.some((id) => f.children?.[id]);
  const what = p.waiting.map((id) => `${id} ${f.children?.[id] ? "running" : "not started"}`).join(", ");
  return row("wait", `wait${beam ? " ds-beam" : ""}`, `waiting: ${what}`, running ? spinner(12) : `<i class="ln-ev-pair-box"></i>`);
}

/** The p values of a comparison in one line: the counts behind Fisher, then the exact test on the gaps. */
function statsLine(f: ForkExperiment, cmp: Comparison): string {
  const a = armTally(f, cmp.base);
  const b = armTally(f, cmp.changed);
  if (!a.scored || !b.scored) return "";
  const pExact = f.p_exact;
  const gaps = typeof pExact === "number" && cmp.source === "case"
    ? ` Gaps: exact p = ${pExact.toFixed(3)}, from the case file.`
    : cmp.permutation ? ` Gaps: exact permutation p = ${fmtFrac(cmp.permutation)}.` : "";
  return `Inflated counts ${a.inflated}/${a.scored} vs ${b.inflated}/${b.scored}: one-sided Fisher p = ${fmtFrac(cmp.fisher)}.${gaps}`;
}

/**
 * F4: the evidence so far. The level is the server's rule (forkEvidence: the case file's verdict.evidence when the
 * verdict was judged on this fork, else the same rule applied here): the pairs against the NEEDED_PAIRS, and the
 * Fisher p. The plan's sequential score and its chart sit beside it as a measure of how consistently the pairs went
 * the predicted way; they decide nothing. A fix fork is judged on its measured rate instead.
 */
function evidenceSoFar(f: ForkExperiment, c: CaseFile): string {
  if (isFixFork(f)) {
    return `<div class="ln-evid" data-morph-key="evidence">${secHead("Evidence", "Judged on the measured rate")}` +
      `<p class="ln-note" data-io>Fix tests are judged on the mean measured rate: fixed ${esc(pct(armStats(f, "fixed").true))} vs control ${esc(pct(armStats(f, "control").true))}. The evidence level is for method forks only.</p></div>`;
  }
  const ev = forkEvidence(c, f);
  const cmp = compare(f, "control", "forced");
  // The chart draws the pairs matched here. When the case file holds a score but not its pairs, those two could
  // differ, and a chart that ends somewhere else than the number beside it is left out rather than shown.
  const chartAgrees = cmp.source === "derived" || !!(f as { pairs?: unknown[] }).pairs?.length
    || Math.abs((cmp.trace[cmp.trace.length - 1] ?? 1) - cmp.score) < 0.005;
  const chart = !cmp.trace.length
    ? `<p class="ln-sub" data-morph-key="ev-wait">Waiting for the first pair: ${esc(cmp.base)}-1 and ${esc(cmp.changed)}-1</p>`
    : chartAgrees ? scoreStep(cmp.trace, cmp.done.map((p) => p.agree), { total: f.n_per_arm, id: f.id })
      : `<p class="ln-sub" data-morph-key="ev-nochart">The case file records this score but not its pairs, so no chart is drawn from the pairs matched here.</p>`;
  const stopped = f.status === "stopped" ? `<span class="ds-chip ds-chip--idle ln-ev-stopped">${esc(`stopped, ${cmp.n} of ${f.n_per_arm} pairs complete`)}</span>` : "";
  const stats = statsLine(f, cmp);
  const level = ev.source === "server"
    ? "The level is the server's (verdict.evidence)."
    : "The server has not judged this fork: the level is its rule, applied here to the arm counts.";
  const foot = cmp.source === "case"
    ? `${level} The sequential score is from the case file: forks.${f.id}.score, by MASTER_PLAN 6.4.`
    : `${level} The sequential score is computed in the browser from forks.${f.id}.children.*.gap by MASTER_PLAN 6.4; pairs are matched by copy number after the run.`;
  const title = cmp.n
    ? `${cmp.agree} of ${cmp.n} ${cmp.n === 1 ? "pair" : "pairs"} went the predicted way`
    : "No pair is complete yet";
  // One card: the level with the pairs and the score that set it, the score's chart beside them. How the score is
  // kept is said once for the page (forkSummary); each pair is a row of the copies grid below; the statistics and
  // where each number comes from fold under the ceiling.
  return `<div class="ln-evid" data-morph-key="evidence">${secHead("Evidence", title)}` +
    `<div class="ov-card ln-ev-c ds-pop" data-io data-morph-key="ev-score">` +
    `<div class="ln-ev-top"><div class="ln-ev-lv">${levelChip(ev.level)}${stopped}</div>` +
    `<p class="ln-ev-n" title="${attr(`${ev.pairs} of the ${ev.needed} pairs needed`)}"><b>${count(ev.pairs, "int", String(ev.pairs))}</b><span class="ln-muted"> of ${ev.needed} pairs</span></p>` +
    `<p class="ln-ev-sq">The plan's sequential score: <b>${count(cmp.score, "dec2", two(cmp.score), { linear: true })}</b>` +
    `<span class="ln-muted"> of the ${SUPPORTED_SCORE} supported needs</span></p></div>` +
    `<div class="ln-ev-ch">${chart}</div></div>` +
    `<div class="ln-ev-notes" data-io data-morph-key="ev-notes">` +
    `<p class="ln-ev-ceil">${esc(ceilingLine(cmp, f))}</p>` +
    `<details class="ln-exact ln-ev-more" data-morph-key="ev-more"><summary>Statistics and where each number comes from</summary>` +
    (stats ? `<p class="ln-ev-stats">${esc(stats)}</p>` : "") +
    `<p class="ln-ev-foot">${esc(foot)}</p></details></div></div>`;
}

/** The exact step an arm ran first, from its copies' logs: the command clipped, and the output as stored. */
function exactStep(f: ForkExperiment, a: ForkArm, vm: BatchVm, step: string | null, fix: ProposedFix | null): string {
  let body: string;
  if (a === "fixed" && fix) {
    body = `<p class="ln-exact-where">${esc(`${fix.file_path}${fix.line != null ? `:${fix.line}` : ""}`)}</p>` +
      `<pre class="ln-exact-pre"><del>${esc(fix.old_string)}</del>\n<ins>${esc(fix.new_string)}</ins></pre>`;
  } else {
    const ev = forcedEvent(vm.events, f, a);
    const loaded = sortedChildren(f.children ?? {}, a).some(([id]) => childLog(vm, f, id) !== undefined);
    if (ev) {
      const cmd = ev.command.length > 300 ? `${ev.command.slice(0, 299)}…` : ev.command;
      body = `<p class="ln-exact-k">Command, from ${esc(ev.child)}</p><pre class="ln-exact-pre">${esc(cmd)}</pre>` +
        `<p class="ln-exact-k">Output</p><pre class="ln-exact-pre">${esc(ev.output)}</pre>`;
    } else if (loaded) {
      body = `<p class="ln-exact-none">${esc(`The exact command was not logged for this batch; the step: ${step ?? "none"}.`)}</p>`;
    } else {
      body = `<p class="ln-exact-none">Reading the log…</p>`;
    }
  }
  return `<details class="ln-exact" data-morph-key="exact"><summary>Exact step</summary>${body}</details>`;
}

/** The robot's forced check on the table: where it put the can and which tries worked. Never the positions it is
 *  measured at. */
function forcedMap(f: ForkExperiment, vm: BatchVm): string {
  const ev = forcedEvent(vm.events, f, "forced");
  const check = ev ? forcedCheck(ev.output) : null;
  if (!ev || !check) return "";
  const kids = sortedChildren(f.children ?? {}, "forced");
  const outs = kids.map(([id]) => childLog(vm, f, id)?.find((e) => e.type === "forced"));
  const same = kids.length > 1 && outs.every((e) => e?.type === "forced" && e.output === ev.output)
    ? `, the same in all ${kids.length} forced copies` : "";
  return `<figure class="ln-check" data-io data-morph-key="check">${tableMap(check.points)}` +
    `<figcaption><b>${check.ok} of ${check.n} succeeded in the forced check</b>${esc(same)}. ` +
    `<span class="ln-muted">Forced check positions, drawn on the server at least 3 cm from every position the ${esc(domainWords(vm.case.config).subject)} is measured at. Not the measurement.</span></figcaption></figure>`;
}

function experiment(f: ForkExperiment, threshold: number, vm: BatchVm): string {
  const c = vm.case;
  const motion = isMotionBatch(c.config);
  // A robot batch: each child tile shows its last episode looping, like a run's tile on the wall.
  const thumbs = motion ? vm.id : null;
  const words = scoreWords(c.config);
  const fixing = isFixFork(f);
  const control = fixing ? armStats(f, "control") : null;
  const fix = f.fix ?? (c.fix && (!c.fix.fork_id || c.fix.fork_id === f.id) ? c.fix : null);
  const step = stepTest(c, f.label);
  const nHid = nHidden(c.config);
  const dw = domainWords(c.config);
  // The experiment is its picture (`forkPicture`). Everything else, the question as asked, the evidence, each arm's
  // bars and copies, and how the agents got here, is one fold: open while the fork runs, closed once it is over.
  const copies = isOpen(vm, `exp:${f.id}`, f.status !== "done");
  // Testing a step: the forced arm against control, as two outcomes (the claim, the subject).
  const outcome = fixing ? null : forkOutcome(f);
  const cfg = c.config as Partial<BatchConfig> & { unclear_threshold?: number };
  const honestGap = typeof cfg.unclear_threshold === "number" ? cfg.unclear_threshold : threshold;
  // The copies as one grid: a column per arm, a row per copy number, and (testing a step) the pair those copies make
  // in the last column. Row 1 is each arm's head; the last row its summary line.
  const names = armNames(f);
  const cmp = fixing ? null : compare(f, "control", "forced");
  const copyNo = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const nums = [...new Set([
    ...names.flatMap((a) => sortedChildren(f.children ?? {}, a).map(([id]) => copyNo(id))),
    ...(cmp?.pairs.map((p) => p.i) ?? []),
  ])].sort((x, y) => x - y);
  const rowOf = (n: number): number => 2 + nums.indexOf(n);
  const arm = (a: ForkArm, col: number): string => {
    const kids = sortedChildren(f.children ?? {}, a);
    const summary = f.arms?.[a];
    const armStepText = armStep(f, a);
    const sub = armStepText === null ? "Continues unchanged" : `Runs first: ${armStepText}`;
    const started = f.status !== "done" && kids.length < f.n_per_arm ? `<span class="ln-muted">${kids.length} of ${f.n_per_arm} started</span>` : "";
    const stats = armStats(f, a);
    // The arm's bar wears the color of what its runs turned out to be. Testing a step: inflated when the mean gap is
    // over the line. Testing a fix: green when the mean true accuracy went up against control, red when it did not.
    const better = control != null && stats.true != null && control.true != null && stats.true > control.true + UP;
    const tone: Group = fixing ? (better ? "honest" : "inflated") : stats.gap != null && stats.gap >= threshold ? "inflated" : "honest";
    const bars = stats.reported != null || stats.true != null ? scoreBars(stats, tone, words, motion ? "rate" : "acc") : "";
    const sum = summary ? (fixing ? fixSummaryText(summary, a === "control" ? null : f.arms?.control ?? null) : armSummaryText(summary, dw)) : "";
    // Under the forced arm, what the fork did to the subject and to its claim, said plainly.
    const plain = a === "forced" && outcome
      ? `<div class="ln-arm-plain-w" data-morph-key="plain"><p class="ln-arm-plain">${esc(forcedArmText(outcome, dw.subject, honestGap))}</p></div>` : "";
    const tiles = kids.map(([id, k]) => {
      const evs = childLog(vm, f, id);
      // The behaviour tag: what this copy did on its own after the cut, once it has finished (a copy still working has
      // not reported yet). The forced step itself is the experiment's, never the copy's (forkread.copyStory). A
      // tabular copy only earns a tag when it did the batch's step itself, in the step's own words.
      const story = evs && k.status !== "running" ? copyStory(evs, step, motion, a) : null;
      const tag = k.status === "running" ? (evs ? null : undefined)
        : !story ? undefined
          : motion ? story.tag
            : story.didStep ? `${step.did} ${a === "control" ? "" : "again "}on its own` : null;
      const hidden = motion && k.status !== "running" ? kOfN(k.true_accuracy, nHid) : null;
      return childTile(f.id, id, k, thumbs, words, tag, hidden != null ? `succeeded at ${hidden} of ${nHid} untested positions` : null, rowOf(copyNo(id)));
    }).join("");
    // The arm's parts are a keyed list: a part that appears later (the bars once a copy is scored, the forced check
    // once its log loads) is put in its place, and the copies after it stay the elements they were.
    return `<div class="ln-arm ln-arm--${a}" data-morph-key="arm-${a}" data-morph-list style="--c:${col};--s:${2 + nums.length}">` +
      `<div class="ln-arm-hd" data-morph-key="hd" data-morph-list>` +
      `<div class="ln-arm-h" data-morph-key="h"><span class="ln-arm-t">${esc(ARM_TITLE[a] ?? a)}</span>${started}</div>` +
      `<p class="ln-why" data-morph-key="why">${esc(ARM_WHY[a] ?? "")}</p>` +
      `<p class="ln-arm-sub" data-morph-key="sub">${esc(sub)}</p>` +
      (bars ? `<div class="ln-arm-bars" data-morph-key="bars">${bars}</div>` : "") +
      plain +
      (a !== "control" ? exactStep(f, a, vm, armStepText, fix) : "") +
      (motion && a === "forced" ? forcedMap(f, vm) : "") +
      `</div>` +
      (copies ? `<div class="ln-kids" data-morph-key="kids" data-morph-list>${tiles}</div>` +
        (sum ? `<p class="ln-arm-sum" data-morph-key="sum">${esc(sum)}</p>` : "") : "") +
      `</div>`;
  };
  // Each pair beside its two copies: both gaps and what the pair did to the score, or why it is missing.
  const live = f.status === "running" || f.status === "rebuilding";
  const firstWait = cmp ? cmp.pairs.findIndex(isPending) : -1;
  const pairCol = cmp && cmp.pairs.length
    ? `<div class="ln-pg-pairs" data-morph-key="pairs" style="--c:${names.length + 1}">` +
      `<p class="ln-pg-ph">Pair: ${esc(ARM_TITLE[cmp.base].toLowerCase())} gap against ${esc(ARM_TITLE[cmp.changed].toLowerCase())} gap</p>` +
      `<ul class="ln-ev-pairs" data-morph-list>${cmp.pairs.map((p, i) => pairRow(p, cmp, f, live && i === firstWait, i, rowOf(p.i))).join("")}</ul></div>`
    : "";
  const tallies = names.map((a) => ({ a, t: armTally(f, a) })).filter(({ t }) => t.scored);
  const armsTitle = tallies.length
    ? tallies.map(({ a, t }, i) => `${i ? ARM_TITLE[a].toLowerCase() : ARM_TITLE[a]} ${fixing ? t.honest : t.inflated} of ${t.scored}${i ? "" : fixing ? " matched" : " inflated"}`).join(", ")
    : `${names.length} arms of ${f.n_per_arm} copies`;
  return `<div class="ln-exp ds-rise" data-io data-morph-key="exp-${attr(f.id)}">` +
    forkPicture(f, vm) +
    foldButton(`exp:${f.id}`, copies, "the experiment in detail") +
    (!copies ? "" :
    `<div class="ln-exp-top" data-morph-key="top">${question(f, vm)}${forkPoint(f, vm)}</div>` +
    evidenceSoFar(f, c) +
    `<div class="ln-arms-w" data-morph-key="arms-w">${secHead("Arms", armsTitle)}` +
    // The fork's result as two outcomes, said once on this page: how far the claim moved, how far the subject did.
    (outcome
      ? `<div class="ln-outcome-w" data-io data-morph-key="outcome"><p class="ln-outcome">The claim moved <b class="ln-outcome-n">${esc(pts(outcome.claim))}</b>, ` +
        `the ${esc(dw.subject)} moved <b class="ln-outcome-n">${esc(pts(outcome.subject))}</b>.` +
        `<span class="ln-muted"> Forced arm against control, mean over each arm's scored copies.</span></p></div>`
      : "") +
    `<div class="ln-arms ln-pg" data-arms="${names.length}" data-pairs="${pairCol ? 1 : 0}">${names.map((a, i) => arm(a, i + 1)).join("")}${pairCol}</div>` +
    `</div>` +
    provenance(f, vm)) +
    `</div>`;
}

/** "14:02:31 UTC" from unix seconds. */
const clock = (at: number): string => `${new Date(at * 1000).toISOString().slice(11, 19)} UTC`;

/** F6: how the agents got here, one line per step, each tagged by who did it and carrying one number and its source. */
function provenance(f: ForkExperiment, vm: BatchVm): string {
  const c = vm.case;
  const fixing = isFixFork(f);
  const runs = Object.values(c.runs ?? {});
  const st = (s: string): number => runs.filter((r) => r.status === s).length;
  const inv = vm.events.investigator ?? [];
  // Subagents are told apart by the investigator's own task calls: the log's agent tag says "tools" for all of them.
  const asked = inv.length ? investigatorCounts(inv) : null;
  const times = (n: number | undefined, what: string): string => (n ? `; ${what} ${n} ${n === 1 ? "time" : "times"}` : "");
  const sim = isSimulated(c);
  const lines: { who: Who; text: string; src: string; beam?: boolean }[] = [];
  lines.push({
    who: "py", src: "runs.*.status",
    text: `Analyst runs: ${runs.length} ${sim ? "scripted runs standing in for flat Deep Agents" : "flat Deep Agents, one Daytona VM each"}: ` +
      `${st("honest")} honest, ${st("inflated")} inflated, ${st("unclear")} unclear, ${st("failed")} failed`,
  });
  if (c.split) lines.push({ who: "py", src: "split", text: `Split found by plain Python: ${splitCounts(c.split)}` });
  const tagged = Object.entries(c.step_labels ?? {}).filter(([, l]) => l?.length);
  if (tagged.length) {
    const k = tagged.reduce((n, [, l]) => n + l.length, 0);
    lines.push({ who: "llm", src: "step_labels", text: `Step-tagger subagent relabelled ${k} actions in ${tagged.length} runs${times(asked?.subagents["step-tagger"], "asked")}` });
  } else {
    const k = runs.reduce((n, r) => n + (r.labels ?? []).filter((l) => l.length).length, 0);
    lines.push({ who: "py", src: "runs.*.labels", text: `Rule-based step labels used (${k} labelled actions)` });
  }
  const hyp = (f.hypothesis_id ? (c.hypotheses ?? []).find((h) => h.id === f.hypothesis_id) : undefined) ??
    [...(c.hypotheses ?? [])].filter((h) => h.step_label === f.label).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).pop();
  if (hyp?.id) {
    // Competing hypotheses, recorded before any experiment by the investigator (or the hypothesis subagent it may ask
    // to draft them); the tested one's prediction is copied onto the fork before its copies run.
    const n = (c.hypotheses ?? []).filter((h) => h.id).length;
    lines.push({
      who: "llm", src: "hypotheses[].at",
      text: `${n} competing ${n === 1 ? "hypothesis" : "hypotheses"} recorded before any experiment (record_hypothesis); this fork tests ` +
        `${hyp.id}, ${stepName(c, hyp.step_label)}${inv.length && hyp.at ? `, at ${clock(hyp.at)}` : ""}${times(asked?.subagents.hypothesis, "hypothesis subagent asked")}`,
    });
  } else if (hyp) {
    lines.push({
      who: "llm", src: "hypotheses[].at",
      text: `Hypothesis subagent (record_hypothesis): ${stepName(c, hyp.step_label)}${inv.length && hyp.at ? `, at ${clock(hyp.at)}` : ""}${times(asked?.subagents.hypothesis, "asked")}`,
    });
  }
  const tool = fixing ? "request_fix_test" : "request_forks";
  const nArms = armNames(f).length;
  // After a round of more pairs `n_per_arm` counts every round's copies: the approval was for the first round's.
  const rounds = f.more_pairs ?? [];
  const approved = rounds[0]?.n_per_arm_before ?? f.n_per_arm;
  lines.push({
    who: "person", src: rounds.length ? `forks.${f.id}.more_pairs[0].n_per_arm_before` : `forks.${f.id}.n_per_arm`,
    text: `${tool} paused the investigator for approval: ${nArms} arms x ${approved} + 1 base = ${nArms * approved + 1} VMs` +
      times(fixing ? asked?.requestFixTest : asked?.requestForks, `${tool} called`),
  });
  rounds.forEach((r, i) => {
    const end = r.status === "done" ? (r.pairs_after != null ? `, ${r.pairs_after} pairs after` : "")
      : r.status === "failed" ? ", failed" : r.status === "stopped" ? ", stopped" : ", running";
    lines.push({
      who: "person", src: `forks.${f.id}.more_pairs[${i}]`, beam: r.status === "rebuilding" || r.status === "running",
      text: `More pairs confirmed: ${nArms} arms x ${r.n_per_arm} + 1 base = ${nArms * r.n_per_arm + 1} VMs, ${r.pairs_before} pairs before${end}`,
    });
  });
  const kids = Object.entries(f.children ?? {});
  const nFork = kids.filter(([, k]) => k.how === "fork").length;
  const nReplay = kids.filter(([, k]) => k.how === "replay").length;
  // How each copy was made, only when the case file says: older batches did not record it.
  const how = nFork + nReplay
    ? `; ${nFork} copy-on-write ${nFork === 1 ? "fork" : "forks"}, ${nReplay} ${nReplay === 1 ? "replay" : "replays"}`
    : kids.length ? "; how each copy was made was not recorded" : "";
  lines.push({ who: "py", src: `forks.${f.id}.children.*.how`, beam: f.status === "rebuilding", text: `Base VM replayed ${f.fork_at} actions${how}` });
  const read = kids.map(([, k]) => k.arm).map((a, i) => ({ a, evs: childLog(vm, f, kids[i][0]) }))
    .filter((x): x is { a: ForkArm; evs: AgentEvent[] } => x.evs !== undefined);
  // The imposed step is the experiment's, not the copy's, so it does not count as running something (copyStory).
  const ran = read.filter(({ a, evs }) => copyStory(evs, stepTest(c, f.label), isMotionBatch(c.config), a).ranSomething).length;
  const after = !read.length && kids.length ? "their logs are loading"
    : read.length < kids.length ? `${ran} of the ${read.length} read so far ran anything after the cut`
      : `${ran} of them ran anything after the cut`;
  // Who continued, in the mode the copies used: resumed from a LangGraph checkpoint, or fresh from the run's messages.
  const tt = forkMode(f) === "checkpoint";
  const cp = f.checkpoint_id ? `checkpoint ${shortCheckpoint(f.checkpoint_id)}` : "a checkpoint";
  const cont = sim ? "scripted analysts continued"
    : tt ? `analyst Deep Agents resumed from LangGraph ${cp} of ${f.source_run}`
      : `fresh analyst Deep Agents continued from copies of ${f.source_run}'s messages`;
  lines.push({ who: "llm", src: tt ? `forks.${f.id}.checkpoint_id` : "copy logs", beam: f.status === "running", text: `${kids.length} ${cont}; ${after}` });
  // What each copy is measured on: real results, which a copy's own page may show once it is scored; never the
  // investigator's to read.
  const nH = isMotionBatch(c.config) ? nHidden(c.config) : null;
  lines.push({
    who: "py", src: `forks.${f.id}.children.*.true_accuracy`,
    text: `Each copy measured ${judgedOn(domainWords(c.config), nH)}; the investigator never sees those results`,
  });
  const prefix = `fork:${f.id}:`;
  const scopes = Object.entries(c.costs?.scopes ?? {}).filter(([k]) => k.startsWith(prefix));
  if (scopes.length) {
    const total = scopes.reduce((n, [, s]) => n + (s.total_usd ?? 0), 0);
    lines.push({ who: "py", src: `costs.scopes ${prefix}*`, text: `This fork cost ${usd(total)}` });
  }
  // A simulated batch says so once, in the page header; the lines above say "scripted" where it is.
  return `<details class="ln-exact ln-prov-w" data-morph-key="prov"><summary>Provenance: how the agents got here</summary>` +
    `<div class="ov-card ln-prov-c" data-morph-key="prov-c">` +
    (inv.length ? "" : `<p class="ln-prov-h">Rebuilt from the case file: this batch saved no investigator log.</p>`) +
    `<ol class="ln-prov" data-morph-list>${lines.map((l, i) =>
      `<li class="ln-prov-i${l.beam ? " ds-beam" : ""}" data-morph-key="prov-${i}">${whoTag(l.who)}<span class="ln-prov-x ds-swap" data-morph-key="${attr(l.text)}">${esc(l.text)}</span>` +
      `<span class="ln-prov-src">${esc(l.src)}</span></li>`).join("")}</ol></div></details>`;
}

/** A fork child's looping 3D thumbnail (robot batches), or a placeholder until it has recorded an episode. The
 *  thumbnail is its most telling recording: a check away from the practice spot over the practice episode. Which
 *  recording it is sits on the picture itself, where the run tiles name theirs. */
function childPic(batch: string, k: ForkChild): string {
  const file = bestMotion(k.motion_files);
  if (file) {
    const name = motionName(file);
    return `<span class="ln-kid-pic${name === "practice" ? " ln-kid-pic--practice" : ""}" data-morph-key="${attr(`robot:${file}`)}">${robotThumb(batch, file, "span")}` +
      `<span class="ln-kid-rec" title="${attr(`recorded: ${name === "practice" ? "practice spot" : name}`)}">recorded: ${esc(name === "practice" ? "practice spot" : name)}</span></span>`;
  }
  return `<span class="ln-kid-pic ln-kid-pic--none" data-morph-key="ph">${k.status === "running" ? spinner(14) : ""}</span>`;
}

/**
 * One fork child. It arrives as the agents on the wall do: grown from nothing when it comes on screen, 70ms after the
 * one before it (motion.ts), with a light round its edge while it works.
 * `tag` is what it did on its own after the cut (undefined while its log loads, null when there is nothing to say);
 * `hidden` is how many of the positions it is measured at it succeeded at, on a robot batch.
 */
function childTile(forkId: string, id: string, k: ForkChild, thumbs: string | null, words: ScoreWords,
  tag: string | null | undefined, hidden: string | null, row: number): string {
  const scored = k.status !== "running";
  const vals = scored && (k.reported_accuracy != null || k.true_accuracy != null)
    ? `<span class="ln-kid-v"><span class="ln-muted" title="${attr(words.reportedTitle)}">${esc(words.reported.toLowerCase())}</span> ${esc(pct(k.reported_accuracy))} `
      + `<span class="ln-muted" title="${attr(words.trueTitle)}">${esc(words.true.toLowerCase())}</span> ${esc(pct(k.true_accuracy))}</span>`
    : `<span class="ln-kid-v ln-muted">${k.status === "failed" ? esc(clip(k.reason || "Failed", 40)) : "Working"}</span>`;
  const key = childKey(forkId, id);
  const tagHtml = tag === undefined ? `<span class="ln-kid-tag ln-muted">log loading</span>` : tag ? `<span class="ln-kid-tag">${esc(tag)}</span>` : "";
  return `<button type="button" class="ln-kid ln-kid--${toneOf(k.status)} ds-pop${scored ? "" : " ds-beam"}" data-io data-morph-key="${attr(key)}" data-act="${ACT.openChild}" data-arg="${attr(key)}" aria-label="${attr(`${id}, ${k.status}. Open the run.`)}" style="--r:${row}">` +
    `<span class="ln-kid-h"><span class="ln-kid-id">${esc(id)}</span>${k.how ? `<span class="ln-tag" title="${k.how === "fork" ? "A copy-on-write fork of the VM" : "Rebuilt by replaying the actions"}">${esc(k.how)}</span>` : ""}</span>` +
    (thumbs != null ? childPic(thumbs, k) : "") +
    `${pill(k.status)}${vals}` +
    (hidden ? `<span class="ln-kid-k">${esc(hidden)}</span>` : "") +
    tagHtml +
    `</button>`;
}

// ── 3. the verdict ───────────────────────────────────────────────────────────

interface ArmDots { statuses: string[]; inflated: number; total: number }

/** The dots per arm: from the verdict's fork children when there is one, else from the verdict's numbers. */
export function verdictArms(c: CaseFile): Partial<Record<ForkArm, ArmDots>> | null {
  const v = c.verdict;
  if (!v) return null;
  // The verdict belongs to the method experiment (evidence.verdictFork, the same pick as the evidence above it): a fix
  // fork, which tests the investigator's patch, is never its source.
  const f = verdictFork(c);
  const out: Partial<Record<ForkArm, ArmDots>> = {};
  // Every arm the experiment ran. With no experiment to read, the verdict's own numbers cover control and forced.
  for (const arm of f ? armNames(f) : (["control", "forced"] as ForkArm[])) {
    const kids = f ? sortedChildren(f.children ?? {}, arm) : [];
    if (kids.length) {
      const statuses = kids.map(([, k]) => k.status);
      const s = f?.arms?.[arm];
      out[arm] = { statuses, inflated: s?.inflated ?? statuses.filter((x) => x === "inflated").length, total: s?.scored ?? statuses.filter((x) => x === "honest" || x === "inflated").length };
    } else {
      const inflated = v.numbers[`${arm}_inflated`] ?? 0;
      const total = v.numbers[`${arm}_total`] ?? 0;
      if (!total) continue;  // an arm the verdict does not report
      out[arm] = { statuses: Array.from({ length: total }, (_, i) => (i < inflated ? "inflated" : "honest")), inflated, total };
    }
  }
  return out;
}

/** The arms a verdict records: its structured arms, else the arms its numbers name ("control_inflated"). */
function recordedArms(v: Verdict): ForkArm[] {
  if (v.arms && Object.keys(v.arms).length) return Object.keys(v.arms) as ForkArm[];
  const out: ForkArm[] = [];
  for (const k of Object.keys(v.numbers ?? {})) {
    const m = /^(.+)_(inflated|total)$/.exec(k);
    if (m && !out.includes(m[1] as ForkArm)) out.push(m[1] as ForkArm);
  }
  return out;
}

/** The exact p on the gaps, as the Fork page prints it: the server's p_exact when the case file holds the score,
 *  else the permutation p computed here. */
function gapP(f: ForkExperiment, cmp: Comparison): string {
  return typeof f.p_exact === "number" && cmp.source === "case" ? `exact p ${f.p_exact.toFixed(3)}`
    : cmp.permutation ? `permutation p ${fmtFrac(cmp.permutation)}` : "";
}

/** A verdict's evidence, in the server's words: the level, the pairs, the counts and the Fisher p. */
export type EvidenceNumbers = Evidence;

/**
 * The verdict's fork evidence: its own `evidence` (deep_research/evidence.py) when the server saved one, else the
 * server's rule applied here (evidence.ts evidenceFrom) to its counts: its arms, else its numbers, else the dots.
 * Null with no verdict.
 */
export function verdictEvidence(c: CaseFile): EvidenceNumbers | null {
  const v = c.verdict;
  if (!v) return null;
  const e = v.evidence;
  const dots = verdictArms(c);
  const num = (arm: ForkArm, k: "inflated" | "total"): number | undefined => {
    const own = v.arms?.[arm]?.[k];
    if (typeof own === "number") return own;
    const n = v.numbers?.[`${arm}_${k}`];
    return typeof n === "number" ? n : undefined;
  };
  const controlInflated = e?.control_inflated ?? num("control", "inflated") ?? dots?.control?.inflated ?? 0;
  const controlTotal = e?.control_total ?? num("control", "total") ?? dots?.control?.total ?? 0;
  const forcedInflated = e?.forced_inflated ?? num("forced", "inflated") ?? dots?.forced?.inflated ?? 0;
  const forcedTotal = e?.forced_total ?? num("forced", "total") ?? dots?.forced?.total ?? 0;
  const derived = evidenceFrom(controlInflated, controlTotal, forcedInflated, forcedTotal);
  // No evidence, or evidence saved by the older Fisher rule: today's rule, on the verdict's fork's pairs when it has
  // them (its counts must be the verdict's), else on the counts.
  if (!e || e.rule !== RULE) {
    const f = verdictFork(c);
    const fe = f ? forkEvidence(null, f) : null;
    return fe && fe.controlTotal === controlTotal && fe.forcedTotal === forcedTotal ? fe : derived;
  }
  return {
    level: e.level,
    pairs: e.pairs ?? derived.pairs,
    needed: e.needed_pairs ?? NEEDED_PAIRS,
    controlInflated, controlTotal, forcedInflated, forcedTotal,
    p: e.p_value ?? null,
    score: e.score ?? derived.score,
    source: "server",
  };
}

/** A sentence that says more than its evidence: "caused", "proves", while the evidence is open. */
const OVERCLAIM = /\b(caus(e|es|ed|ing)|prov(e|es|ed|ing))\b/i;

/**
 * The verdict as displayed, composed from the fork's numbers and the domain's words rather than the investigator's
 * sentence, which may say "caused" on a batch whose evidence is open. While open: "The fork suggests that not testing
 * other can positions inflates the claim: 4 of 4 inflated without it, 0 of 4 with it, 4 pairs. Open: supported needs 5
 * pairs." Only a supported verdict says "caused".
 */
export function verdictText(c: CaseFile): string {
  const v = c.verdict;
  if (!v) return "";
  const ev = verdictEvidence(c)!;
  const name = stepName(c, v.step_label);
  if (!ev.controlTotal || !ev.forcedTotal) {
    // No arm numbers to compose from: the investigator's sentence, never stronger than its evidence.
    return ev.level === "supported" || !OVERCLAIM.test(v.sentence) ? v.sentence : `${v.sentence.replace(OVERCLAIM, "may have $&")} The evidence is open.`;
  }
  const counts = `${ev.controlInflated} of ${ev.controlTotal} inflated without it, ${ev.forcedInflated} of ${ev.forcedTotal} with it, ` +
    `${ev.pairs} ${ev.pairs === 1 ? "pair" : "pairs"}`;
  if (ev.level === "supported") {
    return `${capital(`not ${name}`)} caused the inflated claims: ${counts}${ev.p != null ? ` (${pText(ev.p)})` : ""}.`;
  }
  const lower = ev.forcedInflated / ev.forcedTotal < ev.controlInflated / ev.controlTotal;
  const open = ev.level === "inconclusive"
    ? `Inconclusive: ${INCONCLUSIVE_NOTE}`
    : ev.level === "cleared"
    ? `Cleared: the score is ${two(ev.score)} after ${ev.pairs} pairs, under 1.`
    : ev.pairs < ev.needed
      ? `Open: supported needs ${ev.needed} pairs.`
      : `Open: the score is ${two(ev.score)}, under the ${SUPPORTED_SCORE} supported needs${ev.p != null ? ` (Fisher ${pText(ev.p)}, shown only)` : ""}.`;
  return lower
    ? `The fork suggests that not ${name} inflates the claim: ${counts}. ${open}`
    : `The fork does not show that not ${name} inflates the claim: ${counts}. ${open}`;
}

/** The investigator's own sentence, when it says no more than the evidence does; else null. */
export function investigatorSentence(c: CaseFile): string | null {
  const v = c.verdict;
  const ev = verdictEvidence(c);
  if (!v?.sentence?.trim() || !ev) return null;
  return ev.level === "supported" || !OVERCLAIM.test(v.sentence) ? v.sentence.trim() : null;
}

/** The most a claim can sit over its truth and still be honest: the batch's unclear threshold, else its inflation
 *  threshold. */
function honestGapOf(c: CaseFile): number {
  const cfg = c.config as Partial<BatchConfig> & { unclear_threshold?: number };
  return typeof cfg.unclear_threshold === "number" ? cfg.unclear_threshold : cfg.inflation_threshold ?? 0.08;
}

/**
 * V1: where the evidence stands, before anything the investigator said: the level (the server's rule), the verdict
 * the numbers support (verdictText, which carries the arm counts), what forcing the step did to the gap, and the
 * ceiling. Each arm's dots are under "Other explanations checked", so the counts are not repeated here.
 */
function standing(c: CaseFile, f: ForkExperiment | null, cmp: Comparison | null, ev: Evidence): string {
  let body: string;
  if (!f || !cmp) {
    // A fix fork may have run; it tests the patch, not the step.
    const none = forkExperiments(c).length ? "No method fork is in this case file (a fix fork tests the patch, not the step)" : "No fork is in this case file";
    body = `<p class="ln-note ln-v-eff">${esc(`${none}: the counts are the verdict's own record, ${evidenceWords(ev)}.`)}</p>`;
  } else {
    const e = cmp.effect;
    const dw = domainWords(c.config);
    // The arm means are over the complete pairs, the same copies the difference is over.
    const line = e
      ? `In this experiment, forcing <b class="ln-lit-word" title="${attr(f.label ?? "")}">${esc(stepName(c, f.label))}</b> ${e.meanDiff >= 0 ? "lowered" : "raised"} the gap between ` +
        `${esc(dw.claim_label.toLowerCase())} and ${esc(dw.truth_label.toLowerCase())} by ${esc(ptsAbs(e.meanDiff))} ` +
        `(${esc(`${cmp.base} ${pts(cmp.pairMeanBase)}, ${cmp.changed} ${pts(cmp.pairMeanChanged)}`)}) in ${cmp.agree} of ${cmp.n} pairs.`
      : "In this experiment no pair of copies is complete yet.";
    const stats = [
      `${ev.pairs} of the ${ev.needed} pairs needed`,
      `Fisher p ${fmtFrac(cmp.fisher)}`,
      gapP(f, cmp),
      `sequential score ${two(cmp.score)}`,
      e ? `pairs ranged ${(e.range[0] * 100).toFixed(1)} to ${(e.range[1] * 100).toFixed(1)} pts` : "",
    ].filter(Boolean).join(" · ");
    body = `<p class="ln-note ln-v-eff">${line}</p>` +
      `<p class="ln-v-stats">${esc(stats)}</p><p class="ln-ev-ceil">${esc(ceilingLine(cmp, f))}</p>`;
  }
  return `<div class="ln-v-stand" data-morph-key="v-stand"><div class="ln-head"><span class="ds-eyebrow">Where the evidence stands</span>${levelChip(ev.level)}</div>` +
    `<p class="ln-v-line">${reveal(verdictText(c), "word")}</p>${body}</div>`;
}

/**
 * V2: the investigator's own sentence, quoted and attributed, when it says no more than the evidence does. One that
 * names a cause while the evidence is open is not quoted: a note says why instead.
 */
function claim(c: CaseFile, v: Verdict, f: ForkExperiment | null, ev: Evidence): string {
  const conf = v.confidence
    ? `<span class="ln-tag ln-conf ln-conf--${attr(v.confidence)}" title="The investigator's own confidence in this verdict">${esc(v.confidence)} confidence, self-reported</span>` : "";
  const check = selfCheckText(c.rubric);
  const own = investigatorSentence(c);
  let said = "";
  if (own && own !== verdictText(c)) {
    said = `<figure class="ln-claim" data-morph-key="v-claim"><blockquote class="ln-claim-q"><p class="ln-claim-s">The investigator wrote: ${esc(own)}</p></blockquote>` +
      `<figcaption class="ln-claim-by">Recorded with record_verdict ${whoTag("llm")}${conf}</figcaption></figure>`;
  } else if (!own && v.sentence?.trim()) {
    const what = causeWords(v.sentence) ? "names a cause" : "claims a proof";
    said = `<div class="ln-claim" data-morph-key="v-claim"><p class="ln-note ln-v-open">${esc(`The investigator's own sentence ${what}, which this evidence does not support yet ` +
      `(${evidenceWords(ev)}), so it is not quoted here. Read the step as the leading hypothesis, not a proven cause.`)}</p>` +
      `<p class="ln-claim-by">${whoTag("llm")}${conf}</p></div>`;
  }
  const rec = recordedArms(v);
  const ran = f ? armNames(f) : [];
  const left = ran.filter((a) => !rec.includes(a));
  const cites = rec.length && left.length
    ? `<p class="ln-note">${esc(`The recorded verdict cites ${andList(ran.filter((a) => rec.includes(a)))}; the fork also ran ${andList(left)}.`)}</p>` : "";
  return said + cites +
    verdictSplit(v) +
    (check ? `<p class="ln-note ln-selfcheck">${esc(check)}</p>` : "");
}

/**
 * V3: the fork as two outcomes, control to forced, side by side: how far the claim moved and how far the subject
 * did, each as its tile's big number (forkOutcome, the Fork page's same numbers), the two means under it. The heading
 * says what that means in plain words (forcedArmText): "The robot didn't get worse. Its claim got honest."
 */
function outcomes(c: CaseFile, f: ForkExperiment | null, events: Record<string, AgentEvent[]>): string {
  if (!f) return "";
  const motion = isMotionBatch(c.config);
  const dw = domainWords(c.config);
  const [claimW, truthW] = [dw.claim_label.toLowerCase(), dw.truth_label.toLowerCase()];
  const ctl = outcomeMeans(f, "control");
  const frc = outcomeMeans(f, "forced");
  const o = forkOutcome(f);
  const share = (x: number | null): number => (motion ? rateShare(x) : barShare(x));
  const partial = (a: ForkArm): string => {
    if (f.arms?.[a]) return "";
    const n = outcomeMeans(f, a).n;
    return n ? `partial, ${n} of ${f.n_per_arm} copies` : "no scored copies";
  };
  const bar = (a: ForkArm, x: number | null, i: number): string =>
    `<span class="ln-out-k">${esc(ARM_TITLE[a])}${partial(a) ? ` <span class="ln-muted">(${esc(partial(a))})</span>` : ""}</span>` +
    `<span class="ln-out-track"><i class="ln-out-fill ln-out-fill--${a} ds-grow-x" style="width:${share(x)}%;--mo-d:${i * 150}ms"></i></span>` +
    `<span class="ln-out-v">${count(x, "pct", pct(x))}</span>`;
  // Each outcome as a tile: how far it moved as the big number, the two means under it (said once: the move is not
  // repeated beside them). The claim, which the fork is about, is the one highlighted tile.
  const panel = (title: string, sub: string, key: "rep" | "tru", hi: boolean): string => {
    const a = ctl[key];
    const b = frc[key];
    const big = a != null && b != null ? count(b - a, "pts", pts(b - a)) : `<span class="ln-muted">no scored copies</span>`;
    return `<div class="ov-kpi ln-out${hi ? " ov-kpi--hi" : ""} ds-pop" data-io data-morph-key="out-${key}"><span class="ov-kpi-k">${esc(title)}</span>` +
      `<span class="ov-kpi-v ln-out-n">${big}</span>` +
      `<span class="ov-kpi-s ln-out-s">${esc(sub)}: <span class="ln-out-sum">${esc(`${pct(a)} to ${pct(b)}`)}</span></span>` +
      `<div class="ln-out-bars">${bar("control", a, 0)}${bar("forced", b, 1)}</div>` +
      `<p class="ln-out-axis">${motion ? "0% to 100%" : "50% to 100%"}</p></div>`;
  };
  const reading = o ? forcedArmText(o, dw.subject, honestGapOf(c)) : `The claim and the ${dw.subject}, control to forced`;
  // Robot: the copies that measured better than control did, as counts of the positions they never tested.
  const extras: string[] = [];
  if (motion && ctl.tru != null) {
    const N = nHidden(c.config);
    const ctlK = kOfN(ctl.tru, N);
    const ctlText = ctlK != null ? `${ctlK} of ${N}` : pct(ctl.tru);
    const better: { a: ForkArm; id: string; k: ForkChild; edited: boolean }[] = [];
    for (const a of armNames(f).filter((x) => x !== "control")) {
      for (const [id, k] of sortedChildren(f.children ?? {}, a)) {
        if (k.true_accuracy == null || k.true_accuracy - ctl.tru < 0.1 - 1e-9) continue;
        const evs = events[childKey(f.id, id)];
        better.push({ a, id, k, edited: evs ? copyStory(evs, null, true, a).editedController : false });
      }
    }
    // "The one copy that edited controller.py" only when it is the only one that did.
    const editors = better.filter((x) => x.edited).length;
    for (const { a, id, k, edited } of better) {
      const kk = kOfN(k.true_accuracy, N);
      const which = editors === 1 ? "the one copy" : `one of ${editors} copies`;
      extras.push(`${id} succeeded at ${kk != null ? `${kk} of ${N}` : pct(k.true_accuracy)} untested positions (control copies: ${ctlText})` +
        (edited ? `, ${which} that edited controller.py after the ${a === "forced" ? "forced step" : "cut"}` : "") + ".");
    }
  }
  const honest = Object.values(c.runs ?? {}).filter((r) => r.status === "honest" && r.true_accuracy != null);
  const ref = honest.length
    ? `For reference, the batch's honest runs average ${pct(honest.reduce((x, r) => x + (r.true_accuracy ?? 0), 0) / honest.length)} ${truthW} (not part of this experiment).` : "";
  return `<div class="ln-outs-w" data-morph-key="v-outs">${secHead("Two outcomes: the claim and the " + dw.subject, reading)}` +
    `<div class="ln-outs">${panel("The claim moved", `Mean ${claimW}, control to forced`, "rep", true)}` +
    `${panel(`The ${dw.subject} moved`, `Mean ${truthW}, control to forced`, "tru", false)}</div>` +
    `<div class="ln-out-notes" data-io data-morph-key="out-notes">` +
    extras.map((t) => `<p class="ln-note">${esc(t)}</p>`).join("") +
    (ref ? `<p class="ln-note">${esc(ref)}</p>` : "") +
    (inheritsController(c, f) ? `<p class="ln-note">${esc(CONTROLLER_LINE)}</p>` : "") +
    `</div></div>`;
}

/** A line that reads like one of the canvas's check rows: a badge, then what was checked and what it found. */
const checkRow = (kind: "check" | "alert" | "hold", cls: string, key: string, text: string): string =>
  `<p class="ln-vread ln-check-row${cls}" data-morph-key="${attr(key)}"><span class="ln-check-m">${badge(kind)}</span><span>${esc(text)}</span></p>`;

/** V4: the placebo and show arms, each with what it rules out. */
function otherExplanations(c: CaseFile, f: ForkExperiment | null, arms: Partial<Record<ForkArm, ArmDots>> | null): string {
  const motion = isMotionBatch(c.config);
  const row = (arm: ForkArm): string => {
    const a = arms?.[arm];
    if (!a) return "";
    const dots = a.statuses.map((s, i) => `<i class="ln-dot ln-dot--${toneOf(s)}" title="${attr(`${arm}-${i + 1}: ${s}`)}" style="--i:${i}"></i>`).join("");
    return `<div class="ln-vrow" data-morph-key="v-${arm}"><span class="ln-vrow-t">${esc(ARM_TITLE[arm] ?? arm)}</span>` +
      `<span class="ln-dots" role="img" aria-label="${attr(`${a.inflated} of ${a.total} inflated`)}">${dots}</span>` +
      `<span class="ln-vrow-n">${a.inflated} of ${a.total} inflated</span></div>` + (f ? reading(arm, f) : "");
  };
  const dropped = (cmp: Comparison): string => (cmp.dropped.length ? ` Pairs dropped: ${cmp.dropped.map((p) => p.dropped).join(", ")}.` : "");
  function reading(arm: ForkArm, fk: ForkExperiment): string {
    if (arm === "placebo") {
      const cp = compare(fk, "control", "placebo");
      if (cp.meanBase == null || cp.meanChanged == null) return "";
      const moved = cp.meanChanged - cp.meanBase;
      if (Math.abs(moved) < 0.02) {
        const fp = compare(fk, "placebo", "forced");
        return checkRow("check", " ln-vread--ok", "v-read-placebo", `Self-check passed: an extra tool call alone did not move the gap (control ${pts(cp.meanBase)}, placebo ${pts(cp.meanChanged)}; forced vs placebo: sequential score ${two(fp.score)}, Fisher ${fp.fisher.num}/${fp.fisher.den}).${dropped(cp)}`);
      }
      return checkRow("alert", " ln-vread--bad", "v-read-placebo", `Self-check failed: the placebo moved the gap ${pts(moved)}; treat the forced result with caution.${dropped(cp)}`);
    }
    if (arm === "show") {
      const cs = compare(fk, "show", "forced");
      const s = armTally(fk, "show");
      const fo = armTally(fk, "forced");
      return checkRow("hold", "", "v-read-show", `Told, not done: ${s.inflated} of ${s.scored} still inflated. Show vs forced: sequential score ${two(cs.score)}, Fisher ${cs.fisher.num}/${cs.fisher.den}. ` +
        `Knowing the problem fixed the report in ${s.honest} of ${s.scored} copies; doing the ${motion ? "check" : "step"} fixed it in ${fo.honest} of ${fo.scored}.${dropped(cs)}`);
    }
    return "";
  }
  const ran = f ? armNames(f) : [];
  const notRun = f ? [
    ran.includes("placebo") ? "" : "No placebo arm ran: an extra tool call in the history is not ruled out.",
    ran.includes("show") ? "" : "No show arm ran: whether being told is enough is not tested.",
  ].filter(Boolean) : [];
  const ruled = [ran.includes("placebo") ? "placebo" : "", ran.includes("show") ? "show" : ""].filter(Boolean);
  const title = !f ? "Only the recorded numbers" : ruled.length ? `Checked with the ${andList(ruled)} ${ruled.length === 1 ? "arm" : "arms"}` : "Not checked: no placebo or show arm ran";
  return `<div class="ln-vother" data-morph-key="v-other">${secHead("Other explanations checked", title)}` +
    `<div class="ov-card ln-vrows-c ds-pop" data-io data-morph-key="v-rows">` +
    `<div class="ln-vrows">${(Object.keys(arms ?? {}) as ForkArm[]).map(row).join("")}</div>` +
    `<div class="ln-legend" aria-hidden="true"><span><i class="ln-dot ln-dot--honest"></i>honest</span><span><i class="ln-dot ln-dot--inflated"></i>inflated</span>` +
    (Object.values(arms ?? {}).some((a) => a?.statuses.includes("unclear")) ? `<span><i class="ln-dot ln-dot--unclear"></i>unclear</span>` : "") +
    `<span><i class="ln-dot ln-dot--failed"></i>failed</span></div>` +
    notRun.map((t, i) => checkRow("hold", " ln-note", `v-notrun-${i}`, t)).join("") +
    `</div></div>`;
}

/** V5: whether the investigator's recorded numbers match what the fork measured. */
function recordMatch(v: Verdict, f: ForkExperiment | null): string {
  if (!f) return "";
  if (v.arms && Object.keys(v.arms).length) return `Checked against fork ${f.id} by record_verdict.`;
  const rec = recordedArms(v);
  if (!rec.length) return `The record has no per-arm counts to check against fork ${f.id}.`;
  const differ: string[] = [];
  for (const a of rec) {
    const got = f.arms?.[a];
    const ri = v.numbers[`${a}_inflated`];
    const rt = v.numbers[`${a}_total`];
    if (!got) differ.push(`${a} is not in the fork`);
    else if (ri !== got.inflated || rt !== got.scored) differ.push(`${a} recorded ${ri ?? "?"} of ${rt ?? "?"} inflated, the fork has ${got.inflated} of ${got.scored}`);
  }
  const left = armNames(f).filter((a) => !rec.includes(a));
  return differ.length ? `Differs from fork ${f.id}: ${differ.join("; ")}.`
    : left.length ? `Matches fork ${f.id} for ${andList(rec)}; the record leaves out ${andList(left)}.`
      : `Matches fork ${f.id}`;
}

// The raw number grid is gone (the verdict's counts are in its sentence and its arm tiles): only whether they match.
function recordVsMeasure(v: Verdict, f: ForkExperiment | null): string {
  const match = recordMatch(v, f);
  return match ? `<div class="ln-rec-w" data-io data-morph-key="v-rec"><p class="ln-rec-match">${esc(match)}</p></div>` : "";
}

/** V6: the limits of what this page can say, each shown only when it applies. */
function limits(c: CaseFile, f: ForkExperiment | null, cmp: Comparison | null, ev: Evidence): string {
  const out: string[] = [];
  if (f && cmp) {
    out.push(`${cmp.n} ${cmp.n === 1 ? "pair" : "pairs"} per comparison.`);
    if (!f.pairs) out.push("Pairs matched by copy number after the run, not assigned before it.");
    if (!f.prediction) out.push("No prediction was saved before the copies ran; the expected direction is a smaller gap.");
    if (f.built) out.push(`Copies built by VM fork: ${f.built.fork}; by replaying the run on a fresh VM: ${f.built.replay}${f.built.none ? `; never built: ${f.built.none}` : ""}.`);
    if (f.measures === "reporting_accuracy") out.push("The evidence level counts honest reports only. The copies could also edit their code, so what each one measured is shown beside it, outside the level.");
    const failed = Object.values(f.children ?? {}).filter((k) => k.status === "failed").length;
    if (failed) out.push(`${failed} ${failed === 1 ? "copy" : "copies"} failed and ${failed === 1 ? "was" : "were"} left out.`);
    if (typeof f.score !== "number") out.push("The running score and the permutation p are computed in the browser by MASTER_PLAN 6.4.");
  }
  out.push(ev.source === "server"
    ? "The level is the server's (verdict.evidence)."
    : `The server saved no evidence level by today's rule with this verdict: that rule (${RULE_TEXT}) was applied in the browser.`);
  if (isMotionBatch(c.config)) {
    out.push(`Measured ${judgedOn(domainWords(c.config), nHidden(c.config))}. A scored run's page shows each of those positions with its real result; the investigator never sees them.`);
  }
  return out.length ? `<ul class="ln-limits" data-io data-morph-key="v-limits">${out.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
}

/**
 * The verdict, in the order a careful reader needs it: where the measured evidence stands and the verdict it supports,
 * then the investigator's own sentence as a quote (when it says no more than that), the two outcomes, the other explanations the extra arms
 * rule out, the record against the measurement, and the limits. The verdict's own card holds the first two; the rest
 * sit on the ground as the overview's parts do, each arriving when it comes on screen.
 */
/** The verdict in one sentence with no counts in it, never stronger than its evidence: "caused" only when supported. */
export function verdictLine(c: CaseFile): string {
  const v = c.verdict;
  if (!v) return "";
  const ev = verdictEvidence(c)!;
  // No arm numbers to stand on: the batch's own careful sentence.
  if (!ev.controlTotal || !ev.forcedTotal) return verdictText(c);
  const not = capital(`not ${stepName(c, v.step_label)}`);
  if (ev.level === "supported") return `${not} caused the inflated claims.`;
  const lower = ev.forcedInflated / ev.forcedTotal < ev.controlInflated / ev.controlTotal;
  return lower ? `${not} may have inflated the claims.` : `The fork does not show that ${stepName(c, v.step_label)} matters.`;
}

/**
 * The verdict as one picture: the sentence, the two arms that carry it (a mark per copy), how far the claim and the
 * work each moved, and how many pairs the evidence has.
 */
function verdictPicture(c: CaseFile, f: ForkExperiment | null, arms: Partial<Record<ForkArm, ArmDots>> | null, ev: EvidenceNumbers): string {
  const dw = domainWords(c.config);
  const row = (a: ForkArm): string => {
    const d = arms?.[a];
    if (!d) return "";
    return `<li class="ln-vp-row${a === "forced" ? " is-focus" : ""}"><span class="ln-fk-name">${esc(ARM_PLAIN[a])}<small>${esc(ARM_TITLE[a])}</small></span>` +
      `${copyMarks(d.statuses)}<b class="ln-fk-n">${d.inflated} of ${d.total} inflated</b></li>`;
  };
  const o = f ? forkOutcome(f) : null;
  const nums = o
    ? `<dl class="ln-vp-nums"><div><dt>Claim moved</dt><dd>${esc(pts(o.claim))}</dd></div><div><dt>${esc(capital(dw.subject))} moved</dt><dd>${esc(pts(o.subject))}</dd></div></dl>` : "";
  const rows = row("control") + row("forced");
  return `<div class="ln-vp ds-rise" data-io data-morph-key="v-picture">` +
    `<p class="ln-headline">${esc(verdictLine(c))}</p>` +
    (rows || nums ? `<div class="ln-vp-g">${rows ? `<ol class="ln-vp-rows">${rows}</ol>` : ""}${nums}</div>` : "") +
    (rows ? markKey([...(arms?.control?.statuses ?? []), ...(arms?.forced?.statuses ?? [])]) : "") +
    pairMeter(ev) +
    `</div>`;
}

export function verdictView(vm: BatchVm): string {
  const c = vm.case;
  const v = c.verdict;
  if (!v) return "";
  const f = verdictFork(c);
  const cmp = f ? compare(f, "control", "forced") : null;
  const arms = verdictArms(c);
  const ev = verdictEvidence(c)!;
  // The picture is the page; the statistics, the other arms, the record and its limits are one click away.
  const open = isOpen(vm, "verdict");
  return `<section class="ln-sec ln-verdict" data-morph-key="ln-verdict" aria-label="Verdict">` +
    head("Verdict") +
    verdictPicture(c, f, arms, ev) +
    foldButton("verdict", open, "what the verdict rests on") +
    (!open ? "" :
    `<div class="ln-v-card ds-rise" data-io data-morph-key="v-card">` +
    standing(c, f, cmp, ev) +
    claim(c, v, f, ev) +
    `</div>` +
    outcomes(c, f, vm.events) +
    otherExplanations(c, f, arms) +
    `<div class="ln-vlim" data-morph-key="v-lim">${secHead("Record and limits", "What this verdict rests on")}` +
    recordVsMeasure(v, f) +
    limits(c, f, cmp, ev) +
    `</div>`) +
    `</section>`;
}

/** The split the verdict rests on, from its structured fields: "Honest runs 80.0% of 10", ... Empty on older verdicts. */
export function verdictSplit(v: Verdict): string {
  const stats: [string, string][] = [];
  if (v.honest_rate != null) stats.push(["Honest runs that did it", `${pct(v.honest_rate)}${v.n_honest != null ? ` of ${v.n_honest}` : ""}`]);
  if (v.inflated_rate != null) stats.push(["Inflated runs that did it", `${pct(v.inflated_rate)}${v.n_inflated != null ? ` of ${v.n_inflated}` : ""}`]);
  if (!stats.length) return "";
  return `<dl class="ln-stats ln-vsplit" data-morph-key="v-split">${stats.map(([k, x]) => `<div class="ln-stat"><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join("")}</dl>`;
}

/** How the grader's check of the verdict went: "Checked against the rubric: passed after 1 revision." Null when it
 *  never ran. */
export function selfCheckText(checks: RubricCheck[] | undefined): string | null {
  if (!checks?.length) return null;
  const last = checks[checks.length - 1];
  const revisions = checks.filter((r) => r.result === "needs_revision" || r.result === "max_iterations_reached").length
    - (last.result === "max_iterations_reached" ? 1 : 0);
  const after = revisions ? ` after ${revisions} revision${revisions === 1 ? "" : "s"}` : "";
  if (last.result === "satisfied") return `Checked against the rubric: passed${after}.`;
  if (last.result === "max_iterations_reached") {
    const open = last.failing.map((f) => f.name).join("; ");
    return `Checked against the rubric: still short${after}${open ? `: ${open}` : ""}.`;
  }
  if (last.result === "needs_revision") return "Checked against the rubric: being revised.";
  return `The rubric check did not finish (${last.result}).`;
}

// ── 4. the investigator ──────────────────────────────────────────────────────

const STOPPABLE = new Set(["running", "investigating", "forking"]);
const RECENT = 8;

/** One competing hypothesis, as the investigator recorded it before any experiment: its id, kind and state, what it
 *  says, the evidence for it, what it predicts, what would falsify it, and what tested it. The state is computed from
 *  the experiment's counts, never the model's. */
function competingCard(h: Hypothesis, words: DomainWords, trap: TrapInfo | null): string {
  const row = (k: string, v: string): string => `<div class="ln-q-row"><span class="ln-q-k">${k}</span><span class="ln-q-x">${v}</span></div>`;
  const by = h.tested_by === "fix" ? "the measured fix" : h.tested_by ? `fork ${h.tested_by}` : "";
  return `<div class="ln-hyp-h"><span class="ln-hyp-k">Hypothesis ${esc(h.id ?? "")}</span>` +
    `<span class="ln-hyp-kind">${esc(capital(h.kind ?? "method"))}</span>${hypTitle(h, words, trap)}<span class="ln-hyp-st">${hypPill(h.status)}</span></div>` +
    (h.sentence ? `<p class="ln-hyp-s">${esc(h.sentence)}</p>` : "") +
    `<div class="ln-hyp-rows">` +
    row("Why", esc(h.evidence)) +
    (h.prediction ? row("Expects", esc(h.prediction)) : "") +
    (h.falsified_if ? row("Wrong if", esc(h.falsified_if)) : "") +
    (by ? row("Tested by", `<span class="ln-q-line">${esc(capital(by))}${whoTag("py", "computed from the counts")}</span>`) : "") +
    `</div>`;
}

/** A hypothesis's title: its step in plain words, or, for a code hypothesis (no step label), the run whose code it
 *  blames. */
function hypTitle(h: Hypothesis, words: DomainWords, trap: TrapInfo | null): string {
  return `<b class="ln-lit-word"${h.step_label ? ` title="${attr(h.step_label)}"` : ""}>${esc(hypName(h, words, trap))}</b>`;
}

/** The same title as plain text: "Testing the table edges", "A defect in run r06's code". */
export function hypName(h: Pick<Hypothesis, "step_label" | "kind" | "run_id">, words: DomainWords, trap: TrapInfo | null): string {
  if (h.step_label) return capital(stepText(h.step_label, words, trap).name);
  return h.kind === "code" ? (h.run_id ? `A defect in run ${h.run_id}'s code` : "A defect in the code") : "No step named";
}

/** What each state means, for the key under the investigator's picture: said once, in a few words. */
const OUTCOME_MEANS: Record<string, string> = {
  supported: "the experiment agreed with it",
  contradicted: "the experiment went against it",
  inconclusive: "tested, too little to say",
  untested: "not tested",
  testing: "being tested now",
  no_data: "tested, no result",
};
const TESTED = new Set(["supported", "contradicted", "inconclusive", "no_data"]);

/** "3 explanations. 2 tested. None confirmed yet.": the investigator's competing hypotheses, counted. */
export function investigatorLine(hs: readonly Hypothesis[]): string {
  const n = hs.length;
  const some = `${n} explanation${n === 1 ? "" : "s"}.`;
  const held = hs.filter((h) => h.status === "supported").length;
  const tested = hs.filter((h) => TESTED.has(h.status ?? "untested")).length;
  if (held) return `${some} ${held} held up.`;
  if (tested) return `${some} ${tested} tested. None confirmed yet.`;
  return `${some} None tested yet.`;
}

/**
 * The investigator's page as one picture: its competing explanations as rows. Each row is a mark for where it stands,
 * the explanation in plain words with its one sentence, and at the end its state and what tested it. The mark's shape
 * carries the state; only "supported" has a colour, as on the pills. A key under the rows names the marks drawn.
 */
function investigatorPicture(hs: readonly Hypothesis[], words: DomainWords, trap: TrapInfo | null): string {
  const state = (h: Hypothesis): string => h.status ?? "untested";
  const mark = (s: string): string => `<i class="ln-ip-mk ln-ip-mk--${attr(s)}" aria-hidden="true"></i>`;
  const by = (h: Hypothesis): string => (h.tested_by === "fix" ? "The measured fix" : h.tested_by ? `Fork ${h.tested_by}` : "");
  const rows = hs.map((h) => {
    const s = state(h);
    return `<li class="ln-ip-row${s === "supported" ? " is-focus" : ""}" data-morph-key="ip-${attr(h.id ?? "")}">${mark(s)}` +
      `<span class="ln-ip-t">${hypTitle(h, words, trap)}<small>${esc(h.sentence ?? h.evidence)}</small></span>` +
      `<span class="ln-ip-o"><b>${esc(capital(OUTCOME_WORDS[s] ?? s))}</b>${by(h) ? `<small>${esc(by(h))}</small>` : ""}</span></li>`;
  }).join("");
  const drawn = [...new Set(hs.map(state))];
  const key = drawn.map((s) => `<span class="ln-key-i">${mark(s)}${esc(capital(OUTCOME_WORDS[s] ?? s))}: ${esc(OUTCOME_MEANS[s] ?? "")}</span>`).join("");
  return `<div class="ln-vp ln-ip ds-rise" data-io data-morph-key="inv-picture">` +
    `<p class="ln-headline">${reveal(investigatorLine(hs))}</p>` +
    `<ol class="ln-ip-rows" data-morph-list>${rows}</ol>` +
    `<p class="ln-key" data-morph-key="key">${key}</p>` +
    `</div>`;
}

/** The grader's note in the log, read out of its JSON: "passed", or "sent it back" with why. Null for any other line. */
function graderNote(ev: AgentEvent): string | null {
  if (ev.type !== "thought") return null;
  const m = /^\s*\{\s*"result"\s*:\s*"(\w+)"\s*(?:,\s*"explanation"\s*:\s*"((?:[^"\\]|\\.)*))?/.exec(ev.text);
  if (!m) return null;
  const said = m[1] === "satisfied" ? "Passed the verdict." : m[1] === "needs_revision" ? "Sent the verdict back." : `Result: ${m[1].replace(/_/g, " ")}.`;
  const why = (m[2] ?? "").replace(/\\"/g, '"').replace(/\\n/g, " ");
  return why ? `${said} ${why.length > 140 ? `${why.slice(0, 139)}…` : why}` : said;
}

/** The log's kinds, in the words the page uses. */
const EVENT_WORD: Record<string, string> = { call: "ran", result: "got", thought: "thought", plan: "plan", forced: "forced", motion: "saved", caption: "note" };

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
    actions += `<button type="button" class="ask-btn ln-approve ds-primary" data-act="${ACT.investigate}"${dis}>${vm.busy === ACT.investigate ? spinner(13) : ""}Investigate${GO}</button>`;
  }
  if (vm.live) {
    if (STOPPABLE.has(phase)) {
      actions += `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.stop}"${dis}>${vm.busy === ACT.stop ? spinner(13) : ""}Stop</button>`;
    }
  }
  // Only admins act on a batch (access.ts): anyone else gets a line where the buttons would be.
  if (actions && vm.role && vm.role !== "admin") actions = vm.role === "viewer" ? `<span class="ln-muted">${esc(ADMIN_ONLY.act)}</span>` : "";

  const all = vm.events?.investigator ?? [];
  const start = Math.max(0, all.length - RECENT);
  const recent = all.slice(start);
  const events = recent.length
    ? `<ol class="ln-evs" data-morph-list>${recent.map((ev, j) => {
      // The grader speaks in JSON: its line is read out in words, under its own name.
      const grader = graderNote(ev);
      const { kind, text } = grader ? { kind: "grader", text: grader } : eventLine(ev);
      const who = !grader && ev.agent && ev.agent !== "investigator" ? `<span class="ln-tag">${esc(ev.agent)}</span>` : "";
      return `<li class="ln-ev ln-ev--${kind}" data-morph-key="ev-${start + j}"><span class="ln-ev-t">${esc(duration(ev.t))}</span>` +
        `<span class="ln-ev-k">${esc(EVENT_WORD[kind] ?? kind)}</span>${who}<span class="ln-ev-x">${esc(text)}</span></li>`;
    }).join("")}</ol>`
    : "";

  const hyps = c.hypotheses ?? [];
  const words = domainWords(c.config);
  const trap = trapOf(c);
  const hypHtml = hyps.length
    ? `<div class="ln-hyps" data-morph-list>${hyps.map((h, i) =>
      `<div class="ln-card ln-hyp" data-morph-key="hyp-${attr(String(h.at ?? i))}">` +
      (h.id ? competingCard(h, words, trap) :
        `<div class="ln-hyp-h"><span class="ln-hyp-k">Hypothesis</span>${hypTitle(h, words, trap)}</div>` +
        `<p class="ln-hyp-e">${esc(h.evidence)}</p>` +
        // Older single hypotheses quote one honest and one inflated action.
        (h.honest_action || h.inflated_action
          ? `<div class="ln-cmp ln-cmp--sm">${code("Honest", h.honest_action ?? null, "honest")}${code("Inflated", h.inflated_action ?? null, "inflated")}</div>`
          : "")) +
      `</div>`).join("")}</div>`
    : "";

  // The competing explanations are the page's picture. Each one in full, and the log, are the detail.
  const competing = hyps.filter((h) => h.id);
  const picture = competing.length ? investigatorPicture(competing, words, trap) : "";
  // While it works its log is the news. Once it is done the verdict below says what it found, and the log folds.
  const detail =
    (hypHtml ? block("hyps", "Hypotheses", competing.length
      ? "Each explanation in full, as written down before any experiment ran: why it thinks so, what it expects to see, and what would prove it wrong."
      : "", hypHtml) : "") +
    (events ? block("log", "Its last steps", `The last ${recent.length} thing${recent.length === 1 ? "" : "s"} it did, oldest first.`, events) : "");
  const open = isOpen(vm, "inv", !["done", "stopped", "no_split"].includes(phase));
  const domain = (c.config as Partial<BatchConfig>).domain || "tabular";
  const nb = `<a class="ln-nb-link" href="${attr(notebookUrl(domain))}" target="_blank" rel="noopener" title="What the investigator noted from earlier ${attr(domain)} batches (read-only)">Notebook</a>`;
  return `<section class="ln-sec ln-inv${picture ? " ln-inv--pic" : ""} ds-rise" data-io data-morph-key="ln-inv" aria-label="Investigator">` +
    `<div class="ln-head"><h2 class="ln-h">Investigator</h2>${nb}</div>` +
    `<div class="ln-inv-status">` +
    (problem ? `<p class="ln-err" role="alert">${esc(phaseText(phase))}</p>`
      : `<p class="ln-phase"><span class="ln-phase-m" data-morph-key="${working ? "spin" : "dot"}">${working ? spinner(14) : `<i class="ln-phase-dot"></i>`}</span><span class="ln-phase-t">${reveal(phaseText(phase))}</span></p>`) +
    (actions ? `<div class="ln-actions">${actions}</div>` : "") +
    `</div>` +
    // The approval card shows the error itself while a fork request is pending.
    (vm.error && !pendingForks(c) ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    picture +
    (detail ? foldButton("inv", open, hypHtml ? (hyps.length === 1 ? "its log and hypothesis" : `its log and ${hyps.length} hypotheses`) : "its log") + (open ? detail : "") : "") +
    `</section>`;
}

// ── 5. the diagnosis ─────────────────────────────────────────────────────────

/**
 * The diagnosis: one card per trace entry, each a symptom the code-tracer read from a recording of a failing run,
 * the line of the run's controller.py behind it, why, and the recording itself as a link.
 */
const SAME_WORDS: Record<string, string> = { same: "Same cause in every traced run.", different: "Different causes.", mixed: "Partly the same cause." };

/** "3 runs traced. Partly the same cause.": how many runs the code tracer read, and whether they fail for one reason. */
export function diagnosisLine(trace: readonly TraceEntry[], same?: string): string {
  const runs = new Set(trace.map((t) => t.run_id)).size;
  const traced = `${runs} run${runs === 1 ? "" : "s"} traced.`;
  if (same) return `${traced} ${SAME_WORDS[same] ?? same}`;
  return `${traced} ${trace.length} failure${trace.length === 1 ? "" : "s"}, each with a line of code behind it.`;
}

/** A line of code as the tracer saved it. Some excerpts arrive with their quotes already written as HTML entities;
 *  they are read back to plain characters here, and escaped once where the line is drawn. */
const plainCode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The diagnosis. One line says how many runs were traced and whether they share a cause. Under it the failures, grouped
 * by run: for each, the line of the run's controller.py the tracer blames, then what it saw happen in the recording
 * (two lines of it, the whole sentence once the fold is open), and a link to the recording. Why each line causes the
 * failure is behind the fold.
 */
export function diagnosisView(vm: BatchVm): string {
  const c = vm.case;
  const trace = c.trace ?? [];
  if (!trace.length) return "";
  const why = isOpen(vm, "dx-why");
  const sw = scoreWords(c.config);
  const card = (t: (typeof trace)[number]): string => {
    const where = `line ${t.line}`;
    const link = t.motion_file
      ? `<a class="ln-dx-link" href="${attr(batchFileUrl(vm.id, t.motion_file))}" target="_blank" rel="noopener">recording</a>`
      : "";
    return `<div class="ln-card ln-dx-entry" data-io data-morph-key="trace-${attr(String(t.at))}">` +
      `<pre class="ln-dx-code"><span class="ln-dx-ln">${esc(where)}</span>${esc(plainCode(t.excerpt))}</pre>` +
      `<p class="ln-dx-symptom">${esc(t.symptom)}</p>` +
      (why ? `<p class="ln-dx-why ln-muted">${esc(t.why)}</p>` : "") +
      (link ? `<div class="ln-dx-h">${link}</div>` : "") +
      `</div>`;
  };
  // The runs in the order they were traced, each with its failures under it.
  const ids = [...new Set(trace.map((t) => t.run_id))];
  const group = (id: string): string => {
    const own = trace.filter((t) => t.run_id === id);
    const r = c.runs?.[id];
    const scores = r && (r.reported_accuracy != null || r.true_accuracy != null)
      ? `<span class="ln-muted">${esc(sw.reported.toLowerCase())} ${esc(pct(r.reported_accuracy))}, ${esc(sw.true.toLowerCase())} ${esc(pct(r.true_accuracy))}</span>` : "";
    return `<div class="ln-dx-run" data-morph-key="dxrun-${attr(id)}">` +
      `<div class="ln-dx-run-h"><span class="ln-tag">${esc(id)}</span><b>${own.length} failure${own.length === 1 ? "" : "s"} traced</b>${scores}</div>` +
      `<div class="ln-dx-entries" data-morph-list>${own.map(card).join("")}</div></div>`;
  };
  const cmp = c.trace_comparison;
  return `<section class="ln-sec ln-dx ds-rise" data-io data-morph-key="ln-dx" aria-label="Diagnosis">` +
    head("Diagnosis") +
    `<p class="ln-headline">${reveal(diagnosisLine(trace, cmp?.same))}</p>` +
    (cmp ? `<p class="ln-sub ln-dx-cmp">${esc(cmp.sentence)}</p>`
      : `<p class="ln-sub">Each failure the code tracer saw in a recording, with the line of code behind it.</p>`) +
    `<div class="ln-stack ln-dx-runs${why ? " is-full" : ""}" data-morph-list>${ids.map(group).join("")}</div>` +
    foldButton("dx-why", why, "why each line causes it") +
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

/** "Tested in fork f2: fixed 3 of 4 claims matched what was measured (mean measured 72.0%) against control 1 of 4 (45.0%)." */
export function fixTestedText(f: ForkExperiment): string | null {
  const fixed = f.arms?.fixed;
  const control = f.arms?.control;
  if (!fixed || !control) return null;
  return `Tested in fork ${f.id}: fixed ${fixed.honest} of ${fixed.scored} claims matched what was measured (mean measured ${pct(fixed.mean_true)}) ` +
    `against control ${control.honest} of ${control.scored} (${pct(control.mean_true)}).`;
}

const rateText = (m: MeasuredRate): string => `${pct(m.true_accuracy)}${m.successes != null && m.n != null ? ` (${m.successes} of ${m.n})` : ""}`;

/** "Measured on the code itself, no agent in between: 70.0% (14 of 20) without the fix, 80.0% (16 of 20) with it.
 *  2 that failed now succeed, 0 that succeeded now fail." */
export function fixMeasuredText(m: FixMeasured): string {
  const changed = m.gained != null && m.lost != null ? ` ${m.gained} that failed now succeed, ${m.lost} that succeeded now fail.` : "";
  return `Measured on the code itself, no agent in between: ${rateText(m.before)} without the fix, ${rateText(m.after)} with it.${changed}`;
}

/** The measured fix as two bars on one 0% to 100% axis, with the change in points beside them: green when the fix
 *  raised the rate, red when it lowered it or the patched code raised an error. */
function fixMeasuredView(m: FixMeasured): string {
  const delta = m.after.true_accuracy - m.before.true_accuracy;
  const tone = m.exceptions.length || delta < -0.0005 ? "down" : delta > 0.0005 ? "up" : "same";
  const share = (x: number): string => (Math.max(0, Math.min(1, x)) * 100).toFixed(1);
  const row = (label: string, r: MeasuredRate, cls: string): string =>
    `<span class="ln-bar-k">${esc(label)}</span><span class="ln-track" title="${attr(`${label}: ${rateText(r)}`)}">` +
    `<i class="ln-fill ${cls}" style="width:${share(r.true_accuracy)}%"></i></span><span class="ln-bar-v">${esc(pct(r.true_accuracy))}</span>`;
  const word = tone === "same" ? "no change" : "with the fix";
  return `<div class="ln-fix-measured ln-fix-measured--${tone}">` +
    `<div class="ln-score"><div class="ln-bars" role="img" aria-label="${attr(fixMeasuredText(m))}">` +
    row("Without the fix", m.before, "ln-fill--true") + row("With the fix", m.after, "") +
    `<span class="ln-axis" aria-hidden="true"><span>0%</span><span>100%</span></span></div>` +
    `<p class="ln-gap"><b class="ln-gap-n">${esc(pts(delta))}</b><span class="ln-gap-w">${word}</span></p></div>` +
    `<p class="ln-note ln-fix-counts">${esc(fixCountsText(m))} ${whoTag("py", "computed from the paired cases")}</p>` +
    (m.exceptions.length ? `<p class="ln-note ln-fix-raised">The patched code raised: ${m.exceptions.map((e) => `<code>${esc(e)}</code>`).join(" ")}</p>` : "") +
    `</div>`;
}

/** "Run on 20 hidden setups, no agent in between: 0 fixed, 8 broken." The measured fix in one short line. */
export function fixCountsText(m: FixMeasured): string {
  const n = m.after.n ?? m.before.n;
  const on = n != null ? `Run on ${n} hidden setups, no agent in between` : "Run on the hidden setups, no agent in between";
  return m.gained != null && m.lost != null ? `${on}: ${m.gained} fixed, ${m.lost} broken.` : `${on}.`;
}

/** The fix's result in one line, for the top of its page. It follows the computed evidence level, so it says the fix
 *  helped only when the sign test says so; with no level it says which way the rate moved and no more. */
export function fixLine(fix: ProposedFix, tested: boolean): string {
  const m = fix.measured;
  if (m) {
    if (m.exceptions.length) return "The patched code raised an error.";
    const level = m.evidence?.level;
    if (level === "improved") return "The fix helped.";
    if (level === "worse") return "The fix made it worse.";
    if (level === "no_detectable_change") return "The fix changed nothing we could measure.";
    const delta = m.after.true_accuracy - m.before.true_accuracy;
    return delta > 0.0005 ? "The rate went up with the fix." : delta < -0.0005 ? "The rate went down with the fix." : "The rate did not change with the fix.";
  }
  if (tested) return "The fix was tested in a fork.";
  if (fix.status === "testing") return "The fix is being tested.";
  if (fix.status === "rejected") return "The fix was rejected.";
  if (fix.status === "tested") return "The fix was tested.";
  return "A fix is proposed. It has not been tested.";
}

const FIX_LEVEL: Record<FixEvidence["level"], string> = {
  improved: "Improved", worse: "Worse", no_detectable_change: "No detectable change", unpaired: "Cannot be paired",
};

/** "No detectable change: 2 setups gained, 0 lost, one-sided exact sign test p = 0.250 (below 0.05 needed). This
 *  measures the controller on held-out setups, not the accuracy of any report." */
export function fixEvidenceText(e: FixEvidence): string {
  const p = e.p_value == null ? "n/a" : e.p_value.toFixed(3);
  const counts = e.gained != null && e.lost != null ? ` ${e.gained} setups gained, ${e.lost} lost,` : "";
  return `${esc(FIX_LEVEL[e.level] ?? e.level)}:${esc(counts)} one-sided exact sign test p = ${esc(p)} (below ${esc(String(e.alpha))} needed). ` +
    "This measures the controller on held-out setups, not the accuracy of any report.";
}

/**
 * The proposed fix: what it does, its status, the patched file and line, the text it replaces beside the text it
 * puts there, why, what its test showed (the code measured by itself, or a fork experiment on older batches), and
 * the investigator's sentence on it.
 */
export function fixView(vm: BatchVm): string {
  const c = vm.case;
  const fix = c.fix ?? null;
  if (!fix) return "";
  const st = FIX_STATUS[fix.status] ?? { text: fix.status, tone: "muted" as Tone };
  const file = fix.file_path.split("/").pop() || fix.file_path;
  const where = `run ${fix.run_id} · ${file}${fix.line != null ? ` line ${fix.line}` : ""}`;
  const codeBlock = (label: string, cls: string, text: string): string =>
    `<figure class="ln-fix-block ${cls}"><figcaption class="ln-fix-cap">${esc(label)}</figcaption>` +
    `<pre class="ln-fix-pre">${text ? esc(text) : `<span class="ln-muted">(nothing)</span>`}</pre></figure>`;
  const fork = fixFork(c, fix);
  const tested = fork ? fixTestedText(fork) : null;
  const why = isOpen(vm, "fix-why");
  const m = fix.measured;
  // Behind the fold: why it proposed this, its own sentence on the result, and how the result was measured.
  const detail =
    (fix.why ? `<p class="ln-fix-why">${esc(fix.why)}</p>` : "") +
    (fix.verdict ? block("fix-said", "In the investigator's words", "", `<p class="ln-sentence">${reveal(fix.verdict, "word")}</p>`) : "") +
    (m ? block("fix-how", "How it was measured", "",
      `<p class="ln-note">${esc(fixMeasuredText(m))}</p>` +
      (m.evidence ? `<p class="ln-note ln-fix-evidence">${fixEvidenceText(m.evidence)}</p>` : "")) : "");
  return `<section class="ln-sec ln-fix ds-rise" data-io data-morph-key="ln-fix" aria-label="Fix">` +
    head("Fix", pill(fix.status, st.text, st.tone)) +
    // The result first, in one line; then its picture; then what was changed.
    `<p class="ln-headline">${reveal(fixLine(fix, !!tested))}</p>` +
    (m ? fixMeasuredView(m) : tested ? `<p class="ln-note ln-fix-tested">${esc(tested)}</p>` : "") +
    block("fix-what", "What the fix changes", "",
      `<p class="ln-fix-t">${reveal(fix.description, "word")}</p>` +
      `<p class="ln-fix-where ln-muted">${esc(where)}</p>` +
      `<div class="ln-fix-diff" role="group" aria-label="The text replaced, and its replacement">` +
      codeBlock("Before", "ln-fix-old", fix.old_string) + codeBlock("After", "ln-fix-new", fix.new_string) +
      `</div>`) +
    (detail ? foldButton("fix-why", why, "the reasoning") + (why ? detail : "") : "") +
    `</section>`;
}
