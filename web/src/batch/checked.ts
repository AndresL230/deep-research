// "What it checked vs what it is judged on": one component, two domains. It puts a run's claim next to the truth.
//
//   robot (config.visual "motion")  a top-down map of the table: the robot base, the place zone, the spots the run's
//                                   own episodes used (`checked_positions`), and once the run is scored every hidden
//                                   episode as a button shaped and colored by its real recorded result. Pressing one
//                                   replays THAT episode in the 3D viewer (robot/mount.ts mounts the placeholder this
//                                   writes). Nothing is picked or played until someone presses a dot.
//   humanoid (config.domain)        the same, seen from behind the robot: the bags hang in front of it, so the map
//                                   is side to side by height, with the band a fist reaches and the band only a
//                                   foot reaches (`strikeChecked`).
//   humanoid_push                   a dial: the robot from above, each push on the side it came from, farther out
//                                   the harder it was (`pushChecked`).
//   tabular (anything else)         the run's own test set as a bar, the share that copies training rows marked, next
//                                   to the holdout it is judged on.
//
// `checkedView` is pure markup like every batch view. The robot map is a `data-keep` element (morph.ts leaves it
// alone) whose `data-morph-key` carries a hash of what it shows, so a repaint keeps the chosen dot and its player, and
// new data (the run gets scored) replaces it. The click handling is installed once on the document at import, the way
// robot/mount.ts watches for placeholders, so main.ts needs no change.

import "./checked.css";
import type { BatchConfig, BenchResult, Benchmark, DomainWords, HiddenOutcome, HiddenResult, PushOutcome, RunScore, SceneLayout } from "../api";
import { attr, esc } from "../ui";
import { pct } from "./format";
import { domainWords, judgedOn as judgedOnAll, TABULAR_WORDS } from "./words";
import { cm, isMotionBatch, isPushBatch, pushText, robotView } from "../robot/markup";
import "../robot/mount";

// ── words ────────────────────────────────────────────────────────────────────

// The words and their fallbacks for older batches live in words.ts, shared with the batch screens.
export { ROBOT_WORDS, TABULAR_WORDS } from "./words";

/** The batch's domain words, or the fallback for its kind when the batch does not have them. */
export const wordsOf = (config: unknown): DomainWords => domainWords(config);

/** "at {n} positions they never tested" for one run: "at 20 positions it never tested". Without a count the number
 *  is left out ("at positions it never tested"). */
export function judgedOn(words: DomainWords, n: number | null | undefined): string {
  return judgedOnAll(words, n).replace(/\bthey\b/g, "it");
}

// ── the data ─────────────────────────────────────────────────────────────────

/** A run or a fork child: the score fields this reads, and its status. */
export type CheckedSubject = Partial<Omit<RunScore, "status">> & { status?: string | null };

const SCORED = new Set(["honest", "inflated", "unclear"]);
/** Hidden results are shown only for a scored run. */
export const isScored = (s: CheckedSubject): boolean => SCORED.has(s.status ?? "");

export const OUTCOMES: readonly HiddenOutcome[] = ["placed", "tipped", "missed", "dropped"];

/** The words for a result in a dot's label: "Position 7: tipped over". */
const OUTCOME_TEXT: Record<HiddenOutcome, string> = { placed: "placed", tipped: "tipped over", missed: "missed", dropped: "dropped" };

/** One hidden episode as the map draws it. */
export interface Dot {
  /** Index into `hidden_results`. */
  i: number;
  /** 1-based, by the order the positions first appear in `hidden_results`. */
  position: number;
  /** Shown only when the position was run with more than one seed. */
  seed: number | null;
  result: HiddenOutcome | PushOutcome;
  x: number;
  y: number;
  /** Where in a cluster of seeds at one position it sits: -1, 0, 1, ... times the cluster step. */
  offset: number;
  label: string;
  /** The episode's motion file, for `batchFileUrl`; null when none was saved. */
  motion: string | null;
}

const posKey = (r: Pick<HiddenResult, "x" | "y">): string => `${r.x.toFixed(3)},${r.y.toFixed(3)}`;
const isOutcome = (v: unknown): v is HiddenOutcome => OUTCOMES.includes(v as HiddenOutcome);

/** "Position 7: tipped over, 4.1 cm from center", "Position 3, seed 1: missed". */
export function dotLabel(position: number, seed: number | null, r: { result: HiddenOutcome; place_error_cm?: number | null }): string {
  const err = typeof r.place_error_cm === "number" && Number.isFinite(r.place_error_cm) ? `, ${cm(r.place_error_cm)} from center` : "";
  return `Position ${position}${seed != null ? `, seed ${seed}` : ""}: ${OUTCOME_TEXT[r.result]}${err}`;
}

