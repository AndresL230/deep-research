// What the landing page's 3D scenes share (scene.ts, the hero; devices.ts, the section under it; finder.ts, the
// split finder's chapter): the two palettes, the lights, the gridded floor, the helpers that turn shapes.ts solids
// into three.js meshes, and the loop that only runs while its canvas can be seen. A kit owns one canvas and
// everything made through it, and `dispose()` gives it all back.

import {
  AmbientLight, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight, LinearFilter,
  LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, PlaneGeometry,
  ShaderMaterial, SRGBColorSpace, Vector2, Vector3, Vector4, WebGLRenderer,
  type Material, type Scene, type Texture,
} from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { loop, type Outline, type Solid } from "./shapes";

/** The scenes come in two palettes: dark things on a dark floor, or the white ones on a light floor. */
export type SceneTone = "dark" | "light";

export interface Palette {
  /** A pad's plate, the thin line drawn on it, the kerb, the body, the button's collar and the button. */
  base: number; rim: number; ledge: number; body: number; collar: number; button: number;
  /** The disc an icon sits on, and the colour a step's icon is drawn in. */
  disc: number; glyph: string;
  /** The task's and verdict's body and the ring round their disc: the button's purple, a step darker and as is. */
  port: number; portRing: number;
  /** Outlines: on the pads, on the task and verdict, on the discs. */
  padLine: number; portLine: number; discLine: number;
  /** A line between two pads, and the same line once the work has moved along it. */
  path: number; pathLit: number;
  /** A label's panel and its words (an "r, g, b" triple). */
  label: number; labelInk: string;
  /** The floor's grid, a risen floor tile, and the soft patch under a pad ("r, g, b" and how strong). */
  grid: number; tile: number; shade: string; shadeOpacity: number;

  // The devices under the hero.
  /** A device's casing and the thin line round its screen. */
  casing: number; screenLine: number;
  /** A screen and what is written on it: its faint lines, the words, the quiet words, the accent, and the chip
   *  behind a path. */
  screen: string; scan: string; ink: string; dim: string; accent: string; chip: string;
  /** A stage light: its seat, off, lit, and the glow round the one that is working. */
  ledSeat: number; led: number; ledLit: number; halo: number;
  /** A key and the plate it sits in; the key that is on, and the words on each. */
  key: number; keyPlate: number; keyOn: number; keyInk: string; keyOnInk: string;
  /** The caption under a light: off and lit. */
  caption: string; captionLit: string;
  /** The slot a ticket prints from, the ticket, and the bar and words on it. */
  slot: number; paper: number; paperBar: string; paperInk: string; paperDim: string;
  /** The sheet of glass that stands behind the data bench, how see-through it is, and its edge. */
  glass: number; glassOpacity: number; glassLine: number;
  /** A row of the table on the bench, a planted duplicate, a row held out, and the scanner's light. */
  row: number; twin: number; held: number; beam: number;

  // The split finder's chapter.
  /** The card the chapter sits on (the stylesheet's `--lp-surface`), a run's coin, the line round its edge, and
   *  the run's name written on it. */
  surface: number; coin: number; coinLine: number; coinInk: string;
  /** The web's lines and points. */
  net: number;
}

