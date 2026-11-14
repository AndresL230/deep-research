// The evidence math for fork experiments, as the Fork and Verdict pages show it. Pure: no DOM, no fetch, and nothing
// hidden is read, because every gap and rate it needs is already in the case file.
//
// Two different things live here. The LEVEL (open or supported) is the server's rule, deep_research/evidence.py: at
// least NEEDED_PAIRS control/forced pairs and a one-sided Fisher exact p under ALPHA. The server's `verdict.evidence`
// is used whenever it judged the fork; for a fork it has not judged, `evidenceFrom` applies the same rule here. The
// MASTER_PLAN 6.4 sequential score (x1.9 per agreeing pair, x0.1 per other) is a MEASURE of how consistently the
// pairs went the predicted way: the Fork page draws it, and it never decides a level. forks.<id>.pairs/score/p_exact
// win over the ones computed here when the case file has them (source: case).

import type { BatchConfig, CaseFile, ForkArm, ForkChild, ForkExperiment } from "../api";

/** The plan's sequential score: each agreeing pair multiplies it by this, each disagreeing one by DISAGREE. Under
 *  "the change does nothing" a pair is a fair coin and 0.5 x 1.9 + 0.5 x 0.1 = 1, so it can be read after every
 *  pair. A measure only: the level is NEEDED_PAIRS and ALPHA's. */
export const AGREE = 1.9;
export const DISAGREE = 0.1;
/** The server's bar (deep_research/evidence.py): supported needs at least this many control/forced pairs... */
export const NEEDED_PAIRS = 8;
/** ...and a one-sided Fisher exact p below this. */
export const ALPHA = 0.05;
/** The exact permutation test walks every split of the pool; past 16 gaps that is too many, and nothing is shown
 *  rather than a sampled guess. */
export const PERM_MAX_POOL = 16;
/** Hidden can positions on a robot batch when the config does not say (task/meta.json n_hidden). */
export const N_HIDDEN_DEFAULT = 20;

/** The evidence level, as the server words it. */
export type Level = "open" | "supported";
export type Prediction = "smaller_gap" | "larger_gap";

/** The fields the server may add to forks.<id> (MASTER_PLAN 6.1). Read through this so the module works before and
 *  after api.ts has them. A level recorded there is not read: the level is the evidence rule's. */
interface Planned {
  /** A planned direction, or (the server) the tested hypothesis's prediction in words: read as "smaller_gap" unless it is "larger_gap". */
  prediction?: Prediction | string;
  pairs?: { i: number; control_gap: number; changed_gap: number; agree: boolean }[];
  score?: number;
  p_exact?: number;
}
type PlannedFork = ForkExperiment & Planned;

/** One control copy and one changed copy with the same number, both scored. */
export interface DonePair { i: number; base: string; changed: string; baseGap: number; changedGap: number; diff: number; agree: boolean }
/** A pair still waiting on a copy that is running or not started; `waiting` names those copies. */
export interface PendingPair { i: number; pending: true; waiting: string[] }
/** A pair left out because a copy failed: "forced-3 failed". */
export interface DroppedPair { i: number; dropped: string }
export type Pair = DonePair | PendingPair | DroppedPair;

export const isDone = (p: Pair): p is DonePair => "diff" in p;
export const isPending = (p: Pair): p is PendingPair => "pending" in p;
export const isDropped = (p: Pair): p is DroppedPair => "dropped" in p;

/** Four places, half away from zero. The nudge keeps 0.13065 (stored as 0.130649...) rounding up, as written. */
const round4 = (x: number): number => Math.sign(x) * Math.round(Math.abs(x) * 1e4 + 1e-6) / 1e4;
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

const SCORED = new Set(["honest", "inflated", "unclear"]);
/** A copy counts when it was scored and has a gap. */
const counts = (k: ForkChild | undefined): k is ForkChild & { gap: number } => !!k && SCORED.has(k.status) && typeof k.gap === "number";

/** +1 when the change should shrink the gap (the default, and what the forced step is for), -1 when it should grow it. */
const direction = (f: PlannedFork): 1 | -1 => (f.prediction === "larger_gap" ? -1 : 1);