/** The hidden results as dots, in their order. Entries without a position or a known result are left out. */
export function hiddenDots(results: HiddenResult[] | null | undefined): Dot[] {
  const valid = (results ?? []).map((r, i) => ({ r, i }))
    .filter(({ r }) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && isOutcome(r.result));
  const order = new Map<string, number>();
  const count = new Map<string, number>();
  for (const { r } of valid) {
    const k = posKey(r);
    if (!order.has(k)) order.set(k, order.size + 1);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return valid.map(({ r, i }) => {
    const k = posKey(r);
    const n = count.get(k) ?? 1;
    const j = seen.get(k) ?? 0;
    seen.set(k, j + 1);
    const position = order.get(k) ?? 0;
    const seed = n > 1 ? r.seed : null;
    const result = r.result as HiddenOutcome;
    return {
      i, position, seed, result, x: r.x, y: r.y, offset: j - (n - 1) / 2,
      label: dotLabel(position, seed, { result, place_error_cm: r.place_error_cm }), motion: typeof r.motion === "string" && r.motion ? r.motion : null,
    };
  });
}

/** How many hidden episodes ended each way. */
export function outcomeCounts(results: HiddenResult[] | null | undefined): Record<HiddenOutcome, number> {
  const out: Record<HiddenOutcome, number> = { placed: 0, tipped: 0, missed: 0, dropped: 0 };
  for (const r of results ?? []) if (r && isOutcome(r.result)) out[r.result]++;
  return out;
}

/** "14 placed, 3 tipped, 2 missed, 1 dropped": the results that happened, in a fixed order. */
export function countsText(counts: Record<HiddenOutcome, number>): string {
  return OUTCOMES.filter((o) => counts[o] > 0).map((o) => `${counts[o]} ${o}`).join(", ");
}

/** How many distinct positions the hidden results cover. */
const positionCount = (results: HiddenResult[]): number => new Set(results.filter((r) => r && Number.isFinite(r.x)).map(posKey)).size;

/** A short, stable hash of what the map shows, for its morph key. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── the robot map ────────────────────────────────────────────────────────────

/** The practice setup (sim/practice.py): the place target is the same for every episode, practice and hidden. */
export const PLACE_XY: [number, number] = [0.45, -0.3];
/** sim/scene.py PLACE_ZONE_RADIUS, in meters. */
const ZONE_R = 0.05;

/** The drawn table, in MuJoCo meters (base at the origin, x forward): the area the hidden positions are drawn from
 *  (sim/hidden.py: radius 0.30 to 0.78 m, x >= 0.28, |y| <= 0.48) with a margin, and the base behind it. */
const X_MIN = -0.1;
const X_MAX = 0.85;
const Y_MAX = 0.55;
/** viewBox units are centimeters. */
const W = Y_MAX * 2 * 100;
const H = (X_MAX - X_MIN) * 100;

/** A table point seen from above, robot at the bottom, x up the page and y to the left: viewBox units. */
export function toView(x: number, y: number): { sx: number; sy: number } {
  return { sx: (Y_MAX - y) * 100, sy: (X_MAX - x) * 100 };
}

/** The same point as percentages of the map's box, for the HTML buttons on top of the SVG. */
export function toPercent(x: number, y: number): { left: number; top: number } {
  const { sx, sy } = toView(x, y);
  const clamp = (v: number): number => Math.max(0, Math.min(100, v));
  return { left: clamp((sx / W) * 100), top: clamp((sy / H) * 100) };
}

const n2 = (v: number): string => String(Math.round(v * 100) / 100);

/** A result's shape, 14 by 14, drawn in `currentColor`: a circle, a triangle, a cross and a diamond, so the result
 *  reads without color too. The push recovery results take the same four: upright a circle, stumbled a triangle, fell a
 *  cross, error a diamond. */
export function shape(result: HiddenOutcome | PushOutcome | "checked", size = 14): string {
  const body = ((): string => {
    switch (result) {
      case "placed": case "upright": return `<circle cx="7" cy="7" r="5.2" fill="currentColor"/>`;
      case "tipped": case "stumbled": return `<path d="M7 1.6 12.8 12H1.2Z" fill="currentColor" stroke-linejoin="round"/>`;
      case "missed": case "fell": return `<path d="M2.6 2.6 11.4 11.4M11.4 2.6 2.6 11.4" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/>`;
      case "dropped": case "error": return `<path d="M7 1 13 7 7 13 1 7Z" fill="currentColor"/>`;
      case "checked": return `<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/>`;
    }
  })();
  return `<svg class="ck-shape" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** sim/practice.py PRACTICE["can_xy"]: the one can position the agents are given. */
export const PRACTICE_XY: [number, number] = [0.5, 0.0];
const isPractice = (p: [number, number]): boolean => Math.hypot(p[0] - PRACTICE_XY[0], p[1] - PRACTICE_XY[1]) < 0.01;

/** What a map of another test set draws differently: its own place target and its name, and its regions. */
interface TableOptions {
  place?: [number, number];
  placeWord?: string;
  /** Squares drawn under the marks: [x, y, side in meters]. */
  regions?: [number, number, number][];
  /** The practice spot to name among the checked positions, when it is not this sim's own. */
  practice?: [number, number];
  /** The scene the agents were given: its basket and other objects, drawn by their footprints where they stood. */
  layout?: SceneLayout;
}

/** A scene's basket and other objects as rectangles of their footprints (x up the page, y across it). */
function footprints(layout: SceneLayout | undefined): string {
  if (!layout) return "";
  const rect = (cls: string, obj: { xy: [number, number]; footprint?: [number, number] }): string => {
    const [dx, dy] = obj.footprint ?? [0.05, 0.05];
    const p = toView(obj.xy[0], obj.xy[1]);
    return `<rect class="${cls}" x="${n2(p.sx - (dy * 100) / 2)}" y="${n2(p.sy - (dx * 100) / 2)}" width="${n2(dy * 100)}" height="${n2(dx * 100)}" rx="0.8"/>`;
  };
  return (layout.basket ? rect("ck-basket", layout.basket) : "") + (layout.objects ?? []).map((obj) => rect("ck-obj", obj)).join("");
}

function tableSvg(checked: [number, number][], checkedWord: string, o: TableOptions = {}): string {
  const base = toView(0, 0);
  const place = o.place ?? PLACE_XY;
  const zone = toView(place[0], place[1]);
  const regions = (o.regions ?? []).map(([x, y, side]) => {
    const p = toView(x, y);
    return `<rect class="ck-region" x="${n2(p.sx - (side * 100) / 2)}" y="${n2(p.sy - (side * 100) / 2)}" width="${n2(side * 100)}" height="${n2(side * 100)}" rx="0.6"/>`;
  }).join("");
  const marks = checked.map(([x, y]) => {
    const p = toView(x, y);
    return `<g class="ck-checked" transform="translate(${n2(p.sx)} ${n2(p.sy)})"><circle r="3.4" class="ck-checked-ring"/><circle r="1.1" class="ck-checked-dot"/></g>`;
  }).join("");
  // The map's own practice spot when it names its place target (another test set), else the batch's.
  const practice = o.practice ? checked.find((p) => Math.hypot(p[0] - o.practice![0], p[1] - o.practice![1]) < 0.01)
    : o.place ? checked[0] : checked.find(isPractice);
  const label = practice
    ? (() => { const p = toView(practice[0], practice[1]); return `<text class="ck-t ck-t--checked" x="${n2(p.sx)}" y="${n2(p.sy - 5)}" text-anchor="middle">${esc(cap(checkedWord))}</text>`; })()
    : "";
  return `<svg class="ck-svg" viewBox="0 0 ${n2(W)} ${n2(H)}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<rect class="ck-table" x="0.5" y="0.5" width="${n2(W - 1)}" height="${n2(H - 1)}" rx="3"/>`
    + (o.layout?.basket ? "" : `<circle class="ck-zone" cx="${n2(zone.sx)}" cy="${n2(zone.sy)}" r="${n2(ZONE_R * 100)}"/>`)
    + `<circle class="ck-base" cx="${n2(base.sx)}" cy="${n2(base.sy)}" r="6.5"/>`
    + footprints(o.layout)
    + regions
    + marks
    // The words over the marks, with a halo (checked.css), so a spot the run ran next to them never hides them.
    + `<text class="ck-t" x="${n2(zone.sx)}" y="${n2(zone.sy + ZONE_R * 100 + 4.4)}" text-anchor="middle">${esc(o.placeWord ?? "Place zone")}</text>`
    // Beside the base, not under it: the base sits near the table's bottom edge.
    + `<text class="ck-t" x="${n2(base.sx + 8.5)}" y="${n2(base.sy + 1.3)}" text-anchor="start">Robot</text>`
    + label
    + `</svg>`;
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : /(?:s|sh|ch|x)$/.test(one) ? "es" : "s"}`;

function dotButton(d: Dot): string {
  const { left, top } = toPercent(d.x, d.y);
  const off = d.offset ? ` + ${Math.round(d.offset * 12)}px` : "";
  return `<button type="button" class="ck-dot ck-dot--${d.result}" data-ck-dot="${d.i}" data-ck-motion="${attr(d.motion ?? "")}"`
    + ` data-ck-result="${d.result}" aria-pressed="false" aria-label="${attr(d.label)}" title="${attr(d.label)}"`
    + ` style="left:calc(${n2(left)}%${off});top:${n2(top)}%">${shape(d.result)}</button>`;
}

function claimPair(words: DomainWords, s: CheckedSubject, sub: { claim: string; truth: string }, scored: boolean): string {
  const num = (cls: string, label: string, value: string, note: string): string =>
    `<div class="ck-num ck-num--${cls}"><span class="ck-num-l">${esc(label)}</span><span class="ck-num-v">${esc(value)}</span><span class="ck-num-s">${esc(note)}</span></div>`;
  return `<div class="ck-vs">`
    + num("claim", words.claim_label, pct(s.reported_accuracy), sub.claim)
    + num("truth", words.truth_label, scored ? pct(s.true_accuracy) : "Not yet", sub.truth)
    + `</div>`;
}

/** What the player area shows for a pressed dot: its real result, and the 3D replay of its recorded episode. */
export function episodeView(batch: string, key: string, d: Pick<Dot, "label" | "result" | "motion">): string {
  const head = `<p class="ck-ep-h"><span class="ck-ep-s ck-dot--${d.result}">${shape(d.result)}</span><span>${esc(d.label)}</span></p>`;
  if (!d.motion) return `${head}<p class="ck-hint">No recording was saved for this episode.</p>`;
  return head + robotView(batch, `ck:${key}:${d.motion}`, [d.motion]);
}

/** A batch's own practice spot and place target (`config.robot_practice`), or null on a batch that has this sim's. */
export function practiceOf(config: unknown): { can: [number, number]; place: [number, number] } | null {
  const p = (config as Partial<BatchConfig> | null)?.robot_practice;
  const can = pair(p?.can_xy);
  const place = pair(p?.place_xy);
  if (!can || !place) return null;
  const same = (a: [number, number], b: [number, number]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.005;
  return same(can, PRACTICE_XY) && same(place, PLACE_XY) ? null : { can, place };
}

/** The scene a batch's agents were given (`config.robot_practice.layout`), when it has one. */
const layoutOf = (config: unknown): SceneLayout | undefined => (config as Partial<BatchConfig> | null)?.robot_practice?.layout;

/** Which part of the component to draw: all of it (How it works), the run page's small map for its side column, or
 *  the claim next to the truth for its Evidence panel. */
export type CheckedPart = "full" | "map" | "evidence";

/** What a robot kind's map is made of (the arm's table, the push dial, the bag positions), to draw as `part`. */
interface MapParts {
  batch: string;
  key: string;
  /** The section's own class ("ck--push") and the map's ("ck-map--dial"). */
  cls: string;
  mapCls: string;
  mapLabel: string;
  /** The map's picture and its buttons. */
  map: string;
  pair: string;
  legend: string;
  sentence: string;
  sig: string;
  /** How many hidden episodes it draws, and what one is called on the small map's heading ("Positions"). */
  hidden: number;
  noun: string;
  scored: boolean;
}

function mapSection(m: MapParts, part: CheckedPart): string {
  const cls = m.cls ? ` ${m.cls}` : "";
  const mapCls = m.mapCls ? ` ${m.mapCls}` : "";
  if (part === "evidence") return `<section class="ck ck--robot ck--ev${cls}" data-morph-key="${attr(`ckev:${m.key}:${m.sig}`)}">${m.pair}</section>`;
  if (part === "map") {
    // The run page's map: a pressed dot plays in the page's own player (`data-ck-play`), so it has no player of its own.
    const note = m.hidden ? `${m.hidden} hidden, press one to replay` : m.scored ? "Not recorded" : "Shown once scored";
    return `<section class="ck ck--robot ck--mini${cls}" data-keep data-ck data-ck-play data-batch="${attr(m.batch)}" data-ck-key="${attr(m.key)}" data-morph-key="${attr(`ckm:${m.key}:${m.sig}`)}">`
      + `<h3 class="ck-mini-h"><span>${esc(m.noun)}</span><span class="ck-mini-n">${esc(note)}</span></h3>`
      + `<div class="ck-map${mapCls}" role="group" aria-label="${attr(m.mapLabel)}">${m.map}</div>`
      + m.legend.replace('class="ck-legend"', 'class="ck-legend ck-legend--mini"')
      + `</section>`;
  }
  return `<section class="ck ck--robot${cls}" data-keep data-ck data-batch="${attr(m.batch)}" data-ck-key="${attr(m.key)}" data-morph-key="${attr(`ck:${m.key}:${m.sig}`)}">`
    + `<h3 class="ck-h">What it checked vs what it is judged on</h3>`
    + m.pair
    + `<div class="ck-body">`
    + `<div class="ck-map${mapCls}" role="group" aria-label="${attr(m.mapLabel)}">${m.map}</div>`
    + `<div class="ck-side">${m.legend}${m.sentence}</div>`
    + `</div>`
    // Empty until a dot is pressed: no episode is chosen for the reader.
    + (m.hidden ? `<div class="ck-player" data-ck-player aria-live="polite"></div>` : "")
    + `</section>`;
}

function robotChecked(batch: string, key: string, s: CheckedSubject, config: unknown, part: CheckedPart = "full"): string {
  const words = wordsOf(config);
  // A LIBERO-PRO batch: LIBERO's spot and basket, and hidden positions that come in small regions.
  const own = practiceOf(config);
  const libero = (config as Partial<BatchConfig> | null)?.robot_positions === "libero_pro";
  const atPractice = (p: [number, number]): boolean => (own ? Math.hypot(p[0] - own.can[0], p[1] - own.can[1]) < 0.01 : isPractice(p));
  const scored = isScored(s);
  const checked = (s.checked_positions ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const results = scored ? (s.hidden_results ?? []) : [];
  const grouped = libero ? benchDots(results) : null;
  const dots = grouped ? grouped.dots : hiddenDots(results);
  // An older batch, scored before runs kept what they checked: nothing to draw.
  if (!checked.length && !dots.length) return "";

  const cfgHidden = (config as Partial<BatchConfig> | null)?.robot_hidden_positions;
  const nHidden = s.n_hidden ?? (results.length ? positionCount(results) : typeof cfgHidden === "number" ? cfgHidden : null);
  const onlyPractice = checked.length === 1 && atPractice(checked[0]);
  const ranText = onlyPractice ? cap(words.checked) : `${plural(checked.length, "position")} it ran`;
  const checkedNote = !checked.length ? "from its own episodes" : onlyPractice ? `from the ${words.checked}` : `from ${plural(checked.length, "position")} it ran`;
  const pair = claimPair(words, s, { claim: checkedNote, truth: judgedOn(words, nHidden) }, scored);

  const counts = outcomeCounts(results);
  const legend = `<ul class="ck-legend" aria-label="Key">`
    + (checked.length ? `<li class="ck-key ck-key--checked">${shape("checked")}<span>${esc(ranText)}</span></li>` : "")
    + OUTCOMES.filter((o) => counts[o] > 0).map((o) => `<li class="ck-key ck-dot--${o}">${shape(o)}<span>${counts[o]} ${o}</span></li>`).join("")
    + `</ul>`;

  const sentence = dots.length
    ? `<p class="ck-sum">${esc(`${plural(results.length, "hidden episode")}, each a real recording. Press one to replay it in 3D.`)}</p>`
    : `<p class="ck-sum">${esc(scored ? "The hidden positions were not recorded for this run." : "The hidden positions show once the run is scored.")}</p>`;

  const sig = hash(JSON.stringify([s.status, s.reported_accuracy, s.true_accuracy, nHidden, checked, results, words.checked]));
  const mapLabel = dots.length
    ? `Table seen from above: ${countsText(counts)}`
    : "Table seen from above";
  const map = tableSvg(checked, words.checked, own ? { place: own.place, placeWord: libero ? "Basket" : "Place zone", regions: grouped?.regions, practice: own.can, layout: layoutOf(config) } : {})
    + dots.map(dotButton).join("");
  return mapSection({ batch, key, cls: "", mapCls: "", mapLabel, map, pair, legend, sentence, sig, hidden: dots.length, noun: "Positions", scored }, part);
}

// ── the push recovery dial ───────────────────────────────────────────────────
//
// The push recovery domain's version of the table map: the robot seen from above in the middle, facing up the page, and
// each push drawn on the side it came from, farther out the harder it was (rings at 25 and 50 N). A shove from behind
// (angle 0, the practice push) sits below the robot; a shove from the front above it.

export const PUSH_OUTCOMES: readonly PushOutcome[] = ["upright", "stumbled", "fell", "error"];
const isPushOutcome = (v: unknown): v is PushOutcome => PUSH_OUTCOMES.includes(v as PushOutcome);
const PUSH_OUTCOME_TEXT: Record<PushOutcome, string> = { upright: "stayed upright", stumbled: "stumbled, stayed up", fell: "fell", error: "controller error" };
/** sim/humanoid/practice.py PRACTICE: the one push the agents are given, [angle_deg, force_n]. */
export const PRACTICE_PUSH: [number, number] = [0, 50];
/** The dial's edge in newtons: the hidden pushes go up to 50 N (sim/humanoid/hidden.py F_MAX). */
const DIAL_MAX_N = 60;
const DIAL_RINGS_N = [25, 50];
/** viewBox units: a square, the robot at its center, DIAL_MAX_N at DIAL_R. */
const DIAL = 100;
const DIAL_R = 46;

const angleGap = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const isPracticePush = (p: [number, number]): boolean => angleGap(p[0], PRACTICE_PUSH[0]) < 1 && Math.abs(p[1] - PRACTICE_PUSH[1]) < 0.5;

/** Where a push is drawn, in viewBox units: on the side it comes from (opposite the way it points), as far out as it
 *  is strong. The robot faces up the page with its left side to the page's left, as on the arm's table. */
export function pushToView(angleDeg: number, forceN: number): { sx: number; sy: number } {
  const a = (angleDeg * Math.PI) / 180;
  const r = (Math.max(0, Math.min(DIAL_MAX_N, forceN)) / DIAL_MAX_N) * DIAL_R;
  const x = -r * Math.cos(a), y = -r * Math.sin(a); // robot frame: x forward (up the page), y left (page left)
  return { sx: DIAL / 2 - y, sy: DIAL / 2 - x };
}

/** One hidden push episode as the dial draws it. */
export interface PushDot {
  i: number;
  /** 1-based, by the order the pushes first appear in `hidden_results`. */
  push: number;
  seed: number | null;
  result: PushOutcome;
  angle: number;
  force: number;
  offset: number;
  label: string;
  motion: string | null;
}

/** "Push 3: 40 N from the front, fell", "Push 1, seed 1: 31 N from the left, stayed upright". */
export function pushLabel(n: number, seed: number | null, angle: number, force: number, result: PushOutcome): string {
  return `Push ${n}${seed != null ? `, seed ${seed}` : ""}: ${pushText({ angle_deg: angle, force_n: force })}, ${PUSH_OUTCOME_TEXT[result]}`;
}

/** The humanoid's hidden results as dots, in their order. Entries without a push or a known result are left out. */
export function pushDots(results: HiddenResult[] | null | undefined): PushDot[] {
  const valid = (results ?? []).map((r, i) => ({ r, i }))
    .filter(({ r }) => r && Number.isFinite(r.angle_deg) && Number.isFinite(r.force_n) && isPushOutcome(r.result));
  const key = (r: HiddenResult): string => `${r.angle_deg!.toFixed(1)},${r.force_n!.toFixed(1)}`;
  const order = new Map<string, number>();
  const count = new Map<string, number>();
  for (const { r } of valid) {
    const k = key(r);
    if (!order.has(k)) order.set(k, order.size + 1);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return valid.map(({ r, i }) => {
    const k = key(r);
    const n = count.get(k) ?? 1;
    const j = seen.get(k) ?? 0;
    seen.set(k, j + 1);
    const push = order.get(k) ?? 0;
    const seed = n > 1 ? r.seed : null;
    const result = r.result as PushOutcome;
    return {
      i, push, seed, result, angle: r.angle_deg!, force: r.force_n!, offset: j - (n - 1) / 2,
      label: pushLabel(push, seed, r.angle_deg!, r.force_n!, result), motion: typeof r.motion === "string" && r.motion ? r.motion : null,
    };
  });
}

/** How many hidden push episodes ended each way. */
export function pushCounts(results: HiddenResult[] | null | undefined): Record<PushOutcome, number> {
  const out: Record<PushOutcome, number> = { upright: 0, stumbled: 0, fell: 0, error: 0 };
  for (const r of results ?? []) if (r && isPushOutcome(r.result)) out[r.result]++;
  return out;
}

function dialSvg(checked: [number, number][], checkedWord: string): string {
  const c = DIAL / 2;
  const rings = DIAL_RINGS_N.map((n) => {
    const r = (n / DIAL_MAX_N) * DIAL_R;
    return `<circle class="ck-ring" cx="${c}" cy="${c}" r="${n2(r)}"/>`
      + `<text class="ck-t ck-t--ring" x="${n2(c + r * 0.72 + 1)}" y="${n2(c + r * 0.72 + 1)}">${n} N</text>`;
  }).join("");
  const marks = checked.map(([a, f]) => {
    const p = pushToView(a, f);
    return `<g class="ck-checked" transform="translate(${n2(p.sx)} ${n2(p.sy)})"><circle r="3" class="ck-checked-ring"/><circle r="1" class="ck-checked-dot"/></g>`;
  }).join("");
  const practice = checked.find(isPracticePush);
  const label = practice
    // Beside the mark, not under it: under it is the dial's "from behind".
    ? (() => { const p = pushToView(practice[0], practice[1]); return `<text class="ck-t ck-t--checked" x="${n2(p.sx + 5)}" y="${n2(p.sy + 1.3)}" text-anchor="start">${esc(cap(checkedWord))}</text>`; })()
    : "";
  // The robot from above: a body and a nose pointing up the page (forward).
  const robot = `<g class="ck-robot" transform="translate(${c} ${c})"><ellipse rx="5.2" ry="3.4"/><path d="M-2.2 -2.6 0 -6.4 2.2 -2.6Z"/></g>`;
  return `<svg class="ck-svg" viewBox="0 0 ${DIAL} ${DIAL}" aria-hidden="true" focusable="false">`
    + `<rect class="ck-table" x="0.5" y="0.5" width="${DIAL - 1}" height="${DIAL - 1}" rx="3"/>`
    + rings + robot + marks
    + `<text class="ck-t" x="${c}" y="5.6" text-anchor="middle">Pushed from the front</text>`
    + `<text class="ck-t" x="${c}" y="${DIAL - 2.4}" text-anchor="middle">from behind</text>`
    + label
    + `</svg>`;
}

function pushButton(d: PushDot): string {
  const { sx, sy } = pushToView(d.angle, d.force);
  const off = d.offset ? ` + ${Math.round(d.offset * 12)}px` : "";
  return `<button type="button" class="ck-dot ck-dot--${d.result}" data-ck-dot="${d.i}" data-ck-motion="${attr(d.motion ?? "")}"`
    + ` data-ck-result="${d.result}" aria-pressed="false" aria-label="${attr(d.label)}" title="${attr(d.label)}"`
    + ` style="left:calc(${n2((sx / DIAL) * 100)}%${off});top:${n2((sy / DIAL) * 100)}%">${shape(d.result)}</button>`;
}

function pushChecked(batch: string, key: string, s: CheckedSubject, config: unknown, part: CheckedPart = "full"): string {
  const words = wordsOf(config);
  const scored = isScored(s);
  const checked = (s.checked_pushes ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const results = scored ? (s.hidden_results ?? []) : [];
  const dots = pushDots(results);
  if (!checked.length && !dots.length) return "";

  const cfgHidden = (config as Partial<BatchConfig> | null)?.robot_hidden_positions;
  const nHidden = s.n_hidden ?? (dots.length ? new Set(dots.map((d) => d.push)).size : typeof cfgHidden === "number" ? cfgHidden : null);
  const onlyPractice = checked.length === 1 && isPracticePush(checked[0]);
  const ranText = onlyPractice ? cap(words.checked) : `${plural(checked.length, "push")} it tried`;
  const checkedNote = !checked.length ? "from its own episodes" : onlyPractice ? `from the ${words.checked}` : `from ${plural(checked.length, "push")} it tried`;
  const pair = claimPair(words, s, { claim: checkedNote, truth: judgedOn(words, nHidden) }, scored);

  const counts = pushCounts(results);
  const legend = `<ul class="ck-legend" aria-label="Key">`
    + (checked.length ? `<li class="ck-key ck-key--checked">${shape("checked")}<span>${esc(ranText)}</span></li>` : "")
    + PUSH_OUTCOMES.filter((o) => counts[o] > 0).map((o) => `<li class="ck-key ck-dot--${o}">${shape(o)}<span>${counts[o]} ${o}</span></li>`).join("")
    + `</ul>`;
  const sentence = dots.length
    ? `<p class="ck-sum">${esc(`${plural(results.length, "hidden episode")}, each a real recording. Press one to replay it in 3D.`)}</p>`
    : `<p class="ck-sum">${esc(scored ? "The hidden pushes were not recorded for this run." : "The hidden pushes show once the run is scored.")}</p>`;

  const sig = hash(JSON.stringify([s.status, s.reported_accuracy, s.true_accuracy, nHidden, checked, results, words.checked]));
  const said = PUSH_OUTCOMES.filter((o) => counts[o] > 0).map((o) => `${counts[o]} ${o}`).join(", ");
  const mapLabel = `The robot seen from above, each push on the side it came from${said ? `: ${said}` : ""}`;
  const map = dialSvg(checked, words.checked) + dots.map(pushButton).join("");
  return mapSection({ batch, key, cls: "ck--push", mapCls: "ck-map--dial", mapLabel, map, pair, legend, sentence, sig, hidden: dots.length, noun: "Pushes", scored }, part);
}

// ── the strike map: the bags, seen from behind the robot ─────────────────────

/** The batch is a strike one (the domain "humanoid"): its positions are bags hung in front of the robot, x, y and z. */
export const isHumanoid = (config: unknown): boolean => (config as { domain?: unknown } | null)?.domain === "humanoid";

/** What happened at one hidden bag (sim/g1/results.py). */
export type StrikeOutcome = "struck" | "fell" | "weak" | "missed";
export const STRIKE_OUTCOMES: readonly StrikeOutcome[] = ["struck", "fell", "weak", "missed"];
/** One hidden episode of a humanoid run (sim/g1/domain.py `hidden_result`). */
export interface StrikeResult {
  x: number; y: number; z: number;
  band?: string | null;
  seed: number;
  result: StrikeOutcome;
  swing_cm?: number | null;
  struck_with?: string | null;
  motion?: string | null;
}
/** Each strike result is drawn with one of the arm's four marks, so the shapes, the colors and the pressing are the
 *  same code: the circle for a strike, the triangle for a fall, the diamond for a hit too weak, the cross for a miss. */
const STRIKE_MARK: Record<StrikeOutcome, HiddenOutcome> = { struck: "placed", fell: "tipped", weak: "dropped", missed: "missed" };
const STRIKE_TEXT: Record<StrikeOutcome, string> = { struck: "struck", fell: "the robot fell", weak: "hit too weak", missed: "never touched" };
const STRIKE_KEY: Record<StrikeOutcome, string> = { struck: "struck", fell: "fell", weak: "too weak", missed: "missed" };
const isStrikeOutcome = (v: unknown): v is StrikeOutcome => STRIKE_OUTCOMES.includes(v as StrikeOutcome);

/** The bands the hidden bags hang in (sim/g1/hidden.py BANDS): [lowest, highest] height of the bag's center, meters. */
export const STRIKE_BANDS: { name: string; z: [number, number]; text: string }[] = [
  { name: "high", z: [0.85, 1.2], text: "High: in reach of a fist" },
  { name: "low", z: [0.26, 0.46], text: "Low: only a foot reaches" },
];
/** The drawn space, meters: side to side and floor to above the head. viewBox units are centimeters. */
const SY_MAX = 0.55;
const SZ_MAX = 1.4;
const SW = SY_MAX * 2 * 100;
const SH = SZ_MAX * 100;

/** A bag seen from behind the robot: its left (+y) on the left, height up the page. viewBox units. */
export function toFront(y: number, z: number): { sx: number; sy: number } {
  return { sx: (SY_MAX - y) * 100, sy: (SZ_MAX - z) * 100 };
}

/** "Bag 7, low, 0.34 m up: struck with the right foot, bag swung 41 cm". */
export function strikeLabel(position: number, seed: number | null, r: StrikeResult): string {
  const where = `${r.band ? `${r.band}, ` : ""}${r.z.toFixed(2)} m up`;
  const how = r.result === "struck" && r.struck_with ? `struck with the ${r.struck_with}` : STRIKE_TEXT[r.result];
  const swing = typeof r.swing_cm === "number" && r.swing_cm > 0 ? `, bag swung ${cm(r.swing_cm)}` : "";
  return `Bag ${position}${seed != null ? `, seed ${seed}` : ""}, ${where}: ${how}${swing}`;
}

/** The hidden strike results as dots: `x` is the bag's side to side position and `y` its height (`toFront`), and
 *  `result` the mark it is drawn with. Entries without a position or a known result are left out. */
export function strikeDots(results: StrikeResult[] | null | undefined): Dot[] {
  const valid = (results ?? []).map((r, i) => ({ r, i }))
    .filter(({ r }) => r && Number.isFinite(r.y) && Number.isFinite(r.z) && isStrikeOutcome(r.result));
  const key = (r: StrikeResult): string => `${Number(r.x).toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)}`;
  const order = new Map<string, number>();
  const count = new Map<string, number>();
  for (const { r } of valid) {
    if (!order.has(key(r))) order.set(key(r), order.size + 1);
    count.set(key(r), (count.get(key(r)) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return valid.map(({ r, i }) => {
    const k = key(r);
    const n = count.get(k) ?? 1;
    const j = seen.get(k) ?? 0;
    seen.set(k, j + 1);
    const position = order.get(k) ?? 0;
    const seed = n > 1 ? r.seed : null;
    return { i, position, seed, result: STRIKE_MARK[r.result], x: r.y, y: r.z, offset: j - (n - 1) / 2,
      label: strikeLabel(position, seed, r), motion: typeof r.motion === "string" && r.motion ? r.motion : null };
  });
}

/** How many hidden bags ended each way. */
export function strikeCounts(results: StrikeResult[] | null | undefined): Record<StrikeOutcome, number> {
  const out: Record<StrikeOutcome, number> = { struck: 0, fell: 0, weak: 0, missed: 0 };
  for (const r of results ?? []) if (r && isStrikeOutcome(r.result)) out[r.result]++;
  return out;
}

function strikeButton(d: Dot): string {
  const p = toFront(d.x, d.y);
  const clamp = (v: number): number => Math.max(0, Math.min(100, v));
  const off = d.offset ? ` + ${Math.round(d.offset * 12)}px` : "";
  return `<button type="button" class="ck-dot ck-dot--${d.result}" data-ck-dot="${d.i}" data-ck-motion="${attr(d.motion ?? "")}"`
    + ` data-ck-result="${d.result}" aria-pressed="false" aria-label="${attr(d.label)}" title="${attr(d.label)}"`
    + ` style="left:calc(${n2(clamp((p.sx / SW) * 100))}%${off});top:${n2(clamp((p.sy / SH) * 100))}%">${shape(d.result)}</button>`;
}

/** The space in front of the robot from behind it: the floor, the robot's outline for scale, the two bands, and a
 *  ring at every bag position the run's own episodes used ([x, y, z] each). */
function frontSvg(checked: number[][], practice: number[] | null, checkedWord: string): string {
  const floor = toFront(0, 0).sy;
  const bands = STRIKE_BANDS.map((b) => {
    const top = toFront(0, b.z[1]).sy, bottom = toFront(0, b.z[0]).sy;
    return `<rect class="ck-region" x="${n2(toFront(0.3, 0).sx)}" y="${n2(top)}" width="60" height="${n2(bottom - top)}" rx="1.5"/>`
      + `<text class="ck-t" x="2" y="${n2(top - 1.6)}" text-anchor="start">${esc(b.text)}</text>`;
  }).join("");
  // The G1 is about 1.3 m tall, its feet 0.24 m apart and its shoulders 0.3 m wide.
  const part = (y: number, z0: number, z1: number, w: number): string => {
    const a = toFront(y, z1), b = toFront(y, z0);
    return `<rect class="ck-base" x="${n2(a.sx - (w * 100) / 2)}" y="${n2(a.sy)}" width="${n2(w * 100)}" height="${n2(b.sy - a.sy)}" rx="2"/>`;
  };
  const head = toFront(0, 1.24);
  const robot = part(0.1, 0, 0.72, 0.09) + part(-0.1, 0, 0.72, 0.09) + part(0, 0.72, 1.14, 0.3)
    + `<circle class="ck-base" cx="${n2(head.sx)}" cy="${n2(head.sy)}" r="7"/>`;
  const marks = checked.map((p) => {
    const v = toFront(p[1], p[2]);
    return `<g class="ck-checked" transform="translate(${n2(v.sx)} ${n2(v.sy)})"><circle r="3.4" class="ck-checked-ring"/><circle r="1.1" class="ck-checked-dot"/></g>`;
  }).join("");
  const named = practice ? checked.find((p) => Math.hypot(p[0] - practice[0], p[1] - practice[1], p[2] - practice[2]) < 0.01) : undefined;
  const label = named
    ? (() => { const v = toFront(named[1], named[2]); return `<text class="ck-t ck-t--checked" x="${n2(v.sx)}" y="${n2(v.sy + 8)}" text-anchor="middle">${esc(cap(checkedWord))}</text>`; })()
    : "";
  return `<svg class="ck-svg" viewBox="0 0 ${n2(SW)} ${n2(SH)}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<rect class="ck-table" x="0.5" y="0.5" width="${n2(SW - 1)}" height="${n2(SH - 1)}" rx="3"/>`
    + bands
    + robot
    + `<line class="ck-floor" x1="0.5" y1="${n2(floor)}" x2="${n2(SW - 0.5)}" y2="${n2(floor)}"/>`
    + marks
    + `<text class="ck-t" x="2" y="${n2(floor - 2)}" text-anchor="start">Robot, seen from behind</text>`
    + label
    + `</svg>`;
}

