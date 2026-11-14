// The flat things the devices under the hero show, painted on 2D canvases that devices.ts maps onto them: the
// terminal's screen, the ticket it prints, the sheet behind the data bench, and the small captions on lights and
// keys. One unit in the scene is `PX` canvas pixels here, so sizes below read like the scene's: 0.13 is the
// terminal's type, a little over an eighth of a unit tall.

import type { BenchView } from "./bench";
import { SHEET } from "./bench";
import type { Line, Span, TerminalView } from "./terminal";

/** Canvas pixels per scene unit. */
export const PX = 300;

export interface ScreenColors {
  screen: string;
  scan: string;
  ink: string;
  dim: string;
  accent: string;
  chip: string;
}

export interface Fonts {
  /** The page's type and its monospace, as CSS font families. */
  label: string;
  code: string;
}

const round = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

// ── the terminal ─────────────────────────────────────────────────────────────

/** The screen's size in scene units, and the type on it. */
export const SCREEN = { width: 4.88, height: 3, corner: 0.16, pad: 0.24, title: 0.108, type: 0.13, leading: 0.243, head: 0.56 } as const;

/** How many lines of the terminal fit under the title. */
export const SCREEN_LINES = Math.floor((SCREEN.height - SCREEN.head - SCREEN.pad * 0.6) / SCREEN.leading);

/** Paint the terminal's screen. `seconds` only turns the spinner and blinks the caret. When there are more lines
 *  than fit, the oldest scroll off the top. */
export function paintTerminal(ctx: CanvasRenderingContext2D, view: TerminalView, colors: ScreenColors, fonts: Fonts, seconds: number): void {
  const W = SCREEN.width * PX;
  const H = SCREEN.height * PX;
  const pad = SCREEN.pad * PX;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  round(ctx, 0, 0, W, H, SCREEN.corner * PX);
  ctx.clip();
  ctx.fillStyle = colors.screen;
  ctx.fillRect(0, 0, W, H);
  // The faint lines of a screen.
  ctx.fillStyle = colors.scan;
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);

  // The title: a dot and the name of what the screen is showing.
  const titleY = 0.3 * PX;
  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.arc(pad + 0.03 * PX, titleY, 0.026 * PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 ${SCREEN.title * PX}px ${fonts.label}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = colors.dim;
  ctx.fillText(view.title, pad + 0.11 * PX, titleY + 1);

  const type = SCREEN.type * PX;
  ctx.font = `400 ${type}px ${fonts.code}`;
  const ch = ctx.measureText("0").width;
  const leading = SCREEN.leading * PX;
  const lines = view.lines.slice(Math.max(0, view.lines.length - SCREEN_LINES));
  const tint = (span: Span): string => (span.tint === "ink" ? colors.ink : span.tint === "dim" ? colors.dim : colors.accent);

  lines.forEach((line: Line, row) => {
    const y = SCREEN.head * PX + row * leading + leading / 2;
    // The mark sits in its own two characters; the words start after it.
    const mx = pad + ch / 2;
    if (line.mark === "$" || line.mark === ">") {
      ctx.fillStyle = line.mark === "$" ? colors.dim : colors.accent;
      ctx.fillText(line.mark, pad, y);
    } else if (line.mark === "tick") {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = type * 0.11;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(mx - type * 0.26, y + type * 0.02);
      ctx.lineTo(mx - type * 0.06, y + type * 0.22);
      ctx.lineTo(mx + type * 0.3, y - type * 0.2);
      ctx.stroke();
    } else if (line.mark === "spin") {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = type * 0.1;
      ctx.lineCap = "round";
      const turn = seconds * 5;
      ctx.beginPath();
      ctx.arc(mx, y, type * 0.26, turn, turn + Math.PI * 1.35);
      ctx.stroke();
    }
    let x = pad + ch * 2;
    for (const span of line.spans) {
      const width = ctx.measureText(span.text).width;
      if (span.chip) {
        ctx.fillStyle = colors.chip;
        round(ctx, x - type * 0.36, y - type * 0.78, width + type * 0.72, type * 1.5, type * 0.75);
        ctx.fill();
      }
      ctx.fillStyle = tint(span);
      ctx.fillText(span.text, x, y);
      x += width;
    }
    if (line.caret && seconds % 1 < 0.6) {
      ctx.fillStyle = colors.ink;
      ctx.fillRect(x + ch * 0.12, y - type * 0.58, ch * 0.9, type * 1.14);
    }
  });
  ctx.restore();
}

