// OWNER: subagent E. Replaying a saved batch on a timeline, and the replay controls.
//
// The timeline rebuilds what a live batch's case file looked like `t` seconds in, from the FINAL case file and the
// event logs (deep_research/batch.py is the order of things). Seconds are batch seconds: agent logs play at their own
// pace, and the steps the logs do not time (analysis, the investigator's thinking, the approval wait, VM rebuilds)
// get fixed beats (`BEATS`). Segments, in order:
//
//   1. runs        0 .. runsEnd        every run starts at 0; queued, starting, running (todos, step, last_tool follow
//                                      its log), then its final record (score revealed) at duration_s or last event.
//   2. analyzing   runsEnd + ANALYZE
//   3. ready       + READY             `split` appears (phase `no_split` when there is none).
//   4. investigating + INVESTIGATE     or the investigator log's first part, if longer. Step labels and hypotheses
//                                      appear when the investigator recorded them, or spread over the beat.
//   5. per fork:   awaiting_approval   + APPROVAL with a synthesized `forks.pending`,
//                  forking             + REBUILD status `rebuilding`, then `running`; children start CHILD_BOOT later
//                                      (staggered) and play their logs; `arms` and status `done` once all are done.
//   6. forked      + FORKED            or the investigator's post-fork events, if longer.
//   7. done        at `duration`       the verdict. From here on `caseAt` is the final case file itself.
//
// Approximations (the saved batch does not keep them): when a run turned `starting`, intermediate `costs` (scaled
// linearly by each scope's progress), the pending fork's `estimate_usd` (null), and when step labels and hypotheses
// were recorded if the investigator log is missing. At `t >= duration` everything equals the final case exactly.
//
// Fork child logs: a child's log may begin with the source run's history copied in (fixtures do this: the times
// drop back down where the child's own events start). That copied prefix shows at once when the child starts.
//
// Motion files (robot runs): the server pulls them from the VM while a run is going and logs a `motion` event for
// each, so mid-run `motion_files` are the ones whose event has happened, newest last (`motionAt`). Batches saved
// before those events existed have none: their motion files appear when the run ends, with its final record.

import "./replay.css";
import type {
  AgentEvent, AgentTodo, CaseFile, Costs, ForkChild, ForkExperiment, Hypothesis, PendingForks, Phase, RunRecord,
  ScopeCost, StepLabel,
} from "../api";
import { isPendingForks } from "../api";
import { esc, attr } from "../ui";
import { duration as fmtDuration } from "./format";
import { ACT, childKey, type EventKey, type ReplayState } from "./model";

/** Fixed beats in timeline seconds for what the logs do not time. Tuned so the demo batch runs about 4 minutes. */
export const BEATS = {
  analyze: 6,
  ready: 20,
  investigate: 28,
  approval: 20,
  rebuild: 16,
  childBoot: 4,
  childStagger: 0.4,
  forked: 22,
  /** A run with no events (failed before its agent started) ends this long in. */
  noEvents: 3,
} as const;

/** Score fields hidden until a run or child is scored. */
const SCORE_FIELDS = ["reported_accuracy", "true_accuracy", "overlap_share", "gap", "reason", "n_actions", "labels"] as const;

// ── the schedule ─────────────────────────────────────────────────────────────

export interface RunSlot { first: number; end: number }
export interface ChildSlot { start: number; end: number }
export interface ForkSlot {
  id: string;
  approvalStart: number;
  /** = when forking starts: status `rebuilding`. */
  rebuildAt: number;
  /** Status `running`. */
  runningAt: number;
  children: Record<string, ChildSlot>;
  /** Status `done`, `arms` set. */
  doneAt: number;
}

export interface ReplaySchedule {
  runs: Record<string, RunSlot>;
  runsEnd: number;
  /** `split` appears, phase `ready` (or `no_split`). */
  readyAt: number;
  investigateStart: number | null;
  investigateEnd: number | null;
  stepLabelsAt: Record<string, number>;
  hypothesesAt: number[];
  forks: ForkSlot[];
  /** A pending request saved in the final case (the batch stopped while awaiting approval). */
  finalPendingAt: number | null;
  forkedStart: number | null;
  /** The verdict and the final phase; the end of the timeline. */
  duration: number;
  /** Timeline time of every event, per log, non-decreasing. */
  times: Record<EventKey, number[]>;
}

interface Cached {
  events: Record<EventKey, AgentEvent[]>;
  schedule: ReplaySchedule;
  slices: Map<EventKey, { n: number; arr: AgentEvent[] }>;
}
const cache = new WeakMap<CaseFile, Cached>();