// The light palette's top faces come out as exactly these colours under the lights below, and the sides a step and
// two steps darker. The dark palette keeps that order of lightness: floor, tile, plate, body, collar, button, with
// the outlines and the lit lines lighter than what they are drawn on.
export const PALETTES: Record<SceneTone, Palette> = {
  light: {
    base: 0xffffff, rim: 0xe2e4e4, ledge: 0xe9ecec, body: 0xffffff, collar: 0xffffff, button: 0xebecfa,
    disc: 0x2b3235, glyph: "#c4c8cc",
    port: 0xebecfa, portRing: 0xb7bce1,
    padLine: 0xa8aeb2, portLine: 0x939bcc, discLine: 0x757c81,
    path: 0xb9bfc5, pathLit: 0x5c6368,
    label: 0x51585d, labelInk: "242, 243, 243",
    grid: 0xe9ecec, tile: 0xffffff, shade: "22, 24, 29", shadeOpacity: 0.06,

    casing: 0xf2f3f3, screenLine: 0xd6d9db,
    screen: "#fbfbfc", scan: "rgba(22, 24, 29, 0.022)", ink: "#16181d", dim: "#747b81", accent: "#5a63b0", chip: "rgba(90, 99, 176, 0.13)",
    ledSeat: 0xb9bfc5, led: 0xdfe2e4, ledLit: 0x7d86cf, halo: 0x7d86cf,
    key: 0xffffff, keyPlate: 0xe2e4e4, keyOn: 0x2b3235, keyInk: "#16181d", keyOnInk: "#f2f3f3",
    caption: "#747b81", captionLit: "#16181d",
    slot: 0x2b3235, paper: 0xffffff, paperBar: "rgba(90, 99, 176, 0.2)", paperInk: "#16181d", paperDim: "#747b81",
    glass: 0xffffff, glassOpacity: 0.78, glassLine: 0xc9cdd1,
    row: 0xd6d9db, twin: 0xf0b452, held: 0x939bcc, beam: 0x7d86cf,

    surface: 0xe9ecec, coin: 0xffffff, coinLine: 0xa8aeb2, coinInk: "#c4c8cc",
    net: 0x757c81,
  },
  dark: {
    base: 0x2a2e34, rim: 0x464c54, ledge: 0x23272c, body: 0x31363c, collar: 0x3e444b, button: 0x666c92,
    disc: 0x2b3235, glyph: "#e4e7ea",
    port: 0x33364c, portRing: 0x666c92,
    padLine: 0x626970, portLine: 0x868ec1, discLine: 0x7d848b,
    path: 0x3b4147, pathLit: 0xdde1e4,
    label: 0xe9ecec, labelInk: "22, 24, 29",
    grid: 0x202428, tile: 0x23272c, shade: "0, 0, 0", shadeOpacity: 0.34,

    casing: 0x2d3137, screenLine: 0x4a5058,
    screen: "#0f1114", scan: "rgba(255, 255, 255, 0.018)", ink: "#e4e7ea", dim: "#858c93", accent: "#9aa4df", chip: "rgba(154, 164, 223, 0.17)",
    ledSeat: 0x4a5058, led: 0x3a3f46, ledLit: 0x9aa4df, halo: 0x868ec1,
    key: 0x3e444b, keyPlate: 0x23272c, keyOn: 0xe9ecec, keyInk: "#e4e7ea", keyOnInk: "#16181d",
    caption: "#858c93", captionLit: "#e4e7ea",
    slot: 0x0b0d10, paper: 0xe9ecec, paperBar: "rgba(102, 108, 146, 0.35)", paperInk: "#16181d", paperDim: "#5c646a",
    glass: 0xdfe3ea, glassOpacity: 0.07, glassLine: 0x626970,
    row: 0x444a52, twin: 0xe0a235, held: 0x868ec1, beam: 0x9aa4df,

    surface: 0x1b1e23, coin: 0x3e444b, coinLine: 0x7d848b, coinInk: "#c4c8cc",
    net: 0xc1c7cd,
  },
};

/** The page's type, for words painted into the scenes. */
export const LABEL_FONT = "'Geist', 'Geist Fallback', system-ui, sans-serif";
export const CODE_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** `#rrggbb` for a three.js colour number. */
export const css = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

export const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const GRID_VERTEX = /* glsl */ `
varying vec2 vFloor;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vFloor = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const GRID_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uCell;
uniform float uHalfLine;
uniform vec2 uSize;
uniform vec4 uEdge;
uniform vec3 uFade;
varying vec2 vFloor;
void main() {
  vec2 cell = vFloor / uCell;
  vec2 perPixel = fwidth(cell);
  // Distance to the nearest grid line, in pixels, on each axis.
  vec2 off = abs(fract(cell - 0.5) - 0.5) / perPixel;
  float line = 1.0 - smoothstep(uHalfLine - 0.5, uHalfLine + 0.5, min(off.x, off.y));
  // Far away the cells shrink to a few pixels: let the lines go before they shimmer.
  line *= 1.0 - smoothstep(0.12, 0.34, max(perPixel.x, perPixel.y));
  // Fade with distance from the middle of the floor: by uFade.x, between uFade.y and uFade.z.
  line *= 1.0 - uFade.x * smoothstep(uFade.y, uFade.z, length(vFloor));
  // Fade out toward the canvas's edges (left, top, right, bottom).
  vec2 p = gl_FragCoord.xy;
  line *= smoothstep(0.0, uEdge.x, p.x) * smoothstep(0.0, uEdge.z, uSize.x - p.x);
  line *= smoothstep(0.0, uEdge.w, p.y) * smoothstep(0.0, uEdge.y, uSize.y - p.y);
  gl_FragColor = vec4(uColor, line);
  #include <colorspace_fragment>
}`;

