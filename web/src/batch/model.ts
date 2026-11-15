// The batch UI's shared contract: routes, the view models each view renders from, and the action names views put in
// `data-act`. main.ts owns the state and the event handling; every view is a pure `(vm) => html string` function that
// morph.ts patches in place. Views never fetch, never touch the DOM, never keep state.
//
// Actions: a clickable element carries `data-act="<ACT>"` and, when it needs one, `data-arg="<string>"`. Config inputs
// carry `data-cfg="<BatchConfig field>"` (main.ts reads `.value`, numbers for number/range inputs). The replay scrubber
// is an `<input type="range" data-replay-seek>` whose value is seconds.

import type { AgentEvent, BatchConfig, BatchListItem, CaseFile, Defaults, Estimate, Health } from "../api";
import type { TableView } from "./batch-table";
import type { NeedUi } from "./needs-you";
import type { Role } from "../access";

export const ACT = {
  // anywhere
  home: "home",                 // go to the home screen
  landing: "landing",           // go to the landing page (the header's logo)
  openBatch: "open-batch",      // arg: batch id
  openCosts: "open-costs",      // go to the overall cost screen (also its Retry)
  newBatch: "new-batch",        // open the New batch dialog (the header's button)
  closeNewBatch: "close-new-batch", // close it (its X)
  navMenu: "nav-menu",          // open or close the header's menu of links (narrow screens)
  howStep: "how-step",          // How it works: arg is the tour's stop to show (0 is the first)
  // the New batch form
  start: "start",               // start a live batch with the draft config
  resetConfig: "reset-config",  // draft back to the server defaults
  toggleAdvanced: "toggle-advanced", // show or hide the less used settings
  // batch screen
  openRun: "open-run",          // arg: run id ("r01")
  openChild: "open-child",      // arg: "<fork>/<child>" ("f1/control-1")
  back: "back",                 // from a run or child back to its batch
  goto: "goto",                 // arg: a step of the batch (BatchStep); open its page
  runPanel: "run-panel",        // arg: "notebook" | "steps" | "logs" | "evidence": open that panel of a run's page, or fold it
  runChart: "run-chart",        // arg: a chart's index; a tabular run's page shows it large
  investigate: "investigate",   // live only: start the investigator
  approve: "approve",           // live only: approve forks.pending
  decline: "decline",           // live only: decline forks.pending
  stop: "stop",                 // live only: stop the batch and its VMs
  toggleFeed: "toggle-feed",    // open or close the live feed under its header button (touch; hover opens it too)
  fold: "fold",                 // arg: a fold's key ("split", "exp:f1"): show or hide a section's detail
  // replay
  replayToggle: "replay-toggle",   // play / pause
  replaySpeed: "replay-speed",     // arg: speed multiplier ("1", "4", "16")
  replayRestart: "replay-restart", // back to t = 0 and play
  replayEnd: "replay-end",         // jump to the end (the full saved batch)
  // the conversation view (ask-conversation.ts already emits these)
  toggle: "toggle",
  jump: "jump",
} as const;

// ── routes (location.hash) ───────────────────────────────────────────────────

/**
 * A batch is read a page at a time, in this order: the overview and the agents, then each stage after them. The keys
 * are the page sections' own names (main.ts `batchBody`); the address says them in words (`#/b/<id>/changed`).
 */
export const BATCH_STEPS = ["wall", "split", "phase", "fork", "verdict", "diagnosis", "fix"] as const;
export type BatchStep = (typeof BATCH_STEPS)[number];
export const STEP_SLUG: Record<BatchStep, string> = {
  wall: "agents", split: "changed", phase: "investigator", fork: "fork", verdict: "verdict", diagnosis: "diagnosis", fix: "fix",
};
export const STEP_LABEL: Record<BatchStep, string> = {
  wall: "Agents", split: "What changed", phase: "Investigator", fork: "Fork", verdict: "Verdict", diagnosis: "Diagnosis", fix: "Fix",
};

/**
 * `landing` is the page a visitor arrives on; `home` is the app's own first screen: what needs a person, then the
 * batches. It has two addresses, one per link in the header: `#/start` opens it at its top (Needs you), `#/batches`
 * at the batch table (`at: "batches"`).
 */
export type Route =
  | { name: "landing" }
  | { name: "home"; at?: "batches" }
  /** "How it works": the loop in five steps (how.ts), and the first screen of someone new. */
  | { name: "how" }
  | { name: "costs" }
  /** `step` is left out on the first page (the overview and the agents). */
  | { name: "batch"; id: string; step?: BatchStep }
  | { name: "run"; id: string; run: string }
  | { name: "child"; id: string; fork: string; child: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "b" && parts[1]) {
    if (parts[2] === "run" && parts[3]) return { name: "run", id: parts[1], run: parts[3] };
    if (parts[2] === "fork" && parts[3] && parts[4]) return { name: "child", id: parts[1], fork: parts[3], child: parts[4] };
    const step = BATCH_STEPS.find((k) => STEP_SLUG[k] === parts[2]);
    return step && step !== "wall" ? { name: "batch", id: parts[1], step } : { name: "batch", id: parts[1] };
  }
  if (parts[0] === "costs") return { name: "costs" };
  if (parts[0] === "how") return { name: "how" };
  if (parts[0] === "start") return { name: "home" };
  if (parts[0] === "batches") return { name: "home", at: "batches" };
  return { name: "landing" };
}

