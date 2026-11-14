// The batch API's HTTP and websocket surface (docs/api-contract.md). Same origin: Vite proxies /api (and the
// websocket) to uvicorn on 8000 in dev; the server serves web/dist in production.
//
// The types mirror the case file (deep_research/case_file.py, written by batch.py, scoring.py and analysis.py) and
// the run event log (deep_research/events.py). fixtures/demo-batch/ is a full example; test/api.test.ts checks it.

// ── the case file ────────────────────────────────────────────────────────────

/** The case file's sections, in order. */
export const CASE_SECTIONS = [
  "config", "phase", "runs", "step_labels", "split", "hypotheses", "forks", "verdict", "trace", "fix", "trace_comparison", "rubric", "feed", "costs",
] as const;
export type CaseSection = (typeof CASE_SECTIONS)[number];

/** Phases in the order a batch moves through them. Also `stopped`, `blocked: <why>` and `error: <why>`. */
export const PHASES = [
  "config", "running", "analyzing", "ready", "no_split", "investigating", "awaiting_approval", "forking", "forked", "done", "stopped",
] as const;
export type KnownPhase = (typeof PHASES)[number];
export type Phase = KnownPhase | (string & {});

/** The step labels the server ships with (deep_research/analysis.py LABELS): the base steps plus each trap's honest
 *  step (`deduplicate`, `drop_leak`, `group_split`). A trap added later brings a label that is not listed here, so
 *  `StepLabel` is open; the batch's `config.trap_info` says what its step is. */
export const STEP_LABELS = [
  "load", "inspect", "deduplicate", "drop_leak", "group_split", "deduplicate_near", "clean", "split", "preprocess",
  "train", "evaluate", "plot", "predict", "report",
] as const;
export type KnownStepLabel = (typeof STEP_LABELS)[number];
export type StepLabel = KnownStepLabel | (string & {});

/** A trap, the flaw planted in the data, as the server describes it (deep_research/traps/, `Trap.public()`).
 *  Everything the UI says about a trap comes from here, so a new trap needs no change in the web app. */
export interface TrapInfo {
  /** The value of `BatchConfig.trap`. */
  name: string;
  title: string;
  /** One line for the picker. */
  description: string;
  /** After "planted": "duplicate rows". */
  planted: string;
  /** What `trap_strength` means for this trap, as the slider's label. */
  strength_label: string;
  /** The step an honest run does, and the regex (JavaScript `RegExp` source) that spots it in code. */
  label: string;
  pattern: string;
  /** The step can be part of the split itself (a grouped split). */
  at_split?: boolean;
  /** After "Honest runs": "removed duplicate rows". */
  did: string;
  /** The empty slot on the side that skipped the step: "No duplicate check here". */
  missing: string;
  /** What the fork experiment's forced arm runs. */
  intervention: { description: string; command: string };
  /** How to finish "52% ...", about a run's `overlap_share`. Null when the trap has no evidence number. */
  evidence_text: string | null;
}

/** What the UI draws for a run (deep_research/domains/ `Domain.visual`): its PNG charts, or the motion of its episodes. */
export type Visual = "charts" | "motion";

/** A domain, the kind of task a batch runs, as the server describes it (`Domain.public()`). */
export interface DomainInfo {
  /** The value of `BatchConfig.domain`. */
  name: string;
  title: string;
  description: string;
  visual: Visual;
  /** Files each run must write, relative to its workspace. */
  output_files: string[];
  /** More outputs, as globs relative to the workspace (a robot run's motion files). */
  output_globs: string[];
  /** How the screens talk about this domain (`Domain.words`). Absent on batches saved before it: the views then use
   *  the tabular words they always had. */
  words?: DomainWords;
}

/** A domain's words for the screens (deep_research/domains/ `Domain.words`), so no robot screen says "test rows" and
 *  no headline shows a raw step label. Each is a plain phrase; `{n}` is replaced where noted. */
export interface DomainWords {
  /** The thing that is judged: "robot" or "model". "the claim moved X pts, the robot moved Y pts". */
  subject: string;
  /** Finishes "Measured {judged_on}: 59%", with `{n}` the number of hidden cases: "at {n} positions they never
   *  tested", "on {n} rows they never saw". */
  judged_on: string;
  /** What the agents checked their claim on: "practice spot", "test set". */
  checked: string;
  /** Labels for the two numbers: "Claimed" and "Measured". */
  claim_label: string;
  truth_label: string;
  /** When the domain's step happens, after "did this ": "before writing the report", "before splitting into train
   *  and test". */
  step_when: string;
  /** The empty slot on the side that skipped the step: "This run wrote its report from the practice spot alone". */
  skipped: string;
  /** Finishes "52% ..." about a run's `overlap_share` when the batch has no trap that says it, or null. */
  evidence_text: string | null;
  /** Human words per step label, for headlines: `{name: "testing other can positions", did: "ran the can at other
   *  positions", missing: "Only the practice spot was run here"}`. A tabular batch's trap step is in `trap_info`. */
  steps: Record<string, { name: string; did: string; missing: string }>;
}