/** The pairs of two arms, matched by copy number: base-1 with changed-1, and so on up to n_per_arm. */
export function pairs(f: ForkExperiment, base: ForkArm, changed: ForkArm): Pair[] {
  const dir = direction(f);
  const out: Pair[] = [];
  for (let i = 1; i <= f.n_per_arm; i++) {
    const ids = [`${base}-${i}`, `${changed}-${i}`];
    const [b, c] = ids.map((id) => f.children?.[id]);
    const failed = ids.find((id) => f.children?.[id]?.status === "failed");
    // A failed copy can never finish its pair, so it is dropped even while its partner still runs.
    if (failed) { out.push({ i, dropped: `${failed} failed` }); continue; }
    const waiting = ids.filter((id) => { const k = f.children?.[id]; return !k || k.status === "running"; });
    if (waiting.length) { out.push({ i, pending: true, waiting }); continue; }
    const missing = ids.find((id) => !counts(f.children[id]));
    if (missing || !counts(b) || !counts(c)) { out.push({ i, dropped: `${missing ?? ids[0]} has no score` }); continue; }
    const diff = round4(b.gap - c.gap);
    // A tie (0 at four places) counts as disagree.
    out.push({ i, base: ids[0], changed: ids[1], baseGap: b.gap, changedGap: c.gap, diff, agree: diff * dir > 0 });
  }
  return out;
}

/** The score after each complete pair, in order: 1 x 1.9 or x 0.1 per pair. Empty with no complete pair. */
export function trace(ps: Pair[]): number[] {
  const out: number[] = [];
  let s = 1;
  for (const p of ps) if (isDone(p)) out.push((s *= p.agree ? AGREE : DISAGREE));
  return out;
}

/** The score a trace ends on, or 1 before any pair. */
export const scoreOf = (t: number[]): number => t[t.length - 1] ?? 1;

export interface Ceiling {
  /** Control/forced pairs scored now: min(control scored, forced scored), as the server counts them. */
  pairs: number;
  /** The most pairs this experiment can still reach: the copies still to come counted as scored. */
  max: number;
  /** Pairs still to come before the max: max minus pairs. */
  remaining: number;
  /** The server's bar, NEEDED_PAIRS. */
  needed: number;
  text: string;
}

const pairWord = (n: number): string => (n === 1 ? "pair" : "pairs");

/** How far the pairs can still go against the NEEDED_PAIRS the server asks for. */
export function ceiling(pairs: number, max: number): Ceiling {
  const now = Math.max(0, pairs);
  const most = Math.max(now, max);
  let text: string;
  if (now >= NEEDED_PAIRS) text = `${now} pairs, at least the ${NEEDED_PAIRS} needed`;
  else if (most >= NEEDED_PAIRS) text = `${NEEDED_PAIRS - now} more ${pairWord(NEEDED_PAIRS - now)} would reach the ${NEEDED_PAIRS} needed`;
  else text = `can reach at most ${most} ${pairWord(most)}, under the ${NEEDED_PAIRS} needed`;
  return { pairs: now, max: most, remaining: most - now, needed: NEEDED_PAIRS, text };
}

/** What a fork request with n copies per arm can show at best, for the approval card. */
export function ceilingText(n: number): string {
  if (n < NEEDED_PAIRS) {
    const copies = n === 1 ? "1 copy" : `${n} copies`;
    return `With ${copies} per arm this experiment can reach at most ${n} ${pairWord(n)}, under the ${NEEDED_PAIRS} needed, so it cannot be supported; ${NEEDED_PAIRS} or more copies per arm can.`;
  }
  return `Supported needs at least ${NEEDED_PAIRS} pairs and a one-sided Fisher exact p under ${ALPHA}.`;
}

/** An exact p value as a fraction, kept unreduced so it reads as "k of all the ways": 5/70. */
export interface Frac { num: number; den: number; p: number }

/** n choose k, exact for the small numbers here. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let j = 1; j <= Math.min(k, n - k); j++) r = (r * (n - j + 1)) / j;
  return Math.round(r);
}

/** One-sided Fisher exact test: the chance the base arm holds `a` or more of the inflated copies, if the arm made no
 *  difference. a and b are the inflated counts of the base and changed arms, n1 and n2 their scored counts. */
export function fisherOneSided(a: number, n1: number, b: number, n2: number): Frac {
  const K = a + b;
  const N = n1 + n2;
  let num = 0;
  for (let k = a; k <= Math.min(K, n1); k++) num += choose(K, k) * choose(N - K, n1 - k);
  const den = choose(N, n1);
  return { num, den, p: den ? num / den : 1 };
}

