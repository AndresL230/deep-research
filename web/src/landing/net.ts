// The web that the split finder's chapter draws (finder.ts): points spread over a sphere, each tied to the points
// near it. A point stands for one action of one run, and the web is drawn on, and later thinned out again, in the
// order worked out here: outward from a few seeds, along the ties.
//
// Plain arithmetic on flat arrays, three numbers to a point. Nothing here touches three.js or the DOM, so it is
// tested in test/landing.test.ts.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** `count` points spread evenly over the unit sphere: a spiral from the top to the bottom that turns by the golden
 *  angle from one point to the next, so they never fall into lines. */
export function spherePoints(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const a = i * GOLDEN_ANGLE;
    out[i * 3] = r * Math.cos(a);
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = r * Math.sin(a);
  }
  return out;
}

/** The points turned the way the scene turns them: by `yaw` about the upright axis, then tilted by `tilt` about the
 *  one that runs across, then rolled by `roll` about the line of sight. x is to the right, y up, z toward the
 *  viewer. (three.js makes the same turn from Euler angles (tilt, yaw, roll) in the order "ZXY".) */
export function turn(points: Float32Array, yaw: number, tilt: number, roll: number): Float32Array {
  const out = new Float32Array(points.length);
  const [cy, sy, ct, st, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(tilt), Math.sin(tilt), Math.cos(roll), Math.sin(roll)];
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] * cy + points[i + 2] * sy;
    const z0 = -points[i] * sy + points[i + 2] * cy;
    const y = points[i + 1] * ct - z0 * st;
    const z = points[i + 1] * st + z0 * ct;
    out[i] = x * cr - y * sr;
    out[i + 1] = x * sr + y * cr;
    out[i + 2] = z;
  }
  return out;
}

export interface Links {
  /** The two points each tie joins: two indices per tie, the lower first. */
  pairs: Uint16Array;
  /** Each tie's length, straight through the sphere. */
  length: Float32Array;
  /** How strongly each tie is drawn, 0 to 1: nearly 1 for two points that almost touch, 0 at `reach`. */
  strength: Float32Array;
}

/** A tie between every two points nearer each other than `reach`. Short ties are strong and make the web's mesh;
 *  long ones are faint and cross it. */
export function linksWithin(points: Float32Array, reach: number): Links {
  const count = points.length / 3;
  const pairs: number[] = [];
  const length: number[] = [];
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const d = Math.hypot(points[a * 3] - points[b * 3], points[a * 3 + 1] - points[b * 3 + 1], points[a * 3 + 2] - points[b * 3 + 2]);
      if (d < reach) { pairs.push(a, b); length.push(d); }
    }
  }
  return { pairs: Uint16Array.from(pairs), length: Float32Array.from(length), strength: Float32Array.from(length, (d) => 1 - d / reach) };
}

/** How far each of `count` points is from the nearest of `seeds`, walking along the ties. Infinity for a point no
 *  walk reaches. */
export function walk(count: number, links: Links, seeds: readonly number[]): Float64Array {
  const next: [number, number][][] = Array.from({ length: count }, () => []);
  for (let k = 0; k < links.length.length; k++) {
    const [a, b] = [links.pairs[k * 2], links.pairs[k * 2 + 1]];
    next[a].push([b, links.length[k]]);
    next[b].push([a, links.length[k]]);
  }
  const far = new Float64Array(count).fill(Infinity);
  const done = new Uint8Array(count);
  for (const s of seeds) far[s] = 0;
  // The web is a hundred or so points: the plain search, which looks at every point for the nearest, is plenty.
  for (;;) {
    let at = -1;
    for (let i = 0; i < count; i++) if (!done[i] && far[i] < Infinity && (at < 0 || far[i] < far[at])) at = i;
    if (at < 0) return far;
    done[at] = 1;
    for (const [to, d] of next[at]) if (far[at] + d < far[to]) far[to] = far[at] + d;
  }
}

/** When each point comes on, 0 to 1, from how far it is from a seed: the seeds at 0, a point `full` away or
 *  farther at 1. */
export function orders(far: Float64Array, full: number): Float32Array {
  return Float32Array.from(far, (d) => Math.min(1, d / full));
}

/** `count` of the points that face the viewer (z above `facing`), spread as far from each other on the screen as
 *  they will go: the one nearest the middle first, then each time the one farthest from all those picked. `seen`
 *  is the points as the viewer sees them (see `turn`). */
export function pickSpread(seen: Float32Array, count: number, facing: number): number[] {
  const open: number[] = [];
  for (let i = 0; i < seen.length / 3; i++) if (seen[i * 3 + 2] > facing) open.push(i);
  if (!open.length) return [];
  const apart = (a: number, b: number): number => Math.hypot(seen[a * 3] - seen[b * 3], seen[a * 3 + 1] - seen[b * 3 + 1]);
  const picked = [open.reduce((best, i) => (Math.hypot(seen[i * 3], seen[i * 3 + 1]) < Math.hypot(seen[best * 3], seen[best * 3 + 1]) ? i : best))];
  while (picked.length < Math.min(count, open.length)) {
    let best = -1;
    let bestGap = -1;
    for (const i of open) {
      if (picked.includes(i)) continue;
      const gap = Math.min(...picked.map((p) => apart(i, p)));
      if (gap > bestGap) { best = i; bestGap = gap; }
    }
    picked.push(best);
  }
  return picked;
}

/** The point that lies nearest the direction (x, y, z). */
export function nearest(points: Float32Array, x: number, y: number, z: number): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < points.length / 3; i++) {
    const dot = points[i * 3] * x + points[i * 3 + 1] * y + points[i * 3 + 2] * z;
    if (dot > bestDot) { best = i; bestDot = dot; }
  }
  return best;
}