// ── captions ─────────────────────────────────────────────────────────────────

/** Paint a caption in white, centred on a canvas of `width` by `height` pixels. The scene tints it by multiplying,
 *  so one painting serves a light that is off and one that is lit. `size` is the type's height in pixels. */
export function paintCaption(ctx: CanvasRenderingContext2D, width: number, height: number, text: string, size: number, font: string): void {
  ctx.clearRect(0, 0, width, height);
  ctx.font = `500 ${size}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, width / 2, height / 2 + size * 0.04);
}

// ── the ticket ───────────────────────────────────────────────────────────────

/** The ticket's size in scene units. */
export const TICKET = { width: 1.5, height: 1 } as const;

export interface PaperColors {
  bar: string;
  ink: string;
  dim: string;
}

/** Paint what is printed on the ticket: a short bar, a title, and a line under it. The paper itself is the mesh. */
export function paintTicket(ctx: CanvasRenderingContext2D, lines: readonly [string, string], colors: PaperColors, font: string): void {
  const W = TICKET.width * PX;
  const H = TICKET.height * PX;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = colors.bar;
  round(ctx, 0.12 * PX, 0.18 * PX, 0.44 * PX, 0.04 * PX, 0.02 * PX);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.ink;
  ctx.font = `600 ${0.086 * PX}px ${font}`;
  ctx.fillText(lines[0], 0.12 * PX, 0.4 * PX);
  ctx.fillStyle = colors.dim;
  ctx.font = `400 ${0.07 * PX}px ${font}`;
  ctx.fillText(lines[1], 0.12 * PX, 0.53 * PX);
}

// ── the sheet behind the data bench ──────────────────────────────────────────

/** The sheet's size in scene units. */
export const SHEET_SIZE = { width: 3.1, height: 1.9 } as const;

export interface SheetColors {
  ink: string;
  dim: string;
  accent: string;
  chip: string;
}

/** Paint the sheet: the file and its shape, then the lines written so far, each with its caret while it is being
 *  written. The glass itself is the mesh. */
export function paintSheet(ctx: CanvasRenderingContext2D, view: BenchView, colors: SheetColors, fonts: Fonts, seconds: number): void {
  const W = SHEET_SIZE.width * PX;
  const H = SHEET_SIZE.height * PX;
  ctx.clearRect(0, 0, W, H);
  if (view.sheet <= 0.01) return;
  ctx.globalAlpha = view.sheet;
  const left = 0.3 * PX;

  // The file: a small table mark on a chip, its name, and its shape.
  ctx.fillStyle = colors.chip;
  round(ctx, left, 0.26 * PX, 0.36 * PX, 0.36 * PX, 0.08 * PX);
  ctx.fill();
  ctx.fillStyle = colors.accent;
  for (const [x, y, w] of [[0.07, 0.08, 0.22], [0.07, 0.155, 0.1], [0.19, 0.155, 0.1], [0.07, 0.23, 0.1], [0.19, 0.23, 0.1]]) {
    round(ctx, left + x * PX, 0.26 * PX + y * PX, w * PX, 0.05 * PX, 0.012 * PX);
    ctx.fill();
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.ink;
  ctx.font = `600 ${0.15 * PX}px ${fonts.label}`;
  ctx.fillText(SHEET.file, left + 0.48 * PX, 0.42 * PX);
  ctx.fillStyle = colors.dim;
  ctx.font = `400 ${0.105 * PX}px ${fonts.label}`;
  ctx.fillText(SHEET.shape, left + 0.48 * PX, 0.58 * PX);

  SHEET.lines.forEach(([name, text], i) => {
    const shown = view.written[i] ?? 0;
    if (shown <= 0) return;
    const y = (0.98 + i * 0.3) * PX;
    ctx.font = `600 ${0.1 * PX}px ${fonts.label}`;
    ctx.fillStyle = colors.accent;
    ctx.fillText(name, left, y);
    ctx.font = `400 ${0.125 * PX}px ${fonts.label}`;
    ctx.fillStyle = colors.ink;
    const x = left + 0.62 * PX;
    const part = text.slice(0, shown);
    ctx.fillText(part, x, y);
    if (shown < text.length && seconds % 0.8 < 0.5) {
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x + ctx.measureText(part).width + 4, y - 0.11 * PX, 0.012 * PX, 0.14 * PX);
    }
  });
  ctx.globalAlpha = 1;
}
