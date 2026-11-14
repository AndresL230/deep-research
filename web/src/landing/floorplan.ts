// The robot floor's chapter, as a pure function of how far the page has scrolled through it. factory.ts draws what
// this returns; nothing here touches three.js or the DOM, so it is tested in test/landing.test.ts.
//
// The section is pinned while the page scrolls. One long factory floor lies under a camera that never turns: the
// scrolling slides it from one station to the next, four in all. What happens at a station runs on real time and
// loops (routines.ts); only the camera and the card follow the page.
//
//   the camera   rests on a station at 0, 1/3, 2/3 and 1 of the way through, and eases between them
//   the card     has four chapters, one for each quarter of the way; each chapter's bar fills over its quarter

import { clamp01, smooth } from "./ease";

/** How many stations the floor has, and chapters the card. */
export const STATIONS = 4;

/** The point of the floor (x, z) the camera looks at when it rests on each station. */
export const WAYPOINTS: readonly (readonly [number, number])[] = [
  [-0.4, 1.51],
  [5.24, -4.43],
  [13.71, -6.94],
  [14.52, -15.69],
];

/** The camera: its angle of view, how far it stands from the point of the floor it looks at, and the direction
 *  from that point back to it (a true isometric view: 45 degrees round, 35.26 up). */
export const VIEW = { fov: 14, distance: 19.6, back: [0.57781, 0.57643, -0.57781] as const };
/** The least width of floor, in its own units, a narrow screen still shows: the camera steps back to keep it. */
export const LEAST_WIDTH = 5.4;

/** The floor's grid: the side of a tile. */
export const TILE = 0.5;

/** How far the camera stands from the floor for a canvas `aspect` wide for its height. */
export function standOff(aspect: number): number {
  const across = 2 * Math.tan((VIEW.fov * Math.PI) / 360) * Math.max(aspect, 0.01);
  return Math.max(VIEW.distance, LEAST_WIDTH / across);
}

/** The point of the floor the camera looks at, `p` of the way through the chapter (0 to 1). */
export function lookAt(p: number): [number, number] {
  const legs = STATIONS - 1;
  const at = clamp01(p) * legs;
  const leg = Math.min(legs - 1, Math.floor(at));
  const u = smooth(at - leg);
  const [ax, az] = WAYPOINTS[leg];
  const [bx, bz] = WAYPOINTS[leg + 1];
  return [ax + (bx - ax) * u, az + (bz - az) * u];
}

export interface CardView {
  /** Which chapter the card shows, 0 to 3. */
  chapter: number;
  /** How full each chapter's bar is, 0 to 1: the ones before the open chapter are full, the ones after empty. */
  fills: number[];
}

/** The card, `p` of the way through the chapter. */
export function cardAt(p: number): CardView {
  const at = clamp01(p) * STATIONS;
  return {
    chapter: Math.min(STATIONS - 1, Math.floor(at)),
    fills: Array.from({ length: STATIONS }, (_, i) => clamp01(at - i)),
  };
}

/** How far through the chapter the page goes when a chapter's bar is pressed: to where the camera rests on that
 *  chapter's station. The last station is at the very end, the others inside their own quarter. */
export function stopFor(chapter: number): number {
  const i = Math.min(STATIONS - 1, Math.max(0, Math.floor(chapter)));
  return i / (STATIONS - 1);
}

/** How far through the chapter the page is, having scrolled `scrolled` pixels into a pinned section that travels
 *  `travel` pixels in all. */
export function progressAt(scrolled: number, travel: number): number {
  return travel > 0 ? clamp01(scrolled / travel) : 0;
}

/** A tile of the floor a robot has just been over: which tile, and how strongly its outline still shows. */
export interface TrailCell {
  x: number;
  z: number;
  strength: number;
}

/** How long a tile's outline takes to fade once the robot has left it, in seconds. */
export const TRAIL_FADE = 1.1;
/** The most tiles that show at once. */
export const TRAIL_CELLS = 8;

/** The tiles the robots have just been over. `visit` marks the tile under a point of the floor; `step` fades the
 *  ones nothing stands on any more. */
export class Trail {
  readonly cells: TrailCell[] = [];
  private held = new Set<string>();

  visit(x: number, z: number): void {
    const cx = Math.floor(x / TILE);
    const cz = Math.floor(z / TILE);
    this.held.add(`${cx},${cz}`);
    const seen = this.cells.find((c) => c.x === cx && c.z === cz);
    if (seen) { seen.strength = 1; return; }
    if (this.cells.length >= TRAIL_CELLS) {
      // The faintest one makes room.
      let faintest = 0;
      for (let i = 1; i < this.cells.length; i++) if (this.cells[i].strength < this.cells[faintest].strength) faintest = i;
      this.cells.splice(faintest, 1);
    }
    this.cells.push({ x: cx, z: cz, strength: 1 });
  }

  /** Fade every tile that was not visited since the last step, and forget the ones that are gone. */
  step(seconds: number): void {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      if (this.held.has(`${c.x},${c.z}`)) continue;
      c.strength -= seconds / TRAIL_FADE;
      if (c.strength <= 0) this.cells.splice(i, 1);
    }
    this.held.clear();
  }
}
