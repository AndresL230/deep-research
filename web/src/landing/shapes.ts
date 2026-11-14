// The hero scene's solids as plain arrays: scene.ts wraps them in three.js geometry. Everything is built from an
// outline (a closed curve on the floor, with its outward normals) swept upward, so one function makes the square
// pads, the round pads, and every plate, button and disc on top of them. No three.js here: test/landing.test.ts
// checks the meshes face outward.

/** A closed curve on the floor (the XZ plane), counter-clockwise by angle, with a unit outward normal per point. */
export interface Outline {
  /** x, z per point. */
  points: Float32Array;
  /** Outward unit normal, x, z per point. */
  normals: Float32Array;
  count: number;
  /** The point of the curve whose outward normal is (nx, nz): where a line of sight grazes it. */
  support(nx: number, nz: number): [number, number];
}

/** A rectangle of half-width `halfX` and half-depth `halfZ` with corners rounded to `radius`. */
export function roundedRect(halfX: number, halfZ: number, radius: number, cornerSegments = 12): Outline {
  const count = 4 * (cornerSegments + 1);
  const points = new Float32Array(count * 2);
  const normals = new Float32Array(count * 2);
  const innerX = halfX - radius;
  const innerZ = halfZ - radius;
  let i = 0;
  for (let corner = 0; corner < 4; corner++) {
    // Corner 0 is +x +z, then counter-clockwise by angle: -x +z, -x -z, +x -z.
    const cx = corner === 0 || corner === 3 ? innerX : -innerX;
    const cz = corner < 2 ? innerZ : -innerZ;
    for (let s = 0; s <= cornerSegments; s++) {
      const a = (corner + s / cornerSegments) * (Math.PI / 2);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      points[i * 2] = cx + radius * nx;
      points[i * 2 + 1] = cz + radius * nz;
      normals[i * 2] = nx;
      normals[i * 2 + 1] = nz;
      i++;
    }
  }
  const support = (nx: number, nz: number): [number, number] =>
    [Math.sign(nx) * innerX + radius * nx, Math.sign(nz) * innerZ + radius * nz];
  return { points, normals, count, support };
}

/** A square of half-width `half` with corners rounded to `radius`. */
export function roundedSquare(half: number, radius: number, cornerSegments = 12): Outline {
  return roundedRect(half, half, radius, cornerSegments);
}

/** A circle of `radius`. */
export function circle(radius: number, segments = 72): Outline {
  const points = new Float32Array(segments * 2);
  const normals = new Float32Array(segments * 2);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    normals[i * 2] = Math.cos(a);
    normals[i * 2 + 1] = Math.sin(a);
    points[i * 2] = radius * normals[i * 2];
    points[i * 2 + 1] = radius * normals[i * 2 + 1];
  }
  return { points, normals, count: segments, support: (nx, nz) => [radius * nx, radius * nz] };
}

export interface Solid {
  /** x, y, z per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  index: Uint16Array;
}

export interface PrismOptions {
  /** Steps around the rounded top edge. */
  filletSegments?: number;
  /** Where the solid's underside is. Default 0, the floor it stands on. */
  y0?: number;
  /** Close the underside too. Only a solid that leaves the ground and turns over needs it. */
  closed?: boolean;
}

/** `outline` swept up by `height`, its top edge rounded by `fillet`, with a flat cap. Open underneath unless
 *  `closed`: every other solid in the scene sits on something. */
