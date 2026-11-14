// Brings the robot placeholders (robot/markup.ts) to life: a `[data-robot-view]` becomes the run page's 3D player, a
// `[data-robot-thumb]` a looping thumbnail. The views are pure strings patched in by morph.ts, so this watches the
// document for placeholders coming and going, mounts each once, and disposes it when it leaves the page.
// three.js (robot/viewer.ts) is loaded the first time a placeholder appears: a tabular batch never downloads it.

import "./robot.css";

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
