// The landing page (src/landing/): its route, its markup, and the parts of its 3D scenes that are plain arithmetic:
// the hero loop's timing, the solids' geometry, where the hero's scene is placed, what the two devices under the
// hero play, and the split finder's chapter (its web of points and how it follows the page's scrolling). Drawing
// any of it needs WebGL, so scene.ts, devices.ts and finder.ts are checked by eye in a browser.

import { describe, expect, it } from "vitest";
import { parseRoute, routeHash, type Route } from "../src/batch/model";
import { BENCH_LOOP, BENCH_RESET, HELD, ROWS, SHEET, TWINS, benchAt, benchDone } from "../src/landing/bench";
import { CHAPTER, REVEAL_SOFT, chapterAt, chapterPoster, clockAt } from "../src/landing/chapter";
import { clamp01, easeInOutCubic, easeOutCubic, easeOutQuad, smooth } from "../src/landing/ease";
import { fitScene, type FitInput } from "../src/landing/fit";
import {
  LEAST_WIDTH, STATIONS, TILE, TRAIL_CELLS, TRAIL_FADE, Trail, VIEW, WAYPOINTS, cardAt, lookAt, progressAt, standOff, stopFor,
} from "../src/landing/floorplan";
import { STEP_GLYPHS, TASK_GLYPHS, VERDICT_GLYPHS } from "../src/landing/glyphs";
import { LANDING, demoRuns, landingView } from "../src/landing/landing";
import { linksWithin, nearest, orders, pickSpread, spherePoints, turn, walk } from "../src/landing/net";
import { SCREEN } from "../src/landing/screens";
import { band, circle, flanks, loop, prism, roundedPath, roundedRect, roundedSquare, tag, type Solid } from "../src/landing/shapes";
import { SCRIPTS, STAGES, TERMINAL_HOLD, scriptSeconds, terminalAt, type Line, type Mode } from "../src/landing/terminal";
import {
  HOP, LOOP, NODES, PATHS, PRESS_LEAD, TOSS_HEIGHT, TOSS_TIME, WAVE_LIFE,
  bannerLetter, bannerUp, frameAt, nodeClock, pathAt, posterFrame, press, swap, toss, wave,
} from "../src/landing/timeline";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const steps = (from: number, to: number, by: number): number[] => {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += by) out.push(x);
  return out;
};

describe("routes", () => {
  it("opens on the landing page and keeps the start panel at #/start", () => {
    expect(parseRoute("")).toEqual({ name: "landing" });
    expect(parseRoute("#/")).toEqual({ name: "landing" });
    expect(parseRoute("#/start")).toEqual({ name: "home" });
    expect(parseRoute("#/nowhere")).toEqual({ name: "landing" });
    expect(parseRoute("#/b/demo-batch")).toEqual({ name: "batch", id: "demo-batch" });
  });

  it("writes every route as the hash it reads back", () => {
    const routes: Route[] = [
      { name: "landing" }, { name: "home" }, { name: "batch", id: "demo-batch" },
      { name: "run", id: "demo-batch", run: "r01" }, { name: "child", id: "demo-batch", fork: "f1", child: "control-1" },
    ];
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
    expect(routeHash({ name: "landing" })).toBe("#/");
    expect(routeHash({ name: "home" })).toBe("#/start");
  });
});

describe("landingView", () => {
  const html = landingView();

  it("says what the product is, in one heading and one paragraph", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(text(html)).toContain(LANDING.title);
    expect(text(html)).toContain(LANDING.lede);
    expect(text(html)).toContain(LANDING.brand);
  });

  it("links to the start panel and to the demo replay with real links", () => {
    expect(html).toContain('<a class="lp-cta" href="#/start">Start a batch</a>');
    expect(html).toContain('href="#/b/demo-batch"');
    expect(html).toContain('<a class="lp-brand" href="#/">');
    // Plain links: the app's click handler has nothing to do for them.
    expect(html).not.toContain("data-act=");
  });

  it("gives the scene an element that the patcher leaves alone and screen readers skip", () => {
    const host = html.match(/<div class="lp-scene"[^>]*>/)![0];
    expect(host).toContain("data-lp-scene");
    expect(host).toContain("data-keep");
    expect(host).toContain('aria-hidden="true"');
    expect(html).toContain("data-lp-copy");
    expect(html).toContain("data-lp-nav");
  });

  it("is dark unless its light version is asked for", () => {
    expect(html).toContain('<div class="lp" data-lp-tone="dark"');
    expect(landingView("light")).toContain('<div class="lp" data-lp-tone="light"');
    // Only the tone differs: the words and the links are the same page.
    expect(landingView("light").replace('data-lp-tone="light"', 'data-lp-tone="dark"')).toBe(html);
  });

  it("has one label for each line of the scene and one icon for each step", () => {
    expect(LANDING.labels).toHaveLength(PATHS);
    expect(STEP_GLYPHS).toHaveLength(NODES - 2);
    expect(TASK_GLYPHS.length).toBeGreaterThan(1);
    expect(VERDICT_GLYPHS.length).toBeGreaterThan(1);
    for (const glyph of [...STEP_GLYPHS, ...TASK_GLYPHS, ...VERDICT_GLYPHS]) {
      expect(glyph.length).toBeGreaterThan(0);
      for (const op of glyph) {
        expect(op.d).toMatch(/^M/);
        expect(op.fill ?? op.stroke).toBeTruthy();
      }
    }
  });
});

