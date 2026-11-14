// The hero scene's choreography, as pure functions of time in seconds. scene.ts draws what these return; nothing
// here touches three.js or the DOM, so the loop is tested in test/landing.test.ts.
//
// One pass visits the five nodes in order (the task, the three steps, the verdict), a HOP apart. A new pass starts
// every LOOP seconds, which is shorter than a pass, so the next task leaves while the last verdict is still landing.
//
// A node "fires" at its own time zero. Before that it presses down; at zero its floor ripple starts, its outgoing
// line draws on, and a step's icon disc is tossed like a coin; a moment later the line's label stands up.

import { easeInOutCubic, easeOutCubic, easeOutQuad, smooth } from "./ease";

/** Seconds between two passes. */
export const LOOP = 5.63;
/** Seconds between one node firing and the next. */
export const HOP = 1.65;
/** Node 0 is the task, 1 to 3 are the steps, 4 is the verdict. */
export const NODES = 5;
/** Path k runs from node k to node k + 1. */
export const PATHS = 4;

/** A node starts to press down this long before it fires. */
export const PRESS_LEAD = 0.55;
const PRESS_HOLD = 0.45;
const PRESS_RELEASE = 0.52;

/** A step's disc is in the air this long, turns once, and peaks this high (world units). */
export const TOSS_TIME = 0.96;
export const TOSS_HEIGHT = 0.6;

/** How long a node's floor ripple lasts. */
export const WAVE_LIFE = 2.4;

const DRAW_DELAY = 0.1;
const DRAW_TIME = 0.65;
const FADE_TIME = 1.6;
/** How long each path stays dark before it fades. The last two fade together, early in the next pass. */
const GLOW_HOLD = [3.3, 3.3, 2.73, 1.1] as const;

const RISE_AT = 0.27;
const RISE_TIME = 0.52;
const FALL_AT = 1.93;
const FALL_TIME = 0.6;
const LETTERS_IN = 0.57;
const LETTERS_OUT = 2.31;

// The task and verdict discs swap their icon while pressed: out as the press lands, in as it lets go.
const SWAP_OUT = 0.26;
const SWAP_IN_AT = 0.5;
const SWAP_IN = 0.42;

export interface NodeClock {
  /** Seconds since the node last fired; negative while it presses down before firing; -Infinity before its first press. */
  tau: number;
  /** How many times it has fired. */
  fired: number;
}

/** Node `k`'s own clock at scene time `t`. Passes that would have started before t = 0 never happened. */
export function nodeClock(t: number, k: number): NodeClock {
  const pass = Math.floor((t - k * HOP + PRESS_LEAD) / LOOP);
  if (pass < 0) return { tau: -Infinity, fired: 0 };
  const tau = t - k * HOP - pass * LOOP;
  return { tau, fired: tau >= 0 ? pass + 1 : pass };
}

/** How far a node is pressed, 0 to 1: a slow start into the press, a hold, then a quick spring back. */
export function press(tau: number): number {
  if (tau <= -PRESS_LEAD || tau >= PRESS_HOLD + PRESS_RELEASE) return 0;
  if (tau < 0) return (1 - Math.cos(Math.PI * Math.pow((tau + PRESS_LEAD) / PRESS_LEAD, 1.5))) / 2;
  if (tau <= PRESS_HOLD) return 1;
  return 1 - easeOutCubic((tau - PRESS_HOLD) / PRESS_RELEASE);
}

/** The coin toss of a step's disc: how high it is and how far it has turned (one full turn, 0 to 2π). */
export function toss(tau: number): { lift: number; turn: number } {
  if (tau <= 0 || tau >= TOSS_TIME) return { lift: 0, turn: 0 };
  const u = tau / TOSS_TIME;
  return { lift: TOSS_HEIGHT * 4 * u * (1 - u), turn: 2 * Math.PI * u };
}

/** The ripple's age in seconds, or -1 when the floor is still. */
export function wave(tau: number): number {
  return tau >= 0 && tau < WAVE_LIFE ? tau : -1;
}

/** How visible the task's or verdict's icon is, 0 to 1. It is hidden at tau = 0, which is when the next one is put in. */
export function swap(tau: number): number {
  if (tau <= -SWAP_OUT) return 1;
  if (tau < 0) return 1 - smooth((tau + SWAP_OUT) / SWAP_OUT);
  return smooth((tau - SWAP_IN_AT) / SWAP_IN);
}

