// What a fork child's log says it did, and what the investigator's log says it asked for. Pure readers: no DOM, no
// fetch, no html. lanes.ts builds the Fork and Verdict pages from these, so this file does not import lanes.ts (that
// would be a cycle); the step's mark and words come in as an argument instead.
//
// Nothing here returns a tool_result's text: a code-tracer subagent's results can carry hidden can positions.
import type { AgentEvent, ForkArm, ForkExperiment } from "../api";
import type { EventKey } from "./model";
import type { Mark } from "./trap";

/**
 * Where the copy's own work starts in a fork child's log. A live child's log has the forced step as its first event;
 * a saved one starts with the source run's events, and the clock starts again at the cut, so the last place `t` goes
 * back is the cut. A log with neither (a control copy that has not moved yet) starts at 0.
 */
export function cutIndex(evs: AgentEvent[]): number {
  const forced = evs.findIndex((e) => e.type === "forced");
  if (forced >= 0) return forced;
  for (let i = evs.length - 1; i > 0; i--) if (evs[i].t < evs[i - 1].t) return i;
  return 0;
}

export type ForcedEvent = Extract<AgentEvent, { type: "forced" }> & { child: string };

/** The first "forced" event among the arm's children, in the fork's child order, with the child it came from. */
export function forcedEvent(events: Record<EventKey, AgentEvent[]>, fork: Pick<ForkExperiment, "id" | "children">, arm: ForkArm): ForcedEvent | null {
  for (const [cid, child] of Object.entries(fork.children)) {
    if (child.arm !== arm) continue;
    const ev = events[`${fork.id}/${cid}`]?.find((e) => e.type === "forced");
    if (ev && ev.type === "forced") return { ...ev, child: cid };
  }
  return null;
}

export interface CheckPoint { x: number; y: number; ok: boolean; cm: number }

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const POINT = new RegExp(String.raw`can at \((${NUM}), (${NUM})\): (success|fail), place error (${NUM}) cm`);
const TALLY = /(\d+) of (\d+) can positions succeeded/;

/**
 * The robot's forced check, read back from its printed output: one line per can position the server drew, then the
 * tally. These positions are the forced step's own, never the hidden test's. Null when the output is not that check.
 */
export function forcedCheck(output: string): { points: CheckPoint[]; ok: number; n: number } | null {
  const points: CheckPoint[] = [];
  for (const line of output.split("\n")) {
    const m = POINT.exec(line);
    if (m) points.push({ x: Number(m[1]), y: Number(m[2]), ok: m[3] === "success", cm: Number(m[4]) });
  }
  if (!points.length) return null;
  const tally = TALLY.exec(output);
  return tally
    ? { points, ok: Number(tally[1]), n: Number(tally[2]) }
    : { points, ok: points.filter((p) => p.ok).length, n: points.length };
}

/** The batch's step as copyStory needs it: what marks it in code (lanes.ts stepMark) and its words (stepWords.did). */
export interface StepTest { mark: Mark | null; did: string }

export interface CopyStory {
  /** It ran a command of its own after the cut. */
  ranSomething: boolean;
  /** It wrote or edited controller.py after the cut (robot). */
  editedController: boolean;
  /** Its own code after the cut did the batch's step (tabular). */
  didStep: boolean;
  /** Its last thought after the cut, one line of at most 120 characters, or null. */
  lastThought: string | null;
  /** Tool calls after the cut. */
  calls: number;
  /** The behaviour tag for the child tile, or null when there is nothing worth saying. */
  tag: string | null;
}

// The same one-line clip as lanes.ts's, kept here so this file does not import lanes.ts.
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * What a copy did on its own after the cut. Only its tool calls and thoughts are read, never their results.
 * `step` is the batch's step (tabular); `motion` says the batch is a robot one, whose tags are about the controller.
 * `arm` is the copy's arm: in any arm but control the first step was imposed, not chosen, so it is never credited to
 * the copy. A live log records that step as a "forced" event (not a tool call, so it is never counted); a saved
 * fixture log records it as an ordinary call right after the cut, so in the forced arm, whose imposed step is the
 * step under test, the first call there that does the step is skipped.
 */
export function copyStory(evs: AgentEvent[], step: StepTest | null, motion: boolean, arm: ForkArm | null = null): CopyStory {
  const after = evs.slice(cutIndex(evs));
  const imposed = arm != null && arm !== "control";
  let skipImposed = arm === "forced" && !after.some((e) => e.type === "forced");
  let ranSomething = false;
  let editedController = false;
  let didStep = false;
  let lastThought: string | null = null;
  let calls = 0;
  for (const e of after) {
    if (e.type === "thought") lastThought = clip(e.text, 120) || lastThought;
    if (e.type !== "tool_call") continue;
    const text = str(e.args.command) || str(e.args.content);
    if (skipImposed && !motion && step?.mark?.test(text)) { skipImposed = false; continue; }
    calls++;
    if (e.name === "execute") ranSomething = true;
    if ((e.name === "edit_file" || e.name === "write_file") && str(e.args.file_path).endsWith("controller.py")) editedController = true;
    // The step test is the tabular one: a robot batch's step is about where the can is, not a line of code.
    if (!motion && step?.mark && step.mark.test(text)) didStep = true;
  }
  const idle = imposed ? `ran nothing after the ${arm} step` : "reported without running anything";
  const tag = motion
    ? editedController ? "edited controller.py" : ranSomething ? "ran its own check" : idle
    : didStep && step ? `did ${step.did} ${imposed ? "again " : ""}on its own` : null;
  return { ranSomething, editedController, didStep, lastThought, calls, tag };
}

const PRACTICE = "practice.motion.json";
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * The recording to show for a child: the last file that is not the practice episode, since a copy that ran a check
 * of its own away from the practice spot says more; else the last file. Null with no files.
 */
export function bestMotion(files: readonly string[] | null | undefined): string | null {
  // Never a hidden test's recording: those sit under a run's trace/ folder and are named hidden_NN, and their can
  // positions are the hidden test's.
  const shown = (files ?? []).filter((p) => !p.includes("/trace/") && !p.startsWith("trace/") && !baseName(p).toLowerCase().startsWith("hidden"));
  if (!shown.length) return null;
  for (let i = shown.length - 1; i >= 0; i--) if (baseName(shown[i]) !== PRACTICE) return shown[i];
  return shown[shown.length - 1];
}

export interface InvestigatorCounts {
  /** Task calls per subagent type, in the order each type was first asked for. */
  subagents: Record<string, number>;
  requestForks: number;
  requestFixTest: number;
  recordVerdict: number;
}

/**
 * What the investigator asked for, from its own tool calls. Subagents are told apart by the task call's
 * `args.subagent_type`: the log's `agent` tag reads "tools" for every subagent, so it is not read here.
 */
export function investigatorCounts(events: AgentEvent[]): InvestigatorCounts {
  const out: InvestigatorCounts = { subagents: {}, requestForks: 0, requestFixTest: 0, recordVerdict: 0 };
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    if (e.name === "task") {
      const kind = str(e.args.subagent_type).trim();
      if (kind) out.subagents[kind] = (out.subagents[kind] ?? 0) + 1;
    } else if (e.name === "request_forks") out.requestForks++;
    else if (e.name === "request_fix_test") out.requestFixTest++;
    else if (e.name === "record_verdict") out.recordVerdict++;
  }
  return out;
}
