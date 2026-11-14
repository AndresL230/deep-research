// Brings the robot placeholders (robot/markup.ts) to life: a `[data-robot-view]` becomes the run page's 3D player, a
// `[data-robot-thumb]` a looping thumbnail. The views are pure strings patched in by morph.ts, so this watches the
// document for placeholders coming and going, mounts each once, and disposes it when it leaves the page.
// three.js (robot/viewer.ts) is loaded the first time a placeholder appears: a tabular batch never downloads it.
//
// The chunk is imported ONCE per page, and a failure is final (after one retry): a placeholder that could not be
// mounted shows the error and stays marked as handled. Writing that error changes the document, which the observer
// below sees and answers with another scan, so a placeholder forgotten on failure would be imported again on the next
// frame, and again, forever (a tab open across a rebuild asks for a chunk that no longer exists, and some browsers
// fetch a failed module again on every try).

import "./robot.css";
import { motionChanged } from "./data";

interface Mounted { dispose(): void }
export type Viewer = Pick<typeof import("./viewer"), "mountPlayer" | "mountThumb">;

/** How long to wait before the one retry of a failed import (a network blip; a missing chunk fails again). */
const RETRY_MS = 2000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `load` called at most twice in all (once, and once more `retryMs` later if that failed), its promise shared by
 *  every caller and kept, failure included. */
export function loadOnce<T>(load: () => Promise<T>, retryMs = RETRY_MS, pause: (ms: number) => Promise<void> = wait): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load().catch(() => pause(retryMs).then(load)));
}

/** A placeholder whose viewer could not be loaded or mounted: nothing to dispose, and never tried again. */
const FAILED: Mounted = { dispose: () => undefined };

export function failureText(e: unknown): string {
  const why = e instanceof Error ? e.message : String(e);
  return `Couldn't load the 3D viewer: ${why}. Reload the page to try again.`;
}

/** The placeholders on the page and what each is mounted as (null while the viewer loads). */
export class Mounts {
  readonly mounted = new Map<HTMLElement, Mounted | null>();

  constructor(private readonly viewer: () => Promise<Viewer>) {}

  /** Dispose what left the page and mount the placeholders not seen before. */
  scan(els: Iterable<HTMLElement>): void {
    for (const [el, m] of this.mounted) {
      if (!el.isConnected) { m?.dispose(); this.mounted.delete(el); }
    }
    for (const el of els) {
      if (this.mounted.has(el)) continue;
      this.mounted.set(el, null);
      this.viewer().then((v) => {
        if (!el.isConnected || this.mounted.get(el) !== null) return;
        this.mounted.set(el, el.hasAttribute("data-robot-view") ? v.mountPlayer(el) : v.mountThumb(el));
      }).catch((e: unknown) => {
        if (!el.isConnected || this.mounted.get(el) !== null) return;
        // Kept in the map: the scan that writing this text sets off must leave it alone.
        this.mounted.set(el, FAILED);
        el.classList.add("is-error");
        el.textContent = failureText(e);
      });
    }
  }

  /** Mount `el` again on the next scan. */
  forget(el: HTMLElement): void {
    this.mounted.get(el)?.dispose();
    this.mounted.delete(el);
  }
}

const mounts = new Mounts(loadOnce(() => import("./viewer")));
let queued = 0;

function scan(): void {
  queued = 0;
  mounts.scan(document.querySelectorAll<HTMLElement>("[data-robot-view], [data-robot-thumb]"));
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
  for (const el of Array.from(mounts.mounted.keys())) {
    if (el.dataset.batch !== batch) continue;
    const shows = el.hasAttribute("data-robot-thumb") ? el.dataset.file === path : lastFile(el) === path;
    if (!shows) continue;
    mounts.forget(el);
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
