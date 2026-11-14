// The fork page's three small charts, as SVG strings (pure, like every view): the paired score after each pair, the
// source run's actions with the fork point on them, and the forced check's positions on the table.
//
// Each one scales by its viewBox at width 100% and draws only with currentColor and the classes lanes.css colours
// from the design tokens, so it reads in both themes. Each wrapper's data-morph-key carries the data it was drawn
// from: morph patches a chart whose key is the same and replaces one whose data changed, so a redrawn chart is a new
// element and its line draws in again instead of being bent into the new shape.

import { attr, esc } from "../ui";

/** One position of the forced check, as forkread.forcedCheck reads it from the forced step's output. */
export interface CheckPoint { x: number; y: number; ok: boolean; cm: number }

/** "13.03"; a score under 0.01 keeps two significant figures, so 0.0001 does not read as zero. */
const score2 = (v: number): string => (v >= 0.01 ? v.toFixed(2) : String(Number(v.toPrecision(2))));

// ── the paired score after each pair ─────────────────────────────────────────

const LOG_LO = -2;
const LOG_HI = 2;
const EV = { w: 400, h: 128, l: 38, r: 10, t: 14, b: 22 };

/**
 * The score after each complete pair, as steps on a log scale from 0.01 to 100. It starts at 1 before any pair, so
 * `trace` is the score after pair 1, 2, ... and `agrees[i]` says whether pair i+1 went the predicted way (its dot is
 * --ok, else --bad). A solid rule at 20 is where the evidence counts as supported; the dashed one at 1 is where it
 * started. Values below 0.01 sit on the floor. No trace, no chart: the caller says it is waiting for the first pair.
 *
 * `total` is how many pairs the experiment has room for: the x axis runs over all of them, so a new pair adds a step
 * without moving the ones drawn before it. Each step is its own path, keyed by its pair and value, so when a pair
 * lands only its step draws in and only its dot arrives. `id` keys the chart to its experiment.
 *
 * The axis words are HTML laid over the drawing, not SVG text: SVG text scales with the chart, and these must stay
 * a readable 11px at phone width.
 */
