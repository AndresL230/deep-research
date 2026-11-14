// The robot floor's solids are put together here: boxes, cylinders, swept outlines and bent tubes, each stamped
// with its colour and its mark (contour.ts draws a line wherever two marks meet), then fused into one mesh.
//
// Everything is placed by the middle of its base: `x, y, z` is where the bottom of a part stands. `at` nests, so
// a prop is written once around its own origin and stood anywhere, at any turn.

import {
  BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, CylinderGeometry, ExtrudeGeometry, Matrix4, Mesh,
  Shape, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
  type Color, type Material, type Path,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Tint } from "./contour";

let marks = 0;
/** A mark no other part has. Parts that share one are drawn as one piece: no line where they touch. */
export const nextMark = (): number => {
  marks = (marks % 65000) + 1;
  return marks;
};

export type Axis = "x" | "y" | "z";

export interface CylOptions {
  /** Which way it stands: along y (up) unless said. */
  axis?: Axis;
  /** The radius at its far end, for a cone. */
  top?: number;
  seg?: number;
  mark?: number;
  /** No end caps. */
  open?: boolean;
}

export interface SweepOptions {
  /** `up`: the outline lies on the floor (x, z) and is raised. `along-z`: it stands in x, y and runs back along z.
   *  `along-x`: it stands in z, y and runs along x. The sweep is centred on its length either way. */
  way?: "up" | "along-z" | "along-x";
  seg?: number;
  mark?: number;
}

const scratch = new Matrix4();
const turn = new Matrix4();

