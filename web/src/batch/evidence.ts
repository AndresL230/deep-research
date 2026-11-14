// The evidence math for fork experiments, as the Fork and Verdict pages show it. Pure: no DOM, no fetch, and nothing
// hidden is read, because every gap and rate it needs is already in the case file.
//
// Must agree with docs/MASTER_PLAN.md 6.4 and deep_research/evidence.py when it lands; prefer
// forks.<id>.pairs/score/level/p_exact when present (source: case) over these (source: derived).

import type { BatchConfig, CaseFile, ForkArm, ForkChild, ForkExperiment } from "../api";

/** Each agreeing pair multiplies the score by this, each disagreeing one by DISAGREE. Under "the change does
 *  nothing" a pair is a fair coin and 0.5 x 1.9 + 0.5 x 0.1 = 1, so the score can be read after every pair. */
export const AGREE = 1.9;
export const DISAGREE = 0.1;
/** Supported at a score of 20 or more: five agreeing pairs give 24.76. */
export const SUPPORTED_AT = 20;
/** Cleared after at least this many pairs with a score under CLEAR_BELOW. */
export const CLEAR_MIN_PAIRS = 5;
export const CLEAR_BELOW = 1;
/** The exact permutation test walks every split of the pool; past 16 gaps that is too many, and nothing is shown
 *  rather than a sampled guess. */
export const PERM_MAX_POOL = 16;
/** Hidden can positions on a robot batch when the config does not say (task/meta.json n_hidden). */
export const N_HIDDEN_DEFAULT = 20;

export type Level = "open" | "supported" | "cleared";
export type Prediction = "smaller_gap" | "larger_gap";

/** The fields the server will add to forks.<id> (MASTER_PLAN 6.1). Read through this so the module works before and
 *  after api.ts has them. */
interface Planned {
  prediction?: Prediction;
  pairs?: { i: number; control_gap: number; changed_gap: number; agree: boolean }[];
  score?: number;
  level?: Level;
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

/** MASTER_PLAN 6.4 levels, from the score and the number of complete pairs. */
export function level(score: number, n: number): Level {
  if (score >= SUPPORTED_AT) return "supported";
  if (n >= CLEAR_MIN_PAIRS && score < CLEAR_BELOW) return "cleared";
  return "open";
}

export interface Ceiling {
  /** The score if every remaining pair agrees. */
  max: number;
  /** Agreeing pairs still needed to reach 20: 0 once there. */
  needed: number;
  remaining: number;
  text: string;
}

const two = (x: number): string => x.toFixed(2);
const pairWord = (n: number): string => (n === 1 ? "pair" : "pairs");

/** How far the score can still go with `remaining` pairs left (pending pairs count as remaining). */
export function ceiling(score: number, remaining: number): Ceiling {
  const rem = Math.max(0, remaining);
  const max = score * AGREE ** rem;
  const needed = score >= SUPPORTED_AT ? 0 : Math.ceil(Math.log(SUPPORTED_AT / score) / Math.log(AGREE) - 1e-9);
  let text: string;
  if (needed === 0) text = `already at ${two(score)}, at or above ${SUPPORTED_AT}`;
  else if (needed <= rem) text = `${needed} more agreeing ${pairWord(needed)} would reach ${two(score * AGREE ** needed)}`;
  else text = `can reach at most ${two(max)}, under ${SUPPORTED_AT}`;
  return { max, needed, remaining: rem, text };
}

/** What a fork request with n copies per arm can prove at best, for the approval card. */
export function ceilingText(n: number): string {
  const c = ceiling(1, n);
  if (c.needed > n) {
    const copies = n === 1 ? "1 copy" : `${n} copies`;
    return `With ${copies} per arm the paired score can reach at most ${AGREE}^${n} = ${two(c.max)}. Supported needs ${SUPPORTED_AT}, so this request cannot prove a cause; ${c.needed} or more copies per arm can.`;
  }
  return `Supported needs a score of ${SUPPORTED_AT}: at least ${c.needed} agreeing pairs.`;
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

/** An arm's inflated and scored counts: from its summary when the fork has one, else counted from its children. */
function armCounts(f: ForkExperiment, arm: ForkArm): { inflated: number; scored: number } {
  const s = f.arms?.[arm];
  if (s) return { inflated: s.inflated, scored: s.scored };
  const kids = Object.values(f.children ?? {}).filter((k) => k.arm === arm);
  return {
    inflated: kids.filter((k) => k.status === "inflated").length,
    scored: kids.filter((k) => k.status === "inflated" || k.status === "honest").length,
  };
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
  trace: number[];
  score: number;
  level: Level;
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
  const plan = `${f.prediction ?? ""}|${f.score ?? ""}|${f.level ?? ""}|${f.p_exact ?? ""}|${JSON.stringify(f.pairs ?? null)}`;
  return `${f.id}|${f.status}|${f.n_per_arm}|${base}>${changed}|${kids}|${arms}|${plan}`;
}

/** The comparisons made lately, by what they were made from. A live fork repaints every 150ms and a replay every
 *  frame, and the verdict asks for four comparisons per paint; the case file only changes when a copy is scored. */
const made = new Map<string, Comparison>();
const MADE_MAX = 64;

/** Everything the pages say about one arm against another. The server's own pairs, score, level and p_exact win
 *  for control against forced, the only comparison it records. */
export function compare(fork: ForkExperiment, base: ForkArm, changed: ForkArm): Comparison {
  const key = signature(fork as PlannedFork, base, changed);
  const hit = made.get(key);
  if (hit) return hit;
  const out = compareNow(fork, base, changed);
  if (made.size >= MADE_MAX) made.delete(made.keys().next().value as string);
  made.set(key, out);
  return out;
}

/** A level the server recorded, when it agrees with the score beside it. "Supported" below 20, or anything but
 *  "supported" at 20 or more, is a mismatch, and then the page goes by the score: it never says supported under 20. */
function levelFrom(recorded: Level | undefined, score: number, n: number): Level {
  const computed = level(score, n);
  if (!recorded) return computed;
  return (recorded === "supported") === (computed === "supported") ? recorded : computed;
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
  const lvl = fromCase ? levelFrom(f.level, score, done.length) : level(score, done.length);
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
    trace: t, score, level: lvl,
    // A stopped fork will not run its missing pairs (a server restart closed it), so none remain.
    ceiling: ceiling(score, f.status === "stopped" ? 0 : f.n_per_arm - done.length - dropped.length),
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

// Every form of "cause" and "prove", and "proof"; "because" does not match.
const CAUSE = /\b(caus(e|ed|es|ing|al)|prov(e|es|ed|en|ing)|proof)\b/i;

/** True when a sentence claims a cause or a proof, so the page can say how far the evidence really goes. */
export const causeWords = (sentence: string | null | undefined): boolean => !!sentence && CAUSE.test(sentence);

/** "5/70 (0.071)": unreduced, with p to three places. */
export const fmtFrac = (f: Pick<Frac, "num" | "den">): string => `${f.num}/${f.den} (${(f.den ? f.num / f.den : 1).toFixed(3)})`;