/** What happened at one hidden case (robot_arm): placed upright on the zone, tipped over, never picked up or put
 *  down in the wrong place (missed), or let go of in the air (dropped). */
export type HiddenOutcome = "placed" | "tipped" | "missed" | "dropped";

/** One hidden episode of a scored robot run: where the can stood, what really happened, and its recording. */
export interface HiddenResult {
  x: number;
  y: number;
  seed: number;
  result: HiddenOutcome;
  /** The final distance of the can from the zone center, cm, whatever the result; null only when the episode never ran. */
  place_error_cm: number | null;
  /** The episode's motion file, low frame rate, as a path for `batchFileUrl` (`runs/r02/hidden/07-s0.motion.json`). */
  motion: string | null;
}

export interface BatchConfig {
  /** A domain's `name`: one of `Defaults.domains`. Absent on batches saved before domains: read it as "tabular". */
  domain?: string;
  /** In a case file only: what the UI draws for a run. Absent on batches saved before domains: read it as "charts". */
  visual?: Visual;
  /** In a case file only: the batch's domain, described. */
  domain_info?: DomainInfo;
  /** robot_arm only: what the agent's controller.py holds at the start, the template ("blank") or a colleague's
   *  working controller ("colleague"). Sent back as the server gave it. */
  robot_start?: "blank" | "colleague";
  robot_prompt?: "default" | "practice";
  /** "pima" (built in) or an uploaded dataset's id (`DatasetInfo.id`). */
  dataset: string;
  /** The column to predict. Needed for an uploaded dataset; absent or null means Pima's `outcome`. */
  target?: string | null;
  /** An uploaded training script's id (`ScriptInfo.id`): the agents start from it instead of from nothing. */
  script?: string | null;
  /** A trap's `name`: one of `Defaults.traps`. */
  trap: string;
  /** In a case file only: the batch's trap, described. Absent on batches saved before traps were pluggable. */
  trap_info?: TrapInfo;
  trap_strength: number;
  trap_noise: number;
  /** Share of the planted copies that get the noise. Sent back as the server gave it. */
  trap_hidden_share?: number;
  hint_level: "none" | "light";
  model_hint: "random_forest" | "any";
  holdout_fraction: number;
  n_runs: number;
  forks_per_choice: number;
  /** The fork experiment's extra arms (forks.arm_plan). Sent back as the server gave them. */
  placebo_arm?: boolean;
  show_arm?: boolean;
  analyst_model: string;
  /** A lineup of analyst models the runs take in turn (r01 the first, r02 the second, ...). Null or absent: every run
   *  uses `analyst_model`. The robot domain defaults to Haiku 5.5 and Sonnet 5.5. */
  analyst_models?: string[] | null;
  /** How many runs have a VM at once; the rest wait as "queued". */
  max_concurrent_runs?: number;
  /** The analysts' step limit (LangGraph recursion limit). */
  max_agent_steps?: number;
  investigator_model: string;
  budget_usd: number;
  inflation_threshold: number;
  mode: "live" | "replay";
  seed: number;
  /** robot_arm only: how many hidden can positions a controller is scored on (the first n); null means all. */
  robot_hidden_positions?: number | null;
  /** robot_arm only: the seeds each hidden position is run with (one to five). */
  robot_eval_seeds?: number[];
  /** Live commentary (deep_research/commentary.py): captions of each run and a feed of notable moments. The server
   *  turns it on for robot_arm and off for tabular when it is left out. */
  commentary?: boolean | null;
  commentary_model?: string;
  /** The most the captions may spend in one batch; counted under the cost scope `commentary`. */
  commentary_budget_usd?: number;
  /** Only on fixtures made by scripts/make_fixture.py: the agents' choices are scripted. */
  simulated?: boolean;
}