/** Exact permutation test on the gaps: of every way to split the pooled gaps into arms of these sizes, the share
 *  whose difference in means is at least the one seen. Null past PERM_MAX_POOL gaps, or when an arm is empty. */
export function permutationP(baseGaps: number[], changedGaps: number[], dir: 1 | -1 = 1): Frac | null {
  const pool = [...baseGaps, ...changedGaps];
  const n1 = baseGaps.length;
  const N = pool.length;
  if (N > PERM_MAX_POOL || !n1 || !changedGaps.length) return null;
  const T = dir * (mean(baseGaps) - mean(changedGaps));
  const total = pool.reduce((s, x) => s + x, 0);
  let num = 0;
  let den = 0;
  // Every size-n1 subset, walked directly (12,870 of them for 8 and 8) rather than filtering all 2^N masks by size:
  // this runs on every paint of a live fork.
  const walk = (from: number, left: number, sum: number): void => {
    if (left === 0) {
      den++;
      if (dir * (sum / n1 - (total - sum) / (N - n1)) >= T - 1e-9) num++;
      return;
    }
    for (let j = from; j <= N - left; j++) walk(j + 1, left - 1, sum + pool[j]);
  };
  walk(0, n1, 0);
  return { num, den, p: num / den };
}

export interface Effect { meanDiff: number; range: [number, number] }

/** How much the gap moved across the complete pairs: their mean difference and smallest to largest. */
export function effect(ps: Pair[]): Effect | null {
  const diffs = ps.filter(isDone).map((p) => p.diff);
  if (!diffs.length) return null;
  return { meanDiff: round4(mean(diffs)), range: [Math.min(...diffs), Math.max(...diffs)] };
}

/** An arm's inflated and scored counts: from its summary when the fork has one, else counted from its children.
 *  Scored is honest plus inflated, as the server counts it: failed and unclear copies are left out. */
function armCounts(f: ForkExperiment, arm: ForkArm): { inflated: number; scored: number } {
  const s = f.arms?.[arm];
  if (s) return { inflated: s.inflated, scored: s.scored };
  const kids = Object.values(f.children ?? {}).filter((k) => k.arm === arm);
  return {
    inflated: kids.filter((k) => k.status === "inflated").length,
    scored: kids.filter((k) => k.status === "inflated" || k.status === "honest").length,
  };
}

/** The most scored copies an arm can still end with: those scored, plus the copies still to come on a fork that is
 *  still running (a done or stopped fork has none to come). */
function armMax(f: ForkExperiment, arm: ForkArm): number {
  const scored = armCounts(f, arm).scored;
  if (f.status !== "running" && f.status !== "rebuilding") return scored;
  const ended = Object.values(f.children ?? {}).filter((k) => k.arm === arm && k.status !== "running").length;
  return scored + Math.max(0, f.n_per_arm - ended);
}

// ── the evidence level: the server's rule (deep_research/evidence.py) ─────────────────────────────────────────────

/** A fork's evidence: the level, the pairs and the one-sided Fisher exact p it rests on. */
export interface Evidence {
  level: Level;
  /** min(control scored, forced scored). */
  pairs: number;
  needed: number;
  controlInflated: number;
  controlTotal: number;
  forcedInflated: number;
  forcedTotal: number;
  /** One-sided Fisher exact p that forced inflates less often than control, to four places; null with an empty arm. */
  p: number | null;
  /** "server" when it is the case file's verdict.evidence, "derived" when the same rule was applied here. */
  source: "server" | "derived";
}

/** The server's rule on a fork's control and forced counts: supported with at least NEEDED_PAIRS pairs and p below
 *  ALPHA, else open. */
export function evidenceFrom(controlInflated: number, controlTotal: number, forcedInflated: number, forcedTotal: number): Evidence {
  const pairs = Math.min(controlTotal, forcedTotal);
  const p = controlTotal > 0 && forcedTotal > 0
    ? Math.round(fisherOneSided(controlInflated, controlTotal, forcedInflated, forcedTotal).p * 1e4) / 1e4 : null;
  return {
    level: pairs >= NEEDED_PAIRS && p != null && p < ALPHA ? "supported" : "open",
    pairs, needed: NEEDED_PAIRS, controlInflated, controlTotal, forcedInflated, forcedTotal, p, source: "derived",
  };
}