/** A canvas to paint on and the texture that shows it. Set `texture.needsUpdate` after painting. */
export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
}

/** The floor's grid: tell it the canvas's size whenever that changes. */
export interface Floor {
  mesh: Mesh;
  /** The uniforms of the grid's fade toward the canvas's edges (the canvas's size and how far in each edge fades,
   *  in pixels), for anything else on the floor that should dissolve with it. */
  fade: { uSize: { value: Vector2 }; uEdge: { value: Vector4 } };
  /** `width` is the canvas in CSS pixels; `edge` is how far the grid fades in from each side (left, top, right,
   *  bottom), as fractions of the canvas. */
  resize(width: number, edge: [number, number, number, number]): void;
}

export interface Kit {
  renderer: WebGLRenderer;
  canvas: HTMLCanvasElement;
  ink: Palette;
  /** Remember a material or geometry made outside the kit, so `dispose()` frees it too. */
  keep<T extends Material>(material: T): T;
  own<T extends BufferGeometry>(geometry: T): T;
  /** A matt and a slightly glossy material. Solids sit a hair back in depth so lines drawn on them always win. */
  matte(color: number): MeshLambertMaterial;
  gloss(color: number, specular?: number, shininess?: number): MeshPhongMaterial;
  /** A line material, `width` CSS pixels wide. */
  stroke(color: number, width: number): LineMaterial;
  solid(s: Solid, material: Material): Mesh;
  strokes(points: Float32Array, material: LineMaterial): LineSegments2;
  /** The line round a solid's top, where its rounded edge meets the flat. */
  brow(o: Outline, height: number, fillet: number, y0?: number): Float32Array;
  /** A square texture painted once. */
  paintTexture(size: number, paint: (ctx: CanvasRenderingContext2D) => void): CanvasTexture;
  /** A canvas to paint again and again, with the filtering that keeps small type sharp at a slant. */
  surface(width: number, height: number): Surface;
  /** A unit square lying on the floor, and one standing up, to scale into panels. */
  flat: PlaneGeometry;
  square: PlaneGeometry;
  /** The soft dark patch under something that stands on the floor: `width` by `depth`, `y` above it. */
  blob(width: number, y: number, depth?: number, strength?: number): Mesh;
  /** The three lights every scene uses; `key` is where the main one stands. */
  lights(scene: Scene, key: [number, number, number]): void;
  /** The gridded floor. `fade` is how the grid dies away from the middle: by how much, from where, to where. */
  floor(scene: Scene, cell: number, fade: [number, number, number]): Floor;
  dispose(): void;
}