describe("the list under the hero", () => {
  const html = landingView();
  const items = LANDING.more.items;
  const expanded = (page: string) => [...page.matchAll(/aria-expanded="(true|false)"/g)].map((m) => m[1] === "true");

  it("has one heading, and a button and a paragraph for each item", () => {
    expect(html.match(/<h2 class="lp-more-title"/g)).toHaveLength(1);
    expect(text(html)).toContain(LANDING.more.title);
    expect(html.match(/data-lp-item="/g)).toHaveLength(items.length);
    items.forEach((item, i) => {
      // A real button, which names the paragraph it opens.
      expect(html).toContain(`<button type="button" class="lp-item-t" data-lp-item="${i}"`);
      expect(html).toMatch(new RegExp(`data-lp-item="${i}"[^>]*aria-controls="lp-item-${i}"`));
      expect(html).toContain(`<div class="lp-item-b" id="lp-item-${i}">`);
      expect(text(html)).toContain(item.title);
      for (const words of item.words) expect(text(html)).toContain(typeof words === "string" ? words.trim() : words.chip);
    });
  });

  it("opens one item at a time, and the first unless told otherwise", () => {
    expect(expanded(html)).toEqual([true, false]);
    expect(html).toContain('data-lp-open="0"');
    const second = landingView("dark", 1);
    expect(expanded(second)).toEqual([false, true]);
    expect(second).toContain('data-lp-open="1"');
    for (const page of [html, second]) expect(page.match(/class="lp-item is-open"/g)).toHaveLength(1);
    // Anything that is not one of the items opens the first.
    for (const stray of [-1, items.length, 7, NaN]) expect(landingView("dark", stray)).toBe(html);
  });

  it("draws a path on a chip", () => {
    expect(html).toContain('<span class="lp-chip">/api/batches</span>');
  });

  it("gives the devices an element that the patcher leaves alone and screen readers skip", () => {
    const host = html.match(/<div class="lp-device"[^>]*>/)![0];
    expect(host).toContain("data-lp-devices");
    expect(host).toContain("data-keep");
    expect(host).toContain('aria-hidden="true"');
    // mount.ts reads which item is open from the section the devices are in.
    expect(html.indexOf("data-lp-open=")).toBeLessThan(html.indexOf("data-lp-devices"));
  });
});

describe("the split finder's chapter on the page", () => {
  const html = landingView();
  const f = LANDING.finder;

  it("comes after the list, with a heading and a paragraph of its own", () => {
    // The list's heading, this chapter's, and the robot floor's.
    expect(html.match(/<h2\b/g)).toHaveLength(3);
    expect(html).toContain(`<h2 class="lp-finder-title" id="lp-finder-title">${f.title}</h2>`);
    expect(html).toContain('aria-labelledby="lp-finder-title"');
    expect(text(html)).toContain(f.words.replace("'", "&#39;"));
    expect(html.indexOf('class="lp-more"')).toBeLessThan(html.indexOf('class="lp-pin"'));
    // Only the robot floor comes after it, and that is the last thing on the page.
    expect(html.indexOf('class="lp-pin"')).toBeLessThan(html.indexOf('class="lp-floor"'));
    expect(html.trimEnd().endsWith("</section>\n  </div>")).toBe(true);
  });

  it("pins one screen inside a tall section, and gives the scene an element that says what it shows", () => {
    // finder.ts reads its clock from the tall section and draws in the element inside the pinned screen.
    expect(html).toMatch(/<section class="lp-pin" data-lp-pin[^>]*>\s*<div class="lp-finder">/);
    const host = html.match(/<div class="lp-net"[^>]*>/)![0];
    expect(host).toContain("data-lp-net");
    expect(host).toContain("data-keep");
    expect(host).toContain('role="img"');
    expect(host).toContain(`aria-label="${f.alt}"`);
    expect(host).not.toContain("aria-hidden");
    expect(html.indexOf("data-lp-pin")).toBeLessThan(html.indexOf("data-lp-net"));
    // What the tag will say is in the label too, for someone who cannot see the scene.
    for (const said of [f.split.step, f.split.honest, f.split.inflated]) expect(f.alt).toContain(said);
  });

  it("has a coin for each of the demo batch's runs, and a tag that agrees with them", () => {
    const runs = demoRuns();
    expect(runs).toHaveLength(f.runs);
    expect(runs.map((r) => r.id)).toEqual(["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08", "r09", "r10", "r11", "r12"]);
    const honest = runs.filter((r) => r.honest).length;
    expect(runs.filter((r) => r.honest).map((r) => r.id)).toEqual(["r01", "r04", "r05", "r07", "r11", "r12"]);
    // Every honest run took the step and no inflated one did.
    expect(f.split.honest).toBe(`${honest} of ${honest}`);
    expect(f.split.inflated).toBe(`0 of ${runs.length - honest}`);
    expect(f.split.code).toContain("drop_duplicates");
  });
});

describe("the robot floor on the page", () => {
  const html = landingView();
  const f = LANDING.floor;

  it("pins one screen inside a tall section, with the scene behind a heading and a card", () => {
    expect(html).toMatch(/<section class="lp-floor" data-lp-floor-pin[^>]*>\s*<div class="lp-floor-stage">/);
    const host = html.match(/<div class="lp-floor-scene"[^>]*>/)![0];
    expect(host).toContain("data-lp-floor");
    expect(host).toContain("data-keep");
    expect(host).toContain('role="img"');
    expect(host).toContain(`aria-label="${f.alt}"`);
    expect(html).toContain('aria-labelledby="lp-floor-title"');
    // The heading is two pills, the second led by a round one.
    const heading = html.slice(html.indexOf('<h2 class="lp-floor-title"'), html.indexOf("</h2>", html.indexOf('<h2 class="lp-floor-title"')));
    expect(text(heading).replace(/\s+/g, " ").trim()).toBe(f.title.join(" "));
    expect(heading.match(/class="lp-floor-pill/g)).toHaveLength(2);
    expect(heading.match(/class="lp-floor-dot"/g)).toHaveLength(1);
  });

  it("has a chapter for each station, all in the markup, and a bar to press for each", () => {
    expect(f.chapters).toHaveLength(STATIONS);
    f.chapters.forEach((c, i) => {
      expect(html).toContain(`data-lp-floor-text="${i}"`);
      expect(html).toContain(`<h3 class="lp-floor-h">${c.title}</h3>`);
      expect(text(html)).toContain(c.words);
      expect(html).toMatch(new RegExp(`<button type="button" class="lp-floor-step" data-lp-floor-step="${i}" aria-label="${c.title}"`));
    });
    // The card starts on the first chapter and is left to the scene after that.
    const card = html.match(/<div class="lp-floor-card"[^>]*>/)![0];
    expect(card).toContain('data-chapter="0"');
    expect(card).toContain("data-keep");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("says what the robot domain does, in its own numbers", () => {
    // sim/CALIBRATION.md: the controller is scored on 20 positions the agent never saw; the fork forces 10.
    expect(f.chapters[1].words).toContain("20 positions");
    expect(f.chapters[3].words).toContain("10 random positions");
    expect(f.chapters[0].title).toBe("Pick and place");
  });
});

describe("the robot floor's camera and card", () => {
  it("rests on a station at each third of the way, and is exactly there at the ends", () => {
    expect(WAYPOINTS).toHaveLength(STATIONS);
    WAYPOINTS.forEach((w, i) => {
      const [x, z] = lookAt(i / (STATIONS - 1));
      expect(x).toBeCloseTo(w[0], 9);
      expect(z).toBeCloseTo(w[1], 9);
    });
    expect(lookAt(-1)).toEqual(lookAt(0));
    expect(lookAt(2)).toEqual(lookAt(1));
  });

  it("eases between stations: slow as it leaves and arrives, never backwards, never off the line", () => {
    const [ax, az] = WAYPOINTS[0];
    const [bx, bz] = WAYPOINTS[1];
    const along = (p: number): number => (lookAt(p)[0] - ax) / (bx - ax);
    // Half way through the leg it is half way there, and it starts and ends gently.
    expect(along(1 / 6)).toBeCloseTo(0.5, 9);
    expect(along(0.01)).toBeLessThan(0.01);
    expect(1 - along(1 / 3 - 0.01)).toBeLessThan(0.01);
    let last = -1;
    for (let p = 0; p <= 1 / 3; p += 1 / 300) {
      const u = along(p);
      expect(u).toBeGreaterThanOrEqual(last);
      last = u;
      // On the straight line between the two stations.
      expect(lookAt(p)[1]).toBeCloseTo(az + (bz - az) * u, 9);
    }
    // No jump anywhere along the whole way.
    for (let p = 0; p < 1; p += 1 / 2000) {
      const a = lookAt(p);
      const b = lookAt(p + 1 / 2000);
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(0.03);
    }
  });

  it("looks down from 45 degrees round and 35 up, and steps back on a narrow screen", () => {
    const [x, y, z] = VIEW.back;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 3);
    expect(x).toBeCloseTo(-z, 9);
    expect((Math.asin(y) * 180) / Math.PI).toBeCloseTo(35.2, 1);
    expect(standOff(1.68)).toBe(VIEW.distance);
    expect(standOff(3)).toBe(VIEW.distance);
    const narrow = standOff(0.5);
    expect(narrow).toBeGreaterThan(VIEW.distance);
    // From there the screen is exactly the least width of floor across.
    expect(2 * Math.tan((VIEW.fov * Math.PI) / 360) * 0.5 * narrow).toBeCloseTo(LEAST_WIDTH, 9);
  });

  it("opens a chapter for each quarter of the way and fills its bar over that quarter", () => {
    expect(cardAt(0)).toEqual({ chapter: 0, fills: [0, 0, 0, 0] });
    expect(cardAt(0.125)).toEqual({ chapter: 0, fills: [0.5, 0, 0, 0] });
    expect(cardAt(0.25)).toEqual({ chapter: 1, fills: [1, 0, 0, 0] });
    expect(cardAt(0.625)).toEqual({ chapter: 2, fills: [1, 1, 0.5, 0] });
    expect(cardAt(1)).toEqual({ chapter: 3, fills: [1, 1, 1, 1] });
    expect(cardAt(-3).chapter).toBe(0);
    expect(cardAt(7).chapter).toBe(3);
  });

  it("sends a pressed bar to where the camera rests on that chapter's station, inside the chapter", () => {
    for (let i = 0; i < STATIONS; i++) {
      const p = stopFor(i);
      expect(lookAt(p)[0]).toBeCloseTo(WAYPOINTS[i][0], 9);
      expect(cardAt(p).chapter).toBe(i);
    }
    expect(stopFor(-2)).toBe(0);
    expect(stopFor(99)).toBe(1);
  });

  it("reads how far through the page is from the scrolling", () => {
    expect(progressAt(0, 3000)).toBe(0);
    expect(progressAt(1500, 3000)).toBe(0.5);
    expect(progressAt(9000, 3000)).toBe(1);
    expect(progressAt(-40, 3000)).toBe(0);
    // A section that is not pinned has nowhere to travel.
    expect(progressAt(200, 0)).toBe(0);
  });
});

describe("the tiles a robot has been over", () => {
  it("marks the tile under a point and fades it once the robot has gone", () => {
    const trail = new Trail();
    trail.visit(TILE * 2.5, -TILE * 0.5);
    trail.step(0.1);
    expect(trail.cells).toEqual([{ x: 2, z: -1, strength: 1 }]);
    // Still on it: no fading.
    trail.visit(TILE * 2.1, -TILE * 0.9);
    trail.step(0.5);
    expect(trail.cells[0].strength).toBe(1);
    // Gone: it fades over TRAIL_FADE seconds, then is forgotten.
    trail.step(TRAIL_FADE / 2);
    expect(trail.cells[0].strength).toBeCloseTo(0.5, 9);
    trail.step(TRAIL_FADE);
    expect(trail.cells).toEqual([]);
  });

  it("brings a fading tile back to full when it is visited again, and never keeps more than it can draw", () => {
    const trail = new Trail();
    trail.visit(0.1, 0.1);
    trail.step(0);
    trail.step(TRAIL_FADE * 0.6);
    trail.visit(0.2, 0.2);
    expect(trail.cells).toHaveLength(1);
    expect(trail.cells[0].strength).toBe(1);
    for (let i = 1; i <= TRAIL_CELLS + 4; i++) {
      trail.visit(i * TILE + 0.1, 0.1);
      trail.step(0.05);
    }
    expect(trail.cells.length).toBeLessThanOrEqual(TRAIL_CELLS);
    // The newest tile is there at full strength.
    expect(trail.cells.some((c) => c.x === TRAIL_CELLS + 4 && c.strength === 1)).toBe(true);
  });
});

describe("the web of points", () => {
  // The numbers finder.ts builds its web with.
  const COUNT = 120;
  const REACH = 0.745;
  const points = spherePoints(COUNT);
  const links = linksWithin(points, REACH);
  const at = (set: Float32Array, i: number): [number, number, number] => [set[i * 3], set[i * 3 + 1], set[i * 3 + 2]];
  const between = (a: number, b: number): number => Math.hypot(points[a * 3] - points[b * 3], points[a * 3 + 1] - points[b * 3 + 1], points[a * 3 + 2] - points[b * 3 + 2]);

  it("spreads its points evenly over a sphere", () => {
    expect(points).toHaveLength(COUNT * 3);
    const sum = [0, 0, 0];
    const gaps: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      expect(Math.hypot(...at(points, i))).toBeCloseTo(1, 5);
      at(points, i).forEach((v, k) => { sum[k] += v; });
      let gap = Infinity;
      for (let j = 0; j < COUNT; j++) if (j !== i) gap = Math.min(gap, between(i, j));
      gaps.push(gap);
    }
    // No side of the sphere is heavier than another, and no two points crowd each other.
    for (const v of sum) expect(Math.abs(v / COUNT)).toBeLessThan(0.01);
    expect(Math.min(...gaps)).toBeGreaterThan(0.2);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.6);
  });

  it("ties every two points that are near enough, once, the nearer the stronger", () => {
    const tied = new Set<string>();
    for (let k = 0; k < links.length.length; k++) {
      const [a, b] = [links.pairs[k * 2], links.pairs[k * 2 + 1]];
      expect(a).toBeLessThan(b);
      expect(links.length[k]).toBeCloseTo(between(a, b), 5);
      expect(links.length[k]).toBeLessThan(REACH);
      expect(links.strength[k]).toBeCloseTo(1 - links.length[k] / REACH, 5);
      expect(links.strength[k]).toBeGreaterThan(0);
      expect(links.strength[k]).toBeLessThan(1);
      tied.add(`${a}-${b}`);
    }
    expect(tied.size).toBe(links.length.length);
    let near = 0;
    for (let a = 0; a < COUNT; a++) for (let b = a + 1; b < COUNT; b++) if (between(a, b) < REACH) near++;
    expect(links.length.length).toBe(near);
    // Enough ties to read as a mesh with faint lines across it: about sixteen to a point.
    const each = (links.length.length * 2) / COUNT;
    expect(each).toBeGreaterThan(13);
    expect(each).toBeLessThan(19);
  });

  it("turns the points by yaw, then tilt, then roll, without bending anything", () => {
    const quarter = Math.PI / 2;
    const one = Float32Array.of(0, 0, 1, 1, 0, 0, 0, 1, 0);
    expect(Array.from(turn(one, 0, 0, 0))).toEqual(Array.from(one));
    // A quarter of yaw swings what faced the viewer round to the right.
    const yawed = turn(one, quarter, 0, 0);
    expect(at(yawed, 0)).toEqual([expect.closeTo(1), 0, expect.closeTo(0)]);
    expect(at(yawed, 2)).toEqual([0, 1, 0]);
    // Tilt brings the top toward the viewer; roll then turns the picture on the screen.
    expect(at(turn(one, 0, quarter, 0), 2)).toEqual([0, expect.closeTo(0), expect.closeTo(1)]);
    expect(at(turn(one, 0, 0, quarter), 1)).toEqual([expect.closeTo(0), expect.closeTo(1), 0]);
    // All three together: yaw first, so the point that faced the viewer goes right, stays put under the tilt, then rolls up.
    expect(at(turn(one, quarter, quarter, quarter), 0)).toEqual([expect.closeTo(0), expect.closeTo(1), expect.closeTo(0)]);
    const turned = turn(points, 0.58, 0.192, 0.19);
    for (let i = 0; i < COUNT; i++) expect(Math.hypot(...at(turned, i))).toBeCloseTo(1, 5);
    const [a, b] = [7, 91];
    expect(Math.hypot(turned[a * 3] - turned[b * 3], turned[a * 3 + 1] - turned[b * 3 + 1], turned[a * 3 + 2] - turned[b * 3 + 2])).toBeCloseTo(between(a, b), 5);
  });

  it("measures how far each point is from a seed along the ties", () => {
    const seeds = [3, 60, 117];
    const far = walk(COUNT, links, seeds);
    for (const seed of seeds) expect(far[seed]).toBe(0);
    // The whole web is in one piece, and no walk is shorter than the straight line.
    for (let i = 0; i < COUNT; i++) {
      expect(Number.isFinite(far[i])).toBe(true);
      expect(far[i]).toBeGreaterThanOrEqual(Math.min(...seeds.map((seed) => between(i, seed))) - 1e-6);
    }
    // One tie never changes the distance by more than its own length.
    for (let k = 0; k < links.length.length; k++) {
      expect(Math.abs(far[links.pairs[k * 2]] - far[links.pairs[k * 2 + 1]])).toBeLessThanOrEqual(links.length[k] + 1e-9);
    }
    // More seeds can only bring a point nearer one.
    const fromOne = walk(COUNT, links, [3]);
    for (let i = 0; i < COUNT; i++) expect(far[i]).toBeLessThanOrEqual(fromOne[i] + 1e-9);
    // A point no tie leads to is never reached.
    const apart = walk(3, linksWithin(Float32Array.of(0, 0, 1, 0, 0.1, 1, 0, 0, -1), 0.5), [0]);
    expect(Array.from(apart)).toEqual([0, expect.closeTo(0.1), Infinity]);
  });

  it("turns distances into the order the web is drawn in", () => {
    const far = walk(COUNT, links, [3, 60, 117]);
    const longest = Math.max(...far);
    const growing = orders(far, longest / 0.9);
    expect(Math.max(...growing)).toBeCloseTo(0.9);
    expect([growing[3], growing[60], growing[117]]).toEqual([0, 0, 0]);
    expect(Array.from(growing).filter((o) => o === 0)).toHaveLength(3);
    // A short reach leaves most of the web at the very end of the order: it goes first when the web thins.
    const thinning = orders(walk(COUNT, links, [40]), 1.3);
    expect(thinning[40]).toBe(0);
    const last = Array.from(thinning).filter((o) => o === 1).length;
    expect(last).toBeGreaterThan(COUNT / 2);
    expect(last).toBeLessThan(COUNT - 12);
    expect(Array.from(orders(Float64Array.of(0, 1, Infinity), 2))).toEqual([0, 0.5, 1]);
  });

  it("picks seeds that face the viewer and stand well apart", () => {
    const seen = turn(points, 0.577, 0.192, 0.192);
    const seeds = pickSpread(seen, 12, 0.42);
    expect(seeds).toHaveLength(12);
    expect(new Set(seeds).size).toBe(12);
    for (const i of seeds) expect(seen[i * 3 + 2]).toBeGreaterThan(0.42);
    // The first is the one nearest the middle of the picture.
    const off = (i: number): number => Math.hypot(seen[i * 3], seen[i * 3 + 1]);
    for (let i = 0; i < COUNT; i++) if (seen[i * 3 + 2] > 0.42) expect(off(seeds[0])).toBeLessThanOrEqual(off(i));
    let closest = Infinity;
    for (const a of seeds) for (const b of seeds) if (a !== b) closest = Math.min(closest, Math.hypot(seen[a * 3] - seen[b * 3], seen[a * 3 + 1] - seen[b * 3 + 1]));
    expect(closest).toBeGreaterThan(0.3);
    // It gives what there is when fewer points face the viewer than were asked for.
    const few = pickSpread(seen, 12, 0.985);
    expect(few.length).toBeGreaterThan(0);
    expect(few.length).toBeLessThan(12);
    expect(pickSpread(seen, 12, 1)).toEqual([]);
    // The same turn always gives the same seeds: the coins land where the web's order starts.
    expect(pickSpread(seen, 12, 0.42)).toEqual(seeds);
  });

  it("finds the point that lies nearest a direction", () => {
    expect(nearest(Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), 0.1, 0.2, 0.9)).toBe(2);
    const i = nearest(points, -0.36, 0.1, 0.93);
    const dot = (k: number): number => points[k * 3] * -0.36 + points[k * 3 + 1] * 0.1 + points[k * 3 + 2] * 0.93;
    for (let k = 0; k < COUNT; k++) expect(dot(i)).toBeGreaterThanOrEqual(dot(k));
    // On a web this fine the nearest point is close to where it was asked for.
    expect(dot(i)).toBeGreaterThan(0.97);
  });
});

describe("the split finder's clock", () => {
  const clock = steps(0, CHAPTER, 2);
  const full = 1 + REVEAL_SOFT;

  it("opens on the ring of coins and nothing else", () => {
    expect(chapterAt(0)).toMatchObject({ gather: 0, faces: 1, grey: 0, settle: 0, coins: 1, points: 0, ties: 0, reveal: 0, thinning: false, mark: 0 });
    // The coins turn and tumble a little faster once the page starts to move.
    expect(chapterAt(0).spin).toBeGreaterThan(0);
    expect(chapterAt(300).spin).toBeGreaterThan(chapterAt(0).spin);
    expect(chapterAt(300).tumble).toBeGreaterThan(chapterAt(0).tumble);
  });

  it("makes each coin a point before the web shows, and only then lets the coins go", () => {
    for (const u of clock) {
      const v = chapterAt(u);
      // Nothing of the web is seen until every coin is in place, bare, grey and facing the viewer.
      if (v.points > 0 || v.ties > 0) expect(v).toMatchObject({ gather: 1, faces: 0, grey: 1, settle: 1 });
      // A coin's face is gone before it has shrunk far, and the coins only fade once the web's points are coming up.
      if (v.gather > 0.5) expect(v.faces).toBe(0);
      if (v.coins < 1 && v.mark === 0) expect(v.points).toBeGreaterThan(0);
      // The web does not start to grow under coins that are still there.
      if (v.reveal > 0.02) expect(v.coins).toBeLessThan(0.05);
    }
  });

  it("grows the web whole, holds it, then thins it down, never jumping", () => {
    let before = chapterAt(0);
    let top = 0;
    for (const u of clock) {
      const v = chapterAt(u);
      expect(v.reveal).toBeGreaterThanOrEqual(-REVEAL_SOFT - 1e-9);
      expect(v.reveal).toBeLessThanOrEqual(full + 1e-9);
      // It only grows before the thinning and only shrinks after, and a step this small never moves it far.
      if (v.thinning) expect(v.reveal).toBeLessThanOrEqual(before.reveal + 1e-9);
      else expect(v.reveal).toBeGreaterThanOrEqual(before.reveal - 1e-9);
      expect(Math.abs(v.reveal - before.reveal)).toBeLessThan(0.02);
      // The order the web follows changes only while the whole web is drawn, where it cannot be seen to change.
      if (v.thinning !== before.thinning) expect(before.reveal).toBeCloseTo(full);
      expect(before.thinning && !v.thinning).toBe(false);
      top = Math.max(top, v.reveal);
      before = v;
    }
    expect(top).toBeCloseTo(full);
    // The whole web stands for a while between the two.
    expect(clock.filter((u) => chapterAt(u).reveal > full - 1e-6).length * 2).toBeGreaterThan(60);
    expect(chapterAt(CHAPTER).reveal).toBeCloseTo(-REVEAL_SOFT);
  });

  it("turns the web one way only, and holds it still until it shows", () => {
    let yaw = chapterAt(0).yaw;
    for (const u of clock) {
      const v = chapterAt(u);
      expect(v.yaw).toBeGreaterThanOrEqual(yaw - 1e-12);
      // Where the coins are aimed is where the web's seeds will be: the web has not turned in the meantime.
      if (v.points === 0 && v.mark === 0) expect(v.yaw).toBe(chapterAt(0).yaw);
      yaw = v.yaw;
    }
    expect(chapterAt(CHAPTER).yaw).toBeGreaterThan(chapterAt(0).yaw + 0.5);
    // It has stopped turning by the time the tag is up.
    expect(chapterAt(CHAPTER - 150).yaw).toBe(chapterAt(CHAPTER).yaw);
  });

  it("tags the split once the web has thinned down to it, and keeps the tag up", () => {
    let mark = 0;
    for (const u of clock) {
      const v = chapterAt(u);
      expect(v.mark).toBeGreaterThanOrEqual(mark);
      if (v.mark > 0) {
        expect(v.thinning).toBe(true);
        expect(v.reveal).toBeLessThan(0.05);
      }
      // The tag's own dot takes the last point's place, and no tie outlives it.
      if (v.mark === 1) expect(v).toMatchObject({ points: 0, ties: 0, coins: 0 });
      for (const share of [v.gather, v.faces, v.grey, v.settle, v.coins, v.points, v.ties, v.mark]) {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
      }
      mark = v.mark;
    }
    expect(mark).toBe(1);
    // It is fully up with a good stretch of the chapter still to go.
    expect(chapterAt(CHAPTER - 200).mark).toBe(1);
  });

  it("has a still picture: the whole web with the split tagged in it", () => {
    const still = chapterPoster();
    expect(still).toMatchObject({ coins: 0, points: 1, ties: 1, thinning: false, mark: 1 });
    expect(still.reveal).toBeCloseTo(full);
    // Turned the way the chapter ends, so the split is where its tag expects it.
    expect(still.yaw).toBe(chapterAt(CHAPTER).yaw);
  });

  it("reads its clock from how far the page has scrolled through the pinned section", () => {
    expect(clockAt(0, 2400)).toBe(0);
    expect(clockAt(-300, 2400)).toBe(0);
    expect(clockAt(1200, 2400)).toBeCloseTo(CHAPTER / 2);
    expect(clockAt(2400, 2400)).toBe(CHAPTER);
    expect(clockAt(9000, 2400)).toBe(CHAPTER);
    // A taller screen travels farther for the same chapter.
    expect(clockAt(600, 1200)).toBeCloseTo(clockAt(1200, 2400));
    expect(clockAt(100, 0)).toBe(0);
  });
});

describe("the curves", () => {
  it("run from 0 to 1 without turning back, and hold at the ends", () => {
    for (const curve of [smooth, easeOutQuad, easeOutCubic, easeInOutCubic, clamp01]) {
      expect(curve(-3)).toBe(0);
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
      expect(curve(3)).toBe(1);
      const along = steps(0, 1, 0.02).map(curve);
      for (let i = 1; i < along.length; i++) expect(along[i]).toBeGreaterThanOrEqual(along[i - 1]);
    }
    // The ones that start fast are ahead of an even pace early on; the gentle starts are behind it.
    expect(easeOutCubic(0.25)).toBeGreaterThan(easeOutQuad(0.25));
    expect(easeOutQuad(0.25)).toBeGreaterThan(0.25);
    expect(smooth(0.25)).toBeLessThan(0.25);
    expect(easeInOutCubic(0.25)).toBeLessThan(smooth(0.25));
    expect(smooth(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });
});

describe("the terminal's script", () => {
  const modes = Object.keys(SCRIPTS) as Mode[];
  const words = (line: Line): string => line.spans.map((s) => s.text).join("");
  const rank = { off: 0, on: 1, lit: 2 } as const;

  it("has a step for every light, in order", () => {
    for (const mode of modes) {
      const staged = SCRIPTS[mode].beats.flatMap((b) => (b.kind === "work" || b.kind === "done" ? [b.stage] : []));
      expect(staged).toEqual(STAGES.map((_, k) => k));
      expect(SCRIPTS[mode].beats[0].kind).toBe("type");
      expect(SCRIPTS[mode].beats[SCRIPTS[mode].beats.length - 1].kind).toBe("done");
    }
  });

  it("starts on an empty prompt and types its first command a character at a time", () => {
    for (const mode of modes) {
      const script = SCRIPTS[mode];
      const first = script.beats[0];
      if (first.kind !== "type") throw new Error("the first beat is a command");
      const blank = terminalAt(script, 0);
      expect(blank.title).toBe(script.title);
      expect(blank.lines).toHaveLength(1);
      expect(blank.lines[0]).toMatchObject({ mark: first.mark, caret: true });
      expect(words(blank.lines[0])).toBe("");
      expect(blank.lights.every((l) => l === "off")).toBe(true);
      expect(blank.ticket).toBe(0);

      let typed = 0;
      for (const t of steps(0, scriptSeconds(script), 0.02)) {
        const view = terminalAt(script, t);
        const line = words(view.lines[0]);
        expect(first.text.startsWith(line)).toBe(true);
        // Never more than one character in a step this short, and never one taken back.
        expect(line.length - typed).toBeGreaterThanOrEqual(0);
        expect(line.length - typed).toBeLessThanOrEqual(1);
        typed = line.length;
        // Nothing else happens until the command is whole.
        if (typed < first.text.length) expect(view.lines).toHaveLength(1);
      }
      expect(typed).toBe(first.text.length);
    }
  });

  it("shows a step spinning, then ticked beside its result", () => {
    const script = SCRIPTS.cli;
    const second = script.beats[1];
    if (second.kind !== "work") throw new Error("the second beat is a step");
    const times = steps(0, scriptSeconds(script), 0.02);
    const spinning = terminalAt(script, times.find((t) => terminalAt(script, t).lines.length === 2)!);
    expect(spinning.lines[1].mark).toBe("spin");
    expect(words(spinning.lines[1])).toBe(second.name);
    expect(spinning.lights[second.stage]).toBe("on");
    // The command above it has lost its caret.
    expect(spinning.lines.some((l) => l.caret)).toBe(false);
    const ticked = terminalAt(script, times.find((t) => terminalAt(script, t).lines[1]?.mark === "tick")!);
    expect(words(ticked.lines[1])).toBe(`${second.name.padEnd(12)}${second.result}`);
    expect(ticked.lights[second.stage]).toBe("lit");
  });

  it("lights its stages in order, one at a time, and leaves each one lit", () => {
    for (const mode of modes) {
      const script = SCRIPTS[mode];
      let before = STAGES.map(() => 0);
      for (const t of steps(0, scriptSeconds(script), 0.02)) {
        const view = terminalAt(script, t);
        const now = view.lights.map((l) => rank[l]);
        now.forEach((n, k) => expect(n).toBeGreaterThanOrEqual(before[k]));
        for (let k = 1; k < now.length; k++) if (now[k] > 0) expect(now[k - 1]).toBe(rank.lit);
        expect(now.filter((n) => n === rank.on).length).toBeLessThanOrEqual(1);
        // A spinner is on the screen exactly while a step's light is working (the verdict has no spinner).
        if (view.lines.some((l) => l.mark === "spin")) expect(now).toContain(rank.on);
        // The ticket waits for the verdict.
        if (view.ticket > 0) expect(now.every((n) => n === rank.lit)).toBe(true);
        before = now;
      }
      expect(before).toEqual(STAGES.map(() => rank.lit));
    }
  });

  it("ends on the verdict with the ticket printed, and stays that way", () => {
    for (const mode of modes) {
      const script = SCRIPTS[mode];
      const last = script.beats[script.beats.length - 1];
      if (last.kind !== "done") throw new Error("the last beat is the verdict");
      const end = scriptSeconds(script);
      const done = terminalAt(script, end);
      expect(done.ticket).toBeCloseTo(1);
      expect(done.lines.slice(-2).map(words)).toEqual([last.title, last.detail]);
      expect(done.lines.some((l) => l.caret || l.mark === "spin")).toBe(false);
      // The ticket has not started when the verdict has only just appeared.
      expect(terminalAt(script, end - 1).ticket).toBe(0);
      expect(terminalAt(script, end - 0.45).ticket).toBeCloseTo(0.5);
      const held = terminalAt(script, end + TERMINAL_HOLD);
      expect(held.ticket).toBe(1);
      expect(held.lines).toEqual(done.lines);
      expect(held.lights).toEqual(done.lights);
    }
  });

  it("tells the same batch both ways", () => {
    const verdict = (mode: Mode) => {
      const last = SCRIPTS[mode].beats[SCRIPTS[mode].beats.length - 1];
      return last.kind === "done" ? last.detail : "";
    };
    expect(verdict("api")).toBe(verdict("cli"));
    expect(SCRIPTS.api.ticket).toEqual(SCRIPTS.cli.ticket);
    // Both say they are not a live run.
    for (const mode of modes) expect(SCRIPTS[mode].title).toContain("simulated");
    expect(SCRIPTS.cli.title).not.toBe(SCRIPTS.api.title);
  });

  it("picks out the path a command is about once it has been typed that far", () => {
    const script = SCRIPTS.api;
    const first = script.beats[0];
    if (first.kind !== "type" || !first.chip) throw new Error("the first API command has a chip");
    const chipOf = (t: number) => terminalAt(script, t).lines[0].spans.filter((s) => s.chip).map((s) => s.text);
    expect(chipOf(0.5)).toEqual([]);
    let grown = "";
    for (const t of steps(0, 3, 0.02)) {
      const chip = chipOf(t);
      expect(chip.length).toBeLessThanOrEqual(1);
      if (!chip.length) continue;
      expect(first.chip.startsWith(chip[0])).toBe(true);
      expect(chip[0].length).toBeGreaterThanOrEqual(grown.length);
      grown = chip[0];
    }
    expect(grown).toBe(first.chip);
    const whole = terminalAt(script, 3).lines[0];
    expect(words(whole)).toBe(first.text);
    expect(whole.spans.map((s) => s.tint)).toEqual(["ink", "accent", "ink"]);
  });

  it("writes no line wider than the screen", () => {
    // A character of the screen's type is six tenths as wide as it is tall, and the mark takes two.
    const fits = Math.floor((SCREEN.width - 2 * SCREEN.pad) / (SCREEN.type * 0.6)) - 2;
    for (const mode of modes) {
      const script = SCRIPTS[mode];
      for (const line of terminalAt(script, scriptSeconds(script)).lines) expect(words(line).length).toBeLessThanOrEqual(fits);
    }
  });
});

describe("the data bench", () => {
  const before = steps(0, BENCH_RESET - 0.02, 0.02);

  it("shares the table out the way the task builder does", () => {
    // A fifth of the rows are held out, and half of the rest get a duplicate.
    expect(HELD.length).toBe(ROWS / 5);
    expect(TWINS.length).toBe((ROWS - HELD.length) / 2);
    for (const row of TWINS) expect(HELD as readonly number[]).not.toContain(row);
    expect(Math.min(...HELD)).toBe(ROWS - HELD.length);
    // The sheet's numbers are the same sums on the real table.
    const numbers = (words: string) => (words.match(/\d+/g) ?? []).map(Number);
    const [rows] = numbers(SHEET.shape);
    const [held] = numbers(SHEET.lines[0][1]);
    const [planted, rest] = numbers(SHEET.lines[1][1]);
    expect(held).toBe(Math.ceil(rows / 5));
    expect(rest).toBe(rows - held);
    expect(planted).toBe(rest / 2);
  });

  it("starts empty and loads the rows one after another from the back", () => {
    const start = benchAt(0);
    expect(start.rows).toEqual(Array(ROWS).fill(0));
    expect(start).toMatchObject({ key: 0, held: 0, sealed: 0, scan: 0, beam: 0, written: [0, 0], sheet: 0 });
    for (const p of start.twins) expect(p).toBeCloseTo(0);
    expect(benchAt(0.12).key).toBeGreaterThan(0.9);
    expect(benchAt(0.4).key).toBe(0);
    for (const t of before) {
      const { rows } = benchAt(t);
      for (let i = 1; i < ROWS; i++) expect(rows[i]).toBeLessThanOrEqual(rows[i - 1]);
    }
    const half = benchAt(0.8).rows;
    expect(half[0]).toBeGreaterThan(0.9);
    expect(half[ROWS - 1]).toBe(0);
  });

  it("sets the holdout aside before it plants anything", () => {
    for (const t of before) {
      const v = benchAt(t);
      // The rows only leave once the whole table is in, and the drawer only seals once they are under it.
      if (v.held > 0) expect(v.rows.every((r) => r === 1)).toBe(true);
      if (v.sealed) expect(v.held).toBe(1);
      // The scanner only moves, and only shines, over what is left.
      if (v.scan > 0 || v.beam > 0) expect(v.sealed).toBe(1);
      expect(v.sealed === 0 || v.sealed === 1).toBe(true);
    }
    expect(benchDone().sealed).toBe(1);
  });

  it("plants a duplicate as the scanner reaches its row, and not before", () => {
    const swept = ROWS - HELD.length;
    const seen = TWINS.map(() => 0);
    let scan = 0;
    for (const t of before) {
      const v = benchAt(t);
      expect(v.scan).toBeGreaterThanOrEqual(scan);
      scan = v.scan;
      v.twins.forEach((p, k) => {
        if (p > 1e-9) expect(v.scan * swept).toBeGreaterThanOrEqual(TWINS[k] + 0.5 - 1e-6);
        seen[k] = Math.max(seen[k], p);
      });
      // The light is on while the scanner is crossing, and off once it has stopped.
      if (v.scan > 0.1 && v.scan < 0.9) expect(v.beam).toBe(1);
    }
    // Each one pops a little past its size before it settles.
    for (const peak of seen) expect(peak).toBeGreaterThan(1);
    for (const p of benchDone().twins) expect(p).toBeCloseTo(1);
    expect(benchDone()).toMatchObject({ scan: 1, beam: 0 });
  });

  it("writes each line of the sheet as its step happens, and never past its end", () => {
    const lengths = SHEET.lines.map(([, words]) => words.length);
    let written = [0, 0];
    for (const t of before) {
      const v = benchAt(t);
      v.written.forEach((n, i) => {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(written[i]);
        expect(n).toBeLessThanOrEqual(lengths[i]);
      });
      if (v.written[0] > 0) expect(v.held).toBeGreaterThan(0);
      if (v.written[1] > 0) expect(v.scan).toBeGreaterThan(0);
      // The heading is up before anything is written under it.
      if (v.written[0] > 0) expect(v.sheet).toBe(1);
      written = v.written;
    }
    expect(written).toEqual(lengths);
  });

  it("stands finished for a while, then clears for the next pass", () => {
    const done = benchDone();
    expect(done.rows).toEqual(Array(ROWS).fill(1));
    expect(done).toMatchObject({ key: 0, held: 1, sealed: 1, scan: 1, beam: 0, sheet: 1 });
    expect(done.written).toEqual(SHEET.lines.map(([, words]) => words.length));
    // Nothing moves for the last few seconds before the reset.
    expect(benchAt(BENCH_RESET - 3)).toEqual(done);
    const cleared = benchAt(BENCH_LOOP - 0.01);
    expect(Math.max(...cleared.rows, ...cleared.twins, cleared.held, cleared.scan, cleared.beam, cleared.sheet)).toBeCloseTo(0);
    expect(cleared).toMatchObject({ sealed: 0, written: [0, 0] });
    // Half way through clearing everything is on its way out together.
    const going = benchAt(BENCH_RESET + (BENCH_LOOP - BENCH_RESET) * 0.36);
    expect(going.rows[0]).toBeGreaterThan(0);
    expect(going.rows[0]).toBeLessThan(1);
    expect(going.scan).toBeCloseTo(going.rows[0]);
  });
});

describe("the loop's timing", () => {
  it("fires the pads in order, a hop apart, and again every loop", () => {
    for (let k = 0; k < NODES; k++) {
      expect(nodeClock(k * HOP - PRESS_LEAD - 0.01, k)).toEqual({ tau: -Infinity, fired: 0 });
      expect(nodeClock(k * HOP - 0.2, k).tau).toBeCloseTo(-0.2);
      expect(nodeClock(k * HOP - 0.2, k).fired).toBe(0);
      expect(nodeClock(k * HOP + 0.2, k)).toMatchObject({ fired: 1 });
      expect(nodeClock(k * HOP + 0.2 + 3 * LOOP, k).tau).toBeCloseTo(0.2);
      expect(nodeClock(k * HOP + 0.2 + 3 * LOOP, k).fired).toBe(4);
    }
  });

  it("presses a pad down before it fires, holds it, and lets it spring back", () => {
    expect(press(-Infinity)).toBe(0);
    expect(press(-PRESS_LEAD)).toBe(0);
    expect(press(0)).toBeCloseTo(1);
    expect(press(0.3)).toBe(1);
    expect(press(1.2)).toBe(0);
    const down = steps(-PRESS_LEAD, 0, 0.05).map(press);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeGreaterThanOrEqual(down[i - 1]);
    const up = steps(0.45, 1, 0.05).map(press);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeLessThanOrEqual(up[i - 1]);
  });

  it("tosses a step's disc once: up to its peak and back, one full turn", () => {
    expect(toss(0)).toEqual({ lift: 0, turn: 0 });
    expect(toss(TOSS_TIME)).toEqual({ lift: 0, turn: 0 });
    expect(toss(TOSS_TIME / 2).lift).toBeCloseTo(TOSS_HEIGHT);
    expect(toss(TOSS_TIME / 2).turn).toBeCloseTo(Math.PI);
    expect(toss(TOSS_TIME * 0.999).turn).toBeCloseTo(2 * Math.PI, 1);
    for (const tau of steps(0.02, TOSS_TIME - 0.02, 0.04)) expect(toss(tau).lift).toBeGreaterThan(0);
  });

  it("starts a pad's ripple when it fires and ends it later", () => {
    expect(wave(-0.1)).toBe(-1);
    expect(wave(0)).toBe(0);
    expect(wave(1)).toBe(1);
    expect(wave(WAVE_LIFE)).toBe(-1);
    expect(wave(-Infinity)).toBe(-1);
  });

  it("hides the task's and verdict's icon at the moment it is swapped", () => {
    expect(swap(-Infinity)).toBe(1);
    expect(swap(-1)).toBe(1);
    expect(swap(0)).toBe(0);
    expect(swap(0.3)).toBe(0);
    expect(swap(2)).toBe(1);
  });

  it("draws a line dark from its pad, then fades it out", () => {
    for (let k = 0; k < PATHS; k++) {
      expect(pathAt(-0.2, k)).toEqual({ draw: 0, glow: 0 });
      expect(pathAt(0.5, k).draw).toBeGreaterThan(0);
      expect(pathAt(0.5, k).draw).toBeLessThan(1);
      // The whole line is drawn, at full strength, well before the next pad fires, and still reads as dark when it does.
      expect(pathAt(0.9, k)).toEqual({ draw: 1, glow: 1 });
      expect(pathAt(HOP, k).draw).toBe(1);
      expect(pathAt(HOP, k).glow).toBeGreaterThan(0.5);
      // Gone before its own pad presses again.
      expect(pathAt(LOOP - PRESS_LEAD, k).glow).toBe(0);
      const glow = steps(0.2, LOOP - PRESS_LEAD, 0.1).map((tau) => pathAt(tau, k).glow);
      for (let i = 1; i < glow.length; i++) expect(glow[i]).toBeLessThanOrEqual(glow[i - 1]);
    }
  });

  it("stands a label up, shows its letters left to right, and takes it down before the pad fires again", () => {
    expect(bannerUp(0)).toBe(0);
    expect(bannerUp(1.2)).toBeCloseTo(1);
    expect(bannerUp(2.6)).toBe(0);
    const n = 9;
    // On the way in the first letter leads the last.
    expect(bannerLetter(0.7, 0, n)).toBeGreaterThan(bannerLetter(0.7, n - 1, n));
    for (let i = 0; i < n; i++) {
      expect(bannerLetter(0.4, i, n)).toBe(0);
      expect(bannerLetter(1.4, i, n)).toBe(1);
      // Every letter is gone while the label is still partly up, so it never drops with words on it.
      expect(bannerLetter(2.31, i, n)).toBe(0);
      for (const tau of steps(0, 3, 0.05)) {
        expect(bannerLetter(tau, i, n)).toBeGreaterThanOrEqual(0);
        expect(bannerLetter(tau, i, n)).toBeLessThanOrEqual(1);
      }
    }
    expect(bannerUp(2.31)).toBeGreaterThan(0);
    expect(bannerLetter(1.4, 0, 1)).toBe(1);
  });

  it("starts clean: nothing from a pass that never happened", () => {
    const f = frameAt(0.5);
    expect(f.nodes[0].wave).toBeCloseTo(0.5);
    for (let k = 1; k < NODES; k++) {
      expect(f.nodes[k].wave).toBe(-1);
      expect(f.nodes[k].press).toBe(0);
      expect(f.nodes[k].fired).toBe(0);
    }
    for (let k = 1; k < PATHS; k++) {
      expect(f.paths[k].glow).toBe(0);
      expect(f.banners[k].up).toBe(0);
    }
    // Before anything has fired the scene is at rest.
    const rest = frameAt(-0.9);
    expect(rest.nodes.every((n) => n.press === 0 && n.wave === -1 && n.lift === 0 && n.icon === 1)).toBe(true);
    expect(rest.paths.every((p) => p.glow === 0)).toBe(true);
  });

  it("repeats every loop once the first pass is through", () => {
    for (const t of steps(2 * LOOP, 3 * LOOP, 0.37)) {
      const a = frameAt(t);
      const b = frameAt(t + LOOP);
      for (let k = 0; k < NODES; k++) {
        expect(b.nodes[k].press).toBeCloseTo(a.nodes[k].press);
        expect(b.nodes[k].lift).toBeCloseTo(a.nodes[k].lift);
        expect(b.nodes[k].wave).toBeCloseTo(a.nodes[k].wave);
        expect(b.nodes[k].icon).toBeCloseTo(a.nodes[k].icon);
        expect(b.nodes[k].fired).toBe(a.nodes[k].fired + 1);
      }
      for (let k = 0; k < PATHS; k++) {
        expect(b.paths[k].draw).toBeCloseTo(a.paths[k].draw);
        expect(b.paths[k].glow).toBeCloseTo(a.paths[k].glow);
        expect(b.banners[k].up).toBeCloseTo(a.banners[k].up);
      }
    }
  });

  it("only tosses the steps' discs, and only swaps the task's and verdict's icons", () => {
    for (const t of steps(0, 3 * LOOP, 0.11)) {
      const f = frameAt(t);
      expect(f.nodes[0].lift).toBe(0);
      expect(f.nodes[NODES - 1].lift).toBe(0);
      for (let k = 1; k < NODES - 1; k++) expect(f.nodes[k].icon).toBe(1);
      for (const n of f.nodes) {
        expect(n.press).toBeGreaterThanOrEqual(0);
        expect(n.press).toBeLessThanOrEqual(1);
        expect(n.icon).toBeGreaterThanOrEqual(0);
        expect(n.icon).toBeLessThanOrEqual(1);
      }
    }
  });

  it("writes into the frame it is given", () => {
    const frame = frameAt(1);
    expect(frameAt(4, frame)).toBe(frame);
    expect(frame.nodes[2].wave).toBeCloseTo(4 - 2 * HOP);
  });

  it("shows the whole diagram, still, for reduced motion", () => {
    const f = posterFrame();
    expect(f.nodes.every((n) => n.press === 0 && n.lift === 0 && n.wave === -1 && n.icon === 1)).toBe(true);
    expect(f.paths.every((p) => p.draw === 1 && p.glow === 1)).toBe(true);
    for (const b of f.banners) {
      expect(b.up).toBe(1);
      expect(bannerLetter(b.tau, 0, 8)).toBe(1);
      expect(bannerLetter(b.tau, 7, 8)).toBe(1);
    }
  });
});

describe("the solids", () => {
  /** Every triangle's own facing agrees with the normals at its corners, so nothing is drawn inside out. */
  function expectFacesOutward(s: Solid): void {
    const p = (i: number) => [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]];
    const n = (i: number) => [s.normals[i * 3], s.normals[i * 3 + 1], s.normals[i * 3 + 2]];
    let checked = 0;
    for (let t = 0; t < s.index.length; t += 3) {
      const [a, b, c] = [s.index[t], s.index[t + 1], s.index[t + 2]];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const area = Math.hypot(face[0], face[1], face[2]);
      if (area < 1e-10) continue; // a sliver where two rows meet
      const [na, nb, nc] = [n(a), n(b), n(c)];
      const dot = face[0] * (na[0] + nb[0] + nc[0]) + face[1] * (na[1] + nb[1] + nc[1]) + face[2] * (na[2] + nb[2] + nc[2]);
      expect(dot).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    for (let i = 0; i < s.normals.length; i += 3) expect(Math.hypot(s.normals[i], s.normals[i + 1], s.normals[i + 2])).toBeCloseTo(1, 5);
  }
  const bounds = (positions: Float32Array) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], positions[i]);
    }
    return { lo, hi };
  };

  it("outlines a rounded square and a circle counter-clockwise with unit normals", () => {
    const sq = roundedSquare(0.5, 0.1, 6);
    expect(sq.count).toBe(4 * 7);
    for (let i = 0; i < sq.count; i++) {
      expect(Math.abs(sq.points[i * 2])).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(sq.points[i * 2 + 1])).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.hypot(sq.normals[i * 2], sq.normals[i * 2 + 1])).toBeCloseTo(1, 5);
    }
    // The grazing point for a diagonal line of sight is the middle of a corner; for a square-on one, a side's middle.
    const d = Math.SQRT1_2;
    expect(sq.support(d, d)[0]).toBeCloseTo(0.4 + 0.1 * d);
    expect(sq.support(1, 0)).toEqual([0.5, 0]);
    const round = circle(0.3, 24);
    expect(round.count).toBe(24);
    expect(round.support(0, -1)[1]).toBeCloseTo(-0.3);
  });

  it("outlines a rounded rectangle, of which a rounded square is one", () => {
    const slab = roundedRect(2.6, 1.7, 0.36, 6);
    expect(slab.count).toBe(4 * 7);
    let wide = 0;
    let deep = 0;
    for (let i = 0; i < slab.count; i++) {
      wide = Math.max(wide, Math.abs(slab.points[i * 2]));
      deep = Math.max(deep, Math.abs(slab.points[i * 2 + 1]));
      expect(Math.hypot(slab.normals[i * 2], slab.normals[i * 2 + 1])).toBeCloseTo(1, 5);
    }
    expect(wide).toBeCloseTo(2.6);
    expect(deep).toBeCloseTo(1.7);
    const d = Math.SQRT1_2;
    expect(slab.support(1, 0)).toEqual([expect.closeTo(2.6), 0]);
    expect(slab.support(0, -1)).toEqual([0, expect.closeTo(-1.7)]);
    expect(slab.support(d, d)).toEqual([expect.closeTo(2.24 + 0.36 * d), expect.closeTo(1.34 + 0.36 * d)]);
    const square = roundedSquare(0.5, 0.1, 6);
    expect(Array.from(square.points)).toEqual(Array.from(roundedRect(0.5, 0.5, 0.1, 6).points));
    expect(Array.from(square.normals)).toEqual(Array.from(roundedRect(0.5, 0.5, 0.1, 6).normals));
    // A device's casing is one of these swept upward.
    const casing = prism(slab, 0.34, 0.022);
    expectFacesOutward(casing);
    expect(bounds(casing.positions).hi).toEqual([expect.closeTo(2.6), expect.closeTo(0.34), expect.closeTo(1.7)]);
  });

  it("builds pads, buttons and discs that face outward", () => {
    const square = prism(roundedSquare(0.48, 0.145), 0.36, 0.022);
    expectFacesOutward(square);
    expect(bounds(square.positions).lo).toEqual([expect.closeTo(-0.48), 0, expect.closeTo(-0.48)]);
    expect(bounds(square.positions).hi).toEqual([expect.closeTo(0.48), expect.closeTo(0.36), expect.closeTo(0.48)]);

    expectFacesOutward(prism(circle(0.53), 0.4, 0.022));
    // A square edge, with no rounding.
    expectFacesOutward(prism(circle(0.2, 16), 0.05));

    // The disc that gets tossed is closed underneath and centred on its own middle.
    const disc = prism(circle(0.16, 24), 0.02, 0.008, { y0: -0.01, closed: true });
    expectFacesOutward(disc);
    expect(bounds(disc.positions).lo[1]).toBeCloseTo(-0.01);
    expect(bounds(disc.positions).hi[1]).toBeCloseTo(0.01);
    let down = 0;
    for (let i = 1; i < disc.normals.length; i += 3) if (disc.normals[i] < -0.99) down++;
    expect(down).toBeGreaterThan(24);
    const open = prism(circle(0.16, 24), 0.02, 0.008);
    expect(open.index.length).toBeLessThan(disc.index.length);
  });

  it("builds the raised bands that read as lines and collars", () => {
    const collar = band(circle(0.285, 32), 0.043, 0.018);
    expectFacesOutward(collar);
    let inner = Infinity;
    for (let i = 0; i < collar.positions.length; i += 3) inner = Math.min(inner, Math.hypot(collar.positions[i], collar.positions[i + 2]));
    expect(inner).toBeCloseTo(0.285 - 0.043);
    expectFacesOutward(band(roundedSquare(0.43, 0.097), 0.02, 0.006));
  });

  it("draws a closed line round an outline and the two upright edges on its flanks", () => {
    const o = roundedSquare(0.5, 0.1, 4);
    const ring = loop(o, 0.2, 0.05);
    expect(ring.length).toBe(o.count * 6);
    // Each segment ends where the next begins, and the last ends where the first begins.
    for (let s = 0; s < o.count; s++) {
      const next = ((s + 1) % o.count) * 6;
      expect(Array.from(ring.slice(s * 6 + 3, s * 6 + 6))).toEqual(Array.from(ring.slice(next, next + 3)));
      expect(ring[s * 6 + 1]).toBeCloseTo(0.2);
    }
    // Seen along the floor's diagonal, a circle's flanks are at right angles to the line of sight.
    const sides = flanks(circle(1), 1, 1, 0, 0.5);
    expect(sides.length).toBe(12);
    expect(sides[0] * 1 + sides[2] * 1).toBeCloseTo(0);
    expect(Math.hypot(sides[0], sides[2])).toBeCloseTo(1);
    expect([sides[1], sides[4]]).toEqual([0, 0.5]);
    expect(sides[6]).toBeCloseTo(-sides[0]);
  });

  it("cuts a label with two rounded corners that stands on the floor", () => {
    const t = tag(1.2, 0.48, 0.1);
    const b = bounds(t.positions);
    expect(b.lo).toEqual([expect.closeTo(-0.6), 0, 0]);
    expect(b.hi).toEqual([expect.closeTo(0.6), expect.closeTo(0.48), 0]);
    expect(Math.max(...t.index)).toBe(t.positions.length / 3 - 1);
  });

  it("lays a line round a bend in equal steps", () => {
    const corners: [number, number][] = [[0, 0], [2, 0], [2, 2]];
    const path = roundedPath(corners, 0.3, 0.004, 40);
    expect(path.length).toBe(41 * 3);
    expect([path[0], path[1], path[2]]).toEqual([0, expect.closeTo(0.004), 0]);
    expect(path[40 * 3]).toBeCloseTo(2);
    expect(path[40 * 3 + 2]).toBeCloseTo(2);
    const lengths: number[] = [];
    for (let i = 1; i <= 40; i++) lengths.push(Math.hypot(path[i * 3] - path[i * 3 - 3], path[i * 3 + 2] - path[i * 3 - 1]));
    const total = lengths.reduce((a, b) => a + b, 0);
    // The bend cuts the corner, so the line is shorter than its two legs, and every step is the same length.
    expect(total).toBeLessThan(4);
    expect(total).toBeGreaterThan(4 - 2 * 0.3);
    for (const l of lengths) expect(l).toBeCloseTo(total / 40, 2);
    // It never leaves the corner's square.
    for (let i = 0; i <= 40; i++) {
      expect(path[i * 3]).toBeLessThanOrEqual(2 + 1e-6);
      expect(path[i * 3 + 2]).toBeGreaterThanOrEqual(-1e-6);
    }
    // A straight line stays straight.
    const straight = roundedPath([[0, 0], [0, 3]], 0.3, 0, 3);
    expect(Array.from(straight)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3]);
  });
});