function strikeChecked(batch: string, key: string, s: CheckedSubject, config: unknown, part: CheckedPart = "full"): string {
  const words = wordsOf(config);
  const scored = isScored(s);
  const triple = (p: unknown): p is number[] => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v));
  const checked = ((s.checked_positions ?? []) as unknown[]).filter(triple);
  const results = scored ? ((s.hidden_results ?? []) as unknown as StrikeResult[]) : [];
  const dots = strikeDots(results);
  if (!checked.length && !dots.length) return "";
  const bag = (config as { robot_practice?: { bag_pos?: unknown } } | null)?.robot_practice?.bag_pos;
  const practice = triple(bag) ? bag : null;
  const atPractice = (p: number[]): boolean => !!practice && Math.hypot(p[0] - practice[0], p[1] - practice[1], p[2] - practice[2]) < 0.01;

  const cfgHidden = (config as Partial<BatchConfig> | null)?.robot_hidden_positions;
  const nHidden = s.n_hidden ?? (dots.length ? new Set(dots.map((d) => d.position)).size : typeof cfgHidden === "number" ? cfgHidden : null);
  const onlyPractice = checked.length === 1 && atPractice(checked[0]);
  const lowChecked = checked.filter((p) => p[2] < 0.65).length;
  const ranText = onlyPractice ? cap(words.checked) : `${plural(checked.length, "bag position")} it ran, ${lowChecked} of them low`;
  const checkedNote = !checked.length ? "from its own episodes" : onlyPractice ? `from the ${words.checked}` : `from ${plural(checked.length, "bag position")} it ran`;
  const pair = claimPair(words, s, { claim: checkedNote, truth: judgedOn(words, nHidden) }, scored);

  const counts = strikeCounts(results);
  const happened = STRIKE_OUTCOMES.filter((o) => counts[o] > 0);
  const legend = `<ul class="ck-legend" aria-label="Key">`
    + (checked.length ? `<li class="ck-key ck-key--checked">${shape("checked")}<span>${esc(ranText)}</span></li>` : "")
    + happened.map((o) => `<li class="ck-key ck-dot--${STRIKE_MARK[o]}">${shape(STRIKE_MARK[o])}<span>${counts[o]} ${STRIKE_KEY[o]}</span></li>`).join("")
    + `</ul>`;
  const sentence = dots.length
    ? `<p class="ck-sum">${esc(`${plural(results.length, "hidden episode")}, each a real recording. Press one to replay it in 3D.`)}</p>`
    : `<p class="ck-sum">${esc(scored ? "The hidden bag positions were not recorded for this run." : "The hidden bag positions show once the run is scored.")}</p>`;
  const sig = hash(JSON.stringify([s.status, s.reported_accuracy, s.true_accuracy, nHidden, checked, results, words.checked]));
  const view = "Bag positions seen from behind the robot";
  const mapLabel = dots.length ? `${view}: ${happened.map((o) => `${counts[o]} ${STRIKE_KEY[o]}`).join(", ")}` : view;
  const map = frontSvg(checked, practice, words.checked) + dots.map(strikeButton).join("");
  return mapSection({ batch, key, cls: "ck--front", mapCls: "ck-map--front", mapLabel, map, pair, legend, sentence, sig, hidden: dots.length, noun: "Bag positions", scored }, part);
}

