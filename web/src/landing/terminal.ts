// What the little terminal under the hero plays (devices.ts builds the device, screens.ts paints its screen): one
// batch from the first command to the verdict, told twice, once from the command line and once over the API. The
// commands and routes are the project's own (deep_research/cli.py, docs/api-contract.md) and every number is the
// recorded robot arm run's (fixtures/robot-live-investigation). The screen replays those numbers, not a live run,
// and says so in its title.
//
// Pure functions of time, tested in test/landing.test.ts.

/** The five lights along the bottom of the device, in the order a batch goes through them. */
export const STAGES = ["Runs", "Score", "Split", "Fork", "Verdict"] as const;

/** Which of the screen's colours a piece of text is in. */
export type Tint = "ink" | "dim" | "accent";

export interface Span {
  text: string;
  tint: Tint;
  /** Drawn on a tinted chip: the path or address the line is about. */
  chip?: boolean;
}

/** What a line starts with: a shell prompt, a stream prompt, a tick, a spinner, or nothing. */
export type Mark = "" | "$" | ">" | "tick" | "spin";

export interface Line {
  mark: Mark;
  spans: Span[];
  /** The caret is at the end of this line. */
  caret?: boolean;
}

/** A stage light: not reached, working now, or done. */
export type Light = "off" | "on" | "lit";

export interface TerminalView {
  title: string;
  lines: Line[];
  lights: Light[];
  /** How far the ticket has printed, 0 to 1. */
  ticket: number;
}

export type Beat =
  /** A command typed out a character at a time. `chip` is the part of it to draw on a chip. */
  | { kind: "type"; mark: "$" | ">"; text: string; chip?: string }
  /** A step that spins for a while, then ticks and shows its result. It lights `stage`. */
  | { kind: "work"; stage: number; name: string; result: string; seconds?: number }
  /** A quiet line under the step before it. */
  | { kind: "note"; text: string }
  /** The last step: a title in the accent colour and a sentence under it. */
  | { kind: "done"; stage: number; title: string; detail: string };

export interface Script {
  /** The small line at the top of the screen. */
  title: string;
  beats: Beat[];
  /** The ticket that prints when the script is over: a title and a line under it. */
  ticket: [string, string];
}

export type Mode = "cli" | "api";

export const SCRIPTS: Record<Mode, Script> = {
  cli: {
    title: "robot arm · recorded run",
    beats: [
      { kind: "type", mark: "$", text: "python -m deep_research.cli runs --n 12" },
      { kind: "work", stage: 0, name: "runs", result: "12 sandboxes · one agent in each", seconds: 1.35 },
      { kind: "work", stage: 1, name: "score", result: "3 honest · 5 inflated · 2 unclear" },
      { kind: "note", text: "r06: claimed 100% · measured 65%" },
      { kind: "work", stage: 2, name: "split", result: "tune_params" },
      { kind: "type", mark: "$", text: "python -m deep_research.cli forks $BATCH --n 4" },
      { kind: "work", stage: 3, name: "fork", result: "control 4 of 4 inflated · forced 0 of 4", seconds: 1.35 },
      { kind: "done", stage: 4, title: "Verdict", detail: "Skipping the edge test suggests why" },
    ],
    ticket: ["Verdict · open", "0 of 4 inflated once the test is forced"],
  },
  api: {
    title: "localhost:8000 · recorded run",
    beats: [
      { kind: "type", mark: "$", text: "curl -X POST :8000/api/batches -d @config.json", chip: ":8000/api/batches" },
      { kind: "work", stage: 0, name: "batch", result: '{"id": "$ID"} · 12 runs', seconds: 1.35 },
      { kind: "type", mark: ">", text: "ws /api/batches/$ID/ws" },
      { kind: "work", stage: 1, name: "case.runs", result: "3 honest · 5 inflated · 2 unclear" },
      { kind: "work", stage: 2, name: "case.split", result: "tune_params" },
      { kind: "type", mark: "$", text: "curl -X POST :8000/api/batches/$ID/investigate" },
      { kind: "work", stage: 3, name: "case.forks", result: "control 4 of 4 · forced 0 of 4", seconds: 1.35 },
      { kind: "done", stage: 4, title: "case.verdict", detail: "Skipping the edge test suggests why" },
    ],
    ticket: ["Verdict · open", "0 of 4 inflated once the test is forced"],
  },
};

