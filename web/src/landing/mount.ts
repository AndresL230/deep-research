// Keeps the landing page's moving parts in step with the page. landing.ts only returns markup; the scenes are
// canvases with render loops, and the reveals, the folder's tabs and the small loops in the cards are script, so
// something has to start them when their elements appear and stop them when they go. main.ts calls `syncLanding`
// after every paint; calling it again with nothing changed does nothing.
//
// ribbon.ts, devices.ts, finder.ts and factory.ts (and three.js with them) are imported here on demand, so the rest
// of the app never loads them. The ribbon is on the first screen and starts at once; the others are loaded once the
// page is scrolled near them.

import type { Devices } from "./devices";
import type { Factory } from "./factory";
import type { Finder } from "./finder";
import { DEMO_SPLIT, demoRuns } from "./landing";
import type { Ribbon } from "./ribbon";

const tone = (host: HTMLElement): "dark" | "light" => (host.closest<HTMLElement>(".lp")?.dataset.lpTone === "dark" ? "dark" : "light");
const calm = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How near the screen an element has to come before its scene is loaded: early enough that it is drawn by the
 *  time it scrolls into view. */
const NEAR = "600px 0px";

interface Mounted<T> {
  host: HTMLElement;
  /** The palette it was built in: switching between white and black mode builds it again. */
  tone: "dark" | "light";
  near: IntersectionObserver;
  scene: Promise<T | null> | null;
}

/** A scene in the element `selector` finds. `sync` loads it once that element comes near (at once with `now`),
 *  disposes of it when the element goes or the mode changes, and returns the scene if it is loaded or on its way. */
function scene<T extends { dispose(): void }>(selector: string, load: (host: HTMLElement, root: ParentNode) => Promise<T>, now = false): { sync(root: ParentNode): Promise<T | null> | null } {
  let mounted: Mounted<T> | null = null;
  return {
    sync(root) {
      const host = root.querySelector<HTMLElement>(selector);
      if (mounted && (mounted.host !== host || (host && mounted.tone !== tone(host)))) {
        const gone = mounted;
        mounted = null;
        gone.near.disconnect();
        void gone.scene?.then((s) => s?.dispose());
      }
      if (host && !mounted) {
        const entry: Mounted<T> = {
          host,
          tone: tone(host),
          scene: null,
          near: new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting) || entry.scene) return;
            entry.near.disconnect();
            // The first screen goes first, and its intro plays before anything further down is built: building a
            // scene holds the page up for a moment, and the intro would lose that moment.
            // A scene that could not make a canvas (no WebGL, or the context was refused) leaves its host empty: the
            // host gets `data-still` and the page shows a picture of the scene there instead (landing.css, stills/).
            const still = (): void => { if (!host.querySelector("canvas")) host.dataset.still = "1"; };
            entry.scene = (now ? Promise.resolve() : introPlayed(root)).then(() => load(host, root))
              .then((s) => { still(); return s; }, () => { still(); return null; });
          }, { root: root instanceof Element ? root : null, rootMargin: NEAR }),
        };
        entry.near.observe(host);
        mounted = entry;
      }
      return mounted?.scene ?? null;
    },
  };
}

const scroller = (root: ParentNode): Element | null => (root instanceof Element ? root : null);

/** How long the hero's intro takes once it starts (landing.css: the ribbon's focus pull is the longest part). */
const INTRO_MS = 2600;
/** Longest the intro waits for the ribbon's first frame before it plays anyway. */
const INTRO_WAIT_MS = 1800;
let intro: { hero: HTMLElement; started: Promise<void> } | null = null;

/** Start the hero's intro (nav, pill, title, ribbon: `data-go` on the hero) once the ribbon has drawn its first
 *  frame, so none of it plays while the page is busy building the scene. Resolves when it has started. */
function startIntro(root: ParentNode): Promise<void> {
  const hero = root.querySelector<HTMLElement>(".lp-hero");
  if (!hero) return Promise.resolve();
  if (intro?.hero === hero) return intro.started;
  const started = new Promise<void>((done) => {
    const go = (): void => {
      if (hero.dataset.go) return done();
      hero.dataset.go = "1";
      for (const el of hero.querySelectorAll("[data-lp-rev]")) el.classList.add("is-in");
      done();
    };
    window.setTimeout(go, INTRO_WAIT_MS);
    void Promise.resolve(ribbon.sync(root)).then(() => requestAnimationFrame(() => requestAnimationFrame(go)));
  });
  intro = { hero, started };
  return started;
}