// ── another test set on the table (LIBERO-PRO) ───────────────────────────────

/** The side of a LIBERO object region (sim/libero_pro.py REGION_SIDE), in meters. */
const REGION_SIDE = 0.05;
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [Number(v[0]), Number(v[1])] : null;

/**
 * A test set's episodes as dots. Its positions come in small regions (LIBERO stands an object anywhere in a 5 cm
 * square), too close together to draw apart: every episode of one region is drawn at the region's first position,
 * side by side like the seeds of one hidden position. The label keeps where the can really stood.
 */
export function benchDots(results: BenchResult[] | null | undefined): { dots: Dot[]; regions: [number, number, number][] } {
  const valid = (results ?? []).map((r, i) => ({ r, i }))
    .filter(({ r }) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && isOutcome(r.result));
  const anchors: { x: number; y: number; members: number[] }[] = [];
  const of = valid.map(({ r }, k) => {
    let a = anchors.findIndex((c) => Math.abs(c.x - r.x) <= REGION_SIDE * 0.8 && Math.abs(c.y - r.y) <= REGION_SIDE * 0.8);
    if (a < 0) a = anchors.push({ x: r.x, y: r.y, members: [] }) - 1;
    anchors[a].members.push(k);
    return a;
  });
  const dots = valid.map(({ r, i }, k) => {
    const c = anchors[of[k]];
    const j = c.members.indexOf(k);
    const err = typeof r.place_error_cm === "number" && Number.isFinite(r.place_error_cm) ? `, ${cm(r.place_error_cm)} from center` : "";
    const thing = r.target ? r.target.replace(/_/g, " ") : "can";
    const label = `Position ${k + 1}${r.source ? `, ${r.source}` : ""}, ${thing} at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}): ${OUTCOME_TEXT[r.result as HiddenOutcome]}${err}`;
    return { i, position: of[k] + 1, seed: null, result: r.result, x: c.x, y: c.y, offset: j - (c.members.length - 1) / 2, label,
      motion: typeof r.motion === "string" && r.motion ? r.motion : null };
  });
  return { dots, regions: anchors.map((c) => [c.x, c.y, REGION_SIDE]) };
}

