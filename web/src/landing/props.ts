// What stands on the robot floor: tubs, cartons, carts, conveyors, the machines over them, shelves, trucks and
// the small parts the robots handle. Each function adds one thing to a Sculpt (rig.ts), built round its own
// origin: stations.ts stands them where they go.
//
// Sizes are in the floor's units; a tile of its grid is half of one. A thing's long side runs along its own x.

import { Shape } from "three";
import { Sculpt, nextMark, outline, roundHole, roundRect } from "./rig";
import type { Tint } from "./contour";

const TAU = Math.PI * 2;

/** A small repeatable source of random numbers, so a pile looks the same every time. */
export const dice = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── containers ───────────────────────────────────────────────────────────────

export interface TubOptions {
  /** How round its corners are, how thick its wall, and how far down its floor is from the rim. */
  r?: number; wall?: number; deep?: number;
  tint?: Tint;
  /** A grab handle on its +x side, on its -z side, or none. */
  handle?: "x" | "z" | "none";
}

/** An open container `w` by `d` and `h` high: a wall all round, and a floor inside it. */
export function tub(s: Sculpt, w: number, d: number, h: number, o: TubOptions = {}): void {
  const r = o.r ?? 0.12;
  const wall = o.wall ?? 0.09;
  const tint = o.tint ?? "white";
  const ring = roundRect(w, d, r);
  ring.holes.push(roundHole(w - wall * 2, d - wall * 2, Math.max(0.01, r - wall)));
  s.sweep(ring, h, 0, 0, 0, tint);
  s.sweep(roundRect(w - wall * 2, d - wall * 2, Math.max(0.01, r - wall)), 0.03, 0, h - (o.deep ?? h * 0.42), 0, tint);
  const side = o.handle ?? "none";
  if (side !== "none") {
    // A bent bar standing off the wall.
    const y = h - 0.3;
    const out = 0.09;
    const half = 0.2;
    const pts: [number, number, number][] = side === "x"
      ? [[w / 2 - 0.01, y, half], [w / 2 + out, y - 0.01, half], [w / 2 + out, y - 0.02, 0], [w / 2 + out, y - 0.01, -half], [w / 2 - 0.01, y, -half]]
      : [[half, y, -d / 2 + 0.01], [half, y - 0.01, -d / 2 - out], [0, y - 0.02, -d / 2 - out], [-half, y - 0.01, -d / 2 - out], [-half, y, -d / 2 + 0.01]];
    s.tube(pts, 0.028, tint, { seg: 28 });
  }
}

/** A carton: 0.82 long, 0.52 deep and high, with a pill-shaped handle on the long side that faces -z. */
export const CARTON = { w: 0.82, h: 0.52, d: 0.52 } as const;
export function carton(s: Sculpt, x: number, y: number, z: number, ry = 0, handle = true): void {
  s.at(x, y, z, ry, () => {
    s.box(CARTON.w, CARTON.h, CARTON.d, 0, 0, 0, "paper");
    if (handle) s.sweep(roundRect(0.21, 0.06, 0.03), 0.016, 0.1, CARTON.h * 0.64, -CARTON.d / 2 - 0.004, "amber", { way: "along-z" });
  });
}

/** A drum with a lid. */
export function barrel(s: Sculpt, x: number, z: number, r = 0.37, h = 0.95): void {
  s.cyl(r, h, x, 0, z, "white", { seg: 40 });
  s.cyl(r + 0.02, 0.06, x, h - 0.025, z, "white", { seg: 40 });
}

/** A strip painted on the floor. */
export function dash(s: Sculpt, x: number, z: number, ry = 0, length = 0.62): void {
  s.at(x, 0, z, ry, () => { s.box(length, 0.012, 0.2, 0, 0, 0, "white"); });
}

// ── wheels ───────────────────────────────────────────────────────────────────

/** A wheel standing in the x, y plane, its outer face toward -z, under a mudguard. The origin is its hub's inner
 *  end, at the height of the axle. */