/** A run's score (deep_research/scoring.py RunScore). */
/** "unclear" (robot only): the gap is between the domain's unclear and inflation thresholds; left out of the split. */
export type ScoreStatus = "honest" | "inflated" | "unclear" | "failed";
export interface RunScore {
  status: ScoreStatus;
  reported_accuracy: number | null;
  true_accuracy: number | null;
  /** The trap's evidence number, from the run's own train.csv and test.csv. For duplicates: the share of test rows
   *  that also appear in training. Null when the trap has none (`TrapInfo.evidence_text` is null too). */
  overlap_share: number | null;
  /** reported_accuracy minus true_accuracy. */
  gap: number | null;
  reason: string;
  /** How many hidden cases the true score came from: can positions (robot_arm) or holdout rows (tabular). */
  n_hidden?: number | null;
  /** robot_arm: the can positions the run's own episodes used (printed results and saved motion files), [x, y] in
   *  meters, rounded to the millimeter, deduplicated, in order of first appearance (what it checked). */
  checked_positions?: [number, number][];
  /** robot_arm: every hidden episode's real result. Only present once the run is scored. */
  hidden_results?: HiddenResult[];
  /** tabular: rows in the run's own test set, and how many of them are copies of training rows. */
  n_test?: number | null;
  n_test_copies?: number | null;
}

