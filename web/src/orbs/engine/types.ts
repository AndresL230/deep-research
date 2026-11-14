// Ported from Trov (~/Projects/trov/web/src/orbs/engine/types.ts) — thinking-orbs engine by Jakub Antalik, MIT (./LICENSE in src/orbs).
// Engine-level contracts shared by every mode implementation.

import type { ModeOpts } from './profiles';

export type { Dot } from './core';

/** One frame painter: draws a mode into a 2D context at CSS-px `size`. */
export type ModeDraw = (
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  dark: boolean,
  opts: ModeOpts
) => void;