export function wheel(s: Sculpt, r = 0.27, thick = 0.2, guard = true): void {
  const tyre = new Shape();
  tyre.absarc(0, 0, r, 0, TAU, false);
  const hole = new Shape();
  hole.absarc(0, 0, r * 0.4, 0, TAU, true);
  tyre.holes.push(hole);
  s.sweep(tyre, thick, 0, 0, -thick / 2, "accent", { way: "along-z", seg: 20 });
  if (guard) {
    // An arch over the top of the tyre, a little wider than it.
    const a0 = 0.03 * Math.PI;
    const a1 = 0.72 * Math.PI;
    const arch = new Shape();
    arch.absarc(0, 0, r + 0.085, a0, a1, false);
    arch.absarc(0, 0, r + 0.04, a1, a0, true);
    arch.closePath();
    // It covers the half of the tyre next to the body, and runs on to the body.
    const deep = thick * 0.55 + 0.1;
    s.sweep(arch, deep, 0, 0, 0.1 - deep / 2, "white", { way: "along-z", seg: 16 });
  }
}

// ── carts and trucks ─────────────────────────────────────────────────────────

/** A cart: an open box on four wheels, the two that show on its -z side. It rolls along its own x. The origin
 *  is the middle of its footprint. `inner` is how deep the box is inside, `h` how tall its walls are. */
export const CART = { w: 1.0, d: 1.0, h: 0.85, lift: 0.28, wall: 0.08 } as const;
export function cart(s: Sculpt, inner = 0.28, h: number = CART.h): void {
  const { w, d, lift, wall } = CART;
  const ring = roundRect(w, d, 0.012);
  ring.holes.push(roundHole(w - wall * 2, d - wall * 2, 0.008));
  s.sweep(ring, h, 0, lift, 0, "white");
  s.box(w - wall * 2, 0.03, d - wall * 2, 0, lift + h - inner, 0, "white");
  for (const x of [0.2, -0.36]) s.at(x, 0.27, -d / 2 - 0.02, 0, () => wheel(s, 0.27, 0.19));
  // The far pair shows under the box.
  for (const x of [0.2, -0.36]) s.at(x, 0.27, d / 2 - 0.19, 0, () => wheel(s, 0.27, 0.19, false));
}

/** A pallet truck: a mast at its origin, a deck for the load to its +x, and a hood with the wheels behind the
 *  mast. It rolls along its own x. Only the wheels on the side the camera sees are made. */
export const TRUCK = { deck: 0.075, deckFrom: 0.02, deckLength: 0.76, width: 1.0 } as const;
export function truck(s: Sculpt, side: -1 | 1 = -1): void {
  const width = 0.84;
  // The hood: a block with its top back edge rounded off.
  const top = 0.82;
  const low = 0.2;
  const back = -1.02;
  const front = -0.07;
  const round = 0.2;
  const hood = new Shape();
  hood.moveTo(back, low);
  hood.lineTo(front, low);
  hood.lineTo(front, top);
  hood.lineTo(back + round, top);
  hood.absarc(back + round, top - round, round, Math.PI / 2, Math.PI, false);
  hood.closePath();
  s.sweep(hood, width, 0, 0, 0, "white", { way: "along-z", seg: 8 });
  // The mast: two posts and the bars between them.
  const post = 0.085;
  const mark = nextMark();
  for (const z of [-0.455, 0.455]) s.box(post, 1.8, post, 0, 0, z, "white", mark);
  for (const [y, h] of [[0.5, 0.06], [0.66, 0.06], [1.32, 0.2]] as const) s.box(0.045, h, 0.91 - post, 0, y, 0, "white");
  // The deck.
  s.box(TRUCK.deckLength, TRUCK.deck, TRUCK.width, TRUCK.deckFrom + TRUCK.deckLength / 2, 0, 0, "white");
  // The two wheels on the side that shows (`side`: -1 its -z side, 1 its +z side), each under its guard.
  for (const x of [0.14, -0.55]) s.at(x, 0.31, side * (width / 2 + 0.16), side < 0 ? 0 : Math.PI, () => wheel(s, 0.31, 0.38));
}