/** A rectangle `w` by `d` round the origin with corners of radius `r`, as a floor outline for `sweep`. */
export function roundRect(w: number, d: number, r: number): Shape {
  const s = new Shape();
  const x = w / 2;
  const y = d / 2;
  const k = Math.min(r, x, y);
  s.moveTo(-x + k, -y);
  s.lineTo(x - k, -y);
  s.absarc(x - k, -y + k, k, -Math.PI / 2, 0, false);
  s.lineTo(x, y - k);
  s.absarc(x - k, y - k, k, 0, Math.PI / 2, false);
  s.lineTo(-x + k, y);
  s.absarc(-x + k, y - k, k, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + k);
  s.absarc(-x + k, -y + k, k, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** The same rectangle as a hole to cut out of a shape. */
export function roundHole(w: number, d: number, r: number, cx = 0, cy = 0): Path {
  const s = roundRect(w, d, r);
  const hole = new Shape();
  // A hole runs the other way round.
  const points = s.getPoints(8).reverse();
  hole.moveTo(points[0].x + cx, points[0].y + cy);
  for (let i = 1; i < points.length; i++) hole.lineTo(points[i].x + cx, points[i].y + cy);
  return hole;
}

/** A closed outline through `points` (x, y pairs). */
export function outline(points: readonly (readonly [number, number])[]): Shape {
  const s = new Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

export class Sculpt {
  private parts: BufferGeometry[] = [];
  private m = new Matrix4();

  constructor(private tints: Record<Tint, Color>) {}

  /** Run `fn` with everything it adds stood at (x, y, z) and turned `ry` about the upright axis. */
  at(x: number, y: number, z: number, ry: number, fn: () => void): this {
    const keep = this.m.clone();
    this.m.multiply(scratch.makeTranslation(x, y, z));
    if (ry) this.m.multiply(scratch.makeRotationY(ry));
    fn();
    this.m.copy(keep);
    return this;
  }

  /** Run `fn` with everything it adds tipped by `rx`, then `rz`, about the current origin. */
  tipped(rx: number, rz: number, fn: () => void): this {
    const keep = this.m.clone();
    if (rz) this.m.multiply(scratch.makeRotationZ(rz));
    if (rx) this.m.multiply(scratch.makeRotationX(rx));
    fn();
    this.m.copy(keep);
    return this;
  }

  /** Add any geometry, in the current place. Returns its mark. */
  add(source: BufferGeometry, tint: Tint, mark = nextMark()): number {
    const g = source.index ? source.toNonIndexed() : source;
    if (g !== source) source.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    g.applyMatrix4(this.m);
    const count = g.getAttribute("position").count;
    const c = this.tints[tint];
    const tintArray = new Float32Array(count * 3);
    const markArray = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      tintArray[i * 3] = c.r;
      tintArray[i * 3 + 1] = c.g;
      tintArray[i * 3 + 2] = c.b;
      markArray[i] = mark;
    }
    g.setAttribute("tint", new BufferAttribute(tintArray, 3));
    g.setAttribute("mark", new BufferAttribute(markArray, 1));
    this.parts.push(g);
    return mark;
  }

  /** A box `w` wide (x), `h` high and `d` deep (z), its base centred on (x, y, z). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, tint: Tint, mark?: number): number {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    return this.add(g, tint, mark);
  }

  /** A cylinder of radius `r` and length `h`. Its near end is centred on (x, y, z) and it runs along `axis`. */
  cyl(r: number, h: number, x: number, y: number, z: number, tint: Tint, o: CylOptions = {}): number {
    const g = new CylinderGeometry(o.top ?? r, r, h, o.seg ?? 28, 1, o.open ?? false);
    g.translate(0, h / 2, 0);
    if (o.axis === "x") g.applyMatrix4(turn.makeRotationZ(-Math.PI / 2));
    else if (o.axis === "z") g.applyMatrix4(turn.makeRotationX(Math.PI / 2));
    g.translate(x, y, z);
    return this.add(g, tint, o.mark);
  }

  /** A ball of radius `r` centred on (x, y, z). */
  ball(r: number, x: number, y: number, z: number, tint: Tint, mark?: number): number {
    const g = new SphereGeometry(r, 24, 16);
    g.translate(x, y, z);
    return this.add(g, tint, mark);
  }

  /** A ring of radius `r` and thickness `t` round (x, y, z), lying flat unless `axis` stands it up. */
  ring(r: number, t: number, x: number, y: number, z: number, tint: Tint, axis: Axis = "y", mark?: number): number {
    const g = new TorusGeometry(r, t, 12, 36);
    if (axis === "y") g.applyMatrix4(turn.makeRotationX(Math.PI / 2));
    else if (axis === "x") g.applyMatrix4(turn.makeRotationY(Math.PI / 2));
    g.translate(x, y, z);
    return this.add(g, tint, mark);
  }

  /** An outline swept `length` far: raised from the floor, or run along z or x (see `SweepOptions.way`). */
  sweep(shape: Shape, length: number, x: number, y: number, z: number, tint: Tint, o: SweepOptions = {}): number {
    const g = new ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: o.seg ?? 10 });
    const way = o.way ?? "up";
    if (way === "up") {
      // The outline's y becomes the floor's -z, so an outline drawn (x, -z) comes out as drawn.
      g.applyMatrix4(turn.makeRotationX(-Math.PI / 2));
    } else if (way === "along-z") {
      g.translate(0, 0, -length / 2);
    } else {
      // The outline's x becomes z.
      g.translate(0, 0, -length / 2);
      g.applyMatrix4(turn.makeRotationY(-Math.PI / 2));
    }
    g.translate(x, y, z);
    return this.add(g, tint, o.mark);
  }

  /** A round tube of radius `r` through `points`. */
  tube(points: readonly (readonly [number, number, number])[], r: number, tint: Tint, o: { closed?: boolean; seg?: number; mark?: number } = {}): number {
    const curve = new CatmullRomCurve3(points.map((p) => new Vector3(p[0], p[1], p[2])), o.closed ?? false, "catmullrom", 0.5);
    const g = new TubeGeometry(curve, o.seg ?? Math.max(16, points.length * 6), r, 10, o.closed ?? false);
    return this.add(g, tint, o.mark);
  }

  /** Everything added so far, as one mesh. */
  mesh(material: Material): Mesh {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return new Mesh(merged ?? new BufferGeometry(), material);
  }

  get empty(): boolean { return this.parts.length === 0; }
}