/** Resolves once the intro has played (at once on a page without a hero). */
const introPlayed = (root: ParentNode): Promise<void> =>
  startIntro(root).then(() => new Promise<void>((done) => window.setTimeout(done, calm() ? 0 : INTRO_MS)));

const ribbon = scene<Ribbon>("[data-lp-ribbon]", (host, root) =>
  import("./ribbon").then((m) => m.mountRibbon(host, { tone: tone(host), scroller: scroller(root) })), true);

const devices = scene<Devices>("[data-lp-devices]", (host) =>
  import("./devices").then((m) => m.mountDevices(host, { tone: tone(host), shown: deviceFor(currentTab(host)) })));

const finder = scene<Finder>("[data-lp-net]", (host, root) =>
  import("./finder").then((m) => m.mountFinder(host, { tone: tone(host), pin: null, scroller: scroller(root), runs: demoRuns(), split: DEMO_SPLIT, play: true })));

const factory = scene<Factory>("[data-lp-floor]", (host, root) =>
  import("./factory").then((m) => m.mountFactory(host, {
    tone: tone(host),
    pin: null,
    scroller: scroller(root),
    card: host.parentElement?.querySelector<HTMLElement>("[data-lp-floor-card]") ?? null,
    tour: true,
  })));

// ── the folder's tabs ────────────────────────────────────────────────────────

/** The device each tab shows: the terminal for the runs, the data bench for your own data. The split's tab shows
 *  the split finder's web instead. */
const deviceFor = (tab: number): number => (tab === 2 ? 1 : 0);
const currentTab = (inside: HTMLElement): number => Number(inside.closest<HTMLElement>("[data-lp-folder]")?.dataset.tab) || 0;
/** How long each tab stays open before the next one opens on its own: the split's long enough for the split finder
 *  to play through to the step it finds. */
const TAB_SECONDS = [7, 13, 8];

function setTab(folder: HTMLElement, tab: number, focus = false): void {
  const tabs = Array.from(folder.querySelectorAll<HTMLElement>("[data-lp-tab]"));
  const count = tabs.length;
  const i = ((tab % count) + count) % count;
  if (folder.dataset.tab === String(i) && !focus) return;
  folder.dataset.tab = String(i);
  tabs.forEach((t, k) => {
    t.setAttribute("aria-selected", String(k === i));
    t.tabIndex = k === i ? 0 : -1;
  });
  if (focus) tabs[i].focus();
  for (const stat of folder.querySelectorAll<HTMLElement>("[data-lp-stat]")) {
    const on = Number(stat.dataset.lpStat) === i;
    stat.hidden = !on;
    stat.classList.remove("is-on");
    // Played again from the start: the number arrives a letter at a time each time its tab opens.
    if (on) { void stat.offsetWidth; stat.classList.add("is-on"); }
  }
  for (const chip of folder.querySelectorAll<HTMLElement>("[data-lp-chip]")) chip.classList.toggle("is-on", Number(chip.dataset.lpChip) === i);
  const root = folder.closest(".pg-scroll") ?? document;
  if (i === 1) void finder.sync(root)?.then((f) => f?.restart());
  else void devices.sync(root)?.then((d) => d?.show(deviceFor(i)));
}

/** Wire a folder's tabs once: pressing one, the arrow keys, and opening the next on its own while the folder is on
 *  screen and nobody is pointing at it or in it. */
function wireFolder(folder: HTMLElement, root: ParentNode): void {
  let seen = false;
  let held = false;
  let since = performance.now();
  folder.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-lp-tab]");
    if (!t) return;
    setTab(folder, Number(t.dataset.lpTab));
    since = performance.now();
  });
  folder.addEventListener("keydown", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-lp-tab]");
    if (!t) return;
    const at = Number(t.dataset.lpTab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? 2 : null;
    if (to === null) return;
    e.preventDefault();
    setTab(folder, to, true);
    since = performance.now();
  });
  folder.addEventListener("pointerenter", () => { held = true; });
  folder.addEventListener("pointerleave", () => { held = false; since = performance.now(); });
  folder.addEventListener("focusin", () => { held = true; });
  folder.addEventListener("focusout", () => { held = false; since = performance.now(); });
  new IntersectionObserver((entries) => { seen = entries[entries.length - 1].isIntersecting; since = performance.now(); },
    { root: root instanceof Element ? root : null, threshold: 0.35 }).observe(folder);
  const tick = (): void => {
    if (!folder.isConnected) return;
    if (seen && !held && !calm() && performance.now() - since > (TAB_SECONDS[currentTab(folder)] ?? 7) * 1000) {
      setTab(folder, currentTab(folder) + 1);
      since = performance.now();
    }
    window.setTimeout(tick, 400);
  };
  tick();
}

