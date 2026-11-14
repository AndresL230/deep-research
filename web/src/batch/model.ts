// The batch UI's shared contract: routes, the view models each view renders from, and the action names views put in
// `data-act`. main.ts owns the state and the event handling; every view is a pure `(vm) => html string` function that
// morph.ts patches in place. Views never fetch, never touch the DOM, never keep state.
//
// Actions: a clickable element carries `data-act="<ACT>"` and, when it needs one, `data-arg="<string>"`. Config inputs
// carry `data-cfg="<BatchConfig field>"` (main.ts reads `.value`, numbers for number/range inputs). The replay scrubber
// is an `<input type="range" data-replay-seek>` whose value is seconds.

import type { AgentEvent, BatchConfig, BatchListItem, CaseFile, Defaults, Estimate, Health } from "../api";

export const ACT = {
  // anywhere
  home: "home",                 // go to the home screen
  openBatch: "open-batch",      // arg: batch id
  openCosts: "open-costs",      // go to the overall cost screen (also its Retry)
  // home / config
  start: "start",               // start a live batch with the draft config
  resetConfig: "reset-config",  // draft back to the server defaults
  toggleAdvanced: "toggle-advanced", // show or hide the less used settings
  // batch screen
  openRun: "open-run",          // arg: run id ("r01")
  openChild: "open-child",      // arg: "<fork>/<child>" ("f1/control-1")
  back: "back",                 // from a run or child back to its batch
  runView: "run-view",          // arg: "notebook" | "steps", how a run's page shows its log
  investigate: "investigate",   // live only: start the investigator
  approve: "approve",           // live only: approve forks.pending
  decline: "decline",           // live only: decline forks.pending
  stop: "stop",                 // live only: stop the batch and its VMs
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

export type Route =
  | { name: "home" }
  | { name: "costs" }
  | { name: "batch"; id: string }
  | { name: "run"; id: string; run: string }
  | { name: "child"; id: string; fork: string; child: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "b" && parts[1]) {
    if (parts[2] === "run" && parts[3]) return { name: "run", id: parts[1], run: parts[3] };
    if (parts[2] === "fork" && parts[3] && parts[4]) return { name: "child", id: parts[1], fork: parts[3], child: parts[4] };
    return { name: "batch", id: parts[1] };
  }
  if (parts[0] === "costs") return { name: "costs" };
  return { name: "home" };
}

export function routeHash(r: Route): string {
  const e = encodeURIComponent;
  switch (r.name) {
    case "home": return "#/";
    case "costs": return "#/costs";
    case "batch": return `#/b/${e(r.id)}`;
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
}

export type Loadable<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

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
  error: string | null;
}