function cached(full: CaseFile, events: Record<EventKey, AgentEvent[]>): Cached {
  const hit = cache.get(full);
  if (hit && hit.events === events) return hit;
  const c: Cached = { events, schedule: build(full, events), slices: new Map() };
  cache.set(full, c);
  return c;
}

/** The segment boundaries and per-event times (computed once per (full, events) pair). */
export function replaySchedule(full: CaseFile, events: Record<EventKey, AgentEvent[]>): ReplaySchedule {
  return cached(full, events).schedule;
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Own times of an agent log, non-decreasing; a copied prefix (before the last drop in `t`) is at 0. */
export function agentTimes(evs: AgentEvent[]): number[] {
  let reset = 0;
  for (let i = 1; i < evs.length; i++) if (num(evs[i].t) < num(evs[i - 1].t)) reset = i;
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < evs.length; i++) {
    const t = i < reset ? 0 : Math.max(prev, num(evs[i].t));
    out.push(t);
    prev = t;
  }
  return out;
}

/** The investigator's log split where `t` drops back (each resume opens a new log with its own clock). */
function segments(evs: AgentEvent[]): number[][] {
  const segs: number[][] = [];
  for (let i = 0; i < evs.length; i++) {
    if (i === 0 || num(evs[i].t) < num(evs[i - 1].t)) segs.push([]);
    segs[segs.length - 1].push(i);
  }
  return segs;
}

const realForks = (full: CaseFile): ForkExperiment[] =>
  Object.values(full.forks).filter((f): f is ForkExperiment => !isPendingForks(f));

