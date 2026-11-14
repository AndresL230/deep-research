// How the batch screens talk about a batch's domain: the subject ("robot", "model"), what the agents checked their
// claim on, the two numbers' labels, and every step label in human words. It all comes from the server
// (`config.domain_info.words`, deep_research/domains/ `Domain.words`). A batch saved before that has none, and the
// tables here stand in: the robot words for a motion batch, the tabular words the screens always had otherwise.
//
// A tabular batch's trap step is described by `config.trap_info` (trap.ts), which wins for its own label.

import type { DomainWords, TrapInfo } from "../api";
import { trapWords } from "./trap";

export interface StepText {
  /** A noun phrase: "testing other can positions", "removing duplicate rows". */
  name: string;
  /** Past tense, after "Honest runs": "ran the can at other positions". */
  did: string;
  /** The empty slot on the side that skipped the step: "Only the practice spot was run here". */
  missing: string;
}

/** The robot arm's words, for robot batches saved before the server sent them (sim/domain.py LABELS). */
export const ROBOT_WORDS: DomainWords = {
  subject: "robot",
  judged_on: "at {n} positions they never tested",
  checked: "practice spot",
  claim_label: "Claimed",
  truth_label: "Measured",
  step_when: "before writing the report",
  skipped: "This run wrote its report from the practice spot alone",
  evidence_text: "of tested can positions were the practice spot",
  steps: {
    inspect_scene: { name: "looking at the scene", did: "looked at the scene", missing: "No look at the scene here" },
    write_controller: { name: "writing the controller", did: "wrote the controller", missing: "No controller written here" },
    run_single_episode: { name: "running one episode", did: "ran one episode", missing: "No episode run here" },
    test_one_position: { name: "testing one can position", did: "ran the can at one position", missing: "No single position test here" },
    vary_positions: { name: "testing other can positions", did: "ran the can at other positions", missing: "Only the practice spot was run here" },
    test_table_edges: { name: "testing the table edges", did: "ran the can near the table edges", missing: "No table edges tested here" },
    tune_params: { name: "tuning the controller", did: "tuned the controller's numbers", missing: "No tuning here" },
    write_report: { name: "writing the report", did: "wrote the report", missing: "No report written here" },
  },
};

/** The tabular words, as the screens said them before domains described themselves (deep_research/analysis.py). */
export const TABULAR_WORDS: DomainWords = {
  subject: "model",
  judged_on: "on {n} rows they never saw",
  checked: "test set",
  claim_label: "Reported",
  truth_label: "True",
  step_when: "before splitting into train and test",
  skipped: "This run went straight to splitting the data",
  evidence_text: "of test rows were also in training",
  steps: {
    load: { name: "loading the data", did: "loaded the data", missing: "No data loaded here" },
    inspect: { name: "looking at the data", did: "looked at the data", missing: "No look at the data here" },
    deduplicate: { name: "removing duplicate rows", did: "removed duplicate rows", missing: "No duplicate removal here" },
    deduplicate_near: { name: "removing near-duplicate rows", did: "removed near-duplicate rows", missing: "No near-duplicate removal here" },
    clean: { name: "cleaning up missing values", did: "cleaned up missing values", missing: "No cleaning here" },
    split: { name: "splitting into train and test", did: "split into train and test", missing: "No split here" },
    preprocess: { name: "scaling or imputing the features", did: "scaled or imputed the features", missing: "No preprocessing here" },
    train: { name: "training a model", did: "trained a model", missing: "No model trained here" },
    evaluate: { name: "scoring a model", did: "scored a model", missing: "No scoring here" },
    plot: { name: "drawing a chart", did: "drew a chart", missing: "No chart here" },
    predict: { name: "reading the holdout rows", did: "read the holdout rows", missing: "No holdout rows read here" },
    report: { name: "writing the report", did: "wrote the report", missing: "No report written here" },
  },
};

const isWords = (w: unknown): w is DomainWords => {
  const x = w as Partial<DomainWords> | null;
  return !!x && typeof x.subject === "string" && typeof x.judged_on === "string" && typeof x.claim_label === "string"
    && typeof x.truth_label === "string" && typeof x.step_when === "string" && typeof x.skipped === "string";
};

/** A batch's words: the server's, else the robot table for a motion batch, else the tabular one. Missing step
 *  entries in the server's words fall back to the table's. */
export function domainWords(config: unknown): DomainWords {
  const c = (config ?? {}) as { visual?: unknown; domain?: unknown; domain_info?: { words?: unknown } | null };
  const robot = c.visual === "motion" || c.domain === "robot_arm";
  const table = robot ? ROBOT_WORDS : TABULAR_WORDS;
  const own = c.domain_info?.words;
  if (!isWords(own)) return table;
  return {
    ...table,
    ...own,
    checked: own.checked || table.checked,
    evidence_text: own.evidence_text === undefined ? table.evidence_text : own.evidence_text,
    steps: { ...table.steps, ...(own.steps ?? {}) },
  };
}

/** "vary_positions" -> "vary positions": a label nobody describes, at least without its underscores. */
const unlabel = (label: string): string => label.replace(/[_-]+/g, " ").trim();

/** A step label in words: the batch trap's for its own step, else the domain's, else generic ones. Never the raw
 *  label. */
export function stepText(label: string, words: DomainWords, trap: TrapInfo | null = null): StepText {
  const own = words.steps[label];
  const t = trapWords(trap, label);
  const plain = unlabel(label);
  const name = own?.name ?? `doing the ${plain} step`;
  if (t) return { name, ...t };
  if (own) return own;
  return { name, did: `did the ${plain} step`, missing: `No ${plain} step here` };
}

/** "at 20 positions they never tested", or "at positions they never tested" when the count is unknown. */
export function judgedOn(words: DomainWords, n: number | null | undefined): string {
  if (n != null && Number.isFinite(n) && n > 0) return words.judged_on.replace(/\{n\}/g, String(Math.round(n)));
  return words.judged_on.replace(/\s*\{n\}\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** "robot" -> "Robot". */
export const capital = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