/** A canvas in `host` and the kit to fill it, or null where WebGL is not available. */
export function createKit(host: HTMLElement, tone: SceneTone): Kit | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const ink = PALETTES[tone];
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];
  const keep = <T extends Material>(m: T): T => { materials.push(m); return m; };
  const own = <T extends BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const hold = <T extends Texture>(t: T): T => { textures.push(t); return t; };
  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  const back = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const matte = (color: number): MeshLambertMaterial => keep(new MeshLambertMaterial({ color, ...back }));
  const gloss = (color: number, specular = 0x4a4a4a, shininess = 12): MeshPhongMaterial =>
    keep(new MeshPhongMaterial({ color, specular, shininess, ...back }));
  const stroke = (color: number, width: number): LineMaterial => keep(new LineMaterial({ color, linewidth: width }));

  const solid = (s: Solid, material: Material): Mesh => {
    const g = own(new BufferGeometry());
    g.setAttribute("position", new BufferAttribute(s.positions, 3));
    g.setAttribute("normal", new BufferAttribute(s.normals, 3));
    g.setIndex(new BufferAttribute(s.index, 1));
    return new Mesh(g, material);
  };
  const strokes = (points: Float32Array, material: LineMaterial): LineSegments2 => {
    const g = own(new LineSegmentsGeometry());
    g.setPositions(points);
    return new LineSegments2(g, material);
  };
  const brow = (o: Outline, height: number, fillet: number, y0 = 0): Float32Array => loop(o, y0 + height, fillet);

  const surface = (width: number, height: number): Surface => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    const texture = hold(new CanvasTexture(c));
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    return { canvas: c, ctx: c.getContext("2d")!, texture };
  };
  const paintTexture = (size: number, paint: (ctx: CanvasRenderingContext2D) => void): CanvasTexture => {
    const s = surface(size, size);
    paint(s.ctx);
    return s.texture;
  };

  const flat = own(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const square = own(new PlaneGeometry(1, 1));
  const shade = paintTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, `rgba(${ink.shade}, 1)`);
    g.addColorStop(0.4, `rgba(${ink.shade}, 0.5)`);
    g.addColorStop(0.7, `rgba(${ink.shade}, 0.12)`);
    g.addColorStop(1, `rgba(${ink.shade}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  const shades = new Map<number, MeshBasicMaterial>();
  const blob = (width: number, y: number, depth = width, strength = 1): Mesh => {
    let material = shades.get(strength);
    if (!material) {
      material = keep(new MeshBasicMaterial({ map: shade, transparent: true, opacity: ink.shadeOpacity * strength, depthWrite: false }));
      shades.set(strength, material);
    }
    const m = new Mesh(flat, material);
    m.scale.set(width, 1, depth);
    m.position.y = y;
    m.renderOrder = -1;
    return m;
  };

  const lights = (scene: Scene, key: [number, number, number]): void => {
    const main = new DirectionalLight(0xffffff, 1.3);
    main.position.set(...key);
    const fill = new DirectionalLight(0xffffff, 0.2);
    fill.position.set(0, 3, 10);
    scene.add(new AmbientLight(0xffffff, 1.95), main, fill);
  };

  const floor = (scene: Scene, cell: number, fade: [number, number, number]): Floor => {
    const drawn = new Vector2();
    const uniforms = {
      uColor: { value: new Color(ink.grid) },
      uCell: { value: cell },
      uHalfLine: { value: 0.5 },
      uSize: { value: new Vector2(1, 1) },
      uEdge: { value: new Vector4(1, 1, 1, 1) },
      uFade: { value: new Vector3(...fade) },
    };
    const material = keep(new ShaderMaterial({ uniforms, vertexShader: GRID_VERTEX, fragmentShader: GRID_FRAGMENT, transparent: true, depthWrite: false }));
    const mesh = new Mesh(flat, material);
    mesh.scale.set(260, 1, 260);
    mesh.renderOrder = -2;
    scene.add(mesh);
    return {
      mesh,
      fade: { uSize: uniforms.uSize, uEdge: uniforms.uEdge },
      resize(width, edge) {
        renderer.getDrawingBufferSize(drawn);
        uniforms.uSize.value.copy(drawn);
        // One CSS pixel wide, whatever the screen's density.
        uniforms.uHalfLine.value = (0.5 * drawn.x) / Math.max(1, width);
        uniforms.uEdge.value.set(edge[0] * drawn.x, edge[1] * drawn.y, edge[2] * drawn.x, edge[3] * drawn.y);
      },
    };
  };

  return {
    renderer, canvas, ink, keep, own, matte, gloss, stroke, solid, strokes, brow, paintTexture, surface, flat, square, blob, lights, floor,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

export interface Loop {
  /** Whether frames are being drawn one after another right now. */
  readonly running: boolean;
  /** Draw one frame now, without moving the clock: after a resize, or when something changed while stopped. */
  redraw(): void;
  dispose(): void;
}

/** Calls `frame` every animation frame with the seconds since the last one, but only while `host` is on screen, the
 *  tab is showing and motion is welcome. Otherwise it draws a single still frame (`still` true under reduced motion)
 *  and stops, so an unseen canvas costs nothing. */
export function loopWhileSeen(host: HTMLElement, frame: (seconds: number, still: boolean) => void): Loop {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let last = 0;
  let raf = 0;
  let running = false;
  let onScreen = true;
  let disposed = false;

  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    const seconds = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    frame(seconds, false);
  };
  const sync = (): void => {
    const want = !disposed && onScreen && !document.hidden && !reduced.matches;
    if (want && !running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!want && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
    if (!want && !disposed) frame(0, reduced.matches);
  };
  const watcher = new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; sync(); });
  watcher.observe(host);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
  sync();

  return {
    get running() { return running; },
    redraw() { if (!disposed && !running) frame(0, reduced.matches); },
    dispose() {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      watcher.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
    },
  };
}