// ── frames and shelves ───────────────────────────────────────────────────────

/** An open frame of square bars: `w` by `d` and `h` high, standing on four legs. */
export function frame(s: Sculpt, w: number, d: number, h: number, bar = 0.075, mid = true): void {
  const mark = nextMark();
  const x = w / 2 - bar / 2;
  const z = d / 2 - bar / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.box(bar, h, bar, sx * x, 0, sz * z, "white", mark);
  const levels = mid ? [h - bar, bar * 1.6] : [h - bar];
  for (const y of levels) {
    for (const sz of [-1, 1]) s.box(w - bar * 2, bar, bar, 0, y, sz * z, "white", mark);
    for (const sx of [-1, 1]) s.box(bar, bar, d - bar * 2, sx * x, y, 0, "white", mark);
  }
}

/** A flat frame standing upright along x, like a barrier. */
export function gate(s: Sculpt, w: number, h: number, bar = 0.09): void {
  const mark = nextMark();
  for (const sx of [-1, 1]) s.box(bar, h, bar * 1.4, sx * (w / 2 - bar / 2), 0, 0, "white", mark);
  for (const y of [0.16, h - bar]) s.box(w - bar * 2, bar, bar * 1.4, 0, y, 0, "white", mark);
}

/** A shelf unit `w` long with three boards, and cartons on them. Its front is its -z side. */
export function shelves(s: Sculpt, w = 1.71, d = 0.7, h = 2.37): void {
  const bar = 0.065;
  const mark = nextMark();
  const x = w / 2 - bar / 2;
  const z = d / 2 - bar / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.box(bar, h, bar, sx * x, 0, sz * z, "white", mark);
  for (const sz of [-1, 1]) s.box(w - bar * 2, bar, bar, 0, h - bar, sz * z, "white", mark);
  for (const sx of [-1, 1]) s.box(bar, bar, d - bar * 2, sx * x, h - bar, 0, "white", mark);
  const boards = [0.2, 0.9, 1.6];
  for (const y of boards) s.box(w - 0.02, 0.06, d - 0.02, 0, y, 0, "white");
  // Cartons, long side to the front, where there is one: the top board has a gap.
  const slots: [number, number][] = [[0, -0.42], [0, 0.42], [1, -0.42], [1, 0.42], [2, 0.42]];
  for (const [board, cx] of slots) carton(s, cx, boards[board] + 0.06, 0, 0);
}

// ── conveyors and the machines over them ─────────────────────────────────────

export interface BeltOptions {
  /** Round the belt off at its +x end, at its -x end, or both. */
  ends?: "+" | "-" | "both";
}

/** A conveyor along x, `length` by `width`, its top `top` above the floor: a base a little wider than the belt,
 *  two rails along each side of it, and the belt with a roller where it turns. */
export const BELT_THICK = 0.26;
export function conveyor(s: Sculpt, length: number, width: number, top: number, o: BeltOptions = {}): void {
  const ends = o.ends ?? "+";
  const half = length / 2;
  const r = BELT_THICK / 2;
  const y = top - BELT_THICK;
  const plus = ends !== "-";
  const minus = ends !== "+";
  const belt = new Shape();
  belt.moveTo(-half + (minus ? r : 0), 0);
  belt.lineTo(half - (plus ? r : 0), 0);
  if (plus) belt.absarc(half - r, r, r, -Math.PI / 2, Math.PI / 2, false);
  else belt.lineTo(half, BELT_THICK);
  belt.lineTo(-half + (minus ? r : 0), BELT_THICK);
  if (minus) belt.absarc(-half + r, r, r, Math.PI / 2, Math.PI * 1.5, false);
  belt.closePath();
  s.sweep(belt, width, 0, y, 0, "white", { way: "along-z", seg: 12 });
  // The roller the belt turns on, seen from the side it shows.
  for (const end of [plus ? half - r : null, minus ? -half + r : null]) {
    if (end === null) continue;
    s.cyl(r * 0.86, 0.02, end, y + r, -width / 2 - 0.02, "accent", { axis: "z", seg: 28 });
    s.cyl(r * 0.4, 0.012, end, y + r, -width / 2 - 0.032, "white", { axis: "z", seg: 18 });
  }
  // The base, and the rails along it.
  const baseW = width + 0.16;
  s.box(length, y, baseW, 0, 0, 0, "white");
  const from = -half + (minus ? r * 2 : 0);
  const to = half - (plus ? r * 2 : 0);
  for (const drop of [0.075, 0.2]) s.box(to - from, 0.03, baseW + 0.03, (from + to) / 2, y - drop, 0, "white");
}