function build(full: CaseFile, events: Record<EventKey, AgentEvent[]>): ReplaySchedule {
  const times: Record<EventKey, number[]> = {};

  // 1. runs
  const runs: Record<string, RunSlot> = {};
  let runsEnd = 0;
  for (const [id, r] of Object.entries(full.runs)) {
    const evs = events[id] ?? [];
    const own = agentTimes(evs);
    times[id] = own;
    const last = own.length ? own[own.length - 1] : 0;
    const end = own.length ? Math.max(last, num(r.duration_s)) : num(r.duration_s) || BEATS.noEvents;
    runs[id] = { first: own.length ? own[0] : end, end };
    runsEnd = Math.max(runsEnd, end);
  }

  const forks = realForks(full);
  const pending = Object.values(full.forks).find(isPendingForks) ?? null;
  const inv = events.investigator ?? [];
  const early = full.phase === "config" || full.phase === "running";

  // 2-3. analyzing, ready
  const readyAt = early ? runsEnd : runsEnd + BEATS.analyze;
  const hasInvestigation = !early && (
    inv.length > 0 || full.hypotheses.length > 0 || Object.keys(full.step_labels).length > 0
    || forks.length > 0 || pending !== null || full.verdict !== null || full.phase === "investigating" || full.phase === "done"
  );
  const base: Omit<ReplaySchedule, "duration"> = {
    runs, runsEnd, readyAt, investigateStart: null, investigateEnd: null, stepLabelsAt: {}, hypothesesAt: [],
    forks: [], finalPendingAt: null, forkedStart: null, times,
  };
  if (!hasInvestigation) {
    if (inv.length) times.investigator = inv.map(() => readyAt);
    return { ...base, duration: early ? runsEnd : readyAt };
  }

  // 4. investigating: the investigator log's first part, then the rest after forking.
  const invStart = readyAt + BEATS.ready;
  const segs = segments(inv);
  const first = segs[0] ?? [];
  const firstSpan = first.length ? num(inv[first[first.length - 1]].t) + 2 : 0;
  const invEnd = invStart + Math.max(BEATS.investigate, firstSpan);
  let cursor = invEnd;

  // 5. forks
  const forkSlots: ForkSlot[] = [];
  for (const f of forks) {
    const approvalStart = cursor;
    const rebuildAt = approvalStart + BEATS.approval;
    const runningAt = rebuildAt + BEATS.rebuild;
    const children: Record<string, ChildSlot> = {};
    let doneAt = runningAt + BEATS.childBoot;
    Object.keys(f.children).forEach((cid, i) => {
      const key = childKey(f.id, cid);
      const own = agentTimes(events[key] ?? []);
      const start = runningAt + BEATS.childBoot + i * BEATS.childStagger;
      times[key] = own.map((x) => start + x);
      const span = own.length ? own[own.length - 1] : BEATS.noEvents;
      children[cid] = { start, end: start + span };
      doneAt = Math.max(doneAt, start + span);
    });
    forkSlots.push({ id: f.id, approvalStart, rebuildAt, runningAt, children, doneAt });
    cursor = doneAt;
  }
  let finalPendingAt: number | null = null;
  if (pending) {
    finalPendingAt = cursor;
    cursor += BEATS.approval;
  }

  // 6. the investigator after its first part: before the request_forks result at the first fork's rebuild, the rest
  // from forkedStart on its own clock.
  const forkedStart = forks.length || segs.length > 1 ? cursor : null;
  const invTimes: number[] = new Array<number>(inv.length).fill(0);
  for (const i of first) invTimes[i] = invStart + num(inv[i].t);
  const rest = segs.slice(1).flat();
  let restSpan = 0;
  if (rest.length && forkedStart !== null) {
    const r = rest.findIndex((i) => inv[i].type === "tool_result" && (inv[i] as { name?: string | null }).name === "request_forks");
    const t0 = num(inv[rest[r >= 0 ? r : 0]].t);
    const before = forkSlots[0]?.rebuildAt ?? forkedStart;
    rest.forEach((i, k) => {
      if (r >= 0 && k < r) invTimes[i] = before;
      else {
        const x = Math.max(0, num(inv[i].t) - t0);
        invTimes[i] = forkedStart + x;
        restSpan = Math.max(restSpan, x + 2);
      }
    });
  }
  if (inv.length) {
    for (let i = 1; i < invTimes.length; i++) invTimes[i] = Math.max(invTimes[i], invTimes[i - 1]);
    times.investigator = invTimes;
  }
  if (forkedStart !== null) cursor = forkedStart + Math.max(forks.length ? BEATS.forked : 0, restSpan);

  // Step labels and hypotheses: when the investigator recorded them, else spread over the investigating beat.
  const resultAt = (tool: string): number[] => {
    const callIds = new Map<string, number>();
    const out: number[] = [];
    inv.forEach((e, i) => {
      if (e.type === "tool_call" && e.name === tool) {
        if (e.id) callIds.set(e.id, out.length);
        out.push(invTimes[i]);
      } else if (e.type === "tool_result" && e.id && callIds.has(e.id)) out[callIds.get(e.id)!] = invTimes[i];
    });
    return out;
  };
  const invLen = invEnd - invStart;
  const labelRuns = Object.keys(full.step_labels);
  const labelCalls = inv.filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call" && e.name === "record_step_labels");
  const labelTimes = resultAt("record_step_labels");
  const stepLabelsAt: Record<string, number> = {};
  labelRuns.forEach((run, i) => {
    let k = -1;
    for (let j = labelCalls.length - 1; j >= 0; j--) if (labelCalls[j].args?.run_id === run) { k = j; break; }
    stepLabelsAt[run] = k >= 0 ? labelTimes[k] : invStart + (invLen * 0.5 * (i + 1)) / (labelRuns.length + 1);
  });
  const hypTimes = resultAt("record_hypothesis");
  const nh = full.hypotheses.length;
  const hypothesesAt = full.hypotheses.map((_, i) =>
    hypTimes[i] ?? invStart + invLen * (nh === 1 ? 0.6 : 0.55 + (0.3 * i) / Math.max(1, nh - 1)));

  return {
    ...base, investigateStart: invStart, investigateEnd: invEnd, stepLabelsAt, hypothesesAt, forks: forkSlots,
    finalPendingAt, forkedStart, duration: cursor,
  };
}

// ── the timeline API ─────────────────────────────────────────────────────────

/** Length of the replay timeline in seconds for a saved batch. */
export function replayDuration(full: CaseFile, events: Record<EventKey, AgentEvent[]>): number {
  return replaySchedule(full, events).duration;
}

/** The batch phase `t` seconds into the timeline. */
export function replayPhaseAt(full: CaseFile, events: Record<EventKey, AgentEvent[]>, t: number): Phase {
  const s = replaySchedule(full, events);
  if (t >= s.duration) return full.phase;
  if (t < s.runsEnd) return "running";
  if (t < s.readyAt) return "analyzing";
  if (s.investigateStart === null || t < s.investigateStart) return full.split ? "ready" : "no_split";
  if (t < (s.investigateEnd ?? 0)) return "investigating";
  for (const f of s.forks) {
    if (t >= f.approvalStart && t < f.rebuildAt) return "awaiting_approval";
    if (t >= f.rebuildAt && t < f.doneAt) return "forking";
  }
  if (s.finalPendingAt !== null && t >= s.finalPendingAt) return "awaiting_approval";
  if (s.forkedStart !== null && t >= s.forkedStart && s.forks.length) return "forked";
  return "investigating";
}

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const progress = (t: number, start: number, end: number): number => (end <= start ? (t >= end ? 1 : 0) : clamp01((t - start) / (end - start)));