describe("placing the scene", () => {
  // The scene's shape in its own box: the task at the top middle, the steps across, the verdict at the bottom.
  const points: [number, number][] = [[0.5, 0], [0.05, 0.3], [0.25, 0.18], [0.5, 0.42], [0.95, 0.3], [0.5, 1]];
  const base: FitInput = {
    width: 1470, height: 864, top: 96, right: 28, bottom: 16, left: 12,
    copyRight: 690, copyBottom: 380, gap: 22, aspect: 1.66, points, maxHeight: 674,
  };
  /** The scene's points on the page. */
  const placed = (input: FitInput) => {
    const box = fitScene(input);
    return { box, at: input.points.map(([x, y]) => [box.x + x * box.width, box.y + y * box.height]) };
  };
  const clearOfCopy = (input: FitInput) =>
    placed(input).at.every(([x, y]) => x > input.copyRight + input.gap - 0.5 || y > input.copyBottom + input.gap - 0.5);

  it("keeps the scene's shape and stays inside the hero's margins", () => {
    for (const input of [base, { ...base, width: 1920, height: 1080, maxHeight: 842 }, { ...base, width: 1280, height: 720, maxHeight: 562 }]) {
      const { box } = placed(input);
      expect(box.width / box.height).toBeCloseTo(input.aspect);
      expect(box.x).toBeGreaterThanOrEqual(input.left - 0.5);
      expect(box.x + box.width).toBeCloseTo(input.width - input.right);
      expect(box.y).toBeGreaterThanOrEqual(input.top - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(input.height - input.bottom + 0.5);
      expect(box.height).toBeLessThanOrEqual(input.maxHeight! + 0.5);
    }
  });

  it("takes all the room it is allowed when the copy is out of the way", () => {
    const { box } = placed({ ...base, copyRight: 0, copyBottom: 0 });
    expect(box.height).toBeCloseTo(674);
  });

  it("never lets the scene sit over the copy", () => {
    expect(clearOfCopy(base)).toBe(true);
    expect(clearOfCopy({ ...base, copyBottom: 480 })).toBe(true);
    expect(clearOfCopy({ ...base, width: 1280, height: 720, maxHeight: 562 })).toBe(true);
    expect(clearOfCopy({ ...base, width: 1024, height: 768, copyRight: 650, copyBottom: 215, maxHeight: 600 })).toBe(true);
    // A taller copy leaves less room, so the scene is smaller.
    expect(fitScene({ ...base, copyBottom: 480 }).height).toBeLessThan(fitScene(base).height);
  });

  it("puts the scene under the copy on a narrow page", () => {
    const phone: FitInput = { ...base, width: 390, height: 844, top: 80, right: 12, copyRight: 370, copyBottom: 250, maxHeight: 658 };
    const { box } = placed(phone);
    expect(box.y).toBeGreaterThanOrEqual(phone.copyBottom + phone.gap - 0.5);
    expect(box.width).toBeCloseTo(390 - 12 - 12);
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 16 + 0.5);
  });

  it("gives up shrinking at a least size rather than vanish, and copes with no room at all", () => {
    const cramped = fitScene({ ...base, height: 300, copyBottom: 280, maxHeight: 234 });
    expect(cramped.height).toBeGreaterThanOrEqual(160);
    const none = fitScene({ ...base, width: 0, height: 0 });
    expect(none.width).toBe(0);
    expect(none.height).toBe(0);
  });
});