const TYPE_LEAD = 0.3;
const TYPE_RATE = 34;
const TYPE_TAIL = 0.3;
const WORK = 1.1;
const NOTE = 0.3;
const DONE_LEAD = 0.6;
const TICKET_AT = 0.45;
const TICKET_TIME = 0.9;
/** How long the finished screen is left up before the script plays again. */
export const TERMINAL_HOLD = 7;

/** A step's name is padded to this many characters, so the results line up in a column. */
const NAME_WIDTH = 12;

const beatSeconds = (b: Beat): number => {
  switch (b.kind) {
    case "type": return TYPE_LEAD + b.text.length / TYPE_RATE + TYPE_TAIL;
    case "work": return b.seconds ?? WORK;
    case "note": return NOTE;
    case "done": return DONE_LEAD;
  }
};

/** Seconds from the script's start to the ticket lying printed. */
export function scriptSeconds(script: Script): number {
  return script.beats.reduce((t, b) => t + beatSeconds(b), 0) + TICKET_AT + TICKET_TIME;
}

/** The first `shown` characters of a command as spans, with its chip (if it has one and has been typed that far)
 *  picked out. */
function typed(text: string, shown: number, chip = ""): Span[] {
  const seen = text.slice(0, shown);
  const at = chip ? text.indexOf(chip) : -1;
  if (at < 0 || shown <= at) return [{ text: seen, tint: "ink" }];
  const end = at + chip.length;
  const spans: Span[] = [];
  if (at > 0) spans.push({ text: seen.slice(0, at), tint: "ink" });
  spans.push({ text: seen.slice(at, end), tint: "accent", chip: true });
  if (shown > end) spans.push({ text: seen.slice(end), tint: "ink" });
  return spans;
}

/** The screen `t` seconds into `script`. Before 0 it is empty; after the end it stays as it finished. */
export function terminalAt(script: Script, t: number): TerminalView {
  const lines: Line[] = [];
  const lights: Light[] = STAGES.map(() => "off");
  let start = 0;
  let caretOn: Line | null = null;

  for (const beat of script.beats) {
    if (t < start) break;
    const into = t - start;
    const length = beatSeconds(beat);
    if (beat.kind === "type") {
      const shown = Math.max(0, Math.min(beat.text.length, Math.floor((into - TYPE_LEAD) * TYPE_RATE)));
      const line: Line = { mark: beat.mark, spans: typed(beat.text, shown, beat.chip) };
      lines.push(line);
      caretOn = into < length ? line : null;
    } else if (beat.kind === "work") {
      if (into < length) {
        lines.push({ mark: "spin", spans: [{ text: beat.name, tint: "accent" }] });
        lights[beat.stage] = "on";
      } else {
        lines.push({ mark: "tick", spans: [{ text: beat.name.padEnd(NAME_WIDTH), tint: "accent" }, { text: beat.result, tint: "dim" }] });
        lights[beat.stage] = "lit";
      }
      caretOn = null;
    } else if (beat.kind === "note") {
      lines.push({ mark: "", spans: [{ text: "".padEnd(NAME_WIDTH) + beat.text, tint: "dim" }] });
    } else {
      if (into < length) {
        lights[beat.stage] = "on";
      } else {
        lines.push({ mark: "", spans: [] });
        lines.push({ mark: "tick", spans: [{ text: beat.title, tint: "accent" }] });
        lines.push({ mark: "", spans: [{ text: beat.detail, tint: "ink" }] });
        lights[beat.stage] = "lit";
      }
    }
    start += length;
  }
  if (caretOn) caretOn.caret = true;

  // The ticket prints a moment after the last beat is through.
  const ticket = t >= start ? Math.max(0, Math.min(1, (t - start - TICKET_AT) / TICKET_TIME)) : 0;
  return { title: script.title, lines, lights, ticket };
}