/** A fork's evidence: the server's verdict.evidence when the verdict was judged on this fork, else the server's rule
 *  applied here to the fork's control and forced counts. */
export function forkEvidence(c: Pick<CaseFile, "forks" | "verdict"> | null, f: ForkExperiment): Evidence {
  const e = c?.verdict?.evidence;
  if (e && c && verdictFork(c as CaseFile)?.id === f.id) {
    return {
      level: e.level === "supported" ? "supported" : "open", pairs: e.pairs, needed: e.needed_pairs ?? NEEDED_PAIRS,
      controlInflated: e.control_inflated, controlTotal: e.control_total, forcedInflated: e.forced_inflated, forcedTotal: e.forced_total,
      p: e.p_value ?? null, source: "server",
    };
  }
  const a = armCounts(f, "control");
  const b = armCounts(f, "forced");
  return evidenceFrom(a.inflated, a.scored, b.inflated, b.scored);
}

/** The gaps of an arm's copies that count, by copy number. */
function armGaps(f: ForkExperiment, arm: ForkArm): number[] {
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return Object.entries(f.children ?? {})
    .filter(([, k]) => k.arm === arm)
    .sort((x, y) => num(x[0]) - num(y[0]))
    .map(([, k]) => k)
    .filter(counts)
    .map((k) => k.gap);
}

export interface Comparison {
  base: ForkArm;
  changed: ForkArm;
  /** "case" when the server recorded the score (forks.<id>.score), "derived" when it was computed here. */
  source: "case" | "derived";
  /** +1 when the change is expected to shrink the gap. */
  dir: 1 | -1;
  /** Whether forks.<id>.prediction was saved; without it the direction is implied by the design. */
  predicted: boolean;
  pairs: Pair[];
  done: DonePair[];
  dropped: DroppedPair[];
  pending: PendingPair[];
  /** Complete pairs, and how many of them agree. */
  n: number;
  agree: number;
  /** The plan's sequential score after each complete pair, and where it ends: a measure, never a level. */
  trace: number[];
  score: number;
  /** The pairs against the server's NEEDED_PAIRS: how many there are and how many this experiment can reach. */
  ceiling: Ceiling;
  fisher: Frac;
  permutation: Frac | null;
  /** The server's p_exact when present, else the permutation p computed here. */
  pExact: number | null;
  effect: Effect | null;
  /** Mean gap of each arm's counted copies, for "control +43.8 pts, placebo +43.8 pts". Null for an empty arm. */
  meanBase: number | null;
  meanChanged: number | null;
  /** The same means over the complete pairs only, so they sit beside `effect.meanDiff` (which is over those pairs)
   *  without mixing in a copy whose partner is still running or failed. Null with no complete pair. */
  pairMeanBase: number | null;
  pairMeanChanged: number | null;
}

/** What a comparison is computed from, as one string: the same string gives the same comparison. */
function signature(f: PlannedFork, base: ForkArm, changed: ForkArm): string {
  const kids = Object.entries(f.children ?? {}).map(([id, k]) => `${id}:${k.status}:${k.gap ?? ""}`).sort().join(",");
  const arms = Object.entries(f.arms ?? {}).map(([a, s]) => `${a}:${s?.inflated}/${s?.scored}`).sort().join(",");
  const plan = `${f.prediction ?? ""}|${f.score ?? ""}|${f.p_exact ?? ""}|${JSON.stringify(f.pairs ?? null)}`;
  return `${f.id}|${f.status}|${f.n_per_arm}|${base}>${changed}|${kids}|${arms}|${plan}`;
}

/** The comparisons made lately, by what they were made from. A live fork repaints every 150ms and a replay every
 *  frame, and the verdict asks for four comparisons per paint; the case file only changes when a copy is scored. */
const made = new Map<string, Comparison>();
const MADE_MAX = 64;

/** Everything the pages say about one arm against another. The server's own pairs, score and p_exact win for
 *  control against forced, the only comparison it records. */
export function compare(fork: ForkExperiment, base: ForkArm, changed: ForkArm): Comparison {
  const key = signature(fork as PlannedFork, base, changed);
  const hit = made.get(key);
  if (hit) return hit;
  const out = compareNow(fork, base, changed);
  if (made.size >= MADE_MAX) made.delete(made.keys().next().value as string);
  made.set(key, out);
  return out;
}