export interface PortalOptions {
  /** How thick its walls are on the -z and the +z side, and the beam across the top. */
  near?: number; far?: number; beam?: number;
  /** How round its top corners are, on the -z and the +z side. */
  rNear?: number; rFar?: number;
}

/** A machine that stands over a conveyor running along x: an arch `depth` long (x), `w` wide (z) and `h` high,
 *  centred on its own footprint. */
export function portal(s: Sculpt, depth: number, w: number, h: number, o: PortalOptions = {}): void {
  const near = o.near ?? 0.1;
  const far = o.far ?? 0.22;
  const beam = o.beam ?? 0.43;
  const rn = o.rNear ?? 0.3;
  const rf = o.rFar ?? 0.05;
  const half = w / 2;
  // Drawn in (z, y): -half is the side that shows.
  const arch = new Shape();
  arch.moveTo(-half, 0);
  arch.lineTo(-half + near, 0);
  arch.lineTo(-half + near, h - beam);
  arch.lineTo(half - far, h - beam);
  arch.lineTo(half - far, 0);
  arch.lineTo(half, 0);
  arch.lineTo(half, h - rf);
  arch.absarc(half - rf, h - rf, rf, 0, Math.PI / 2, false);
  arch.lineTo(-half + rn, h);
  arch.absarc(-half + rn, h - rn, rn, Math.PI / 2, Math.PI, false);
  arch.closePath();
  s.sweep(arch, depth, 0, 0, 0, "white", { way: "along-x", seg: 10 });
}

/** A panel on a machine's -z wall: a raised plate with a screen set in it, and a button under the screen if asked. */
export function panel(s: Sculpt, w: number, h: number, button: Tint | null = null): void {
  s.box(w, h, 0.07, 0, 0, -0.035, "white");
  const screenH = button ? h * 0.4 : h * 0.46;
  s.box(w * 0.7, screenH, 0.012, 0, h - screenH - h * 0.16, -0.076, "steel");
  if (button) s.sweep(roundRect(0.2, 0.11, 0.055), 0.03, 0, h * 0.2, -0.085, button, { way: "along-z" });
}

/** A lamp bar on a machine's +x wall: a slab, or a pill. Built twice, once in each colour, by stations.ts. */
export function lampBar(s: Sculpt, tint: Tint, pill = false): void {
  if (pill) s.sweep(roundRect(0.62, 0.14, 0.07), 0.07, 0.035, 0, 0, tint, { way: "along-x" });
  else s.box(0.07, 0.17, 0.56, 0.035, -0.085, 0, tint);
}

/** Strips hanging across the top of a way through, `w` wide, on a machine's -z wall. */
export function curtain(s: Sculpt, w: number, drop = 0.36, strips = 6): void {
  const each = w / strips;
  for (let i = 0; i < strips; i++) s.box(each - 0.035, drop, 0.02, -w / 2 + each * (i + 0.5), -drop, -0.012, "white");
}