/** Index of the last event at or before `t` (+1): how many events have happened. */
function countAt(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function without<T extends object>(o: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out as Partial<T>;
}

const RUN_LIVE_FIELDS = [...SCORE_FIELDS, "status", "todos", "step", "last_tool", "duration_s", "charts", "motion_files", "tokens", "vm_id", "lab_url"];

/**
 * The motion files of a run or fork child as they were `t` seconds in: those whose `motion` event has happened, in
 * the order they last arrived (a changed file moves to the end), limited to the files the final record lists (only
 * those are known to be on disk). Null when none had arrived yet, or the log has no motion events (an older batch).
 */
export function motionAt(final: string[] | undefined, evs: AgentEvent[], times: number[], t: number): string[] | null {
  if (!final?.length) return null;
  const keep = new Set(final);
  const out: string[] = [];
  const n = countAt(times, t);
  for (let i = 0; i < n; i++) {
    const e = evs[i];
    if (e.type !== "motion" || !keep.has(e.path)) continue;
    const k = out.indexOf(e.path);
    if (k >= 0) out.splice(k, 1);
    out.push(e.path);
  }
  return out.length ? out : null;
}

function runAt(r: RunRecord, slot: RunSlot, evs: AgentEvent[], times: number[], t: number): RunRecord {
  if (t >= slot.end) return { ...r };
  const rest = without(r, RUN_LIVE_FIELDS);
  if (t < slot.first) {
    const starting = slot.first >= 1 && t >= slot.first / 2;
    return { ...rest, id: r.id, status: starting ? "starting" : "queued" };
  }
  const out: RunRecord = { ...rest, id: r.id, status: "running" };
  if (r.vm_id !== undefined) out.vm_id = r.vm_id;
  if (r.lab_url !== undefined) out.lab_url = r.lab_url;
  let todos: AgentTodo[] | null = null;
  let tool: string | null = null;
  const n = countAt(times, t);
  for (let i = 0; i < n; i++) {
    const e = evs[i];
    if (e.type === "todos") todos = e.todos;
    else if (e.type === "tool_call") tool = e.name;
  }
  if (todos) {
    out.todos = todos;
    out.step = todos.find((x) => x.status === "in_progress")?.content ?? null;
  }
  if (tool !== null) out.last_tool = tool;
  const motion = motionAt(r.motion_files, evs, times, t);
  if (motion) out.motion_files = motion;
  if (r.tokens) {
    const p = progress(t, 0, slot.end);
    out.tokens = { input: Math.round(r.tokens.input * p), output: Math.round(r.tokens.output * p) };
  }
  return out;
}

function childAt(c: ForkChild, slot: ChildSlot, evs: AgentEvent[], times: number[], t: number): ForkChild | null {
  if (t < slot.start) return null;
  if (t >= slot.end) return { ...c };
  const out: ForkChild = { arm: c.arm, status: "running" };
  if (c.lab_url !== undefined) out.lab_url = c.lab_url;
  if (c.how !== undefined) out.how = c.how;
  const motion = motionAt(c.motion_files, evs, times, t);
  if (motion) out.motion_files = motion;
  return out;
}

function forkAt(f: ForkExperiment, slot: ForkSlot, events: Record<EventKey, AgentEvent[]>, times: Record<EventKey, number[]>, t: number): ForkExperiment | null {
  if (t < slot.rebuildAt) return null;
  if (t >= slot.doneAt) return { ...f };
  const rest = without(f, ["status", "children", "arms"]) as Omit<ForkExperiment, "status" | "children" | "arms">;
  if (t < slot.runningAt) return { ...rest, status: "rebuilding", children: {} };
  const children: Record<string, ForkChild> = {};
  for (const [cid, c] of Object.entries(f.children)) {
    const key = childKey(f.id, cid);
    const at = childAt(c, slot.children[cid], events[key] ?? [], times[key] ?? [], t);
    if (at) children[cid] = at;
  }
  return { ...rest, status: "running", children };
}

function scaleScope(s: ScopeCost, p: number): ScopeCost {
  const out: ScopeCost = { ...s };
  for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    const v = s[k];
    if (typeof v === "number") out[k] = Math.round(v * p);
  }
  for (const k of ["model_usd", "vm_seconds", "vm_usd", "total_usd"] as const) {
    const v = s[k];
    if (typeof v === "number") out[k] = v * p;
  }
  return out;
}

