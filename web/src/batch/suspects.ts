// The investigator's science, as MASTER_PLAN Phase 8 shows it: the suspect board, the approval card of a paired
// experiment, the verdict by suspect (with the two-factor grid and the audit sheet), the investigator's plan and the
// subagent at work, and the lessons it proposes. Every export is a pure `(vm) => html` view that returns "" when its
// section is absent, so main.ts can stack them on the existing pages. Classes are prefixed `sx-`; the look is in
// suspects.css, on lanes.css's tokens.
//
// Sources (all optional, read when present; docs/api-contract.md):
//   suspects[]          {id, target, kind, rationale, proposed_by, status}; without it, `hypotheses` with an id
//   evidence.<id>       {pairs, agree, score, p_exact, level, cost_usd, experiments}; without it, computed from the
//                       forks that name the suspect (`suspect_id`, or `hypothesis_id`) and their `pairs`
//   forks.<id>          suspect_id, change, anchor, prediction, pairs[{i, control_gap, changed_gap, agree}], score, level
//   forks.pending       suspect_id, change, anchor, prediction, pairs (a count), estimate_usd, cost_per_pair_usd
//   interaction, audit  deep_research/interaction.py, deep_research/audit.py
//   lessons[]           {id, name, rule, status: proposed | approved | rejected, suspect_id?}
//   investigator        {todos, subagent}; without it, the investigator log's last plan and the agent of its last event
//
// The evidence rule (MASTER_PLAN 6.4, deep_research/experiments.py): the score starts at 1, x1.9 per agreeing pair,
// x0.1 per other; supported at 20 or more, cleared after at least 5 pairs under 1, open otherwise. A cause is never
// shown without its score.
import "./suspects.css";
import type { AgentEvent, AgentTodo, AuditAnswer, CaseFile, ForkExperiment, Interaction, PendingForks } from "../api";
import { isPendingForks } from "../api";
import { chip, spinner, type ChipMark, type ChipTone } from "../motion";
import { attr, esc } from "../ui";
import { usd } from "./format";
import { ACT, type BatchVm } from "./model";
import { isDone, pairs as childPairs } from "./evidence";
import { ADMIN_ONLY } from "../access";

// ── the rule ─────────────────────────────────────────────────────────────────

export const AGREE = 1.9;
export const DISAGREE = 0.1;
export const SUPPORTED_AT = 20;
export const CLEARED_AFTER = 5;
/** The most pairs one experiment may ask for (experiments.MAX_PAIRS_PER_CALL). */
export const MAX_PAIRS = 6;

export type SxLevel = "open" | "supported" | "cleared";
export type SxStatus = "proposed" | "testing" | SxLevel;

/** The running score of a list of pair outcomes. */
export const scoreOf = (agree: readonly boolean[]): number => agree.reduce((s, a) => s * (a ? AGREE : DISAGREE), 1);

export function levelOf(score: number, nPairs: number): SxLevel {
  if (score >= SUPPORTED_AT) return "supported";
  if (nPairs >= CLEARED_AFTER && score < 1) return "cleared";
  return "open";
}

/** The score bar's axis: 10^-3 to 10^3, a decade a sixth of the width. */
const LOG_MIN = -3, LOG_MAX = 3;
/** Where a score sits on the bar, 0 to 1. */
export const logShare = (score: number): number =>
  !(score > 0) ? 0 : Math.min(1, Math.max(0, (Math.log10(score) - LOG_MIN) / (LOG_MAX - LOG_MIN)));

/** 169.8, 13.03, 1, 0.19, 0.0036. */
export function scoreText(x: number): string {
  if (!Number.isFinite(x)) return "–";
  if (x >= 100) return x.toFixed(1);
  if (x >= 1) return String(Number(x.toPrecision(4)));
  return String(Number(x.toPrecision(2)));
}

// ── reading the case ─────────────────────────────────────────────────────────

export type SuspectKind = "omission" | "commission" | "attribute" | "data";
export interface Suspect { id: string; target: string; kind: SuspectKind | string; rationale: string; proposed_by: string; status: SxStatus | string; simulated?: boolean }
export interface Pair { i: number; control_gap: number; changed_gap: number; agree: boolean }
export interface Lesson { id: string; name: string; rule: string; status: "proposed" | "approved" | "rejected" | string; suspect_id?: string; simulated?: boolean }
/** forks.pending as the paired engine writes it (MASTER_PLAN 6.1), on top of today's fields. */
export interface SuspectPending extends PendingForks {
  suspect_id?: string | null;
  change?: string | null;
  anchor?: string | null;
  source_run?: string | null;
  reason?: string | null;
  /** How many pairs it asks for. */
  pairs?: number | null;
  cost_per_pair_usd?: number | null;
  /** Unix seconds: when its prediction was saved (tells one request from the next). */
  preregistered_at?: number | null;
}
type PairedFork = ForkExperiment & { simulated?: boolean };
/** The sections this module reads that api.ts's CaseFile may not name yet. */
export type SxCase = CaseFile & {
  suspects?: Suspect[];
  lessons?: Lesson[];
  investigator?: { todos?: AgentTodo[]; subagent?: string | null; subagent_calls?: Record<string, number> } | null;
};

