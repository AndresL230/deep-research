// The robot floor: one canvas behind the last chapter of the landing page. A camera that never turns looks down
// on a long factory floor, and the page's scrolling slides it from station to station (floorplan.ts) while the
// robots at each one keep working on their own time (stations.ts). contour.ts draws it: flat colour and a line on
// every edge.
//
// Like the other scenes this is loaded on demand and owns the canvas in `host`. The chapter's card is the page's
// own markup; this only says which chapter is open and how full each bar is, and listens for a press on a bar.

import { PerspectiveCamera, Scene, Vector3, type Mesh } from "three";
import { createContour, FLOOR_INK, tintColors } from "./contour";
import { smooth } from "./ease";
import { STATIONS, Trail, VIEW, cardAt, lookAt, progressAt, standOff, stopFor } from "./floorplan";
import { createKit, loopWhileSeen, type Loop, type SceneTone } from "./kit";
import { buildStations, type Stage } from "./stations";

export interface FactoryOptions {
  /** Which palette to draw in. */
  tone: SceneTone;
  /** The tall element the chapter is pinned in: how far the page has scrolled through it moves the camera.
   *  Without it the camera stays on the first station. */
  pin: HTMLElement | null;
  /** The element the page scrolls in, or null for the window. */
  scroller: Element | null;
  /** The chapter's card: its `data-chapter` and each bar's `--lp-fill` are kept up to date. */
  card: HTMLElement | null;
  /** Tour the floor on its own clock instead of the page's: rest at a station, glide to the next, and back the
   *  other way, for a card that does not pin. */
  tour?: boolean;
}

export interface Factory {
  dispose(): void;
}

/** How quickly the camera catches up with the page's scrolling, per second: a wheel's steps become one motion. */
const CATCH_UP = 7;
/** Under this width, in CSS pixels, the card is as wide as the screen; the scene is raised by this share of the
 *  screen's height to clear it. */
const NARROW = 860;
const RAISE = 0.1;
/** Where each station's loop stands in the still picture shown when motion is not welcome. */
const STILL = 2.6;

/** Something to steer the scene by hand while working on it. Only there in development. */
interface Steer {
  /** Hold the camera `p` of the way through, or let it follow the page again. */
  seek(p: number | null): void;
  /** Hold every station's loop at `t` seconds, or let them run. */
  at(t: number | null): void;
}

