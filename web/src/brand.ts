/** Orro's logo: the Fault symbol and the wordmark, as outlines (no font), so they are the same at every size.
 *
 *  The symbol: a run's steps drawn as three bars, broken by a 60° fault where the far side slipped exactly one layer.
 *  A fault is an error; one layer is an off-by-one; three bars cut by a slash read as ≢, not identical. On a 256 grid:
 *  bars 44.6 high, gaps 15.9 (between bars and at the fault), the slip one pitch (60.5) along the fault. At 24 px and
 *  below the small cut is used: its gaps are wider so they stay open.
 *  The wordmark: drawn from scratch, x-height 100 units: squarish o's with thinner tops and bottoms, and a small spur
 *  where each r's arm leaves its stem.
 *  In a lockup the symbol is about 1.6 times the word's height and the gap is 0.41 x-height (one bar), the word centred on it.
 *  Everything takes its colour from `currentColor`. The full kit and guidelines: ~/Desktop/orro-identity-kit. */
import "./brand.css";

const FAULT = "M202.43 15.00L223.44 15.00L223.44 59.56L176.70 59.56ZM32.56 120.04L32.56 75.48L149.13 75.48L123.41 120.04ZM223.44 120.04L141.78 120.04L167.51 75.48L223.44 75.48ZM32.56 180.52L32.56 135.96L114.22 135.96L88.49 180.52ZM223.44 180.52L106.87 180.52L132.59 135.96L223.44 135.96ZM53.57 241.00L32.56 241.00L32.56 196.44L79.30 196.44Z";
const FAULT_BOX = "32.56 15.00 190.88 226.00";
const FAULT_SMALL = "M206.45 12.00L227.38 12.00L227.38 55.09L181.58 55.09ZM28.62 118.06L28.62 74.97L147.14 74.97L122.26 118.06ZM227.38 118.06L145.22 118.06L170.10 74.97L227.38 74.97ZM28.62 181.03L28.62 137.94L110.78 137.94L85.90 181.03ZM227.38 181.03L108.86 181.03L133.74 137.94L227.38 137.94ZM49.55 244.00L28.62 244.00L28.62 200.91L74.42 200.91Z";
const FAULT_SMALL_BOX = "28.62 12.00 198.76 232.00";
const WORD = "M50.00 -1.50C81.00 -1.50 100.00 18.07 100.00 50.00C100.00 81.93 81.00 101.50 50.00 101.50C19.00 101.50 0.00 81.93 0.00 50.00C0.00 18.07 19.00 -1.50 50.00 -1.50ZM50.00 18.00C67.36 18.00 78.00 30.16 78.00 50.00C78.00 69.84 67.36 82.00 50.00 82.00C32.64 82.00 22.00 69.84 22.00 50.00C22.00 30.16 32.64 18.00 50.00 18.00ZM112 100V0H134V12C139 3 147 -1.5 158 -1.5H172V18H160C145 18 134 27 134 44V100ZM180 100V0H202V12C207 3 215 -1.5 226 -1.5H240V18H228C213 18 202 27 202 44V100ZM294.00 -1.50C325.00 -1.50 344.00 18.07 344.00 50.00C344.00 81.93 325.00 101.50 294.00 101.50C263.00 101.50 244.00 81.93 244.00 50.00C244.00 18.07 263.00 -1.50 294.00 -1.50ZM294.00 18.00C311.36 18.00 322.00 30.16 322.00 50.00C322.00 69.84 311.36 82.00 294.00 82.00C276.64 82.00 266.00 69.84 266.00 50.00C266.00 30.16 276.64 18.00 294.00 18.00Z";
/** The wordmark's box: 344 wide, the x-height of 100 plus 1.5 of overshoot on the round letters, top and bottom. */
const WORD_BOX = "0 -1.5 344 103";
/** Width over height of the symbol's box. */
const FAULT_RATIO = 0.8446;

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The wordmark, its x-height `height` px (the box adds the overshoot). */
export function wordmark(height: number, cls = ""): string {
  return `<svg class="brand-word${cls ? ` ${cls}` : ""}" viewBox="${WORD_BOX}" width="${r2(height * 3.44)}" height="${r2(height * 1.03)}" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="${WORD}"/></svg>`;
}

/** The symbol on its own, `height` px tall, cropped to the mark (for lockups beside the wordmark). */
export function mark(height: number, cls = ""): string {
  const small = height <= 24;
  return `<svg class="brand-mark${cls ? ` ${cls}` : ""}" viewBox="${small ? FAULT_SMALL_BOX : FAULT_BOX}" width="${r2(height * FAULT_RATIO)}" height="${height}" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="${small ? FAULT_SMALL : FAULT}"/></svg>`;
}

/** The symbol in a `size` px square (the 256 grid, with its margins), for icons. */
export function symbol(size: number): string {
  const small = size <= 24;
  return `<svg class="brand-sym" viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="${small ? FAULT_SMALL : FAULT}"/></svg>`;
}

/** The symbol on its tile, `size` px square: the small marks inside buttons, pills and chips. */
export function symbolTile(size: number, cls = ""): string {
  return `<span class="brand-tile${cls ? ` ${cls}` : ""}" style="--brand-tile:${size}px">${symbol(Math.round(size * 0.78))}</span>`;
}

/** The horizontal lockup at x-height `xh` px: symbol about 1.6 times the word's height, a one-bar gap, then the word. */
export function logo(xh: number, cls = ""): string {
  return `<span class="brand-lock${cls ? ` ${cls}` : ""}" style="--xh:${xh}px">${mark(r2(xh * 1.63))}${wordmark(xh)}</span>`;
}