function costsAt(full: CaseFile, s: ReplaySchedule, t: number): Costs {
  const c = full.costs;
  if (!c.scopes) return { ...c };
  const runSlots = Object.values(s.runs);
  const runTotal = runSlots.reduce((a, r) => a + r.end, 0);
  const scopeProgress = (scope: string): number => {
    if (scope === "runs") return runTotal > 0 ? runSlots.reduce((a, r) => a + Math.min(t, r.end), 0) / runTotal : progress(t, 0, s.runsEnd);
    if (scope.startsWith("run:")) {
      const r = s.runs[scope.slice(4)];
      if (r) return progress(t, 0, r.end);
    }
    if (scope.startsWith("fork:")) {
      const [, fid, cid] = scope.split(":");
      const f = s.forks.find((x) => x.id === fid);
      if (f && cid === "base") return progress(t, f.rebuildAt, f.doneAt);
      const ch = f?.children[cid];
      if (ch) return progress(t, ch.start, ch.end);
      if (f) return progress(t, f.rebuildAt, f.doneAt);
    }
    if (scope === "investigator" && s.investigateStart !== null) return progress(t, s.investigateStart, s.duration);
    return progress(t, 0, s.duration);
  };
  const scopes: Record<string, ScopeCost> = {};
  let fullUsd = 0, nowUsd = 0;
  for (const [k, v] of Object.entries(c.scopes)) {
    scopes[k] = scaleScope(v, scopeProgress(k));
    fullUsd += num(v.total_usd);
    nowUsd += num(scopes[k].total_usd);
  }
  const out: Costs = { ...c, scopes };
  if (typeof c.spent_usd === "number") out.spent_usd = fullUsd > 0 ? c.spent_usd * (nowUsd / fullUsd) : c.spent_usd * progress(t, 0, s.duration);
  return out;
}

/** The case file as it was `t` seconds into the timeline. Never mutates `full`; at `t >= duration` it equals `full`. */
export function caseAt(full: CaseFile, events: Record<EventKey, AgentEvent[]>, t: number): CaseFile {
  const s = replaySchedule(full, events);
  if (t >= s.duration) {
    return { ...full, runs: { ...full.runs }, step_labels: { ...full.step_labels }, hypotheses: [...full.hypotheses], forks: { ...full.forks } };
  }
  const runs: Record<string, RunRecord> = {};
  for (const [id, r] of Object.entries(full.runs)) runs[id] = runAt(r, s.runs[id], events[id] ?? [], s.times[id] ?? [], t);

  const step_labels: Record<string, StepLabel[][]> = {};
  for (const [run, labels] of Object.entries(full.step_labels)) if (t >= s.stepLabelsAt[run]) step_labels[run] = labels;
  const hypotheses: Hypothesis[] = full.hypotheses.filter((_, i) => t >= s.hypothesesAt[i]);

  const forks: Record<string, ForkExperiment | PendingForks> = {};
  const real = realForks(full);
  real.forEach((f, i) => {
    const slot = s.forks[i];
    if (t >= slot.approvalStart && t < slot.rebuildAt) {
      const n = f.n_per_arm;
      forks.pending = { id: "pending", status: "awaiting_approval", n_per_arm: n, vm_count: 2 * n + 1, estimate_usd: null };
    }
    const at = forkAt(f, slot, events, s.times, t);
    if (at) forks[f.id] = at;
  });
  if (s.finalPendingAt !== null && t >= s.finalPendingAt && full.forks.pending) forks.pending = { ...full.forks.pending };

  return {
    config: full.config,
    phase: replayPhaseAt(full, events, t),
    runs,
    step_labels,
    split: t >= s.readyAt ? full.split : null,
    hypotheses,
    forks,
    verdict: null,
    // The commentary feed: each item once its run's clock (the timeline, for runs) has passed it.
    feed: (full.feed ?? []).filter((f) => t >= f.t),
    costs: costsAt(full, s, t),
  };
}