/** A control box on a machine's +x wall: a plate with an amber and a red button. */
export function controls(s: Sculpt): void {
  s.box(0.07, 0.4, 0.575, 0.035, 0, 0, "white");
  for (const [z, tint] of [[0.15, "amber"], [-0.04, "red"]] as const) s.cyl(0.055, 0.03, 0.07, 0.14, z, tint, { axis: "x", seg: 18 });
}

/** A round lamp on a machine's -z wall. */
export function lampDisc(s: Sculpt, tint: Tint, r = 0.17): void {
  s.cyl(r, 0.05, 0, 0, 0, tint, { axis: "z", seg: 32 });
}

// ── parts ────────────────────────────────────────────────────────────────────

/** A gear lying flat: `r` to the tips of its teeth. */
export function gearShape(r = 0.17, teeth = 8): Shape {
  const root = r * 0.76;
  const pts: [number, number][] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    const step = TAU / teeth;
    pts.push([Math.cos(a - step * 0.2) * r, Math.sin(a - step * 0.2) * r]);
    pts.push([Math.cos(a + step * 0.2) * r, Math.sin(a + step * 0.2) * r]);
    pts.push([Math.cos(a + step * 0.32) * root, Math.sin(a + step * 0.32) * root]);
    pts.push([Math.cos(a + step * 0.68) * root, Math.sin(a + step * 0.68) * root]);
  }
  const shape = outline(pts);
  const hole = new Shape();
  hole.absarc(0, 0, r * 0.3, 0, TAU, true);
  shape.holes.push(hole);
  return shape;
}
export const GEAR_THICK = 0.075;
/** A gear lying flat on (x, y, z), turned `ry`. */
export function gear(s: Sculpt, x = 0, y = 0, z = 0, ry = 0): void {
  s.at(x, y, z, ry, () => { s.sweep(gearShape(), GEAR_THICK, 0, 0, 0, "amber", { seg: 6 }); });
}

/** A motor lying along z, its shaft toward -z: a drum on a foot, a box on top, a stub of shaft at each end. With
 *  `geared`, a gear is on the -z shaft. The origin is under the middle of its foot. */
export function motor(s: Sculpt, geared = false): void {
  const mark = nextMark();
  s.box(0.24, 0.6, 0.3, 0, 0, 0, "accent", mark);
  s.cyl(0.2, 0.42, 0, 0.3, -0.21, "accent", { axis: "z", seg: 28 });
  s.cyl(0.165, 0.09, 0, 0.3, -0.3, "accent", { axis: "z", seg: 28 });
  s.box(0.2, 0.07, 0.16, 0, 0.6, 0, "accent");
  // A stub of shaft with a knob on it, out of each end.
  for (const from of [-0.43, 0.21]) s.cyl(0.035, 0.13, 0, 0.3, from, "accent", { axis: "z", seg: 14 });
  for (const from of [-0.485, 0.34]) s.cyl(0.058, 0.055, 0, 0.3, from, "accent", { axis: "z", seg: 14 });
  if (geared) s.sweep(gearShape(0.19), GEAR_THICK, 0, 0.3, -0.39, "amber", { way: "along-z", seg: 6 });
}

/** A hex bolt standing on its head. */
export function bolt(s: Sculpt, scale = 1): void {
  const head = new Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    if (i === 0) head.moveTo(Math.cos(a) * 0.085 * scale, Math.sin(a) * 0.085 * scale);
    else head.lineTo(Math.cos(a) * 0.085 * scale, Math.sin(a) * 0.085 * scale);
  }
  head.closePath();
  s.sweep(head, 0.07 * scale, 0, 0, 0, "amber");
  s.cyl(0.042 * scale, 0.13 * scale, 0, 0.07 * scale, 0, "amber", { seg: 12 });
}

/** The part that gets fastened: a plate with a hole in it and a drum beside it. `bolted` puts a bolt's head in
 *  the hole. The origin is under the middle of the plate. */
