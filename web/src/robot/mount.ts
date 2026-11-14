// Brings the robot placeholders (robot/markup.ts) to life: a `[data-robot-view]` becomes the run page's 3D player, a
// `[data-robot-thumb]` a looping thumbnail. The views are pure strings patched in by morph.ts, so this watches the
// document for placeholders coming and going, mounts each once, and disposes it when it leaves the page.
// three.js (robot/viewer.ts) is loaded the first time a placeholder appears: a tabular batch never downloads it.

import "./robot.css";
import { motionChanged } from "./data";

interface Mounted { dispose(): void }
type Viewer = typeof import("./viewer");

const mounted = new Map<HTMLElement, Mounted | null>();
let viewer: Promise<Viewer> | null = null;
let queued = 0;

function scan(): void {
  queued = 0;
  for (const [el, m] of mounted) {
    if (!el.isConnected) { m?.dispose(); mounted.delete(el); }
  }
  const els = document.querySelectorAll<HTMLElement>("[data-robot-view], [data-robot-thumb]");
  if (!els.length) return;
  for (const el of Array.from(els)) {
    if (mounted.has(el)) continue;
    mounted.set(el, null);
    viewer ??= import("./viewer");
    viewer.then((v) => {
      if (!el.isConnected || mounted.get(el) !== null) return;
      mounted.set(el, el.hasAttribute("data-robot-view") ? v.mountPlayer(el) : v.mountThumb(el));
    }).catch((e: unknown) => {
      viewer = null;
      mounted.delete(el);
      el.classList.add("is-error");
      el.textContent = `Couldn't load the 3D viewer: ${e instanceof Error ? e.message : String(e)}`;
    });
  }
}

function schedule(): void {
  if (!queued) queued = requestAnimationFrame(scan);
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const start = (): void => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
}

/**
 * A live run's motion file arrived (a `motion` event on the websocket). A new file needs nothing here: the case update
 * that follows lists it, and the views draw a new placeholder for it. A file saved again under the same path does: the
 * thumbnails showing it, and a player on it by default (its last file), are mounted again on the new content.
 */
export function refreshMotion(batch: string, path: string): void {
  if (!motionChanged(batch, path)) return;
  let again = false;
  for (const [el, m] of mounted) {
    if (el.dataset.batch !== batch) continue;
    const shows = el.hasAttribute("data-robot-thumb") ? el.dataset.file === path : lastFile(el) === path;
    if (!shows) continue;
    m?.dispose();
    mounted.delete(el);
    // A player draws itself from scratch when mounted; a thumbnail adds its canvas in front of its label.
    el.querySelectorAll(".rb-thumb-c").forEach((c) => c.remove());
    el.classList.remove("is-ready", "is-error");
    again = true;
  }
  if (again) schedule();
}

function lastFile(el: HTMLElement): string | undefined {
  try {
    const files = JSON.parse(el.dataset.files ?? "[]") as unknown;
    return Array.isArray(files) && typeof files.at(-1) === "string" ? (files.at(-1) as string) : undefined;
  } catch { return undefined; }
}
