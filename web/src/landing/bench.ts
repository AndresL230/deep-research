// What the data bench under the hero does (devices.ts builds it, screens.ts paints its sheet): the task builder
// in miniature, in the order deep_research/task.py works. A table is loaded, a holdout is set aside and locked
// away, and duplicate rows are planted in what is left. The numbers on the sheet are the built-in table's at the
// default settings: 768 rows, a 20% holdout, duplicates for half of the rest.
//
// Pure functions of time, tested in test/landing.test.ts.

import { clamp01, easeOutCubic, smooth } from "./ease";

/** Rows of the table shown on the bench. */
export const ROWS = 10;
/** The rows set aside as the holdout: the last 20%. */
export const HELD = [8, 9] as const;
/** The rows that get a planted duplicate: half of the rest. */
export const TWINS = [1, 2, 5, 7] as const;

/** The sheet standing behind the bench: the file, then one line for each thing done to it. */
export const SHEET = {
  file: "pima.csv",
  shape: "768 rows · 9 columns · target: outcome",
  lines: [
    ["Holdout", "154 rows · labels stay on the server"],
    ["Planted", "307 duplicate rows in the other 614"],
  ],
} as const;

/** Seconds for one pass, from the key press to the bench standing empty again. */
export const BENCH_LOOP = 13;
/** Seconds into a pass when the bench starts to clear for the next one. Until then nothing is undone. */
export const BENCH_RESET = BENCH_LOOP - 1.1;

const LOAD_AT = 0.35;
const LOAD_STEP = 0.07;
const LOAD_TIME = 0.4;
const HOLD_AT = 1.6;
const HOLD_TIME = 1.0;
const SWEEP_AT = 3.1;
const SWEEP_TIME = 2.4;
const POP_TIME = 0.35;
const TYPE_RATE = 30;
const RESET_TIME = 0.8;

/** Overshoots a little, then settles: for something that pops into place. */
const pop = (x: number): number => { const u = clamp01(x) - 1; return 1 + 2.4 * u * u * u + 1.4 * u * u; };

export interface BenchView {
  /** How far the load key is pressed, 0 to 1. */
  key: number;
  /** Each row's presence, 0 (not loaded) to 1. */
  rows: number[];
  /** How far the held rows have slid into the vault, 0 to 1. */
  held: number;
  /** The vault's light: 0 off, 1 on. */
  sealed: number;
  /** Where the scanner stands along the rows it sweeps: 0 before the first, 1 past the last. */
  scan: number;
  /** The scanner's light: 1 while it sweeps, 0 otherwise. */
  beam: number;
  /** Each planted duplicate's presence, 0 to 1, in the order of `TWINS`. */
  twins: number[];
  /** How many characters of each of the sheet's lines are written. */
  written: number[];
  /** Whether the sheet's heading is up yet, 0 to 1. */
  sheet: number;
}

/** The rows the scanner passes over: all but the held ones. */
const SWEPT = ROWS - HELD.length;

/** The bench `t` seconds into its loop. */
export function benchAt(t: number): BenchView {
  const leaving = smooth((t - BENCH_RESET) / RESET_TIME);
  const key = t < 0.3 ? smooth(t / 0.12) * (1 - smooth((t - 0.16) / 0.14)) : 0;
  const rows = Array.from({ length: ROWS }, (_, i) => easeOutCubic((t - LOAD_AT - i * LOAD_STEP) / LOAD_TIME) * (1 - leaving));
  const held = smooth((t - HOLD_AT) / HOLD_TIME) * (1 - leaving);
  const sealed = t >= HOLD_AT + HOLD_TIME && t < BENCH_RESET ? 1 : 0;
  const sweep = (t - SWEEP_AT) / SWEEP_TIME;
  // The scanner crosses at an even pace, rests at the far end, and goes back as the bench resets.
  const scan = clamp01(sweep) * (1 - leaving);
  const beam = smooth(sweep / 0.06) * (1 - smooth((sweep - 0.97) / 0.06));
  // A duplicate pops up as the scanner reaches its row.
  const twins = TWINS.map((row) => pop((t - SWEEP_AT - ((row + 0.5) / SWEPT) * SWEEP_TIME) / POP_TIME) * (1 - leaving));
  const written = [
    Math.max(0, Math.floor((t - HOLD_AT - 0.2) * TYPE_RATE)),
    Math.max(0, Math.floor((t - SWEEP_AT - 0.5) * TYPE_RATE)),
  ].map((n, i) => (t >= BENCH_RESET ? 0 : Math.min(n, SHEET.lines[i][1].length)));
  return { key, rows, held, sealed, scan, beam, twins, written, sheet: smooth((t - 0.2) / 0.4) * (1 - leaving) };
}

/** The bench as it stands once everything is done: the still picture for reduced motion. */
export function benchDone(): BenchView {
  return benchAt(BENCH_RESET - 0.01);
}
