// Motion: the markup the views use for things that move (pure functions, like every view), and the small runtime
// main.ts calls after every paint.
//
// The timings come from one reference, measured frame by frame (system.css holds them as tokens):
//   text       each character rises 65% of its height over 0.79s, 5.6ms after the one before it, starting purple and
//              a little blurred; a changed word arrives the same way while the words around it stay
//   a number   counts up: 1.9s at a steady rate for the one large count, about 1.45s easing out for the others
//   a card     grows from nothing over 0.93s, easing out, and its contents fade in behind it
//   a status   a stepped spinner while it works; when it ends, a dot grows into a disc (0.3s) and its mark is drawn (0.3s)
//
// morph.ts makes a live element's attributes equal the next markup's on every paint, so nothing the runtime sets on
// an element survives by itself. What must survive is either inside a `data-keep` element (morph leaves those
// alone) or kept here in a WeakMap and put back after each paint (`syncMotion`), before the browser styles the page.

import { attr, esc } from "./ui";
import { pct, pts, tokens } from "./batch/format";

// ── markup ───────────────────────────────────────────────────────────────────

/**
 * Text that arrives a character at a time (or a word at a time, for a long sentence). The words are a keyed list, so
 * when the text changes only the words that changed are new elements, and only they animate. The plain text is
 * there too, for a screen reader.
 */
export function reveal(text: string, by: "char" | "word" = "char"): string {
  const words = text.split(/\s+/).filter(Boolean);
  let c = 0;
  const html = words.map((w, i) => {
    const inner = by === "word"
      ? `<span class="mo-c" style="--c:${c}">${esc(w)}</span>`
      : Array.from(w).map((ch, j) => `<span class="mo-c" style="--c:${c + j}">${esc(ch)}</span>`).join("");
    c += w.length + 1;
    return `<span class="mo-w" data-morph-key="${i}:${attr(w)}">${inner}${i === words.length - 1 ? "" : " "}</span>`;
  }).join("");
  return `<span class="mo-sr">${esc(text)}</span><span class="mo-t" aria-hidden="true" data-morph-list>${html}</span>`;
}

export type CountFmt = "int" | "dec2" | "pct" | "pct0" | "pts" | "usd" | "tokens";

const FORMAT: Record<CountFmt, (x: number) => string> = {
  int: (x) => Math.round(x).toLocaleString("en-US"),
  // A score read to two places ("13.03"): counted at two places all the way, so its width does not jump at the end.
  dec2: (x) => x.toFixed(2),
  pct: (x) => pct(x),
  pct0: (x) => pct(x, 0),
  pts: (x) => pts(x),
  // Not format.ts `usd`: on the way up a count passes through fractions of a cent, which that one prints as "<$0.01".
  usd: (x) => `$${x.toFixed(x < 10 ? 2 : 1)}`,
  tokens: (x) => tokens(Math.round(x)),
};

/**
 * A number that counts up to its value when it first shows, and from its old value when it changes. `text` is what
 * it reads once it has arrived (the caller's own formatting); the runtime writes the numbers on the way there.
 */
export function count(value: number | null | undefined, fmt: CountFmt, text: string, opts: { linear?: boolean } = {}): string {
  if (value == null || Number.isNaN(value)) return `<span class="mo-n">${esc(text)}</span>`;
  return `<span class="mo-n" data-count="${value}" data-fmt="${fmt}" data-text="${attr(text)}"${opts.linear ? " data-linear" : ""}><span data-keep>${esc(text)}</span></span>`;
}

/** The spinner: eight ticks, each fainter than the one before it. CSS turns it a tick at a time. */
export function spinner(size = 14): string {
  const ticks = Array.from({ length: 8 }, (_, i) =>
    `<path d="M8 1.6v3.1" transform="rotate(${i * 45} 8 8)" opacity="${(0.16 + (0.84 * (i + 1)) / 8).toFixed(2)}"></path>`).join("");
  return `<svg class="ds-spin" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="butt" aria-hidden="true">${ticks}</svg>`;
}

const BADGE_PATH = {
  check: "M4.7 8.3 7 10.5 11.3 5.7",
  alert: "M8 4.2v4.6M8 11v.9",
  cross: "M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2",
  // Neither one thing nor the other: a level line.
  hold: "M4.8 8h6.4",
} as const;
export type BadgeKind = keyof typeof BADGE_PATH;

/** A finished thing's mark: a disc with a check, an alert, a cross or a level line drawn on it. */
export function badge(kind: BadgeKind, size = 14): string {
  return `<svg class="ds-badge ds-badge--${kind}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">`
    + `<circle class="ds-badge-c" cx="8" cy="8" r="8"></circle><path class="ds-badge-p" pathLength="1" d="${BADGE_PATH[kind]}"></path></svg>`;
}

export type ChipTone = "ok" | "bad" | "warn" | "live" | "idle";
export type ChipMark = "dot" | "spin" | BadgeKind;

/**
 * A status chip. It is keyed by what it says, so when the status changes the chip is a new element and its mark and
 * word animate in. `cls` adds the view's own classes.
 */
export function chip(label: string, tone: ChipTone, mark: ChipMark, cls = ""): string {
  const lead = mark === "dot" ? `<i class="ds-dot"></i>` : mark === "spin" ? spinner(12) : badge(mark, 14);
  return `<span class="ds-chip ds-chip--${tone}${cls ? ` ${cls}` : ""}" data-morph-key="chip:${attr(label)}:${mark}">`
    + `<span class="ds-ic">${lead}</span><span class="ds-chip-t">${reveal(label)}</span></span>`;
}