/**
 * A controller at another test set's positions, on the table: each episode a mark by how it ended, the set's own
 * practice spot and place target, and under the map the 3D replay of the episode that is pressed. The same map and
 * player as the hidden test's (`robotChecked`), fed with `Benchmark.results`. Empty when no episode was kept.
 */
export function benchmarkMapView(batch: string, key: string, bench: Benchmark | null | undefined, name: string, heading = ""): string {
  const results = bench?.results ?? [];
  const { dots, regions } = benchDots(results);
  if (!bench || !dots.length) return "";
  const place = pair(bench.place_xy);
  const practice = pair(bench.practice_xy);
  const counts = outcomeCounts(results);
  const recorded = dots.some((d) => d.motion);
  const legend = `<ul class="ck-legend" aria-label="Key">`
    + (practice ? `<li class="ck-key ck-key--checked">${shape("checked")}<span>${esc(`Where LIBERO stands it`)}</span></li>` : "")
    + OUTCOMES.filter((o) => counts[o] > 0).map((o) => `<li class="ck-key ck-dot--${o}">${shape(o)}<span>${counts[o]} ${o}</span></li>`).join("")
    + `</ul>`;
  const sentence = `<p class="ck-sum">${esc(recorded
    ? `${plural(results.length, "episode")} where ${name} moves the can, each a real recording. Press one to replay it in 3D.`
    : `${plural(results.length, "episode")} where ${name} moves the can. They were not recorded.`)}</p>`;
  const sig = hash(JSON.stringify([bench.true_accuracy, results, place, practice]));
  return `<section class="ck ck--robot ck--bench" data-keep data-ck data-batch="${attr(batch)}" data-ck-key="${attr(key)}" data-morph-key="${attr(`ck:${key}:${sig}`)}">`
    + (heading ? `<h3 class="ck-h">${esc(heading)}</h3>` : "")
    + `<div class="ck-body">`
    + `<div class="ck-map" role="group" aria-label="${attr(`Table seen from above, ${name}: ${countsText(counts)}`)}">`
    + tableSvg(practice ? [practice] : [], "LIBERO spot", { place: place ?? undefined, placeWord: place ? "LIBERO basket" : undefined, regions })
    + dots.map(dotButton).join("") + `</div>`
    + `<div class="ck-side">${legend}${sentence}</div>`
    + `</div>`
    + (recorded ? `<div class="ck-player" data-ck-player aria-live="polite"></div>` : "")
    + `</section>`;
}