export const RUN_STATUSES = ["queued", "starting", "running", "honest", "inflated", "unclear", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface AgentTodo { content: string; status: "pending" | "in_progress" | "completed" }

/** One analyst run. Fields fill in as it goes: queued, then starting, running, and finally its score. */
export interface RunRecord extends Partial<Omit<RunScore, "status">> {
  id: string;
  status: RunStatus;
  /** The analyst model this run uses (from the batch's lineup). Absent on batches saved before lineups. */
  model?: string;
  vm_id?: string;
  /** Signed preview URL of the lab page inside the VM. Null when it could not start, in replays, and once the run
   *  has ended (the VM is deleted then; see `charts`). */
  lab_url?: string | null;
  todos?: AgentTodo[];
  /** The todo in progress. */
  step?: string | null;
  last_tool?: string;
  n_actions?: number;
  /** Step labels per action, in order. */
  labels?: StepLabel[][];
  /** The charts the run saved, oldest first, as paths for `batchFileUrl`. Set once the run has finished. */
  charts?: string[];
  /** The motion files the run saved (`visual` "motion"), as paths for `batchFileUrl`, such as
   *  `runs/r01/outputs/live/practice.motion.json`, newest last. Grows while the run is going (the server pulls them
   *  from its VM every 15 s, each with a `motion` event); final once it has finished. Absent in the tabular domain. */
  motion_files?: string[];
  // Fixture only (scripts/make_fixture.py).
  duration_s?: number;
  tokens?: { input: number; output: number };
}

/** Where honest and inflated runs part ways (deep_research/analysis.py SplitFinding). */
export interface SplitFinding {
  label: StepLabel;
  /** Share of honest runs that did `label` before splitting; inflated_rate is the same for inflated runs. */
  honest_rate: number;
  inflated_rate: number;
  n_honest: number;
  n_inflated: number;
  /** Fork this inflated run just before this action. */
  fork_run_id: string | null;
  fork_at: number | null;
  honest_example: string | null;
  inflated_example: string | null;
  /** What the forced arm does, or null when no intervention exists for the label yet. */
  intervention: string | null;
}

/** The experiment's arms (deep_research/forks.py `arm_plan`), in the order they are run.
 *  `placebo` runs a harmless command so `forced` is not the only arm with an extra tool call in its history;
 *  `show` is told what `forced` fixes and left to decide. Both are optional per batch. A fix experiment
 *  (`ForkExperiment.kind` "fix") runs `fixed`, the run with the proposed fix applied, in place of `forced`. */
export type ForkArm = "control" | "placebo" | "show" | "forced" | "fixed";

/** What a fork experiment tests: `method`, which step caused the inflation (the default), or `fix`, whether the
 *  investigator's proposed patch makes the code better. */
export type ForkKind = "method" | "fix";

export interface ForkChild extends Partial<Omit<RunScore, "status">> {
  arm: ForkArm;
  status: "running" | ScoreStatus;
  lab_url?: string | null;
  /** The charts the child saved, as paths for `batchFileUrl`. */
  charts?: string[];
  /** The motion files the child saved, as paths for `batchFileUrl` (`forks/f1/forced-1/outputs/live/...`), newest
   *  last. Grows while the child runs, as a run's does. */
  motion_files?: string[];
  /** "fork": a copy-on-write VM fork. "replay": rebuilt by replaying the actions when forking failed. */
  how?: "fork" | "replay";
  /** The analyst model the copy continues on: its source run's. */
  model?: string;
}

export interface ArmSummary {
  total: number;
  scored: number;
  inflated: number;
  honest: number;
  /** Only when some child is unclear (robot): counted on its own, not in `scored`. */
  unclear?: number;
  failed: number;
  mean_reported: number | null;
  mean_true: number | null;
}

export interface ForkExperiment {
  id: string;
  /** Absent means "method": the experiment that tests which step. A "fix" experiment's `arm_steps` has `control`,
   *  optionally `placebo`, and `fixed` (never `forced`). */
  kind?: ForkKind;
  status: "rebuilding" | "running" | "done" | "stopped";
  source_run: string;
  fork_at: number;
  label: StepLabel;
  /** What the `forced` arm runs first. */
  intervention: string;
  n_per_arm: number;
  /** Each arm in order, mapped to the step run before it continues (null for `control`).
   *  Absent on batches saved before the extra arms existed: those ran `control` and `forced` only. */
  arm_steps?: Partial<Record<ForkArm, string | null>>;
  /** Keyed `control-1`, `placebo-1`, `show-1`, `forced-1`, ... */
  children: Record<string, ForkChild>;
  /** Set when status is "done". */
  arms?: Partial<Record<ForkArm, ArmSummary>>;
  /** A fix experiment's patch, as the server copied it onto the fork (batch.py). */
  fix?: ProposedFix;
  // Planned (MASTER_PLAN 6.1): the evidence the server will record. Until it does, the UI computes these itself
  // (batch/evidence.ts) and labels them as derived.
  /** The direction saved before any copy ran. */
  prediction?: "smaller_gap" | "larger_gap";
  /** Control and changed copies matched before the run, with whether each pair went the predicted way. */
  pairs?: { i: number; control_gap: number; changed_gap: number; agree: boolean }[];
  /** The paired score: x1.9 per agreeing pair, x0.1 per disagreeing one. */
  score?: number;
  p_exact?: number;
  level?: "open" | "supported" | "cleared";
}

/** forks["pending"]: the investigator asked for forks and is waiting for `postDecision`. */
export interface PendingForks {
  id: "pending";
  status: "awaiting_approval";
  /** Absent means "method". "fix": the investigator wants to test its proposed fix (`CaseFile.fix`). */
  kind?: ForkKind;
  n_per_arm: number;
  vm_count: number;
  estimate_usd: number | null;
}

export type Confidence = "low" | "medium" | "high";

/** The split a hypothesis or verdict rests on, as fields. Absent on case files saved before they existed. */
export interface SplitFields {
  /** The step, the same as `step_label`. */
  step?: StepLabel;
  /** Shares 0 to 1 of the honest and inflated runs that did the step, and how many runs each is over. */
  honest_rate?: number;
  inflated_rate?: number;
  n_honest?: number;
  n_inflated?: number;
  confidence?: Confidence;
}

export interface Hypothesis extends SplitFields {
  /** Unix seconds. */
  at: number;
  step_label: StepLabel;
  honest_action: string;
  inflated_action: string;
  evidence: string;
  /** The hypothesis in one sentence. */
  sentence?: string;
}

export interface Verdict extends SplitFields {
  sentence: string;
  step_label: StepLabel;
  /** `{arm}_inflated` and `{arm}_total` per arm (the old form; derived from `arms` when that is set). */
  numbers: Record<string, number>;
  /** Every arm the fork experiment scored: inflated and scored copies. */
  arms?: Partial<Record<ForkArm, { inflated: number; total: number }>>;
  /** How strong the fork evidence is (deep_research/evidence.py). The words follow it: "suggests" while open,
   *  "caused" only when supported. Absent on verdicts saved before it: read it as open. */
  evidence?: VerdictEvidence;
}

/** "supported": at least `needed_pairs` control and forced pairs, and the forced arm's inflated count is lower than
 *  the control arm's by a one-sided Fisher exact test at p < 0.05. Anything else is "open". */
export interface VerdictEvidence {
  level: "open" | "supported";
  /** Scored control and forced copies, paired: min(control_total, forced_total). */
  pairs: number;
  needed_pairs: number;
  control_inflated: number;
  control_total: number;
  forced_inflated: number;
  forced_total: number;
  p_value: number | null;
}

/** Whether the runs the code-tracer traced fail at the same line with the same symptom. */
export interface TraceComparison {
  at: number;
  same: "same" | "different" | "mixed";
  sentence: string;
  run_ids: string[];
}

/** One grader check of the verdict against the investigator's rubric. */
export interface RubricCheck {
  at: number;
  /** 0 for the first check; each revision adds one. */
  iteration: number;
  /** "satisfied", "needs_revision", "max_iterations_reached", "failed" or "grader_error". */
  result: string;
  explanation: string;
  /** How many criteria the grader checked, and the ones that failed. */
  criteria: number;
  failing: { name: string; gap: string }[];
}

/** One finding of the investigator's `code-tracer` subagent: a symptom read from a recording of a failing run, and
 *  the line of that run's controller.py behind it. */
export interface TraceEntry {
  /** Unix seconds. */
  at: number;
  /** The run whose code was traced ("r02"). */
  run_id: string;
  /** One sentence from the recording: "The can slipped out of the grip at 2.14 s, 0.31 m into a 0.60 m carry, ..." */
  symptom: string;
  /** 1-based line in the run's controller.py. */
  line: number;
  /** That line's text; may be empty. */
  excerpt: string;
  /** Why that line causes the symptom. */
  why: string;
  /** Batch-relative path of the recording it was read from (`runs/r02/trace/hidden_07.motion.json`), for
   *  `batchFileUrl`. Null when unknown. */
  motion_file: string | null;
}

/** The investigator's proposed patch to a run's controller, and how its fix experiment went. */
export interface ProposedFix {
  /** The run whose controller is patched. */
  run_id: string;
  /** The file's path in the VM: "/home/daytona/workspace/controller.py". */
  file_path: string;
  /** The line the fix targets, or null. */
  line: number | null;
  /** The exact text replaced, and its replacement. */
  old_string: string;
  new_string: string;
  /** One line: "Scale the carry time with the carry distance". */
  description: string;
  /** The reasoning. */
  why: string;
  status: "proposed" | "testing" | "tested" | "rejected";
  /** Unix seconds. */
  proposed_at: number;
  /** The fix experiment's fork id ("f2") once it runs. */
  fork_id?: string;
  /** The investigator's one sentence on what the fix experiment showed, once recorded. */
  verdict?: string;
}

export interface ScopeCost {
  input_tokens: number;
  output_tokens: number;
  // Absent on fixtures made before cache tokens were tracked.
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  model_usd?: number | null;
  vm_seconds?: number;
  vm_usd?: number | null;
  total_usd?: number | null;
}

/** Empty `{}` until the first cost push. Scopes are `run:r01`, `fork:f1:base`, `fork:f1:control-1`, `investigator`. */
export interface Costs {
  budget_usd?: number;
  /** Null when some price is unknown: then only token counts are real. */
  spent_usd?: number | null;
  prices_missing?: boolean;
  scopes?: Record<string, ScopeCost>;
  simulated?: boolean;
}

export interface CaseFile {
  /** `{}` until the batch starts. */
  config: BatchConfig | Record<string, never>;
  phase: Phase;
  runs: Record<string, RunRecord>;
  /** The investigator's step labels per run, one list per action. */
  step_labels: Record<string, StepLabel[][]>;
  split: SplitFinding | null;
  hypotheses: Hypothesis[];
  forks: Record<string, ForkExperiment | PendingForks>;
  verdict: Verdict | null;
  /** `[]` until the code-tracer subagent records something. Absent on case files saved before it existed (and in
   *  a replay's rebuilt snapshots): read as `[]`. */
  trace?: TraceEntry[];
  /** Null until the investigator proposes a fix. Absent on case files saved before it existed: read as null. */
  fix?: ProposedFix | null;
  /** Null until the investigator compares its traces. Absent on older case files. */
  trace_comparison?: TraceComparison | null;
  /** The grader's checks of the verdict, oldest first. Absent on older case files. */
  rubric?: RubricCheck[];
  /** The live commentary's notable moments, oldest first (at most 200). Absent on case files saved before it existed,
   *  and empty in a batch without commentary. */
  feed?: FeedItem[];
  costs: Costs;
}

/** One item of the commentary feed (deep_research/commentary.py). */
export interface FeedItem {
  /** Seconds on the run's own clock, like its events' `t`. */
  t: number;
  run: string;
  /** The run's model, short: "Sonnet". May be empty. */
  model: string;
  /** What made it notable: "first_success", "drop", "label" (a step such as moving the can), "finish", "failed". */
  kind: string;
  text: string;
}

export const isPendingForks = (f: ForkExperiment | PendingForks): f is PendingForks => f.id === "pending";

// ── event logs (events.jsonl) ────────────────────────────────────────────────

/** One line of a run's, fork child's or the investigator's events.jsonl. `t` is seconds since it started. */
export type AgentEvent = { t: number; /** Investigator only: which agent or subagent. */ agent?: string } & (
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string | null; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string | null; content: string }
  | { type: "todos"; todos: AgentTodo[] }
  /** Forced fork children only: the step the experiment forced, before the agent continues. */
  | { type: "forced"; command: string; output: string }
  /** Robot runs and fork children only: a motion file arrived from the VM (new, or changed since it last did), at
   *  `path`, batch-relative as in `motion_files`. Batches saved before these existed have none. */
  | { type: "motion"; path: string }
  /** Runs with live commentary only: a short caption of what the run is doing. `final`: written once the run was
   *  scored, with its claim and its result. */
  | { type: "caption"; text: string; final?: boolean }
);