const HYP_STATUS: Record<string, SxStatus> = { untested: "proposed", testing: "testing" };

/** The suspects: `suspects` when written, else the hypotheses that have an id (their outcomes are not levels: an
 *  outcome becomes a level only through a score, below). */
export function suspectsOf(c: CaseFile): Suspect[] {
  const s = (c as SxCase).suspects;
  if (Array.isArray(s) && s.length) return s;
  return (c.hypotheses ?? []).filter((h) => h.id).map((h) => ({
    id: h.id!, target: h.step_label, kind: h.kind === "code" ? "commission" : "omission",
    rationale: (h as { sentence?: string }).sentence ?? h.evidence ?? "", proposed_by: "investigator",
    status: HYP_STATUS[h.status ?? "untested"] ?? (h.tested_by ? "open" : "proposed"),
  }));
}

/** The finished experiments that tested a suspect, oldest first. */
export function experimentsOf(c: CaseFile, id: string): PairedFork[] {
  return Object.values(c.forks ?? {})
    .filter((f): f is PairedFork => !isPendingForks(f) && (f.suspect_id ?? f.hypothesis_id) === id)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** An experiment's pairs: the server's when it wrote them, else matched from its scored copies. */
export function forkPairs(f: ForkExperiment): Pair[] {
  if (Array.isArray(f.pairs)) return f.pairs;
  if (f.status !== "done" && f.status !== "stopped") return [];
  return childPairs(f, "control", f.kind === "fix" ? "fixed" : "forced").filter(isDone)
    .map((p) => ({ i: p.i, control_gap: p.baseGap, changed_gap: p.changedGap, agree: p.agree }));
}

export interface SuspectRow {
  s: Suspect;
  pairs: Pair[];
  /** Pairs behind the score: the evidence's count when recorded, else `pairs.length`. */
  nPairs: number;
  score: number | null;
  level: SxLevel | null;
  /** The status to show: a level only when there is a score behind it. */
  status: SxStatus;
  prediction: string | null;
  change: string | null;
  cost: number | null;
  /** The experiments, by fork id. */
  experiments: string[];
  /** True when the score came from the case file, false when it was matched here. */
  recorded: boolean;
  simulated: boolean;
}

export function suspectRows(c: CaseFile): SuspectRow[] {
  return suspectsOf(c).map((s) => {
    const ev = c.evidence?.[s.id];
    const exps = experimentsOf(c, s.id);
    const pairs = exps.flatMap(forkPairs);
    const score = ev ? ev.score : pairs.length ? scoreOf(pairs.map((p) => p.agree)) : null;
    const n = ev ? ev.pairs : pairs.length;
    const level = score == null ? null : ev?.level ?? levelOf(score, n);
    const said = String(s.status);
    const status: SxStatus = level && level !== "open" ? level
      : said === "testing" || exps.some((f) => f.status === "running" || f.status === "rebuilding") ? "testing"
      : level ?? "proposed";
    const last = exps.at(-1);
    const costs = exps.map((f) => f.cost_usd);
    const cost = ev ? ev.cost_usd : costs.length && costs.every((x) => typeof x === "number") ? (costs as number[]).reduce((a, b) => a + b, 0) : null;
    return {
      s, pairs, nPairs: n, score, level, status, cost, recorded: !!ev,
      prediction: last?.prediction ?? null, change: last?.change ?? null,
      experiments: ev?.experiments ?? exps.map((f) => f.id),
      simulated: !!(s.simulated || (ev as { simulated?: boolean } | undefined)?.simulated || exps.some((f) => f.simulated)),
    };
  });
}

export const isSimulatedCase = (c: CaseFile): boolean =>
  (c.config as { simulated?: boolean }).simulated === true || c.costs?.simulated === true;
export const assistOn = (c: CaseFile): boolean => (c.config as { investigator_assist?: string }).investigator_assist === "baseline";

// ── words and small pieces ───────────────────────────────────────────────────

const PRED: Record<string, string> = { smaller_gap: "the change shrinks the gap", larger_gap: "the change widens the gap" };
export const predictionText = (p: string | null | undefined): string => (p ? PRED[p] ?? p : "no prediction saved");

const KIND_WORD: Record<string, string> = {
  force_step: "Run a step", fake_result: "Fake a check's result", edit_context: "Tell the agent", swap_model: "Swap the model", control: "No change",
};
/** "force_step:deduplicate" -> "Run a step: deduplicate". */
export function changeText(change: string | null | undefined): string {
  if (!change) return "–";
  const i = change.indexOf(":");
  if (i < 0) return KIND_WORD[change] ?? change;
  const kind = change.slice(0, i);
  return `${KIND_WORD[kind] ?? kind}: ${change.slice(i + 1)}`;
}
export const anchorText = (a: string | null | undefined): string =>
  !a || a === "before_split" ? "just before the split" : a.startsWith("before_label:") ? `just before ${a.slice(13)}`
    : a.startsWith("index:") ? `at action ${a.slice(6)}` : a;

const STATUS_CHIP: Record<SxStatus, [ChipTone, ChipMark, string]> = {
  proposed: ["idle", "dot", "Proposed"], testing: ["live", "spin", "Testing"], open: ["warn", "hold", "Open"],
  supported: ["ok", "check", "Supported"], cleared: ["idle", "cross", "Cleared"],
};
const statusChip = (s: SxStatus): string => { const [t, m, w] = STATUS_CHIP[s]; return chip(w, t, m, `sx-st sx-st--${s}`); };

const tag = (text: string, cls = ""): string => `<span class="ln-tag sx-tag${cls ? ` ${cls}` : ""}">${esc(text)}</span>`;
export const simTag = (on: boolean): string => (on ? tag("simulated", "sx-tag--sim") : "");

/** The score on a log bar: a line at 1 (where it starts) and a line at 20 (supported). */
export function scoreBar(score: number | null, level: SxLevel | null): string {
  const at20 = (logShare(SUPPORTED_AT) * 100).toFixed(2);
  const at1 = (logShare(1) * 100).toFixed(2);
  const w = score == null ? 0 : logShare(score) * 100;
  const fill = score == null ? "" : `<span class="sx-bar-fill sx-bar-fill--${level ?? "open"}" style="width:${w.toFixed(2)}%"></span>`;
  return `<span class="sx-bar" role="img" aria-label="${attr(score == null ? "No score yet" : `Score ${scoreText(score)}, supported at ${SUPPORTED_AT}`)}">` +
    `<span class="sx-bar-track">${fill}<i class="sx-bar-one" style="left:${at1}%"></i><i class="sx-bar-bar" style="left:${at20}%"></i></span>` +
    `<span class="sx-bar-ax"><span style="left:0">0.001</span><span style="left:${at1}%">1</span><span class="sx-bar-ax-20" style="left:${at20}%">20</span><span style="left:100%">1000</span></span>` +
    `</span>`;
}

export function pairDots(pairs: readonly Pair[]): string {
  if (!pairs.length) return `<span class="sx-dots sx-dots--none">No pairs yet</span>`;
  const n = pairs.filter((p) => p.agree).length;
  return `<span class="sx-dots" role="img" aria-label="${attr(`${n} of ${pairs.length} pairs went the predicted way`)}">` +
    pairs.map((p) => `<i class="sx-dot sx-dot--${p.agree ? "agree" : "disagree"}" title="${attr(`Pair ${p.i}: control gap ${pts(p.control_gap)}, changed ${pts(p.changed_gap)}${p.agree ? ", as predicted" : ", not as predicted"}`)}"></i>`).join("") +
    `<span class="sx-dots-n">${n} of ${pairs.length} agree</span></span>`;
}

const pts = (x: number): string => `${(x * 100).toFixed(1)} pts`;
const costText = (x: number | null, simulated: boolean): string => (x != null ? usd(x) : simulated ? "no spend (simulated)" : "cost unknown");

const section = (key: string, title: string, body: string, extra = ""): string =>
  `<section class="ln-sec sx-sec sx-sec--${key}" data-morph-key="sx-${key}" aria-label="${attr(title)}">` +
  `<div class="ln-head"><h2 class="ln-h">${esc(title)}</h2>${extra}</div>${body}</section>`;

// ── tags ─────────────────────────────────────────────────────────────────────

/** "Simulated" and "Investigator assist" where a batch is either; "" otherwise. */
export function sxTagsView(vm: BatchVm): string {
  const c = vm.case;
  const tags: string[] = [];
  if (isSimulatedCase(c)) tags.push(`<span class="sx-flag sx-flag--sim" title="Scripted fixture data: nothing here ran on a model or a VM">Simulated batch</span>`);
  if (assistOn(c)) tags.push(`<span class="sx-flag sx-flag--assist" title="investigator_assist = baseline: the investigator was shown the plain-Python ranking of suspects">Investigator assist on</span>`);
  return tags.length ? `<div class="sx-flags" data-morph-key="sx-flags">${tags.join("")}</div>` : "";
}

// ── 1. the suspect board ─────────────────────────────────────────────────────

/** How a suspect card ends: on a finished batch, a suspect nobody tested says so, and where the investigator can be
 *  resumed (a real saved batch, `vm.testable`) it offers to ask for the test. */
export interface CardCtx { done: boolean; testable: readonly string[]; busy: string | null; admin: boolean }

function untestedLine(r: SuspectRow, ctx: CardCtx): string {
  if (!ctx.done || r.experiments.length || r.status !== "proposed") return "";
  const can = ctx.admin && ctx.testable.includes(r.s.id);
  const busy = ctx.busy === `test:${r.s.id}`;
  const btn = can
    ? `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${SX_ACT.testSuspect}" data-arg="${attr(r.s.id)}"${ctx.busy ? " disabled" : ""}>${busy ? spinner(13) : ""}Ask the investigator to test this</button>`
    : "";
  return `<p class="sx-untested" data-morph-key="sx-untested-${attr(r.s.id)}"><span>Not tested: the investigator reached its verdict first.</span>${btn}</p>`;
}

function suspectCard(r: SuspectRow, ctx: CardCtx = { done: false, testable: [], busy: null, admin: false }): string {
  const s = r.s;
  const scoreLine = r.score == null
    ? `<span class="sx-score-n sx-score-n--none">no score</span>`
    : `<span class="sx-score-n sx-score-n--${r.level}">${esc(scoreText(r.score))}</span>`;
  return `<article class="ln-card sx-sus sx-sus--${r.status}" data-morph-key="sx-sus-${attr(s.id)}">` +
    `<header class="sx-sus-h"><span class="sx-id">${esc(s.id)}</span><b class="sx-target">${esc(s.target)}</b>` +
    `${tag(s.kind)}${simTag(r.simulated)}<span class="sx-sp"></span>${statusChip(r.status)}</header>` +
    (s.rationale ? `<p class="sx-why">${esc(s.rationale)}</p>` : "") +
    `<dl class="sx-facts">` +
    `<div><dt>Proposed by</dt><dd><span class="sx-agent">${esc(s.proposed_by || "investigator")}</span></dd></div>` +
    `<div><dt>Prediction</dt><dd>${r.prediction ? esc(predictionText(r.prediction)) : `<span class="ln-muted">no experiment yet</span>`}</dd></div>` +
    (r.change ? `<div><dt>Change</dt><dd><code>${esc(r.change)}</code></dd></div>` : "") +
    `<div><dt>Cost</dt><dd>${r.experiments.length ? esc(costText(r.cost, r.simulated)) : `<span class="ln-muted">–</span>`}</dd></div>` +
    `</dl>` +
    `<div class="sx-ev"><div class="sx-score"><span class="sx-score-k">Score</span>${scoreLine}</div>${scoreBar(r.score, r.level)}</div>` +
    `<div class="sx-ev-foot">${pairDots(r.pairs)}${r.experiments.length ? `<span class="sx-exps">${esc(r.experiments.join(", "))}</span>` : ""}</div>` +
    untestedLine(r, ctx) +
    `</article>`;
}

export function suspectBoardView(vm: BatchVm): string {
  const rows = suspectRows(vm.case);
  if (!rows.length) return "";
  // A replay (vm.case is the case at its clock) is done only once it reaches the end; a simulated batch is never testable.
  const ctx: CardCtx = { done: investigatorDone(vm.case), testable: isSimulatedCase(vm.case) ? [] : vm.testable ?? [],
    busy: vm.busy, admin: !vm.role || vm.role === "admin" };
  const order: SxStatus[] = ["supported", "testing", "open", "proposed", "cleared"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const n = (st: SxStatus): number => rows.filter((r) => r.status === st).length;
  const sum = [`${rows.length} ${rows.length === 1 ? "suspect" : "suspects"}`, ...(["supported", "cleared", "open", "testing"] as const).filter((st) => n(st)).map((st) => `${n(st)} ${st}`)].join(" · ");
  const rule = `<p class="sx-rule">Score starts at 1, ×${AGREE} for each pair that goes the predicted way, ×${DISAGREE} for each that does not. Supported at ${SUPPORTED_AT}; cleared after ${CLEARED_AFTER} pairs under 1.</p>`;
  return section("board", "Suspects", `<p class="ln-sub">${esc(sum)}</p>${rule}<div class="sx-board" data-morph-list>${sorted.map((r) => suspectCard(r, ctx)).join("")}</div>`);
}

// ── 2. the approval card ─────────────────────────────────────────────────────

/** The pending experiment when it is a paired one (it names a suspect or a change); else null, and lanes.ts shows
 *  its own card. */
export function suspectPending(c: CaseFile): SuspectPending | null {
  const p = c.forks?.pending as SuspectPending | undefined;
  return p && isPendingForks(p) && (p.suspect_id || p.change) ? p : null;
}

/** The pairs it asks for, held to 1..MAX_PAIRS. */
export const askedPairs = (p: SuspectPending): number => clampPairs(p.pairs ?? p.n_per_arm ?? 3);
export const clampPairs = (n: number): number => Math.min(MAX_PAIRS, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));

/** The estimate for `n` pairs: the per-pair price when given, else the request's estimate scaled by pairs. */
export function pairsEstimate(p: SuspectPending, n: number): number | null {
  if (typeof p.cost_per_pair_usd === "number") return p.cost_per_pair_usd * n;
  if (typeof p.estimate_usd !== "number") return null;
  const asked = askedPairs(p);
  return asked > 0 ? (p.estimate_usd * n) / asked : p.estimate_usd;
}

export const SX_ACT = {
  /** data-arg "1" or "-1": one pair more or fewer on the pending experiment. */
  pairs: "sx-pairs",
  lessonApprove: "sx-lesson-approve",
  lessonReject: "sx-lesson-reject",
  /** data-arg a suspect id: ask the finished investigator to test it (`POST .../suspects/{id}/test`). */
  testSuspect: "sx-test-suspect",
} as const;

export function approvalView(vm: BatchVm): string {
  const c = vm.case;
  const p = suspectPending(c);
  if (!p) return "";
  const s = suspectsOf(c).find((x) => x.id === p.suspect_id) ?? null;
  const n = clampPairs(vm.pairs ?? askedPairs(p));
  const edited = n !== askedPairs(p);
  const est = pairsEstimate(p, n);
  const sim = isSimulatedCase(c);
  const disabled = !vm.live || vm.busy != null;
  const step = (d: -1 | 1, lbl: string): string =>
    `<button type="button" class="sx-step" data-act="${SX_ACT.pairs}" data-arg="${d}" aria-label="${attr(lbl)}"${(d < 0 ? n <= 1 : n >= MAX_PAIRS) || vm.busy != null ? " disabled" : ""}>${d < 0 ? "−" : "+"}</button>`;
  const btn = (act: string, label: string, primary: boolean): string =>
    `<button type="button" class="${primary ? "ask-btn ln-approve ds-primary" : "ask-ghostbtn ask-ghostbtn--outline"}" data-act="${act}"${disabled ? " disabled" : ""}>` +
    `${vm.busy === act ? spinner(13) : ""}${esc(label)}</button>`;
  const admin = !vm.role || vm.role === "admin";
  const actions = !admin
    ? (vm.role === "viewer" ? `<div class="ln-actions"><span class="ln-muted">${esc(ADMIN_ONLY.approve)}</span></div>` : "")
    : `<div class="ln-actions">${btn(ACT.approve, edited ? `Approve ${n} pairs` : "Approve", true)}${btn(ACT.decline, "Decline", false)}` +
      (vm.live ? "" : `<span class="ln-muted">Approval happens on live batches.</span>`) + `</div>`;
  const body =
    `<div class="ln-card sx-ask ds-pop" data-morph-key="sx-ask" role="group" aria-label="Approve the experiment">` +
    `<p class="sx-ask-t">The investigator wants to test ${s ? `<b>${esc(s.id)}</b> <span class="sx-target">${esc(s.target)}</span>` : `<b>${esc(p.suspect_id ?? "a suspect")}</b>`}${simTag(sim)}</p>` +
    (s?.rationale ? `<p class="sx-why">${esc(s.rationale)}</p>` : "") +
    `<dl class="sx-facts sx-facts--ask">` +
    `<div><dt>Change</dt><dd><code>${esc(p.change ?? "–")}</code> <span class="ln-muted">${esc(changeText(p.change))}, ${esc(anchorText(p.anchor))}${p.source_run ? ` of run ${esc(p.source_run)}` : ""}</span></dd></div>` +
    `<div><dt>Prediction</dt><dd>${esc(predictionText(p.prediction))} <span class="ln-muted">saved before any copy runs</span></dd></div>` +
    `<div><dt>Pairs</dt><dd><span class="sx-pairs">${step(-1, "One pair fewer")}<output class="sx-pairs-n" aria-live="polite">${n}</output>${step(1, "One pair more")}</span>` +
    `<span class="ln-muted">${n * 2} copies, a control and a changed one per pair${edited ? `, edited from ${askedPairs(p)}` : ""}</span></dd></div>` +
    `<div><dt>Estimate</dt><dd><b>${esc(est != null ? usd(est) : sim ? "no spend (simulated)" : "unknown, prices missing")}</b></dd></div>` +
    `</dl>` +
    (p.reason ? `<p class="ln-ask-more">${esc(p.reason)}</p>` : "") +
    actions +
    (vm.live && vm.error ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    `</div>`;
  return section("ask", "Experiment to approve", body);
}

// ── 3. the verdict by suspect ────────────────────────────────────────────────

function verdictRow(r: SuspectRow): string {
  return `<li class="sx-vrow sx-vrow--${r.status}" data-morph-key="sx-v-${attr(r.s.id)}">` +
    `<span class="sx-id">${esc(r.s.id)}</span><b class="sx-target">${esc(r.s.target)}</b>` +
    `<span class="sx-vscore">score <b>${r.score == null ? "–" : esc(scoreText(r.score))}</b> over ${r.nPairs} ${r.nPairs === 1 ? "pair" : "pairs"}</span>` +
    `${simTag(r.simulated)}</li>`;
}

export function interactionView(x: Interaction | null | undefined, names: Record<string, string> = {}): string {
  if (!x || !x.cells) return "";
  const [sa, sb] = x.suspects ?? [];
  const nameA = names[sa] ?? x.change_a, nameB = names[sb] ?? x.change_b;
  const cell = (k: "neither" | "a" | "b" | "both"): string => {
    const v = x.cells[k];
    const g = v?.mean_gap;
    return `<td class="sx-cell${g != null && g > 0.08 ? " sx-cell--hi" : ""}"><b>${g == null ? "–" : esc(pts(g))}</b><span class="ln-muted">${v?.n ?? 0} copies</span></td>`;
  };
  // A positive effect shrinks the gap, so it is written as a minus; under 0.05 pts it is no move at all.
  const eff = (v: number | null): string => (v == null ? "–" : Math.abs(v) < 0.0005 ? "0.0 pts" : `${v > 0 ? "−" : "+"}${pts(Math.abs(v))}`);
  return `<div class="sx-grid-w" data-morph-key="sx-grid">` +
    `<h3 class="ln-h3">Two factors together${(x as { simulated?: boolean }).simulated ? ` ${simTag(true)}` : ""}</h3>` +
    `<table class="sx-grid"><caption class="ln-muted">Mean gap (reported minus true) per cell, from one fork point.</caption>` +
    `<thead><tr><th></th><th scope="col">${esc(sb ?? "B")} unchanged</th><th scope="col">${esc(sb ?? "B")} changed</th></tr></thead>` +
    `<tbody><tr><th scope="row">${esc(sa ?? "A")} unchanged</th>${cell("neither")}${cell("b")}</tr>` +
    `<tr><th scope="row">${esc(sa ?? "A")} changed</th>${cell("a")}${cell("both")}</tr></tbody></table>` +
    `<p class="sx-eff"><span><code>${esc(nameA)}</code> moves the gap <b>${esc(eff(x.effect_a))}</b></span>` +
    `<span><code>${esc(nameB)}</code> moves it <b>${esc(eff(x.effect_b))}</b></span>` +
    `<span>together, beyond the sum: <b>${esc(eff(x.interaction))}</b></span></p></div>`;
}

const ANSWER_CHIP: Record<string, [ChipTone, ChipMark]> = { yes: ["ok", "check"], no: ["bad", "alert"], unknown: ["idle", "dot"] };
const Q_SHORT: Record<string, string> = {
  test_touched_training: "Test touched training?", columns_fair: "Columns fair?", test_matches_claim: "Test matches the claim?",
};
/** The good answer to each question: a "no" to the first is good, a "yes" to the others. */
const GOOD: Record<string, string> = { test_touched_training: "no", columns_fair: "yes", test_matches_claim: "yes" };

function answerCell(a: AuditAnswer | undefined): string {
  if (!a) return `<td class="sx-au-c"><span class="ln-muted">–</span></td>`;
  const good = GOOD[a.id];
  const tone: ChipTone = a.answer === "unknown" ? "idle" : !good ? ANSWER_CHIP[a.answer][0] : a.answer === good ? "ok" : "bad";
  const mark: ChipMark = a.answer === "unknown" ? "dot" : tone === "ok" ? "check" : "alert";
  return `<td class="sx-au-c" title="${attr(a.evidence.join("\n"))}">${chip(a.answer, tone, mark, "sx-au-chip")}</td>`;
}

export function auditView(vm: BatchVm): string {
  const a = vm.case.audit;
  const runs = a?.runs ? Object.values(a.runs).sort((x, y) => x.run_id.localeCompare(y.run_id, undefined, { numeric: true })) : [];
  if (!runs.length) return "";
  const ids = Object.keys(Q_SHORT);
  const open = vm.open === "all" || !!vm.open?.["sx-audit"];
  const rows = runs.map((r) => {
    const by = new Map(r.questions.map((q) => [q.id, q]));
    return `<tr data-morph-key="sx-au-${attr(r.run_id)}"><th scope="row"><span class="sx-id">${esc(r.run_id)}</span> <span class="ln-pill-dot sx-au-dot sx-au-dot--${attr(r.status)}"></span><span class="ln-muted">${esc(r.status)}</span></th>` +
      ids.map((id) => answerCell(by.get(id as AuditAnswer["id"]))).join("") + `</tr>`;
  }).join("");
  const evidence = open
    ? `<div class="sx-au-ev">${runs.map((r) => `<div class="sx-au-run"><b class="sx-id">${esc(r.run_id)}</b><ul>${r.questions.map((q) =>
      `<li><span class="sx-au-q">${esc(q.question)}</span> <b>${esc(q.answer)}</b>: ${esc(q.evidence.join("; ") || "no evidence")}</li>`).join("")}</ul></div>`).join("")}</div>`
    : "";
  return `<div class="sx-au-w" data-morph-key="sx-audit">` +
    `<h3 class="ln-h3">Audit sheet, one per run</h3>` +
    `<div class="sx-au-scroll"><table class="sx-au"><thead><tr><th scope="col">Run</th>${ids.map((id) => `<th scope="col">${esc(Q_SHORT[id])}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` +
    `<button type="button" class="ln-fold ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.fold}" data-arg="sx-audit" aria-expanded="${open}">${open ? "Hide" : "Show"} the evidence for each answer</button>` +
    evidence + `</div>`;
}

export function suspectVerdictView(vm: BatchVm): string {
  const c = vm.case;
  const rows = suspectRows(c);
  const grid = interactionView(c.interaction, Object.fromEntries(rows.map((r) => [r.s.id, r.s.target])));
  const audit = auditView(vm);
  const decided = rows.filter((r) => r.score != null);
  if (!decided.length && !grid && !audit) return "";
  const group = (st: SxLevel, title: string, none: string): string => {
    const rs = decided.filter((r) => r.level === st);
    return `<div class="sx-vgrp sx-vgrp--${st}"><h3 class="sx-vgrp-h">${statusChip(st)}<span>${esc(title)}</span></h3>` +
      (rs.length ? `<ul class="sx-vlist">${rs.map(verdictRow).join("")}</ul>` : `<p class="ln-muted sx-vnone">${esc(none)}</p>`) + `</div>`;
  };
  const groups = decided.length
    ? `<div class="sx-vgrps">${group("supported", "Supported causes", "No suspect reached a score of 20.")}${group("cleared", "Cleared", "No suspect cleared yet.")}${group("open", "Still open", "Nothing left open.")}</div>`
    : "";
  return section("verdict", "Verdict by suspect", groups + grid + audit);
}

// ── 4. the investigator panel ────────────────────────────────────────────────

export interface InvestigatorState {
  todos: AgentTodo[];
  subagent: string | null;
  seen: string[];
  /** How many times the investigator called each subagent (`task` calls), by subagent name. */
  calls: Record<string, number>;
}

/** The phases in which the investigator has finished. */
const INV_DONE = ["done", "stopped", "no_split"];
export const investigatorDone = (c: CaseFile): boolean => INV_DONE.includes(String(c.phase));

/** Agents in the log that are not subagents the investigator sent: itself, an unnamed namespace, and the rubric's
 *  grader (RubricMiddleware), which the summary counts as checks of the verdict instead. */
const NOT_SUBAGENTS = new Set(["investigator", "subagent", "rubric_grader"]);

/** Each subagent the investigator sent, with how many times: its own `task` calls in the log. */
export function subagentCalls(events: readonly AgentEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "tool_call" || e.name !== "task" || (e.agent && e.agent !== "investigator")) continue;
    const kind = String((e.args as { subagent_type?: unknown } | undefined)?.subagent_type ?? "subagent");
    out[kind] = (out[kind] ?? 0) + 1;
  }
  if (Object.keys(out).length) return out;
  // A log without its `task` calls (written before they were logged): each unbroken stretch of one subagent's
  // events is one call.
  let prev: string | undefined;
  for (const e of events) {
    const a = e.agent;
    if (a && !NOT_SUBAGENTS.has(a) && a !== prev) out[a] = (out[a] ?? 0) + 1;
    prev = a;
  }
  return out;
}

/** Its plan and who is working, from `investigator` when written, else from its log. */
export function investigatorState(c: CaseFile, events: readonly AgentEvent[] = []): InvestigatorState {
  const own = (c as SxCase).investigator;
  const seen = [...new Set(events.map((e) => e.agent).filter((a): a is string => !!a && a !== "investigator"))];
  let todos: AgentTodo[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "todos" && (!e.agent || e.agent === "investigator")) { todos = e.todos; break; }
  }
  const last = events.at(-1);
  const fromLog = last?.agent && last.agent !== "investigator" ? last.agent : null;
  const done = investigatorDone(c);
  const logged = subagentCalls(events);
  return {
    todos: own?.todos?.length ? own.todos : todos,
    subagent: done ? null : own && "subagent" in own ? own.subagent ?? null : fromLog,
    seen: own && (own as { seen?: string[] }).seen ? (own as { seen: string[] }).seen : seen,
    calls: own?.subagent_calls && Object.keys(own.subagent_calls).length ? own.subagent_calls : logged,
  };
}

const TODO_MARK: Record<AgentTodo["status"], string> = { completed: "sx-todo--done", in_progress: "sx-todo--now", pending: "sx-todo--next" };

function todoList(todos: readonly AgentTodo[], live: boolean): string {
  return `<ol class="sx-todos" data-morph-list>${todos.map((t, i) => {
    const now = live && t.status === "in_progress";
    return `<li class="sx-todo ${TODO_MARK[t.status] ?? ""}" data-morph-key="sx-todo-${i}"><span class="sx-todo-m" aria-hidden="true">${now ? spinner(12) : ""}</span>` +
      `<span class="sx-todo-t">${esc(t.content)}</span>${now ? `<span class="sx-todo-now">now</span>` : ""}</li>`;
  }).join("")}</ol>`;
}

/** The subagents that ran, each with its number of calls; "" when none ran. */
function callsList(calls: Record<string, number>): string {
  const rows = Object.entries(calls).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!rows.length) return "";
  return `<p class="sx-seen"><span class="sx-who-k">Subagents that ran</span>${rows.map(([a, n]) =>
    `<span class="sx-agent">${esc(a)} <b class="sx-agent-n">×${n}</b></span>`).join("")}</p>`;
}

/** What the investigation cost: the investigator and its experiments (every scope but the runs), else the
 *  experiments' own costs; null when neither is known. */
function investigationCost(c: CaseFile): number | null {
  const scopes = (c.costs as { scopes?: Record<string, { total_usd?: number }> } | undefined)?.scopes;
  const spent = scopes ? Object.entries(scopes).filter(([k]) => !k.startsWith("run:")).map(([, s]) => s.total_usd ?? 0) : [];
  const total = spent.reduce((a, b) => a + b, 0);
  if (total > 0) return total;
  const exps = Object.values(c.forks ?? {}).filter((f): f is ForkExperiment => !isPendingForks(f));
  const costs = exps.map((f) => f.cost_usd).filter((x): x is number => typeof x === "number");
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

/** The finished investigation in a few facts: the verdict, the suspects, the experiments, the cost. */
function doneSummary(vm: BatchVm): string {
  const c = vm.case;
  const rows = suspectRows(c);
  const v = c.verdict;
  const ev = v?.evidence;
  const level = (ev?.level ?? (v ? "open" : null)) as SxLevel | null;
  const verdict = v
    ? `<div class="sx-sum-v">${statusChip(level ?? "open")}<b class="sx-target">${esc(v.step_label)}</b>` +
      (ev?.score != null ? `<span class="sx-sum-score">score ${esc(scoreText(ev.score))}</span>` : "") +
      `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline sx-sum-go" data-act="${ACT.goto}" data-arg="verdict">Open the verdict</button></div>`
    : `<p class="ln-muted">It finished without a verdict.</p>`;
  const n = (st: SxStatus): number => rows.filter((r) => r.status === st).length;
  const tested = rows.filter((r) => r.experiments.length > 0).length;
  const untested = rows.length - tested;
  const exps = Object.values(c.forks ?? {}).filter((f) => !isPendingForks(f)).length;
  const cost = investigationCost(c);
  const sim = isSimulatedCase(c);
  const rubric = (c as { rubric?: unknown }).rubric;
  const checks = Array.isArray(rubric) ? rubric.length : 0;
  const fact = (k: string, val: string): string => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`;
  const facts = `<dl class="sx-facts sx-sum-facts">` +
    (rows.length ? fact("Suspects", esc(`${rows.length} proposed · ${tested} tested · ${n("supported")} supported · ${n("cleared")} cleared · ${untested} untested`)) : "") +
    fact("Experiments run", esc(String(exps))) +
    (checks ? fact("Verdict checked", esc(`${checks} ${checks === 1 ? "time" : "times"} by the rubric grader`)) : "") +
    fact("Cost", esc(cost != null ? usd(cost) : sim ? "no spend (simulated)" : "–")) +
    `</dl>`;
  return `<div class="sx-sum" data-morph-key="sx-sum">${verdict}${facts}</div>`;
}

export function investigatorPanelView(vm: BatchVm): string {
  const st = investigatorState(vm.case, vm.events?.investigator ?? []);
  const calls = callsList(st.calls);
  if (investigatorDone(vm.case)) {
    // Finished: what it came to, its plan if it wrote one, and the subagents that really ran. Nobody is at work.
    if (!vm.case.verdict && !st.todos.length && !calls) return "";
    const plan = st.todos.length ? `<div class="sx-inv-plan"><h3 class="ln-h3">Its plan</h3>${todoList(st.todos, false)}</div>` : "";
    const side = calls ? `<div class="sx-inv-side">${calls}</div>` : "";
    return section("inv", "What the investigator did",
      doneSummary(vm) + (plan || side ? `<div class="sx-inv${plan && side ? "" : " sx-inv--one"}">${plan}${side}</div>` : ""));
  }
  if (!st.todos.length && !st.subagent && !st.seen.length) return "";
  const done = st.todos.filter((t) => t.status === "completed").length;
  const list = st.todos.length ? todoList(st.todos, true) : `<p class="ln-muted">No plan written yet.</p>`;
  const who = st.subagent
    ? `<p class="sx-who"><span class="sx-who-k">Working now</span>${chip(st.subagent, "live", "spin", "sx-who-chip")}</p>`
    : `<p class="sx-who"><span class="sx-who-k">Working now</span><span class="ln-muted">the investigator itself</span></p>`;
  return section("inv", "Investigator's plan",
    `<p class="ln-sub">${st.todos.length ? `${done} of ${st.todos.length} done` : ""}</p><div class="sx-inv">${list}<div class="sx-inv-side">${who}${calls}</div></div>`);
}

// ── 5. lessons ───────────────────────────────────────────────────────────────

export function lessonsView(vm: BatchVm): string {
  const ls = (vm.case as SxCase).lessons;
  if (!Array.isArray(ls) || !ls.length) return "";
  const admin = !vm.role || vm.role === "admin";
  const dis = !vm.live || vm.busy != null ? " disabled" : "";
  const order = ["proposed", "approved", "rejected"];
  const sorted = [...ls].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const card = (l: Lesson): string => {
    const st = l.status === "approved" ? chip("Approved", "ok", "check", "sx-st") : l.status === "rejected" ? chip("Rejected", "idle", "cross", "sx-st") : chip("Proposed", "warn", "dot", "sx-st");
    const acts = l.status === "proposed" && admin
      ? `<div class="ln-actions"><button type="button" class="ask-btn ds-primary sx-lbtn" data-act="${SX_ACT.lessonApprove}" data-arg="${attr(l.id)}"${dis}>${vm.busy === `lesson:${l.id}` ? spinner(13) : ""}Approve</button>` +
        `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline sx-lbtn" data-act="${SX_ACT.lessonReject}" data-arg="${attr(l.id)}"${dis}>Reject</button>` +
        (vm.live ? "" : `<span class="ln-muted">Lessons are approved on live batches.</span>`) + `</div>`
      : "";
    return `<article class="ln-card sx-lesson sx-lesson--${attr(l.status)}" data-morph-key="sx-l-${attr(l.id)}">` +
      `<header class="sx-sus-h"><code class="sx-lname">${esc(l.name)}</code>${l.suspect_id ? tag(`from ${l.suspect_id}`) : ""}${simTag(!!l.simulated)}<span class="sx-sp"></span>${st}</header>` +
      `<p class="sx-rule-t">${esc(l.rule)}</p>${acts}</article>`;
  };
  const n = ls.filter((l) => l.status === "proposed").length;
  return section("lessons", "Lessons", `<p class="ln-sub">${n ? `${n} proposed for the next batch, waiting on a person` : "Nothing waiting"}</p><div class="sx-lessons" data-morph-list>${sorted.map(card).join("")}</div>`);
}