// ── the runtime ──────────────────────────────────────────────────────────────

const reduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The `data-io` elements that have been on screen, and how long each waits after the others that arrived with it.
 * The wait is for an element's arrival only: once what arrived with it has finished moving the wait is dropped, so
 * whatever changes inside it later (a status, a result) moves at once.
 */
const seen = new WeakSet<Element>();
const delays = new WeakMap<Element, { ms: number; at: number }>();
let io: IntersectionObserver | null = null;
let ioRoot: Element | null = null;
/** One step between things that come on screen together, and the most any of them waits. */
const STAGGER_MS = 70;
const STAGGER_MAX = 9;

function mark(el: Element): void {
  el.setAttribute("data-in", "");
  const d = delays.get(el);
  if (d?.ms) (el as HTMLElement).style.setProperty("--io-d", `${d.ms}ms`);
}

/** Drop an element's wait once nothing that arrived with it is still moving (loops, like a spinner, do not count). */
function settle(el: Element): void {
  if (!el.isConnected) { delays.delete(el); return; }
  const moving = (el as HTMLElement).getAnimations?.({ subtree: true }).some((a) =>
    a.playState !== "finished" && a.playState !== "idle" && a.effect?.getComputedTiming().iterations !== Infinity) ?? false;
  if (moving) { setTimeout(() => settle(el), 400); return; }
  delays.delete(el);
  (el as HTMLElement).style.removeProperty("--io-d");
}

function onSeen(entries: IntersectionObserverEntry[]): void {
  const fresh = entries.filter((e) => e.isIntersecting && !seen.has(e.target)).map((e) => e.target);
  if (!fresh.length) return;
  fresh.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  fresh.forEach((el, k) => {
    seen.add(el);
    const ms = Math.min(k, STAGGER_MAX) * STAGGER_MS;
    delays.set(el, { ms, at: performance.now() });
    io?.unobserve(el);
    mark(el);
    setTimeout(() => settle(el), ms + 1200);
  });
  if (ioRoot) syncCounts(ioRoot);
}

interface Counting { el: HTMLElement; from: number; to: number; t0: number; ms: number; linear: boolean; fmt: CountFmt }
/** What each count shows now and where it is going. */
const shown = new WeakMap<Element, { to: number; value: number }>();
const counting = new Map<Element, Counting>();
let countFrame = 0;

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 4);

function write(el: HTMLElement, text: string): void {
  const out = el.firstElementChild;
  if (out && out.textContent !== text) out.textContent = text;
}

function stepCounts(now: number): void {
  countFrame = 0;
  for (const [el, c] of counting) {
    if (!el.isConnected) { counting.delete(el); continue; }
    const p = Math.max(0, Math.min(1, (now - c.t0) / c.ms));
    const value = c.from + (c.to - c.from) * (c.linear ? p : easeOut(p));
    shown.set(el, { to: c.to, value });
    // The last frame reads exactly what the view wrote, whatever the formatter above would make of it.
    write(c.el, p >= 1 ? c.el.dataset.text ?? FORMAT[c.fmt](c.to) : FORMAT[c.fmt](value));
    if (p >= 1) counting.delete(el);
  }
  if (counting.size) countFrame = requestAnimationFrame(stepCounts);
}

function syncCounts(root: Element): void {
  const still = reduced();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-count]"))) {
    const to = Number(el.dataset.count);
    const fmt = (el.dataset.fmt ?? "int") as CountFmt;
    const was = shown.get(el);
    if (was && was.to === to) continue;
    if (still || !Number.isFinite(to)) { shown.set(el, { to, value: to }); write(el, el.dataset.text ?? ""); continue; }
    // A count waits, at zero, for the part of the page it is in to come on screen.
    const gate = el.closest("[data-io]");
    if (!was && gate && !seen.has(gate)) { write(el, FORMAT[fmt](0)); continue; }
    const linear = el.hasAttribute("data-linear");
    // A first count starts a moment after its card does; in a card that arrived long ago, at once.
    const d = gate ? delays.get(gate) : undefined;
    const wait = was ? 0 : d ? Math.max(0, d.at + d.ms + 250 - performance.now()) : gate ? 0 : 250;
    counting.set(el, { el, from: was?.value ?? 0, to, t0: performance.now() + wait, ms: was ? 600 : linear ? 1900 : 1450, linear, fmt });
    shown.set(el, { to, value: was?.value ?? 0 });
    if (!was) write(el, FORMAT[fmt](0));
  }
  if (counting.size && !countFrame) countFrame = requestAnimationFrame(stepCounts);
}

/**
 * After every paint: put back what morph took off (which parts have been on screen), watch the new parts, and start
 * any number that has somewhere to go. `scroller` is the element the page scrolls in.
 */
export function syncMotion(root: HTMLElement, scroller: HTMLElement): void {
  if (typeof IntersectionObserver === "undefined" || reduced()) {
    for (const el of Array.from(root.querySelectorAll("[data-io]"))) { seen.add(el); el.setAttribute("data-in", ""); }
  } else {
    if (!io || ioRoot !== scroller) {
      io?.disconnect();
      ioRoot = scroller;
      // A part counts as on screen once its edge is a little way in, so it is not missed at the very bottom.
      io = new IntersectionObserver(onSeen, { root: scroller, rootMargin: "0px 0px -6% 0px", threshold: 0 });
    }
    for (const el of Array.from(root.querySelectorAll("[data-io]"))) {
      if (seen.has(el)) mark(el);
      else io.observe(el);
    }
  }
  syncCounts(root);
}