/** Each event log cut to what had happened by `t`. The arrays are the input's events, never copies of them. */
export function eventsAt(full: CaseFile, events: Record<EventKey, AgentEvent[]>, t: number): Record<EventKey, AgentEvent[]> {
  const c = cached(full, events);
  const out: Record<EventKey, AgentEvent[]> = {};
  for (const [key, evs] of Object.entries(events)) {
    const times = c.schedule.times[key] ?? agentTimes(evs);
    const n = t >= c.schedule.duration ? evs.length : countAt(times, t);
    const prev = c.slices.get(key);
    if (prev && prev.n === n) { out[key] = prev.arr; continue; }
    const arr = n === evs.length ? evs.slice() : evs.slice(0, n);
    c.slices.set(key, { n, arr });
    out[key] = arr;
  }
  return out;
}

// ── following the story ──────────────────────────────────────────────────────

/** How long after the person last scrolled a playing replay leaves the page where they put it. */
export const USER_SCROLL_QUIET_MS = 4000;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

/** A key that scrolls the page, pressed outside a text field (where it moves the caret instead). */
export function isScrollKey(key: string, target?: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!SCROLL_KEYS.has(key)) return false;
  const tag = target?.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true);
}

/**
 * Whether a playing replay may scroll a newly revealed section into view: not while the person is scrolling
 * themselves. Only the person's own input (wheel, touch, keys, the scrollbar) is reported here, never the replay's
 * programmatic scroll, so following the story never counts as the person scrolling.
 */
export class ScrollFollow {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly quietMs = USER_SCROLL_QUIET_MS) {}
  /** The person scrolled at `now` (ms). */
  userScrolled(now: number): void { this.last = now; }
  /** True when the person has not scrolled in the last `quietMs`. */
  follows(now: number): boolean { return now - this.last >= this.quietMs; }
}

// ── the control bar ──────────────────────────────────────────────────────────

const svg = (body: string, size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block">${body}</svg>`;
const ICON = {
  play: svg(`<path d="M7 4.5v15l12-7.5z" fill="currentColor"></path>`),
  pause: svg(`<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"></rect><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"></rect>`),
  restart: svg(`<path d="M4 12a8 8 0 1 0 2.4-5.7"></path><path d="M4 4v4.5h4.5"></path>`),
  end: svg(`<path d="M5 5l8 7-8 7z" fill="currentColor"></path><path d="M18 5v14"></path>`),
};

export const REPLAY_SPEEDS = [1, 4, 16] as const;

const tenth = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/** Play / pause, speed, scrubber, restart, jump to end. */
export function replayBar(r: ReplayState): string {
  const total = Math.max(0, r.duration);
  const t = Math.min(Math.max(0, r.t), total);
  const max = Math.ceil(total * 10) / 10;
  const atEnd = t >= total;
  const pct = total > 0 ? (t / total) * 100 : 0;
  const toggle = r.playing
    ? `<button type="button" class="rp-btn rp-toggle" data-act="${ACT.replayToggle}" aria-label="Pause replay" title="Pause">${ICON.pause}</button>`
    : `<button type="button" class="rp-btn rp-toggle" data-act="${ACT.replayToggle}" aria-label="Play replay" title="Play">${ICON.play}</button>`;
  const speeds = REPLAY_SPEEDS.map((s) =>
    `<button type="button" class="rp-speed" data-act="${ACT.replaySpeed}" data-arg="${s}" aria-pressed="${r.speed === s}" aria-label="Speed ${s}x">${s}x</button>`).join("");
  const elapsed = fmtDuration(t), whole = fmtDuration(total);
  return `<div class="rp-bar" role="group" aria-label="Replay controls">`
    + `<span class="rp-tag">Replay</span>`
    + toggle
    + `<button type="button" class="rp-btn" data-act="${ACT.replayRestart}" aria-label="Restart replay" title="Restart">${ICON.restart}</button>`
    + `<input class="rp-seek" type="range" data-replay-seek min="0" max="${tenth(max)}" step="0.1" value="${tenth(Math.min(t, max))}"`
    + ` aria-label="Replay position" aria-valuetext="${attr(`${elapsed} of ${whole}`)}" style="--rp-p:${pct.toFixed(2)}%">`
    + `<span class="rp-time"><span class="rp-now">${esc(elapsed)}</span> / ${esc(whole)}</span>`
    + `<span class="rp-speeds" role="group" aria-label="Replay speed">${speeds}</span>`
    + `<button type="button" class="rp-end" data-act="${ACT.replayEnd}" aria-label="Skip to end"${atEnd ? " disabled" : ""}>${ICON.end}<span>Skip to end</span></button>`
    + `</div>`;
}