export function scoreStep(trace: number[], agrees: boolean[], opts: { total?: number; id?: string } = {}): string {
  if (!trace.length) return "";
  const slots = Math.max(trace.length, Math.round(opts.total ?? 0));
  const yOf = (v: number): number => {
    const lg = Math.min(LOG_HI, Math.max(LOG_LO, Math.log10(Math.max(v, 1e-12))));
    return EV.t + ((LOG_HI - lg) / (LOG_HI - LOG_LO)) * (EV.h - EV.t - EV.b);
  };
  const xOf = (i: number): number => EV.l + (i / slots) * (EV.w - EV.l - EV.r);
  const f = (v: number): string => v.toFixed(1);
  // Where a point of the drawing sits on the wrapper, in percent, for the HTML labels over it.
  const px = (x: number): string => `${((x / EV.w) * 100).toFixed(2)}%`;
  const py = (y: number): string => `${((y / EV.h) * 100).toFixed(2)}%`;
  const rule = (v: number, cls: string): string =>
    `<line class="ln-evc-rule ${cls}" x1="${EV.l}" x2="${EV.w - EV.r}" y1="${f(yOf(v))}" y2="${f(yOf(v))}"></line>`;
  const yLabel = (v: number, text: string, cls = ""): string =>
    `<span class="ln-evc-ax ln-evc-ax--y${cls}" aria-hidden="true" style="left:${px(EV.l - 7)};top:${py(yOf(v))}">${esc(text)}</span>`;
  let prev = 1;
  const steps = trace.map((v, i) => {
    const ok = agrees[i] === true;
    const d = `M${f(xOf(i))} ${f(yOf(prev))}H${f(xOf(i + 1))}V${f(yOf(v))}`;
    prev = v;
    return `<g data-morph-key="${attr(`pair:${i + 1}:${v}:${ok ? 1 : 0}`)}" style="--i:${i}">`
      + `<path class="ln-evc-line ds-draw" pathLength="1" d="${d}"></path>`
      + `<circle class="ln-evc-dot ln-evc-dot--${ok ? "ok" : "bad"}" cx="${f(xOf(i + 1))}" cy="${f(yOf(v))}" r="3.6">`
      + `<title>${esc(`pair ${i + 1}: ${ok ? "agrees x1.9" : "disagrees x0.1"}, score ${score2(v)}`)}</title></circle></g>`;
  }).join("");
  const xLabels = Array.from({ length: slots }, (_, i) =>
    `<span class="ln-evc-ax ln-evc-ax--x${i < trace.length ? "" : " ln-evc-ax--todo"}" style="left:${px(xOf(i + 1))}">${i + 1}</span>`).join("");
  const last = trace[trace.length - 1];
  const label = `Paired score after ${trace.length} ${trace.length === 1 ? "pair" : "pairs"}: ${score2(last)} of the 20 needed for supported. `
    + `Step by step: ${trace.map(score2).join(", ")}.`;
  const key = `ev-chart:${opts.id ?? ""}:${slots}`;
  return `<div class="ln-ev-chart" data-morph-key="${attr(key)}">`
    + `<svg class="ln-evc-svg" viewBox="0 0 ${EV.w} ${EV.h}" width="100%" role="img" aria-label="${attr(label)}">`
    + rule(20, "ln-evc-rule--hi") + rule(1, "ln-evc-rule--one") + rule(0.01, "ln-evc-rule--edge")
    + `<g data-morph-list>${steps}</g></svg>`
    + `<span class="ln-evc-ax ln-evc-ax--hi" aria-hidden="true" style="right:${px(EV.r)};top:${py(yOf(20))}">supported</span>`
    + yLabel(20, "20", " ln-evc-ax--hi") + yLabel(1, "1") + yLabel(0.01, "0.01")
    + `<div class="ln-evc-xs" aria-hidden="true">${xLabels}</div></div>`;
}

// ── the fork point on the source run ─────────────────────────────────────────

const SRC = { w: 360, h: 24, gap: 4 };

/**
 * One tick per action of the source run, labelled by `ticks` (an empty label reads "no label"). The first `forkAt`
 * are solid, because every copy inherits them; the rest are faded, because they are what the source run did next
 * and the copies did not. The marker sits at the cut. It is HTML over the SVG so it can carry ds-beam while the base
 * VM is still replaying, and so its word does not grow with the strip.
 */
export function sourceStrip(ticks: string[], forkAt: number, opts: { src?: string; rebuilding?: boolean } = {}): string {
  const n = ticks.length;
  if (!n) return "";
  const at = Math.max(0, Math.min(n, Math.round(forkAt)));
  const slot = SRC.w / n;
  const bars = ticks.map((raw, i) => {
    const label = raw.trim() || "no label";
    const cls = i < at ? "ln-src-tick" : "ln-src-tick ln-src-tick--next";
    return `<g class="${cls}"><title>${esc(`action ${i + 1}: ${label}`)}</title>`
      + `<rect x="${(i * slot + SRC.gap / 2).toFixed(1)}" y="0" width="${(slot - SRC.gap).toFixed(1)}" height="${SRC.h}" ></rect></g>`;
  }).join("");
  const src = opts.src || "the run";
  const caps = at >= n
    ? `<span style="flex:1">forked after everything the run did</span>`
    : (at > 0 ? `<span style="flex:${at}">inherited by every copy</span>` : "")
      + `<span class="ln-src-cap-next">${esc(`what ${src} did next`)}</span>`;
  const next = at < n ? `, before ${ticks[at].trim() || "an action with no label"}` : "";
  const label = `The source run's ${n} actions. The copies were forked after action ${at}${next}.`;
  const key = `src-strip:${at}:${opts.rebuilding ? 1 : 0}:${ticks.join("|")}`;
  return `<div class="ln-src-strip" data-morph-key="${attr(key)}">`
    + `<div class="ln-src-track"><svg class="ln-src-svg" viewBox="0 0 ${SRC.w} ${SRC.h}" width="100%" preserveAspectRatio="none" role="img" aria-label="${attr(label)}">${bars}</svg>`
    + `<i class="ln-src-mark${at * 4 >= n * 3 ? " ln-src-mark--end" : ""}${opts.rebuilding ? " ds-beam" : ""}" style="left:${((at / n) * 100).toFixed(2)}%" aria-hidden="true"><b>fork</b></i></div>`
    + `<div class="ln-src-cap" aria-hidden="true">${caps}</div></div>`;
}

