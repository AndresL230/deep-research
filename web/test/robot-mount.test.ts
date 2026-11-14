// The 3D viewer chunk is imported once per page however often the placeholders are scanned, and a failed import is
// shown once and never retried in a loop (robot/mount.ts). The loop this guards against: writing the error into a
// placeholder changes the document, the observer scans again, and a placeholder forgotten on failure was imported
// again on the next frame, forever (thousands of requests for the chunk a minute).

import { describe, expect, it } from "vitest";
import { Mounts, failureText, loadOnce, type Viewer } from "../src/robot/mount";

type Fake = HTMLElement & { remove(): void; writes: number };

/** Enough of an element for mount.ts: a placeholder that is on the page until `remove()`, counting its text writes. */
function placeholder(kind: "view" | "thumb"): Fake {
  const classes = new Set<string>();
  let text = "";
  const el = {
    isConnected: true,
    writes: 0,
    get textContent(): string { return text; },
    set textContent(t: string) { text = t; el.writes++; },
    dataset: {},
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    hasAttribute: (name: string) => name === (kind === "view" ? "data-robot-view" : "data-robot-thumb"),
    remove(): void { el.isConnected = false; },
  };
  return el as unknown as Fake;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeViewer(): Viewer & { players: number; thumbs: number; disposed: number } {
  const v = {
    players: 0, thumbs: 0, disposed: 0,
    mountPlayer: () => { v.players++; return { dispose: () => { v.disposed++; } }; },
    mountThumb: () => { v.thumbs++; return { dispose: () => { v.disposed++; } }; },
  };
  return v;
}

describe("loadOnce", () => {
  it("loads once for every caller", async () => {
    let calls = 0;
    const load = loadOnce(() => { calls++; return Promise.resolve("viewer"); });
    const all = await Promise.all([load(), load(), load()]);
    expect(all).toEqual(["viewer", "viewer", "viewer"]);
    await load();
    expect(calls).toBe(1);
  });

  it("retries a failure once after a pause, then keeps the failure", async () => {
    let calls = 0;
    const pauses: number[] = [];
    const load = loadOnce(() => { calls++; return Promise.reject(new Error("Failed to fetch dynamically imported module")); }, 2000,
      (ms) => { pauses.push(ms); return Promise.resolve(); });
    for (let i = 0; i < 50; i++) await expect(load()).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(2);
    expect(pauses).toEqual([2000]);
  });

  it("succeeds on the retry when the first try was a blip", async () => {
    let calls = 0;
    const load = loadOnce(() => (++calls === 1 ? Promise.reject(new Error("blip")) : Promise.resolve("viewer")), 0, () => Promise.resolve());
    expect(await load()).toBe("viewer");
    expect(await load()).toBe("viewer");
    expect(calls).toBe(2);
  });
});

describe("Mounts", () => {
  it("loads the viewer once for many placeholders and repeated scans, and mounts each placeholder once", async () => {
    let loads = 0;
    const v = fakeViewer();
    const mounts = new Mounts(loadOnce(() => { loads++; return Promise.resolve(v); }));
    const view = placeholder("view");
    const thumbs = [placeholder("thumb"), placeholder("thumb"), placeholder("thumb")];
    // Every paint (and every frame a mutation lands in) scans again.
    for (let i = 0; i < 100; i++) mounts.scan([view, ...thumbs]);
    await settle();
    for (let i = 0; i < 100; i++) mounts.scan([view, ...thumbs]);
    await settle();
    expect(loads).toBe(1);
    expect(v.players).toBe(1);
    expect(v.thumbs).toBe(3);
    // A new placeholder later (a fork child appears): mounted from the loaded viewer, no new import.
    const later = placeholder("thumb");
    mounts.scan([view, ...thumbs, later]);
    await settle();
    expect(loads).toBe(1);
    expect(v.thumbs).toBe(4);
  });

  it("disposes a placeholder that left the page", async () => {
    const v = fakeViewer();
    const mounts = new Mounts(loadOnce(() => Promise.resolve(v)));
    const a = placeholder("thumb");
    mounts.scan([a]);
    await settle();
    a.remove();
    mounts.scan([]);
    expect(v.disposed).toBe(1);
    expect(mounts.mounted.size).toBe(0);
  });

  it("shows a failed import once and does not import again however often the page is scanned", async () => {
    let loads = 0;
    const err = new Error("Failed to fetch dynamically imported module: http://localhost/assets/viewer-OLD.js");
    const mounts = new Mounts(loadOnce(() => { loads++; return Promise.reject(err); }, 0, () => Promise.resolve()));
    const view = placeholder("view");
    const thumb = placeholder("thumb");
    // The error text written into each placeholder is a mutation, so the observer scans again: many times over.
    for (let round = 0; round < 20; round++) {
      mounts.scan([view, thumb]);
      await settle();
    }
    expect(loads).toBe(2); // the first try and its one retry
    expect(view.classList.contains("is-error")).toBe(true);
    expect(view.textContent).toBe(failureText(err));
    expect(view.textContent).toContain("Reload the page");
    expect(thumb.textContent).toBe(failureText(err));
    // Written once each: a placeholder forgotten on failure would be mounted (and fail) again on every scan.
    expect(view.writes).toBe(1);
    expect(thumb.writes).toBe(1);
    // A placeholder drawn after the failure shows it too, without another import.
    const later = placeholder("thumb");
    mounts.scan([view, thumb, later]);
    await settle();
    expect(loads).toBe(2);
    expect(later.textContent).toBe(failureText(err));
  });

  it("a mount that throws marks that placeholder only, and the viewer is not imported again", async () => {
    let loads = 0;
    const v = fakeViewer();
    v.mountPlayer = () => { throw new Error("no scene"); };
    const mounts = new Mounts(loadOnce(() => { loads++; return Promise.resolve(v); }));
    const view = placeholder("view");
    const thumb = placeholder("thumb");
    for (let round = 0; round < 20; round++) {
      mounts.scan([view, thumb]);
      await settle();
    }
    expect(loads).toBe(1);
    expect(view.textContent).toBe(failureText(new Error("no scene")));
    expect(view.writes).toBe(1);
    expect(v.thumbs).toBe(1);
  });

  it("forget mounts a placeholder again on the next scan, from the loaded viewer", async () => {
    let loads = 0;
    const v = fakeViewer();
    const mounts = new Mounts(loadOnce(() => { loads++; return Promise.resolve(v); }));
    const thumb = placeholder("thumb");
    mounts.scan([thumb]);
    await settle();
    mounts.forget(thumb);
    mounts.scan([thumb]);
    await settle();
    expect(v.disposed).toBe(1);
    expect(v.thumbs).toBe(2);
    expect(loads).toBe(1);
  });
});
