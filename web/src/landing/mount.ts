// Keeps the landing page's 3D scenes in step with the page. landing.ts only returns markup; a scene is a canvas
// with a render loop, so something has to start it when its element appears, stop it when the element goes, and
// tell the devices which item of the list is open. main.ts calls `syncLanding` after every paint.
//
// scene.ts, devices.ts, finder.ts and factory.ts (and three.js with them) are imported here on demand, so the rest
// of the app never loads them. The devices, the split finder and the robot floor are below the first screen: each
// is loaded once the page is scrolled near it.

import type { Devices } from "./devices";
import type { Factory } from "./factory";
import type { Finder } from "./finder";
import { LANDING, demoRuns } from "./landing";
import type { HeroScene } from "./scene";

let hero: { host: HTMLElement; scene: Promise<HeroScene | null> } | null = null;

const tone = (host: HTMLElement): "dark" | "light" => (host.closest<HTMLElement>(".lp")?.dataset.lpTone === "light" ? "light" : "dark");

/** How near the screen an element has to come before its scene is loaded: early enough that it is drawn by the
 *  time it scrolls into view. */
const NEAR = "600px 0px";

interface Mounted<T> {
  host: HTMLElement;
  /** Watches for the element coming near the screen, until it does. */
  near: IntersectionObserver;
  /** Null until then. */
  scene: Promise<T | null> | null;
}

/** A scene under the first screen, in the element `selector` finds. `sync` loads it once that element comes near,
 *  disposes of it when the element goes, and returns the scene if it is loaded or on its way. */
function later<T extends { dispose(): void }>(selector: string, load: (host: HTMLElement, root: ParentNode) => Promise<T>): { sync(root: ParentNode): Promise<T | null> | null } {
  let mounted: Mounted<T> | null = null;
  return {
    sync(root) {
      const host = root.querySelector<HTMLElement>(selector);
      if (mounted && mounted.host !== host) {
        const gone = mounted;
        mounted = null;
        gone.near.disconnect();
        void gone.scene?.then((scene) => scene?.dispose());
      }
      if (host && !mounted) {
        const entry: Mounted<T> = {
          host,
          scene: null,
          near: new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting) || entry.scene) return;
            entry.near.disconnect();
            // The hero goes first: on a short page the next scene is near from the start, and building it must
            // not hold up the one that is already on screen. Without the scene the copy beside it still reads.
            entry.scene = Promise.resolve(hero?.scene).then(() => load(host, root)).catch(() => null);
            // The margin is measured from the box that scrolls: against the window it would be clipped away by it.
          }, { root: root instanceof Element ? root : null, rootMargin: NEAR }),
        };
        entry.near.observe(host);
        mounted = entry;
      }
      return mounted?.scene ?? null;
    },
  };
}

/** Which item of the list the devices' element sits beside is open. */
const openItem = (host: HTMLElement | null): number => Number(host?.closest<HTMLElement>("[data-lp-open]")?.dataset.lpOpen) || 0;

const devices = later<Devices>("[data-lp-devices]", (host) =>
  import("./devices").then((m) => m.mountDevices(host, { tone: tone(host), shown: openItem(host) })));

const finder = later<Finder>("[data-lp-net]", (host, root) =>
  import("./finder").then((m) => m.mountFinder(host, {
    tone: tone(host),
    pin: host.closest<HTMLElement>("[data-lp-pin]"),
    scroller: root instanceof Element ? root : null,
    runs: demoRuns(),
    split: LANDING.finder.split,
  })));

const factory = later<Factory>("[data-lp-floor]", (host, root) =>
  import("./factory").then((m) => m.mountFactory(host, {
    tone: tone(host),
    pin: host.closest<HTMLElement>("[data-lp-floor-pin]"),
    scroller: root instanceof Element ? root : null,
    card: host.parentElement?.querySelector<HTMLElement>("[data-lp-floor-card]") ?? null,
  })));

/** Mount whichever of the landing page's scenes `root` has an element for, dispose of a scene whose element is
 *  gone, and show the open item's device. `root` is the element the page scrolls in. Calling it again with nothing
 *  changed does nothing. */
export function syncLanding(root: ParentNode): void {
  const sceneHost = root.querySelector<HTMLElement>("[data-lp-scene]");
  if (hero && hero.host !== sceneHost) {
    const gone = hero;
    hero = null;
    void gone.scene.then((scene) => scene?.dispose());
  }
  if (sceneHost && !hero) {
    const page = sceneHost.closest<HTMLElement>(".lp");
    hero = {
      host: sceneHost,
      scene: import("./scene")
        .then((m) => m.mountHeroScene(sceneHost, {
          tone: tone(sceneHost),
          labels: LANDING.labels,
          copy: page?.querySelector<HTMLElement>("[data-lp-copy]"),
          nav: page?.querySelector<HTMLElement>("[data-lp-nav]"),
        }))
        // Without the scene the page is its copy on a plain ground, which still reads.
        .catch(() => null),
    };
  }

  const shown = openItem(root.querySelector<HTMLElement>("[data-lp-devices]"));
  void devices.sync(root)?.then((scene) => scene?.show(shown));
  finder.sync(root);
  factory.sync(root);
}