// ── the websocket ────────────────────────────────────────────────────────────

/** Messages on `/api/batches/{id}/ws`. A replay sends one snapshot and closes; a live batch keeps streaming. */
export type BatchMessage =
  /** `resumable`: a saved batch of ours that stopped at a split; `POST .../resume` brings it back live. */
  | { kind: "snapshot"; case: CaseFile; live: boolean; resumable?: boolean }
  | { [S in CaseSection]: { kind: "case"; section: S; value: CaseFile[S] } }[CaseSection]
  | { kind: "event"; run: string; event: AgentEvent }
  | { kind: "fork_event"; fork: string; child: string; event: AgentEvent }
  | { kind: "investigator"; event: AgentEvent }
  | { kind: "error"; message: string };

/** Apply a websocket message to the case file the page holds. Events do not change it. */
export function applyMessage(c: CaseFile | null, m: BatchMessage): CaseFile | null {
  if (m.kind === "snapshot") return m.case;
  if (m.kind === "case" && c) return { ...c, [m.section]: m.value };
  return c;
}

export interface BatchSocket { close(): void }

/** Open the batch websocket. `onClose` gets whether the server closed it normally (a replay always does). */
export function openBatchSocket(
  batchId: string,
  on: { message: (m: BatchMessage) => void; close?: (clean: boolean) => void },
  loc: Pick<Location, "protocol" | "host"> = location,
): BatchSocket {
  const ws = new WebSocket(batchSocketUrl(batchId, loc));
  ws.onmessage = (e) => {
    try { on.message(JSON.parse(String(e.data)) as BatchMessage); } catch { /* not JSON: ignore */ }
  };
  ws.onclose = (e) => on.close?.(e.wasClean);
  return { close: () => ws.close() };
}

