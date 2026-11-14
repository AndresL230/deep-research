// The batch's trap, as the views use it. Everything said about a trap (the step's words, the pattern that
// highlights it, the evidence sentence) comes from the server's description of it: `config.trap_info` in a case file,
// `defaults.traps` on the home screen. A batch saved before traps were pluggable has neither, and each helper then
// answers null so the caller keeps the words it always had.

import type { CaseFile, Defaults, TrapInfo } from "../api";
import { pct } from "./format";

/** What the new batch panel's summary says is planted before it knows the trap: the default trap's words. */
export const DEFAULT_PLANTED = "planted duplicate rows";

const isTrap =(t: unknown): t is TrapInfo => {
  const x = t as Partial<TrapInfo> | null;
  return !!x && typeof x.name === "string" && typeof x.label === "string" && typeof x.pattern === "string";
};

/** The trap a batch planted, or null on a batch that does not say. */
export function trapOf(c: Pick<CaseFile, "config"> | null | undefined): TrapInfo | null {
  const info = (c?.config as { trap_info?: unknown } | undefined)?.trap_info;
  return isTrap(info) ? info : null;
}

/** The trap chosen in the new batch panel, from the server's list. Null until the list is there. */
export function chosenTrap(defaults: Defaults | null, name: string | null | undefined): TrapInfo | null {
  return defaults?.traps?.find((t) => isTrap(t) && t.name === name) ?? null;
}

/** Says whether a piece of code (a line, a cell) does a step. A RegExp is one. */
export interface Mark { test(code: string): boolean }

/** Code without its import statements. The backend reads a trap's step the same way (deep_research/analysis.py
 *  `_without_imports`): importing `GroupShuffleSplit` is not using it. */
export const withoutImports = (code: string): string => code
  .replace(/^[ \t]*from\s+[\w.]+\s+import\s*\([^)]*\)/gm, "")
  .replace(/(^|;|-c\s+["'])[ \t]*(?:from\s+[\w.]+\s+import|import)\s[^;\n"']*/gm, "$1");

const compiled = new Map<string, Mark | null>();

/** A trap's pattern as a mark, or null when the browser cannot read it. Views run on every paint, so it is kept. */
function patternOf(trap: TrapInfo): Mark | null {
  let mark = compiled.get(trap.pattern);
  if (mark === undefined) {
    try {
      const rx = new RegExp(trap.pattern);
      mark = { test: (code) => rx.test(withoutImports(code)) };
    } catch { mark = null; }
    compiled.set(trap.pattern, mark);
  }
  return mark;
}

/** What marks `label` in code when it is the trap's own step, else null (the caller has a table for the rest). */
export function trapMark(trap: TrapInfo | null, label: string | null | undefined): Mark | null {
  return trap && label != null && trap.label === label ? patternOf(trap) : null;
}

/** The trap's words for `label` when it is the trap's own step, else null. */
export function trapWords(trap: TrapInfo | null, label: string): { did: string; missing: string } | null {
  return trap && trap.label === label && trap.did && trap.missing ? { did: trap.did, missing: trap.missing } : null;
}

/**
 * The evidence sentence in two parts, "52%" and "of test rows were also in training", or null when there is nothing
 * to say: the run has no number, or the trap has no evidence number at all. `fallback` finishes the sentence on a
 * batch that does not describe its trap.
 */
export function evidenceParts(share: number | null | undefined, trap: TrapInfo | null, fallback: string, digits = 0): { share: string; text: string } | null {
  if (share == null || Number.isNaN(share)) return null;
  const text = trap ? trap.evidence_text : fallback;
  return text ? { share: pct(share, digits), text } : null;
}