// ── the forced check's positions on the table ────────────────────────────────

// The table, seen from above: x runs away from the robot (up the map), y to its left (left on the map), in metres.
const TABLE = { x0: 0.25, x1: 0.8, y0: -0.5, y1: 0.5 };
const MAP = { s: 200, pad: 12, foot: 20 };
const MAP_W = (TABLE.y1 - TABLE.y0) * MAP.s + MAP.pad * 2;
const MAP_H = (TABLE.x1 - TABLE.x0) * MAP.s + MAP.pad * 2 + MAP.foot;

/**
 * The positions the forced step checked, each a --ok dot where the can was placed and a --bad ring where it was not,
 * on the table, with the practice spot as a hollow ring. It draws only the points it is given: these are the forced
 * check's own positions, never the hidden test's.
 */
export function tableMap(points: CheckPoint[], practice: { x: number; y: number } = { x: 0.5, y: 0 }): string {
  const px = (y: number): number => MAP.pad + (TABLE.y1 - Math.min(TABLE.y1, Math.max(TABLE.y0, y))) * MAP.s;
  const py = (x: number): number => MAP.pad + (TABLE.x1 - Math.min(TABLE.x1, Math.max(TABLE.x0, x))) * MAP.s;
  const f = (v: number): string => v.toFixed(1);
  const dots = points.map((p) => {
    const tip = `can at (${p.x}, ${p.y}): ${p.ok ? "success" : "fail"}, ${Number.isFinite(p.cm) ? `${p.cm} cm off` : "error not given"}`;
    return `<circle class="ln-map-pt ln-map-pt--${p.ok ? "ok" : "fail"}" cx="${f(px(p.y))}" cy="${f(py(p.x))}" r="${p.ok ? 4.2 : 3.8}"><title>${esc(tip)}</title></circle>`;
  }).join("");
  const sx = px(practice.y);
  const sy = py(practice.x);
  const spot = `<circle class="ln-map-spot" cx="${f(sx)}" cy="${f(sy)}" r="7"><title>practice spot (${practice.x}, ${practice.y})</title></circle>`
    + `<text class="ln-map-t" x="${f(sx)}" y="${f(sy - 11)}" text-anchor="middle">practice spot</text>`;
  const ok = points.filter((p) => p.ok).length;
  const label = `Forced check positions on the table, seen from above: ${ok} of ${points.length} succeeded.`;
  const key = `map:${points.map((p) => `${p.x},${p.y},${p.ok ? 1 : 0}`).join(";")}:${practice.x},${practice.y}`;
  const tw = (TABLE.y1 - TABLE.y0) * MAP.s;
  const th = (TABLE.x1 - TABLE.x0) * MAP.s;
  return `<div class="ln-map" data-morph-key="${attr(key)}">`
    + `<svg class="ln-map-svg" viewBox="0 0 ${f(MAP_W)} ${f(MAP_H)}" width="100%" role="img" aria-label="${attr(label)}">`
    + `<rect class="ln-map-table" x="${MAP.pad}" y="${MAP.pad}" width="${f(tw)}" height="${f(th)}" rx="3"></rect>`
    + `<text class="ln-map-t ln-map-t--edge" x="${f(MAP_W / 2)}" y="${f(MAP_H - 4)}" text-anchor="middle">robot side</text>`
    + spot + dots + `</svg></div>`;
}