export function batchSocketUrl(batchId: string, loc: Pick<Location, "protocol" | "host"> = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${batchPath(batchId)}/ws`;
}

// ── REST ─────────────────────────────────────────────────────────────────────

/** `resumable`: a saved batch with scored runs, a split and no verdict yet, that `resumeBatch` can pick up again. */
export interface BatchListItem {
  id: string;
  kind: "live" | "replay";
  resumable?: boolean;
  /** Run on another machine and read from the team hub; `machine` says which. */
  remote?: boolean;
  machine?: string | null;
}

export interface DatasetColumn {
  name: string;
  kind: "number" | "text";
  n_unique: number;
  missing: number;
  /** Why this column cannot be the target, or null when it can. */
  target_problem: string | null;
}
/** A dataset a batch can run on (deep_research/datasets.py). */
export interface DatasetInfo {
  id: string;
  name: string;
  builtin: boolean;
  rows: number;
  columns: DatasetColumn[];
  /** The built-in dataset's target, or the suggested one for an upload. */
  target: string | null;
}
/** The server refuses larger files (datasets.py MAX_UPLOAD_BYTES). */
export const MAX_DATASET_BYTES = 20 * 1024 * 1024;

/** An uploaded training script (deep_research/user_scripts.py). The server parses it and never runs it. */
export interface ScriptInfo {
  id: string;
  name: string;
  lines: number;
  /** Third-party packages the script imports. */
  imports: string[];
  /** The ones not installed in the agents' VMs. */
  missing_packages: string[];
}
/** The server refuses larger scripts (user_scripts.py MAX_UPLOAD_BYTES). */
export const MAX_SCRIPT_BYTES = 200 * 1024;
/** This server's link to the team hub (deep_research/hub.py `status`). Never carries the token. */
export interface HubStatus {
  state: "off" | "connected" | "wrong_token" | "unreachable";
  url?: string;
  machine?: string;
  batches?: number | null;
  machines?: number | null;
  last_update?: string | null;
  error?: string;
  /** Updates waiting to be sent, when the last push, and its error since then. */
  queued?: number;
  last_push_at?: number | null;
  push_error?: string | null;
}
export interface Health { ok: boolean; keys: { anthropic: boolean; daytona: boolean }; hub?: HubStatus }
export interface Defaults {
  config: BatchConfig;
  prices_missing: boolean;
  /** Every trap a batch can plant, for the picker. Absent from a server older than the trap registry. */
  traps?: TrapInfo[];
  /** Every domain a batch can run, each with its own default config. Absent from a server older than domains. */
  domains?: (DomainInfo & { config: BatchConfig })[];
}
export interface Estimate {
  avg_run_usd: number | null;
  runs_usd: number | null;
  forks_usd: number | null;
  total_usd: number | null;
  over_budget: boolean;
  basis: string;
  /** The domain the estimate is for: each domain has its own average run cost. */
  domain?: string;
  /** With a lineup of models: how many runs each model gets and its average run cost (null when unknown). */
  by_model?: Record<string, { runs: number; avg_run_usd: number | null }>;
}

// The cost report (deep_research/cost_report.py, `GET /api/costs`): spend across every batch.
export interface CostTokens { input: number; output: number; cache_read: number; cache_write: number }
/** One total split two ways: by group (runs + forks + investigator + other) and by kind (model + vm). */
export interface CostUsd { total: number; runs: number; forks: number; investigator: number; /** The live commentary; absent in reports from before it. */ commentary?: number; other: number; model: number; vm: number }
export interface BatchCost {
  id: string;
  kind: "live" | "replay";
  /** Local time, `YYYY-MM-DDTHH:MM:SS`, or null when nothing says (fixtures). */
  started_at: string | null;
  phase: Phase | null;
  dataset: string | null;
  trap: string | null;
  analyst_model: string | null;
  investigator_model: string | null;
  simulated: boolean;
  prices_missing: boolean;
  counts: { runs: number; honest: number; inflated: number; unclear?: number; failed: number; fork_runs: number };
  /** Null for a simulated batch: tokens only. */
  usd: CostUsd | null;
  /** Some price was unknown: `usd` is the sum of what is known, and the real figure is higher. */
  usd_partial: boolean;
  tokens: CostTokens;
  vm_seconds: number;
}
export interface ModelCost {
  model: string;
  roles: ("analyst" | "investigator")[];
  batches: number;
  /** Model spend only: VM time belongs to no model. */
  usd: number;
  usd_by_group: { runs: number; forks: number; investigator: number; commentary?: number };
  usd_partial: boolean;
  tokens: CostTokens;
}
export interface CostReport {
  /** Real batches only. */
  totals: {
    batches: number; runs: number; honest: number; inflated: number; unclear?: number; failed: number; fork_runs: number;
    usd: CostUsd; usd_partial: boolean; tokens: CostTokens; vm_seconds: number; excludes_simulated: true;
  };
  /** What the totals leave out. */
  simulated: { batches: number; runs: number; tokens: CostTokens };
  by_model: ModelCost[];
  /** Newest first, simulated ones last. */
  batches: BatchCost[];
  not_counted: string[];
}

/** A request the server refused or could not answer: `message` is what to tell the person. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === "AbortError";

const batchPath = (id: string): string => `/api/batches/${encodeURIComponent(id)}`;

/** A run's (`"r01"`) or fork child's (`"f1/control-1"`) lab page, proxied by our server so Daytona's preview-URL
 *  warning never shows. Only meaningful when that record has a `lab_url`. The trailing slash matters: the page loads
 *  `state.json` and `live/<chart>` relative to it. */
export function labPageUrl(batchId: string, key: string): string {
  const slash = key.indexOf("/");
  const tail = slash < 0
    ? `runs/${encodeURIComponent(key)}`
    : `forks/${encodeURIComponent(key.slice(0, slash))}/${encodeURIComponent(key.slice(slash + 1))}`;
  return `${batchPath(batchId)}/${tail}/lab/`;
}

/** The URL of a file saved with a batch, such as a run's `charts` entry. Holdout labels are never served. */
/** The investigator's notebook for a domain, as plain text (GET /api/memory/<domain>). */
export const notebookUrl = (domain: string): string => `/api/memory/${encodeURIComponent(domain)}`;

export const batchFileUrl = (batchId: string, path: string): string =>
  `${batchPath(batchId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

async function errorMessage(res: Response): Promise<string> {
  // The Vite proxy answers 502/504 (or 500 with no body) when the server is not running.
  if (res.status === 502 || res.status === 503 || res.status === 504) return `Couldn't reach the server (HTTP ${res.status}). Is it running on port 8000?`;
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { detail?: unknown; error?: unknown };
      const d = j.detail ?? j.error;
      detail = typeof d === "string" ? d : d ? JSON.stringify(d) : "";
    } catch { detail = text.slice(0, 200); }
  } catch { /* no body */ }
  if (res.status === 500 && !detail.trim()) return "Couldn't reach the server (HTTP 500). Is it running on port 8000?";
  return `The server answered HTTP ${res.status}${detail ? `: ${detail}` : "."}`;
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const req: RequestInit = json === undefined ? rest : {
    ...rest, method: rest.method ?? "POST", body: JSON.stringify(json), headers: { "content-type": "application/json", ...rest.headers },
  };
  let res: Response;
  try {
    res = await fetch(path, req);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError("Couldn't reach the server. Is it running on port 8000?", 0);
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  return (await res.json()) as T;
}

type Opts = { signal?: AbortSignal };

export const fetchHealth = (o: Opts = {}) => call<Health>("/api/health", o);
export const fetchDefaults = (o: Opts = {}) => call<Defaults>("/api/defaults", o);
export const postEstimate = (cfg: BatchConfig, o: Opts = {}) => call<Estimate>("/api/estimate", { ...o, json: cfg });
export const fetchDatasets = (o: Opts = {}) => call<DatasetInfo[]>("/api/datasets", o);
/** Upload a CSV file. The body is the file itself; the server answers with its columns and a suggested target. */
export const uploadDataset = (file: Blob & { name?: string }, o: Opts = {}) =>
  call<DatasetInfo>(`/api/datasets?name=${encodeURIComponent(file.name ?? "dataset.csv")}`, {
    ...o, method: "POST", body: file, headers: { "content-type": "text/csv" },
  });
/** Upload a Python training script. The body is the file itself. */
export const uploadScript = (file: Blob & { name?: string }, o: Opts = {}) =>
  call<ScriptInfo>(`/api/scripts?name=${encodeURIComponent(file.name ?? "train.py")}`, {
    ...o, method: "POST", body: file, headers: { "content-type": "text/x-python" },
  });
export const fetchBatches = (o: Opts = {}) => call<BatchListItem[]>("/api/batches", o);
export const fetchCosts = (o: Opts = {}) => call<CostReport>("/api/costs", o);
export const startBatch = (cfg: BatchConfig, o: Opts = {}) => call<{ id: string }>("/api/batches", { ...o, json: cfg });
export const fetchCase = (id: string, o: Opts = {}) => call<CaseFile>(`${batchPath(id)}/case`, o);
export const fetchRunEvents = (id: string, run: string, o: Opts = {}) =>
  call<AgentEvent[]>(`${batchPath(id)}/runs/${encodeURIComponent(run)}/events`, o);
export const fetchForkEvents = (id: string, fork: string, child: string, o: Opts = {}) =>
  call<AgentEvent[]>(`${batchPath(id)}/forks/${encodeURIComponent(fork)}/${encodeURIComponent(child)}/events`, o);
export const fetchInvestigatorEvents = (id: string, o: Opts = {}) => call<AgentEvent[]>(`${batchPath(id)}/investigator/events`, o);
/** Live batches only: start the investigator once the phase is `ready`. */
export const startInvestigation = (id: string, o: Opts = {}) => call<{ ok: true }>(`${batchPath(id)}/investigate`, { ...o, method: "POST" });
/** Bring a saved, resumable batch back live on this server (phase `ready`); with `investigate`, start the investigator
 *  in the same call. 409 with the reason when the batch cannot be resumed. */
export const resumeBatch = (id: string, investigate = false, o: Opts = {}) =>
  call<{ id: string; phase: string }>(`${batchPath(id)}/resume${investigate ? "?investigate=true" : ""}`, { ...o, method: "POST" });
/** Live batches only: answer `forks.pending` while the phase is `awaiting_approval`. */
export const postDecision = (id: string, approve: boolean, o: Opts = {}) => call<{ ok: true }>(`${batchPath(id)}/decision`, { ...o, json: { approve } });
/** Live batches only: cancel the work and stop every VM. */
export const stopBatch = (id: string, o: Opts = {}) => call<{ ok: true }>(`${batchPath(id)}/stop`, { ...o, method: "POST" });