export const PLATE = { w: 0.52, h: 0.17, d: 0.52 } as const;
export function plate(s: Sculpt, bolted = false): void {
  s.box(PLATE.w, PLATE.h, PLATE.d, 0, 0, 0, "accent");
  s.cyl(0.15, 0.3, -0.25, 0, -0.25, "accent", { seg: 28 });
  if (bolted) {
    const head = new Shape();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      if (i === 0) head.moveTo(Math.cos(a) * 0.085, Math.sin(a) * 0.085);
      else head.lineTo(Math.cos(a) * 0.085, Math.sin(a) * 0.085);
    }
    head.closePath();
    s.sweep(head, 0.06, 0, PLATE.h, 0, "amber");
  } else {
    s.cyl(0.035, 0.004, 0, PLATE.h, 0, "accent", { seg: 16 });
  }
}

/** The part that gets wired: a block with three posts and two cables looping from its back to the outer posts.
 *  The third cable is separate (`cable`). The origin is under the middle of the block. */
export const BLOCK = { w: 0.5, h: 0.2, d: 0.38 } as const;
export const POSTS: readonly (readonly [number, number])[] = [[-0.16, -0.08], [0, -0.11], [0.16, -0.08]];
export function wiredBlock(s: Sculpt): void {
  s.box(BLOCK.w, BLOCK.h, BLOCK.d, 0, 0, 0, "accent");
  const y = BLOCK.h;
  for (const [x, z] of POSTS) {
    s.cyl(0.046, 0.03, x, y, z, "white", { seg: 18 });
    s.cyl(0.025, 0.026, x, y + 0.03, z, "white", { seg: 12 });
  }
  for (const [x, z] of [POSTS[0], POSTS[2]]) {
    // Kept out near the outer posts, so a hand plugging the middle one fits between them.
    s.tube([[x * 0.8, y, 0.12], [x * 0.85, y + 0.26, 0.085], [x * 0.95, y + 0.3, -0.02], [x, y + 0.05, z]], 0.021, "amber", { seg: 24 });
  }
}

type P3 = [number, number, number];
const LOOSE: readonly P3[] = [[0.05, BLOCK.h, 0.13], [0.17, BLOCK.h + 0.22, 0.1], [0.37, BLOCK.h + 0.14, 0.02], [0.42, BLOCK.h - 0.08, -0.05]];
const PLUGGED: readonly P3[] = [[0.05, BLOCK.h, 0.13], [0.07, BLOCK.h + 0.31, 0.085], [0.03, BLOCK.h + 0.34, -0.03], [0, BLOCK.h + 0.05, -0.11]];
/** The third cable's shape `u` of the way from lying loose beside the block (0) to plugged into the middle post
 *  (1): the points it bends through, in the block's own terms. Its free end is the last. */
export function cablePoints(u: number): P3[] {
  const lift = Math.sin(Math.PI * u) * 0.17;
  return LOOSE.map((a, i) => {
    const b = PLUGGED[i];
    const up = i >= 2 ? lift : i === 1 ? lift * 0.4 : 0;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + up, a[2] + (b[2] - a[2]) * u];
  });
}
/** The third cable, `u` of the way from loose to plugged, with the plug on its end. */
export function cable(s: Sculpt, u: number): void {
  const pts = cablePoints(u);
  s.tube(pts, 0.021, "amber", { seg: 24 });
  const end = pts[pts.length - 1];
  s.ball(0.034, end[0], end[1], end[2], "white");
}

/** The tool that drives a bolt: a barrel with a collar and a hex socket at its tip, a little wider than a bolt's
 *  head so it fits over one. It points along -y from its origin, which is where the hand holds it; its tip is
 *  `DRIVER_TIP` below that. */
export const DRIVER_TIP = 0.42;
export function driver(s: Sculpt): void {
  s.cyl(0.11, 0.36, 0, -0.2, 0, "white", { seg: 24 });
  s.cyl(0.118, 0.09, 0, -0.29, 0, "amber", { seg: 24 });
  s.cyl(0.1, 0.13, 0, -DRIVER_TIP, 0, "accent", { seg: 6 });
}