export function prism(outline: Outline, height: number, fillet = 0, options: PrismOptions = {}): Solid {
  const { filletSegments = 6, y0 = 0, closed = false } = options;
  const n = outline.count;
  // The wall's rows from the floor up: [inset, y, how far the normal has tipped from sideways (0) to up (π/2)].
  const rows: [number, number, number][] = [[0, 0, 0]];
  if (fillet > 0) {
    rows.push([0, height - fillet, 0]);
    for (let j = 1; j <= filletSegments; j++) {
      const tip = (j / filletSegments) * (Math.PI / 2);
      rows.push([fillet * (1 - Math.cos(tip)), height - fillet + fillet * Math.sin(tip), tip]);
    }
  } else {
    rows.push([0, height, 0]);
  }
  // A square edge needs its own row for the cap, so the wall and the cap do not share a normal.
  const capRow = fillet > 0 ? rows.length - 1 : rows.length;
  // A closed solid gets one more row and a second centre, for the underside.
  const underRow = capRow + 1;
  const rowCount = underRow + (closed ? 1 : 0);
  const vertexCount = rowCount * n + (closed ? 2 : 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);

  const put = (row: number, inset: number, y: number, tip: number): void => {
    const sideways = Math.cos(tip);
    const up = Math.sin(tip);
    for (let i = 0; i < n; i++) {
      const nx = outline.normals[i * 2];
      const nz = outline.normals[i * 2 + 1];
      const v = (row * n + i) * 3;
      positions[v] = outline.points[i * 2] - inset * nx;
      positions[v + 1] = y0 + y;
      positions[v + 2] = outline.points[i * 2 + 1] - inset * nz;
      normals[v] = nx * sideways;
      normals[v + 1] = up;
      normals[v + 2] = nz * sideways;
    }
  };
  rows.forEach(([inset, y, tip], r) => put(r, inset, y, tip));
  if (fillet <= 0) put(capRow, 0, height, Math.PI / 2);
  if (closed) put(underRow, 0, 0, -Math.PI / 2);

  const centre = rowCount * n;
  positions[centre * 3 + 1] = y0 + height;
  normals[centre * 3 + 1] = 1;
  const under = centre + 1;
  if (closed) {
    positions[under * 3 + 1] = y0;
    normals[under * 3 + 1] = -1;
  }

  const wallRows = rows.length - 1;
  const index = new Uint16Array(wallRows * n * 6 + n * 3 * (closed ? 2 : 1));
  let k = 0;
  for (let r = 0; r < wallRows; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = r * n + i;
      const b = r * n + j;
      const c = (r + 1) * n + i;
      const d = (r + 1) * n + j;
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    index[k++] = centre; index[k++] = capRow * n + j; index[k++] = capRow * n + i;
    if (closed) { index[k++] = under; index[k++] = underRow * n + i; index[k++] = underRow * n + j; }
  }
  return { positions, normals, index };
}

/** A raised band that follows `outline`: `width` wide (measured inward), `height` tall, flat on top. The thin ones
 *  read as lines drawn on a pad; the wide ones are the collar round a button and the kerb round a body. */
