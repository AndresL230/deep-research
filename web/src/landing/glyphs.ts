// What the hero scene paints on a 2D canvas and maps onto the 3D scene: the icons on the discs and the words on the
// labels. The icons are this project's own, drawn on a 24 unit grid like the app's icon set (ask-icons.ts).

/** One stroke or fill of an icon. `d` is an SVG path on the 24 unit grid. A colour is a CSS colour, or `INK` or
 *  `DISC` for the two that depend on the scene's palette. */
export interface GlyphOp {
  d: string;
  fill?: string;
  stroke?: string;
  width?: number;
}
export type Glyph = GlyphOp[];

/** The scene's own colours an icon can ask for: the line colour of a step's icon, and the disc it is drawn on. */
export interface GlyphColors {
  ink: string;
  disc: string;
}

const ring = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const bar = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

const INK = "ink";
const DISC = "disc";
const BLUE = "#5f8dff";
const CORAL = "#ff7a59";
const VIOLET = "#9d8cff";
// The pads' purple (scene.ts PALETTES `portRing`), lightened so it reads on the dark disc.
const PURPLE = "#9aa4df";
const AMBER = "#ffb224";

/** The three steps, in the order the scene visits them: run the agents, find the split, fork the VM. */
export const STEP_GLYPHS: Glyph[] = [
  [{ d: "M8.4 5.4 18.9 12 8.4 18.6z", stroke: INK, width: 1.9 }],
  [{ d: ring(10.8, 10.8, 6.3), stroke: INK, width: 1.9 }, { d: "M15.6 15.6l4.6 4.6", stroke: INK, width: 1.9 }],
  [
    { d: ring(6.5, 5.6, 2.3), stroke: INK, width: 1.9 },
    { d: ring(17.5, 5.6, 2.3), stroke: INK, width: 1.9 },
    { d: ring(12, 18.4, 2.3), stroke: INK, width: 1.9 },
    { d: "M6.5 7.9v1.6a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V7.9M12 12.5v3.6", stroke: INK, width: 1.9 },
  ],
];

/** The task's disc cycles through kinds of data: a table, a chart, a scatter of points. */
export const TASK_GLYPHS: Glyph[] = [
  [
    { d: bar(3, 4.4, 18, 4.4, 1.3), fill: BLUE },
    { d: bar(3, 10.3, 8.3, 4, 1.3), fill: BLUE },
    { d: bar(12.7, 10.3, 8.3, 4, 1.3), fill: BLUE },
    { d: bar(3, 15.8, 8.3, 4, 1.3), fill: BLUE },
    { d: bar(12.7, 15.8, 8.3, 4, 1.3), fill: BLUE },
  ],
  [
    { d: bar(3.6, 12, 4.4, 8.2, 1.4), fill: CORAL },
    { d: bar(9.8, 7.4, 4.4, 12.8, 1.4), fill: CORAL },
    { d: bar(16, 3.8, 4.4, 16.4, 1.4), fill: CORAL },
  ],
  [
    { d: ring(6.2, 17, 2.2), fill: VIOLET },
    { d: ring(10.8, 11.2, 2.6), fill: VIOLET },
    { d: ring(16.4, 14.6, 1.9), fill: VIOLET },
    { d: ring(17.4, 6.8, 2.8), fill: VIOLET },
    { d: ring(6.8, 7.2, 1.7), fill: VIOLET },
  ],
];