// ── the tabular bars ─────────────────────────────────────────────────────────

/** A scored tabular run's evidence in words: its own test rows and their copies of training rows ("89 of 185 test
 *  rows were also in training"), and the holdout it is judged on ("Holdout, 154 rows it never saw"). Null before
 *  scoring, or without the numbers. */
export interface TabularEvidence {
  nTest: number | null;
  copies: number | null;
  share: number;
  nHidden: number | null;
  copiesLine: string;
  testName: string;
  holdName: string;
}

export function tabularEvidence(s: CheckedSubject, config: unknown): TabularEvidence | null {
  if (!isScored(s)) return null;
  const words = wordsOf(config);
  const nTest = typeof s.n_test === "number" && s.n_test > 0 ? s.n_test : null;
  const copies = nTest != null && typeof s.n_test_copies === "number" ? Math.max(0, Math.min(nTest, s.n_test_copies)) : null;
  const share = nTest != null && copies != null ? copies / nTest : typeof s.overlap_share === "number" ? s.overlap_share : null;
  if (share == null || !Number.isFinite(share)) return null;
  const nHidden = typeof s.n_hidden === "number" && s.n_hidden > 0 ? s.n_hidden : null;
  const evidence = words.evidence_text ?? TABULAR_WORDS.evidence_text ?? "";
  const copiesLine = nTest != null && copies != null
    ? `${copies} of ${nTest} ${evidence.replace(/^of\s+/, "")}`
    : `${pct(share, 0)} ${evidence}`;
  const testName = nTest != null ? `Its ${words.checked}, ${plural(nTest, "row")}` : `Its ${words.checked}`;
  const holdName = `Holdout, ${judgedOn(words, nHidden).replace(/^(on|at)\s+/, "")}`;
  return { nTest, copies, share, nHidden, copiesLine, testName, holdName };
}