export function band(outline: Outline, width: number, height: number): Solid {
  const n = outline.count;
  // Three strips, each between two rows: the outer wall, the top, the inner wall. [inset, y, normal: out, up]
  const rows: [number, number, number, number][] = [
    [0, 0, 1, 0], [0, height, 1, 0],
    [0, height, 0, 1], [width, height, 0, 1],
    [width, height, -1, 0], [width, 0, -1, 0],
  ];
  const positions = new Float32Array(rows.length * n * 3);
  const normals = new Float32Array(rows.length * n * 3);
  rows.forEach(([inset, y, out, up], r) => {
    for (let i = 0; i < n; i++) {
      const nx = outline.normals[i * 2];
      const nz = outline.normals[i * 2 + 1];
      const v = (r * n + i) * 3;
      positions[v] = outline.points[i * 2] - inset * nx;
      positions[v + 1] = y;
      positions[v + 2] = outline.points[i * 2 + 1] - inset * nz;
      normals[v] = nx * out;
      normals[v + 1] = up;
      normals[v + 2] = nz * out;
    }
  });
  const index = new Uint16Array(3 * n * 6);
  let k = 0;
  for (let strip = 0; strip < 3; strip++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = strip * 2 * n + i;
      const b = strip * 2 * n + j;
      const c = (strip * 2 + 1) * n + i;
      const d = (strip * 2 + 1) * n + j;
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  return { positions, normals, index };
}

/** The outline as a closed loop at height `y`, pulled in by `inset`: point pairs, one per segment, for a fat line. */
export function loop(outline: Outline, y: number, inset = 0): Float32Array {
  const n = outline.count;
  const out = new Float32Array(n * 6);
  const at = (i: number, o: number): void => {
    out[o] = outline.points[i * 2] - inset * outline.normals[i * 2];
    out[o + 1] = y;
    out[o + 2] = outline.points[i * 2 + 1] - inset * outline.normals[i * 2 + 1];
  };
  for (let i = 0; i < n; i++) {
    at(i, i * 6);
    at((i + 1) % n, i * 6 + 3);
  }
  return out;
}

/** The two upright edges a viewer sees on a solid's flanks: where lines of sight from direction (viewX, viewZ) on
 *  the floor graze `outline`. Each runs from `y0` to `y1`. Point pairs, like `loop`. */
export function flanks(outline: Outline, viewX: number, viewZ: number, y0: number, y1: number): Float32Array {
  const len = Math.hypot(viewX, viewZ) || 1;
  // The grazing normals are square to the line of sight.
  const nx = -viewZ / len;
  const nz = viewX / len;
  const out = new Float32Array(12);
  [[nx, nz], [-nx, -nz]].forEach(([ax, az], i) => {
    const [x, z] = outline.support(ax, az);
    out.set([x, y0, z, x, y1, z], i * 6);
  });
  return out;
}

/** An upright tag in the XY plane, standing on y = 0 and centred on x, with its two top corners rounded. Faces +z. */
export function tag(width: number, height: number, radius: number, cornerSegments = 8): { positions: Float32Array; index: Uint16Array } {
  const half = width / 2;
  const pts: number[] = [-half, 0, half, 0];
  for (let s = 0; s <= cornerSegments; s++) {
    const a = (s / cornerSegments) * (Math.PI / 2);
    pts.push(half - radius + radius * Math.cos(a), height - radius + radius * Math.sin(a));
  }
  for (let s = 0; s <= cornerSegments; s++) {
    const a = Math.PI / 2 + (s / cornerSegments) * (Math.PI / 2);
    pts.push(-half + radius + radius * Math.cos(a), height - radius + radius * Math.sin(a));
  }
  const count = pts.length / 2;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = pts[i * 2];
    positions[i * 3 + 1] = pts[i * 2 + 1];
  }
  const index = new Uint16Array((count - 2) * 3);
  for (let i = 1; i < count - 1; i++) index.set([0, i, i + 1], (i - 1) * 3);
  return { positions, index };
}

/** A polyline with its corners rounded to `radius`, resampled into `segments` equal steps: x, y, z per point. */
export function roundedPath(corners: [number, number][], radius: number, y: number, segments: number): Float32Array {
  // First the exact curve as a dense polyline, then equal steps along its length.
  const dense: [number, number][] = [corners[0]];
  for (let i = 1; i < corners.length - 1; i++) {
    const [px, pz] = corners[i - 1];
    const [cx, cz] = corners[i];
    const [nx, nz] = corners[i + 1];
    const inLen = Math.hypot(cx - px, cz - pz);
    const outLen = Math.hypot(nx - cx, nz - cz);
    const ix = (cx - px) / inLen;
    const iz = (cz - pz) / inLen;
    const ox = (nx - cx) / outLen;
    const oz = (nz - cz) / outLen;
    const r = Math.min(radius, inLen / 2, outLen / 2);
    // Corners here are right angles, so the arc starts `r` before the corner and ends `r` after it: a quarter
    // circle that leaves along the first leg and arrives along the second.
    const sx = cx - ix * r;
    const sz = cz - iz * r;
    const steps = 16;
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * (Math.PI / 2);
      dense.push([sx + ix * r * Math.sin(a) + ox * r * (1 - Math.cos(a)), sz + iz * r * Math.sin(a) + oz * r * (1 - Math.cos(a))]);
    }
  }
  dense.push(corners[corners.length - 1]);

  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = lengths[lengths.length - 1];
  const out = new Float32Array((segments + 1) * 3);
  let seg = 1;
  for (let s = 0; s <= segments; s++) {
    const target = (s / segments) * total;
    while (seg < dense.length - 1 && lengths[seg] < target) seg++;
    const span = lengths[seg] - lengths[seg - 1] || 1;
    const u = (target - lengths[seg - 1]) / span;
    out[s * 3] = dense[seg - 1][0] + (dense[seg][0] - dense[seg - 1][0]) * u;
    out[s * 3 + 1] = y;
    out[s * 3 + 2] = dense[seg - 1][1] + (dense[seg][1] - dense[seg - 1][1]) * u;
  }
  return out;
}
