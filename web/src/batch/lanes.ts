// OWNER: subagent C. The Split, Fork and Verdict states, and the investigator's panel.
import type { BatchVm } from "./model";

/** The lane chart: one lane per run through the step labels, the split step lit, the two commands side by side. */
export function splitView(vm: BatchVm): string { void vm; return ""; }

/** The fork experiment: the approval card (forks.pending), then control and forced arms fanning out. */
export function forkView(vm: BatchVm): string { void vm; return ""; }

/** The verdict: dots per arm colored by outcome, plus the one sentence. */
export function verdictView(vm: BatchVm): string { void vm; return ""; }

/** The investigator: what it is doing (its events, hypotheses) and the live-only Investigate / Stop actions. */
export function investigatorView(vm: BatchVm): string { void vm; return ""; }