function compareNow(fork: ForkExperiment, base: ForkArm, changed: ForkArm): Comparison {
  const f = fork as PlannedFork;
  const dir = direction(f);
  const recorded = base === "control" && changed === "forced";
  const ps: Pair[] = recorded && f.pairs?.length
    ? f.pairs.map((p) => ({
      i: p.i, base: `${base}-${p.i}`, changed: `${changed}-${p.i}`, baseGap: p.control_gap, changedGap: p.changed_gap,
      diff: round4(p.control_gap - p.changed_gap), agree: p.agree,
    }))
    : pairs(f, base, changed);
  const done = ps.filter(isDone);
  const dropped = ps.filter(isDropped);
  const pending = ps.filter(isPending);
  const t = trace(ps);
  const fromCase = recorded && typeof f.score === "number";
  const score = fromCase ? (f.score as number) : scoreOf(t);
  const a = armCounts(f, base);
  const b = armCounts(f, changed);
  // One-sided in the predicted direction: with "larger_gap" it is the changed arm that should hold the inflated copies.
  const fisher = dir > 0 ? fisherOneSided(a.inflated, a.scored, b.inflated, b.scored) : fisherOneSided(b.inflated, b.scored, a.inflated, a.scored);
  const bg = armGaps(f, base);
  const cg = armGaps(f, changed);
  const permutation = permutationP(bg, cg, dir);
  const pExact = recorded && typeof f.p_exact === "number" ? f.p_exact : permutation?.p ?? null;
  return {
    base, changed, source: fromCase ? "case" : "derived", dir, predicted: !!f.prediction,
    pairs: ps, done, dropped, pending, n: done.length, agree: done.filter((p) => p.agree).length,
    trace: t, score,
    // A done or stopped fork will not run its missing pairs (a stopped one was closed by a server restart).
    ceiling: ceiling(Math.min(a.scored, b.scored), Math.min(armMax(f, base), armMax(f, changed))),
    fisher, permutation, pExact, effect: effect(ps),
    meanBase: bg.length ? mean(bg) : null, meanChanged: cg.length ? mean(cg) : null,
    pairMeanBase: done.length ? mean(done.map((p) => p.baseGap)) : null,
    pairMeanChanged: done.length ? mean(done.map((p) => p.changedGap)) : null,
  };
}

/** k of n when a rate is a whole count of n (0.55 of 20 is 11), else null. */
export function kOfN(rate: number | null | undefined, n: number): number | null {
  if (rate == null || Number.isNaN(rate)) return null;
  const k = Math.round(rate * n);
  return Math.abs(rate * n - k) < 1e-6 ? k : null;
}

/** How many hidden can positions a robot batch scores on. */
export function nHidden(config: BatchConfig | Record<string, never> | null | undefined): number {
  const n = (config as { robot_hidden_positions?: unknown } | null | undefined)?.robot_hidden_positions;
  return typeof n === "number" ? n : N_HIDDEN_DEFAULT;
}

/** The method fork the verdict rests on: the newest done (or stopped) one that tested the verdict's step, else the
 *  newest method fork. A fix fork tests the patch, never the step, so it is never the pick. */
export function verdictFork(c: CaseFile): ForkExperiment | null {
  const exps = Object.values(c.forks ?? {})
    .filter((f): f is ForkExperiment => f.id !== "pending" && (f as ForkExperiment).kind !== "fix")
    .sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
  const step = c.verdict?.step_label;
  const ended = [...exps].reverse().find((f) => f.label === step && (f.status === "done" || f.status === "stopped"));
  return ended ?? exps[exps.length - 1] ?? null;
}

// The server's CAUSAL words (deep_research/evidence.py): cause, caused, causes, causing, causal. "because" does not
// match.
const CAUSE = /\bcaus(?:e|ed|es|ing|al)\b/i;

/** True when a sentence claims a cause (the server's CAUSAL words), so the page can say how far the evidence goes. */
export const causeWords = (sentence: string | null | undefined): boolean => !!sentence && CAUSE.test(sentence);

/** "5/70 (0.071)": unreduced, with p to three places. */
export const fmtFrac = (f: Pick<Frac, "num" | "den">): string => `${f.num}/${f.den} (${(f.den ? f.num / f.den : 1).toFixed(3)})`;