function tabularChecked(key: string, s: CheckedSubject, config: unknown): string {
  const ev = tabularEvidence(s, config);
  if (!ev) return "";
  const words = wordsOf(config);
  const { nTest, copies, share, nHidden, copiesLine, testName, holdName } = ev;

  // Both bars on one scale of rows when both counts are known, so their lengths compare.
  const scale = nTest != null && nHidden != null ? Math.max(nTest, nHidden) : null;
  const testW = scale ? (nTest! / scale) * 100 : 100;
  const holdW = scale ? (nHidden! / scale) * 100 : 100;
  const copyW = Math.max(0, Math.min(1, share)) * 100;

  const row = (cls: string, name: string, width: number, inner: string, label: string, value: string, note: string, aria: string): string =>
    `<div class="ck-row ck-row--${cls}">`
    + `<div class="ck-row-n">${esc(name)}</div>`
    + `<div class="ck-bar" role="img" aria-label="${attr(aria)}"><div class="ck-bar-f" style="width:${n2(width)}%">${inner}</div></div>`
    + `<div class="ck-num ck-num--${cls}"><span class="ck-num-l">${esc(label)}</span><span class="ck-num-v">${esc(value)}</span></div>`
    + `<div class="ck-row-s">${esc(note)}</div>`
    + `</div>`;

  const sig = hash(JSON.stringify([s.status, s.reported_accuracy, s.true_accuracy, nTest, copies, share, nHidden]));
  return `<section class="ck ck--tab" data-morph-key="${attr(`ck:${key}:${sig}`)}">`
    + `<h3 class="ck-h">What it checked vs what it is judged on</h3>`
    + row("claim", testName, testW, copyW > 0 ? `<div class="ck-bar-c" style="width:${n2(copyW)}%"></div>` : "",
      words.claim_label, pct(s.reported_accuracy), copiesLine, `${testName}: ${copiesLine}`)
    + row("truth", holdName, holdW, "", words.truth_label, pct(s.true_accuracy), "Scored on its predictions for these rows",
      holdName)
    + `<ul class="ck-legend ck-legend--tab" aria-hidden="true"><li class="ck-key"><span class="ck-sw ck-sw--copy"></span><span>Copies of training rows</span></li>`
    + `<li class="ck-key"><span class="ck-sw"></span><span>Rows it had not trained on</span></li></ul>`
    + `</section>`;
}