/** Mount the scene in `host` and start it. `host` gets `data-ready` once it has drawn. */
export function mountFactory(host: HTMLElement, options: FactoryOptions): Factory {
  const kit = createKit(host, options.tone);
  if (!kit) return { dispose() { /* no WebGL: the card still reads */ } };
  const { renderer } = kit;
  const ink = FLOOR_INK[options.tone];
  const contour = createContour(renderer, ink);

  const scene = new Scene();
  scene.add(contour.floor);
  const trail = new Trail();
  const meshes: Mesh[] = [];
  const stage: Stage = { contour, tints: tintColors(ink), scene, trail, meshes };
  const stations = buildStations(stage);

  const camera = new PerspectiveCamera(VIEW.fov, 1, 1, 96);
  const back = new Vector3(...VIEW.back).normalize();
  const target = new Vector3();
  const anchor = new Vector3(0, 0, 0);
  let distance = VIEW.distance;
  /** How far toward the camera the point it looks at is moved, along x and (the other way) along z. */
  let nearer = 0;
  // The camera never turns: aim it once.
  camera.position.copy(back);
  camera.lookAt(0, 0, 0);

  const { pin, scroller, card } = options;
  /** On tour: how long the camera rests at a station, and how long it takes to glide to the next. */
  const REST = 5.2;
  const GLIDE = 1.8;
  const toured = (): number => {
    const legs = STATIONS - 1;
    const cycle = (REST + GLIDE) * legs * 2;
    const at = time % cycle;
    const leg = Math.floor(at / (REST + GLIDE));
    const into = at - leg * (REST + GLIDE);
    const u = into < REST ? 0 : smooth((into - REST) / GLIDE);
    // Out along the stations and back: 0, 1, 2, 3, 2, 1.
    const from = leg < legs ? leg : 2 * legs - leg;
    const to = leg < legs ? leg + 1 : from - 1;
    return stopFor(from) + (stopFor(to) - stopFor(from)) * u;
  };
  const readProgress = (): number => {
    if (options.tour) return toured();
    if (!pin) return 0;
    const box = pin.getBoundingClientRect();
    const portTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const portHeight = scroller ? scroller.clientHeight : window.innerHeight;
    return progressAt(portTop - box.top, box.height - portHeight);
  };

  const bars = card ? Array.from(card.querySelectorAll<HTMLElement>("[data-lp-floor-step]")) : [];
  let shown = "";
  const showCard = (p: number): void => {
    if (!card) return;
    const view = cardAt(p);
    const key = `${view.chapter}:${view.fills.map((f) => f.toFixed(3)).join(",")}`;
    if (key === shown) return;
    shown = key;
    if (card.dataset.chapter !== String(view.chapter)) card.dataset.chapter = String(view.chapter);
    bars.forEach((bar, i) => {
      bar.style.setProperty("--lp-fill", view.fills[i].toFixed(3));
      bar.setAttribute("aria-current", i === view.chapter ? "step" : "false");
    });
  };

  let width = 0;
  let height = 0;
  /** How far through the chapter what is drawn stands; it trails the page a little. NaN before the first frame. */
  let progress = NaN;
  let time = 0;
  let heldProgress: number | null = null;
  let heldTime: number | null = null;

  const frame = (seconds: number, still: boolean): void => {
    if (!width || !height) return;
    const goal = heldProgress ?? readProgress();
    if (Number.isNaN(progress) || still || seconds === 0) progress = goal;
    else progress += (goal - progress) * (1 - Math.exp(-CATCH_UP * seconds));
    if (Math.abs(goal - progress) < 0.00005) progress = goal;
    time += seconds;
    showCard(goal);

    // On a narrow screen the card covers the bottom of the picture: look a little nearer, so the station sits
    // above it.
    const [x, z] = lookAt(progress);
    target.set(x + nearer, 0, z - nearer);
    camera.position.copy(target).addScaledVector(back, distance);
    camera.updateMatrixWorld();

    for (const station of stations) {
      const t = heldTime ?? (still ? STILL : time);
      station.update(((t % station.period) + station.period) % station.period);
    }
    trail.step(seconds);
    contour.trail(trail.cells);
    contour.render(scene, camera, heldTime ?? time, anchor);
    if (!host.dataset.ready) host.dataset.ready = "1";
  };

  let runner: Loop | null = null;
  let disposed = false;

  const resize = (): void => {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    // At least one and a half buffer pixels to a CSS pixel, so the lines stay clean on a plain screen.
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    distance = standOff(camera.aspect);
    // A tenth of the screen's height, as a length on the floor.
    const tall = 2 * Math.tan((VIEW.fov * Math.PI) / 360) * distance;
    nearer = width < NARROW && !options.tour ? (RAISE * tall) / VIEW.back[1] / Math.SQRT2 : 0;
    contour.resize(width, height);
    runner?.redraw();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(host);

  // A press on a bar scrolls the page to that chapter's station.
  const onPress = (e: Event): void => {
    const bar = (e.target as Element | null)?.closest<HTMLElement>("[data-lp-floor-step]");
    if (!bar || !pin) return;
    const box = pin.getBoundingClientRect();
    const portTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const portHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const now = scroller ? scroller.scrollTop : window.scrollY;
    const top = now + (box.top - portTop) + (box.height - portHeight) * stopFor(Number(bar.dataset.lpFloorStep) || 0);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (scroller ?? window).scrollTo({ top, behavior: calm ? "auto" : "smooth" });
  };
  card?.addEventListener("click", onPress);

  // While the loop is stopped (motion not welcome) the picture still follows the page.
  const onScroll = (): void => { if (runner && !runner.running) runner.redraw(); };
  const scrollTarget: EventTarget = scroller ?? window;
  scrollTarget.addEventListener("scroll", onScroll, { passive: true });

  resize();
  runner = loopWhileSeen(host, frame);

  const steered = window as unknown as { __lpFloor?: Steer };
  if (import.meta.env.DEV) {
    steered.__lpFloor = {
      seek(p) { heldProgress = p; progress = NaN; runner?.redraw(); },
      at(t) { heldTime = t; runner?.redraw(); },
    };
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      runner?.dispose();
      sizes.disconnect();
      card?.removeEventListener("click", onPress);
      scrollTarget.removeEventListener("scroll", onScroll);
      if (import.meta.env.DEV) delete steered.__lpFloor;
      for (const mesh of meshes) mesh.geometry.dispose();
      contour.dispose();
      kit.dispose();
      delete host.dataset.ready;
    },
  };
}