// ── reveals and the small loops ──────────────────────────────────────────────

/** Elements already wired, one set for each kind of wiring (an element can have more than one), so a second paint
 *  does not wire them again. */
const revealed = new WeakSet<Element>();
const wired = { folder: new WeakSet<Element>(), rows: new WeakSet<Element>(), beam: new WeakSet<Element>() };

/** Add `is-in` to each `data-lp-rev` element as it comes into view, once; and `is-near` to each section a little
 *  before, which draws its line. */
function wireReveals(root: ParentNode): void {
  const port = root instanceof Element ? root : null;
  // The hero's own reveals wait for its intro (startIntro).
  const fresh = Array.from(root.querySelectorAll<HTMLElement>("[data-lp-rev]")).filter((el) => !revealed.has(el) && !el.closest(".lp-hero"));
  if (fresh.length) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    }, { root: port, rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    for (const el of fresh) { revealed.add(el); io.observe(el); }
  }
  const sections = Array.from(root.querySelectorAll<HTMLElement>(".lp-sec")).filter((el) => !revealed.has(el));
  if (sections.length) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-near");
        io.unobserve(e.target);
      }
    }, { root: port, rootMargin: "0px 0px -5% 0px" });
    for (const el of sections) { revealed.add(el); io.observe(el); }
  }
}

/** Run something every `ms` while `el` is on screen and motion is welcome; it stops when `el` leaves the page. */
function whileSeen(el: HTMLElement, root: ParentNode, ms: number, step: () => void): void {
  let seen = false;
  new IntersectionObserver((entries) => { seen = entries[entries.length - 1].isIntersecting; },
    { root: root instanceof Element ? root : null }).observe(el);
  const tick = (): void => {
    if (!el.isConnected) return;
    if (seen && !calm()) step();
    window.setTimeout(tick, ms);
  };
  window.setTimeout(tick, ms);
}

/** The run list rolls up a row at a time; rows further from the middle sit back. */
function wireRows(list: HTMLElement, root: ParentNode): void {
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".lp-row"));
  let at = 0;
  const place = (): void => {
    list.style.setProperty("--lp-roll", String(at - 2));
    const middle = at + 2;
    rows.forEach((row, i) => row.style.setProperty("--lp-far", Math.min(1, Math.abs(i - middle) / 3).toFixed(2)));
  };
  place();
  whileSeen(list, root, 1500, () => { at = (at + 1) % Math.max(1, rows.length - 4); place(); });
}

/** A light runs round one feature card's edge at a time. */
function wireBeam(feats: HTMLElement, root: ParentNode): void {
  const cards = Array.from(feats.querySelectorAll<HTMLElement>(".lp-feat"));
  let at = 0;
  cards[0]?.classList.add("is-lit");
  whileSeen(feats, root, 3000, () => {
    cards[at]?.classList.remove("is-lit");
    at = (at + 1) % cards.length;
    cards[at]?.classList.add("is-lit");
  });
}

/** Start whichever of the landing page's scenes and loops `root` has elements for, and dispose of a scene whose
 *  element is gone. `root` is the element the page scrolls in. */
export function syncLanding(root: ParentNode): void {
  ribbon.sync(root);
  void startIntro(root);
  devices.sync(root);
  finder.sync(root);
  factory.sync(root);
  wireReveals(root);
  for (const folder of root.querySelectorAll<HTMLElement>("[data-lp-folder]")) {
    if (wired.folder.has(folder)) continue;
    wired.folder.add(folder);
    wireFolder(folder, root);
  }
  for (const list of root.querySelectorAll<HTMLElement>(".lp-rows")) {
    if (wired.rows.has(list)) continue;
    wired.rows.add(list);
    wireRows(list, root);
  }
  for (const feats of root.querySelectorAll<HTMLElement>("[data-lp-beam]")) {
    if (wired.beam.has(feats)) continue;
    wired.beam.add(feats);
    wireBeam(feats, root);
  }
}