export function routeHash(r: Route): string {
  const e = encodeURIComponent;
  switch (r.name) {
    case "landing": return "#/";
    case "home": return r.at === "batches" ? "#/batches" : "#/start";
    case "costs": return "#/costs";
    case "how": return "#/how";
    case "batch": return r.step && r.step !== "wall" ? `#/b/${e(r.id)}/${STEP_SLUG[r.step]}` : `#/b/${e(r.id)}`;
    case "run": return `#/b/${e(r.id)}/run/${e(r.run)}`;
    case "child": return `#/b/${e(r.id)}/fork/${e(r.fork)}/${e(r.child)}`;
  }
}

// ── view models ──────────────────────────────────────────────────────────────

/** Event log keys: a run id ("r01"), a fork child ("f1/control-1"), or "investigator". */
export type EventKey = string;
export const childKey = (fork: string, child: string): EventKey => `${fork}/${child}`;

export interface ReplayState {
  /** Seconds into the replay timeline (replay.ts). */
  t: number;
  /** Where the timeline ends: the full saved batch. */
  duration: number;
  playing: boolean;
  /** Timeline seconds per wall-clock second. */
  speed: number;
}

/** One event log with a clock, for the notebook views (notebook.ts), which type code out as it is written. */
export interface LogView {
  /** Everything known of the log. In a replay that is the WHOLE saved log, including what has not happened yet. */
  events: AgentEvent[];
  /** Each event's time in the log's own seconds, non-decreasing (a fork child's copied prefix is at 0). */
  times: number[];
  /** Now, in the same seconds. Events after it have not happened yet. Infinity = the log is over. */
  clock: number;
  /** The events after `clock` are known (a replay), so a cell can be typed out before its call lands. */
  lookahead: boolean;
}

export interface BatchVm {
  id: string;
  /** Started on this server: the live-only actions (investigate, approve, decline, stop) work. */
  live: boolean;
  /** A saved batch that stopped at its split: Investigate brings it back live first (`resumeBatch`). */
  resumable?: boolean;
  /** Untested suspects the finished investigator can be asked to test (`POST .../suspects/{id}/test`). */
  testable?: string[];
  /** The case file. During a replay it is the case AT `replay.t` (replay.ts `caseAt`), not the final one. */
  case: CaseFile;
  /** Event logs loaded so far, keyed by EventKey. During a replay, cut to `replay.t`. Missing key = not loaded. */
  events: Record<EventKey, AgentEvent[]>;
  /** The same logs with clocks, for the notebooks. Absent in tests: notebook.ts falls back to `events`. */
  logs?: Record<EventKey, LogView>;
  /** Null for a live batch. */
  replay: ReplayState | null;
  /** The action in flight ("investigate", "approve", ...), to disable its button. */
  busy: string | null;
  /** The last action's error, to show near the actions. */
  error: string | null;
  /** Wall-clock ms, for "running for 42s" style labels. */
  now: number;
  /** The folds the person opened or closed, by key (lanes.ts): each section shows its key points and keeps its
   *  detail folded until asked for. A key that is absent takes the fold's own default. "all": every fold open. */
  open?: Readonly<Record<string, boolean>> | "all";
  /** Who is looking (access.ts): only "admin" gets the actions (investigate, approve, decline, stop). Absent: admin. */
  role?: Role;
  /** The pairs a person set on the pending experiment's approval card (suspects.ts), or null/absent for as asked. */
  pairs?: number | null;
}

export type Loadable<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

/**
 * The app's shared state behind the home screen, the header and the New batch dialog: the batch list (the home's
 * Needs you and table, the header's count) and the form's draft. main.ts loads it on any app page, so the dialog and
 * the count work from a batch page as well.
 */
export interface HomeVm {
  batches: Loadable<BatchListItem[]>;
  health: Health | null;
  defaults: Defaults | null;
  /** The config being edited; null until the defaults load. */
  draft: BatchConfig | null;
  estimate: Loadable<Estimate> | null;
  /** The less used settings are showing (default: hidden). */
  advanced?: boolean;
  /** POST /api/batches in flight. */
  starting: boolean;
  /** How the batch table is sorted and filtered (batch-table.ts); absent: newest first, every domain. */
  table?: TableView;
  /** The "Needs you" rows' states (needs-you.ts), keyed by `needKey`: a quote, an open confirm, an error. Absent: at rest. */
  needs?: Record<string, NeedUi>;
  error: string | null;
}