/** The verdict's disc cycles through what a verdict can say: the cause is proven, a score was inflated, the step is found. */
export const VERDICT_GLYPHS: Glyph[] = [
  [{ d: "M4.8 12.9l4.7 4.7L19.4 7.1", stroke: PURPLE, width: 3.3 }],
  [
    { d: "M12 3.3a1.6 1.6 0 0 1 1.4.8l8.1 14.2a1.6 1.6 0 0 1-1.4 2.4H3.9a1.6 1.6 0 0 1-1.4-2.4l8.1-14.2a1.6 1.6 0 0 1 1.4-.8z", fill: AMBER },
    { d: "M12 9.4v4.6", stroke: DISC, width: 2.3 },
    { d: ring(12, 17.3, 1.25), fill: DISC },
  ],
  [
    { d: ring(12, 12, 8.4), stroke: BLUE, width: 2.3 },
    { d: ring(12, 12, 4.3), stroke: BLUE, width: 2.3 },
    { d: ring(12, 12, 1.5), fill: BLUE },
  ],
];

/** Paint `glyph` to fill a `size` pixel square at the canvas origin. */
export function paintGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, size: number, colors: GlyphColors): void {
  const colour = (c: string): string => (c === INK ? colors.ink : c === DISC ? colors.disc : c);
  ctx.save();
  ctx.scale(size / 24, size / 24);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const op of glyph) {
    const path = new Path2D(op.d);
    if (op.fill) { ctx.fillStyle = colour(op.fill); ctx.fill(path); }
    if (op.stroke) { ctx.strokeStyle = colour(op.stroke); ctx.lineWidth = op.width ?? 1.9; ctx.stroke(path); }
  }
  ctx.restore();
}

// ── labels ───────────────────────────────────────────────────────────────────

/** Canvas pixels per world unit on a label: a label is 0.48 tall and its words 0.16, so 240 and 80 pixels. */
export const LABEL_PX = 500;
/** A label's height, its side padding and its type size, in world units (48, 22 and 16 CSS pixels at 1/100). */
export const LABEL_HEIGHT = 0.48;
export const LABEL_PAD = 0.22;
export const LABEL_TYPE = 0.16;

export interface LabelLayout {
  text: string;
  font: string;
  /** Each letter's left edge, in canvas pixels. */
  xs: number[];
  /** The label's whole width (the words plus padding) and height, in canvas pixels. */
  width: number;
  height: number;
}

/** Measure `text` in `family` and lay its letters out, each where the whole word would put it (kerning kept). */
export function layoutLabel(ctx: CanvasRenderingContext2D, text: string, family: string): LabelLayout {
  const font = `500 ${LABEL_TYPE * LABEL_PX}px ${family}`;
  ctx.font = font;
  const pad = LABEL_PAD * LABEL_PX;
  const xs = Array.from(text, (_, i) => pad + ctx.measureText(text.slice(0, i)).width);
  return { text, font, xs, width: Math.ceil(ctx.measureText(text).width + 2 * pad), height: LABEL_HEIGHT * LABEL_PX };
}

/** Paint a label's words in `ink` (an "r, g, b" triple), letter `i` at `opacity(i)`. A letter that is not fully
 *  there is blurred by how much of it is missing. The blur is the letter's own shadow, cast from off the canvas,
 *  since a canvas filter is not available everywhere. */
export function paintLabel(ctx: CanvasRenderingContext2D, layout: LabelLayout, ink: string, opacity: (i: number) => number): void {
  const { width, height, text, font, xs } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const y = height / 2 + LABEL_TYPE * LABEL_PX * 0.04;
  const away = width + 400;
  for (let i = 0; i < text.length; i++) {
    const o = opacity(i);
    if (o <= 0.004 || text[i] === " ") continue;
    if (o >= 0.996) {
      ctx.fillStyle = `rgb(${ink})`;
      ctx.fillText(text[i], xs[i], y);
      continue;
    }
    ctx.save();
    ctx.shadowColor = `rgba(${ink}, ${o.toFixed(3)})`;
    // 0.375em of blur at nothing, none at full: shadowBlur is twice the blur's standard deviation.
    ctx.shadowBlur = 2 * (1 - o) * 0.375 * LABEL_TYPE * LABEL_PX;
    ctx.shadowOffsetX = away;
    ctx.fillStyle = "#000";
    ctx.fillText(text[i], xs[i] - away, y);
    ctx.restore();
  }
}