/** Path `k` at its source node's `tau`: how much of it is drawn dark (0 to 1 from the source) and how dark it is. */
export function pathAt(tau: number, k: number): { draw: number; glow: number } {
  const hold = GLOW_HOLD[k] ?? GLOW_HOLD[0];
  if (tau < DRAW_DELAY || tau >= hold + FADE_TIME) return { draw: 0, glow: 0 };
  return { draw: smooth((tau - DRAW_DELAY) / DRAW_TIME), glow: 1 - smooth((tau - hold) / FADE_TIME) };
}

/** How far a label stands up, 0 flat on the floor to 1 upright. */
export function bannerUp(tau: number): number {
  if (tau <= RISE_AT || tau >= FALL_AT + FALL_TIME) return 0;
  if (tau < FALL_AT) return easeOutCubic((tau - RISE_AT) / RISE_TIME);
  return 1 - easeInOutCubic((tau - FALL_AT) / FALL_TIME);
}

/** The opacity of letter `i` of an `n` letter label. Letters come in left to right, each a little slower than the
 *  last, and leave together. scene.ts blurs a letter by how far it is from opaque. */
export function bannerLetter(tau: number, i: number, n: number): number {
  const s = n > 1 ? i / (n - 1) : 0;
  const inStart = LETTERS_IN + 0.05 * s;
  const shown = easeOutQuad((tau - inStart) / (0.1 + 0.22 * s));
  const outStart = LETTERS_OUT - 0.09 - 0.11 * s;
  const gone = smooth((tau - outStart) / (LETTERS_OUT - outStart));
  return Math.min(shown, 1 - gone);
}

export interface NodeState {
  /** 0 at rest, 1 pressed all the way down. */
  press: number;
  /** A step's disc: height above its seat in world units, and its turn in radians. Zero for the task and verdict. */
  lift: number;
  turn: number;
  /** The floor ripple's age in seconds, or -1. */
  wave: number;
  /** How many times the node has fired: which icon the task and the verdict show. */
  fired: number;
  /** The task's and verdict's icon opacity. Always 1 for a step. */
  icon: number;
}

export interface PathState {
  draw: number;
  glow: number;
}

export interface BannerState {
  up: number;
  /** The source node's tau, for `bannerLetter`. */
  tau: number;
}

export interface Frame {
  nodes: NodeState[];
  paths: PathState[];
  banners: BannerState[];
}

export function createFrame(): Frame {
  return {
    nodes: Array.from({ length: NODES }, () => ({ press: 0, lift: 0, turn: 0, wave: -1, fired: 0, icon: 1 })),
    paths: Array.from({ length: PATHS }, () => ({ draw: 0, glow: 0 })),
    banners: Array.from({ length: PATHS }, () => ({ up: 0, tau: -Infinity })),
  };
}

const isStep = (k: number): boolean => k > 0 && k < NODES - 1;

/** Everything the scene needs at time `t`, written into `out` so the render loop allocates nothing. */
export function frameAt(t: number, out: Frame = createFrame()): Frame {
  for (let k = 0; k < NODES; k++) {
    const { tau, fired } = nodeClock(t, k);
    const node = out.nodes[k];
    node.press = press(tau);
    node.wave = wave(tau);
    node.fired = fired;
    if (isStep(k)) {
      const { lift, turn } = toss(tau);
      node.lift = lift;
      node.turn = turn;
      node.icon = 1;
    } else {
      node.lift = 0;
      node.turn = 0;
      node.icon = swap(tau);
    }
    if (k < PATHS) {
      const path = pathAt(tau, k);
      out.paths[k].draw = path.draw;
      out.paths[k].glow = path.glow;
      out.banners[k].up = bannerUp(tau);
      out.banners[k].tau = tau;
    }
  }
  return out;
}

/** The still picture shown instead of the loop under reduced motion: the whole diagram, every label standing. */
export function posterFrame(out: Frame = createFrame()): Frame {
  for (const node of out.nodes) { node.press = 0; node.lift = 0; node.turn = 0; node.wave = -1; node.fired = 0; node.icon = 1; }
  for (const path of out.paths) { path.draw = 1; path.glow = 1; }
  for (const banner of out.banners) { banner.up = 1; banner.tau = 1.4; }
  return out;
}