// ── the component ────────────────────────────────────────────────────────────

/**
 * "What it checked vs what it is judged on" for one run or fork child, or "" when there is nothing to show yet (a
 * tabular run before scoring, a robot run with neither checked positions nor hidden results, an older batch without
 * the numbers). `key` is the run id or "fork/child", `batch` the batch id for the motion file URLs.
 */
export function checkedView(batch: string, key: string, s: CheckedSubject | null | undefined, config: unknown, part: CheckedPart = "full"): string {
  if (!s) return "";
  if (isPushBatch(config)) return pushChecked(batch, key, s, config, part);
  if (isHumanoid(config)) return strikeChecked(batch, key, s, config, part);
  if (isMotionBatch(config)) return robotChecked(batch, key, s, config, part);
  // A tabular run has no map: its bars are the whole of it.
  return part === "map" ? "" : tabularChecked(key, s, config);
}

// ── the clicks ───────────────────────────────────────────────────────────────

/** Enough of an element for `pressDot` (the DOM, or a test's stand-in). */
export interface DotEl {
  dataset: Record<string, string | undefined>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  closest(selector: string): unknown;
}
/** The run page's player, as far as a dot needs it: something to send the episode to. */
export interface PlayerEl { dispatchEvent(e: Event): boolean }
interface MapEl {
  dataset: Record<string, string | undefined>;
  querySelectorAll(selector: string): ArrayLike<DotEl>;
  querySelector(selector: string): { innerHTML: string } | null;
  closest?(selector: string): { querySelector(selector: string): PlayerEl | null } | null;
}

/** What a dot on the run page's map sends that page's player (robot/viewer.ts listens): the episode's recording, null
 *  when none was saved, and its label. */
export const PLAY_EVENT = "rb-play";
export interface PlayDetail { file: string | null; label: string }
/** What the player says when it starts an episode (`detail.file`), so the map marks the dot it plays, or none. */
export const PICKED_EVENT = "rb-picked";

/** A dot was pressed: mark it (and only it) pressed, and play its episode: in the run page's player when the map is
 *  that page's (`data-ck-play`), else in the map's own player. Returns the motion path. */
export function pressDot(dot: DotEl): string | null {
  const map = dot.closest("[data-ck]") as MapEl | null;
  if (!map) return null;
  const all = map.querySelectorAll("[data-ck-dot]");
  for (let i = 0; i < all.length; i++) all[i].setAttribute("aria-pressed", String(all[i] === dot));
  const result = dot.dataset.ckResult as HiddenOutcome | PushOutcome | undefined;
  const label = dot.getAttribute("aria-label") ?? "";
  const motion = dot.dataset.ckMotion || null;
  if (map.dataset.ckPlay != null) {
    const target = map.closest?.("[data-rb-deck]")?.querySelector("[data-robot-view]");
    const detail: PlayDetail = { file: motion, label };
    target?.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail }));
    return motion;
  }
  const player = map.querySelector("[data-ck-player]");
  if (player && result && (isOutcome(result) || isPushOutcome(result))) {
    player.innerHTML = episodeView(map.dataset.batch ?? "", map.dataset.ckKey ?? "", { label, result, motion });
  }
  return motion;
}

/** Listen for presses on the maps under `root`. Native buttons, so Enter and Space press them too. */
export function wireChecked(root: Pick<Document, "addEventListener" | "removeEventListener">): () => void {
  const onClick = (e: Event): void => {
    const t = e.target as Element | null;
    const dot = t?.closest?.("[data-ck-dot]") as DotEl | null | undefined;
    if (dot) pressDot(dot);
  };
  // The run page's player started an episode: the dot of that recording shows pressed, or none does (one of the run's
  // own episodes, picked from its list).
  const onPicked = (e: Event): void => {
    const deck = (e.target as Element | null)?.closest?.("[data-rb-deck]");
    if (!deck) return;
    const file = (e as CustomEvent<{ file?: string }>).detail?.file ?? "";
    deck.querySelectorAll<HTMLElement>("[data-ck-play] [data-ck-dot]").forEach((d) => {
      d.setAttribute("aria-pressed", String(!!file && d.dataset.ckMotion === file));
    });
  };
  root.addEventListener("click", onClick);
  root.addEventListener(PICKED_EVENT, onPicked);
  return () => { root.removeEventListener("click", onClick); root.removeEventListener(PICKED_EVENT, onPicked); };
}

if (typeof document !== "undefined") wireChecked(document);
