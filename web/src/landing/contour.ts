// How the robot floor is drawn: flat colour in two steps of light, and a dark line along every contour.
//
// Each frame is four passes into one multisampled buffer, then a fifth onto the canvas:
//
//   1  the marks    every solid again, into a buffer nobody sees: the way each surface faces, and a number (its
//                   "mark") that is different for every part
//   2  the paint    the floor with its grid, then every solid in its flat colour, lit or in shade and nothing
//                   in between
//   3  the lines    one screen-wide pass that reads the marks: wherever two parts meet, a surface folds or one
//                   thing stands in front of another, it draws the line
//   4  the clouds   the robots' bodies, which are not solid: a screen-wide pattern of dots, squares and crosses
//   5  the finish   FXAA, so the lines' edges come out straight and smooth instead of in steps
//
// Every solid is made by rig.ts and carries its colour and its mark in its vertices, so one material paints them
// all and one more writes all their marks. Nothing is lit by three.js lights and no colour is converted on the way
// out: the palettes below are the colours on the screen.

import {
  BufferAttribute, BufferGeometry, Camera, Color, DepthTexture, DoubleSide, Mesh, NearestFilter, NoBlending,
  PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderTarget,
  type PerspectiveCamera, type WebGLRenderer,
} from "three";
import type { SceneTone } from "./kit";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { TILE, TRAIL_CELLS, type TrailCell } from "./floorplan";

/** What a part is painted with. `arm` is a robot's sleeves and `steel` its hands. */
export type Tint = "white" | "paper" | "accent" | "amber" | "red" | "steel" | "arm";

export interface FloorInk {
  /** The floor, its grid, and the outline of a tile a robot is over. */
  floor: number; grid: number; trail: number;
  /** The contour line. */
  line: number;
  /** A part in the light, by tint. In shade it is `shade` times as bright. */
  tints: Record<Tint, number>;
  shade: number;
  /** The patch of floor under a robot. */
  shadow: number;
  /** A robot's body: its dots, its squares and its crosses. */
  dot: number; square: number; cross: number;
}

// The light palette is the reference's, measured from its page, with the dashboard's light purple (system.css #b07af2)
// where the reference has teal. Purple is one flat colour: a purple part is never put in shade. The dark one keeps its order of lightness on the page's near-black, with lines lighter than what they
// are drawn on.
export const FLOOR_INK: Record<SceneTone, FloorInk> = {
  light: {
    floor: 0xe7e5e0, grid: 0xd3d0c5, trail: 0x2a2926,
    line: 0x061a1e,
    tints: { white: 0xeeece7, paper: 0xe9e7e2, accent: 0xb07af2, amber: 0xf5c042, red: 0xd9675b, steel: 0xe6e4df, arm: 0xf1efea },
    shade: 0.955,
    shadow: 0xbfbfbf,
    dot: 0xf6f4f0, square: 0xdad7cb, cross: 0xb07af2,
  },
  dark: {
    floor: 0x15171b, grid: 0x23272c, trail: 0x8a9199,
    line: 0x9299a1,
    tints: { white: 0x30353b, paper: 0x2b3035, accent: 0xb07af2, amber: 0xe0a235, red: 0xd9675b, steel: 0x6a727b, arm: 0x555d66 },
    shade: 0.86,
    shadow: 0x0b0c0f,
    dot: 0xe4e7ea, square: 0x4d545c, cross: 0xb07af2,
  },
};

/** Which pass draws a thing. A solid is on `solid`; the floor and what lies flat on it on `ground`; a cloud on `over`. */
export const LAYER = { solid: 0, ground: 1, over: 2 } as const;

/** The light, as seen from the camera (which never turns): from above, a little to the right. A surface is lit
 *  when it faces the light by more than `step`. */
const LIGHT = new Vector3(0.21838, 0.97549, 0.02706);
const LIGHT_STEP = 0.15;
/** A line's width in CSS pixels, the fold a surface must make to get one (as the cosine of the angle), and how
 *  far apart in depth two surfaces of one part must be, as a share of how far away they are. */
const LINE_WIDTH = 1.6;
const CREASE = Math.cos((40 * Math.PI) / 180);
const DEPTH_STEP = 0.006;
/** The grid's line, in CSS pixels. */
const GRID_LINE = 1.2;

/** How many CSS pixels a unit of the scene is on the screen the clouds' pattern was sized for. */
const FULL_UNIT = 185;
/** A cloud's pattern, in CSS pixels: the grid it sits on, a dot's largest radius, and a cross's arm and thickness. */
const CELL = 22;
const MOTIF = 10.45;
const CROSS_ARM = 7.4;
const CROSS_THICK = 3.5;

const SOLID_VERTEX = /* glsl */ `
attribute vec3 tint;
attribute float mark;
varying vec3 vTint;
varying vec3 vFacing;
varying float vMark;
void main() {
  vTint = tint;
  vMark = mark;
  vFacing = normalMatrix * normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PAINT_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform float uStep;
uniform float uShade;
uniform vec3 uFlat;
varying vec3 vTint;
varying vec3 vFacing;
void main() {
  vec3 n = normalize(vFacing);
  if (!gl_FrontFacing) n = -n;
  float lit = max(step(uStep, dot(n, uLight)), step(distance(vTint, uFlat), 0.004));
  gl_FragColor = vec4(vTint * mix(uShade, 1.0, lit), 1.0);
}`;

// The way the surface faces goes in two channels and the mark in the other two (sixteen bits of it).
const MARK_FRAGMENT = /* glsl */ `
varying vec3 vFacing;
varying float vMark;
void main() {
  vec3 n = normalize(vFacing);
  if (!gl_FrontFacing) n = -n;
  float mark = floor(vMark + 0.5);
  float high = floor(mark / 256.0);
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, (mark - high * 256.0) / 255.0, high / 255.0);
}`;

const SCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const LINE_FRAGMENT = /* glsl */ `
uniform sampler2D uMarks;
uniform sampler2D uDepth;
uniform vec2 uPixel;
uniform float uWidth;
uniform vec3 uColor;
uniform float uCrease;
uniform float uDepthStep;
uniform vec2 uPlanes;
varying vec2 vUv;

float markOf(vec4 s) { return floor(s.b * 255.0 + 0.5) + floor(s.a * 255.0 + 0.5) * 256.0; }
vec3 facingOf(vec4 s) { vec2 xy = s.rg * 2.0 - 1.0; return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))); }
float farOf(vec2 uv) {
  float z = texture2D(uDepth, uv).r * 2.0 - 1.0;
  return 2.0 * uPlanes.x * uPlanes.y / (uPlanes.y + uPlanes.x - z * (uPlanes.y - uPlanes.x));
}

// How much of a line belongs at a point 'off' pixels from this one: all of it if a different part is there, or
// the same part folded or stepped back.
float edgeAt(vec2 off, float mark, vec3 facing, float far) {
  vec2 uv = vUv + off * uPixel;
  vec4 s = texture2D(uMarks, uv);
  float other = markOf(s);
  if (abs(other - mark) > 0.5) return 1.0;
  if (mark < 0.5) return 0.0;
  if (dot(facingOf(s), facing) < uCrease) return 1.0;
  return step(uDepthStep * far, abs(farOf(uv) - far));
}

void main() {
  vec4 here = texture2D(uMarks, vUv);
  float mark = markOf(here);
  vec3 facing = facingOf(here);
  float far = farOf(vUv);
  // Every pixel within the line's half width, whole pixels only (the marks are not filtered): a ring at that
  // distance would land between pixels and make the line thicker in some places than others.
  float reach = uWidth * uWidth + 0.01;
  float edge = 0.0;
  for (int i = -3; i <= 3; i++) {
    for (int j = -3; j <= 3; j++) {
      vec2 off = vec2(float(i), float(j));
      float r = dot(off, off);
      if (r < 0.5 || r > reach) continue;
      edge = max(edge, edgeAt(off, mark, facing, far));
    }
  }
  if (edge < 0.5) discard;
  gl_FragColor = vec4(uColor, 1.0);
}`;

const FLOOR_VERTEX = /* glsl */ `
varying vec2 vFloor;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vFloor = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FLOOR_FRAGMENT = /* glsl */ `
uniform vec3 uFloor;
uniform vec3 uGrid;
uniform vec3 uTrail;
uniform float uTile;
uniform float uHalfLine;
uniform vec3 uCells[${TRAIL_CELLS}];
varying vec2 vFloor;
void main() {
  vec2 g = vFloor / uTile;
  vec2 perPixel = fwidth(g);
  // Distance to the nearest grid line on each axis, in pixels.
  vec2 off = abs(fract(g - 0.5) - 0.5) / perPixel;
  float near = min(off.x, off.y);
  float line = 1.0 - smoothstep(uHalfLine - 0.5, uHalfLine + 0.5, near);
  vec3 color = mix(uFloor, uGrid, line);
  // A tile a robot is over: its own side of the four lines round it, in the trail's colour.
  vec2 cell = floor(g);
  float hot = 0.0;
  for (int i = 0; i < ${TRAIL_CELLS}; i++) {
    vec3 c = uCells[i];
    if (abs(cell.x - c.x) < 0.5 && abs(cell.y - c.y) < 0.5) hot = max(hot, c.z);
  }
  float border = 1.0 - smoothstep(uHalfLine * 1.6 - 0.5, uHalfLine * 1.6 + 0.5, near);
  color = mix(color, uTrail, border * hot);
  gl_FragColor = vec4(color, 1.0);
}`;

const SHADOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() { gl_FragColor = vec4(uColor, uOpacity); }`;

const PLAIN_VERTEX = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// A cloud is a rectangle that always faces the screen, as far away as the middle of the body it stands for. The
// pattern sits on a grid that is fixed to the floor's picture, not to the body: as the body moves, it passes over
// the grid and the motifs under it swell and shrink.
const CLOUD_VERTEX = /* glsl */ `
uniform vec3 uCentre;
uniform vec2 uHalf;
uniform vec2 uSize;
varying vec2 vCentre;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(uCentre, 1.0);
  vCentre = (clip.xy / clip.w * 0.5 + 0.5) * uSize;
  clip.xy += position.xy * uHalf / uSize * 2.0 * clip.w;
  gl_Position = clip;
}`;

const CLOUD_FRAGMENT = /* glsl */ `
uniform vec2 uHalf;
uniform vec2 uPan;
uniform float uRatio;
uniform float uScale;
uniform float uTime;
uniform float uSeed;
uniform float uShow;
uniform vec3 uDot;
uniform vec3 uSquare;
uniform vec3 uCross;
varying vec2 vCentre;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  // The pattern is sized for a full screen and shrinks with the scene on a small one. 'px' is one of its own
  // pixels, in buffer pixels.
  float px = uRatio * uScale;
  float cellSize = ${CELL.toFixed(1)} * px;
  vec2 g = (gl_FragCoord.xy - uPan) / cellSize;
  vec2 id = floor(g);
  vec2 local = (fract(g) - 0.5) * cellSize / px;
  vec2 middle = (id + 0.5) * cellSize + uPan;
  // The body is rounder than a ball is tall: how squarely it faces the eye at this cell's middle.
  vec2 q = (middle - vCentre) / uHalf;
  float facing = sqrt(max(0.0, 1.0 - dot(q, q)));
  // Each cell lives through one motif after another, out of step with its neighbours.
  float life = uTime * 0.3 + hash(id + uSeed) * 9.0;
  float age = fract(life);
  float turn = floor(life);
  float pick = hash(id + turn * 17.0 + uSeed * 3.0);
  float envelope = smoothstep(0.0, 0.16, age) * (1.0 - smoothstep(0.84, 1.0, age));
  float size = pow(facing, 1.15) * mix(0.62, 1.0, hash(id + turn * 31.0 + 7.0)) * envelope * uShow;
  // A few of the cells stay empty, more of them toward the edge.
  size *= step(hash(id + turn * 5.0 + 2.0), 0.72 + 0.28 * facing);
  if (size < 0.03) discard;

  float alpha;
  vec3 color;
  if (pick < 0.2) {
    // A cross: two bars at 45 degrees.
    vec2 r = vec2(local.x + local.y, local.x - local.y) * 0.7071;
    float arm = ${CROSS_ARM.toFixed(2)} * size;
    float thick = ${(CROSS_THICK / 2).toFixed(2)} * (0.45 + 0.55 * size);
    float a = max(abs(r.x) - arm, abs(r.y) - thick);
    float b = max(abs(r.y) - arm, abs(r.x) - thick);
    alpha = 1.0 - smoothstep(-0.5, 0.5, min(a, b) * px);
    color = uCross;
  } else if (pick < 0.29) {
    float side = ${(MOTIF * 0.78).toFixed(2)} * size;
    alpha = 1.0 - smoothstep(-0.5, 0.5, (max(abs(local.x), abs(local.y)) - side) * px);
    color = uSquare;
  } else {
    alpha = 1.0 - smoothstep(-0.5, 0.5, (length(local) - ${MOTIF.toFixed(2)} * size) * px);
    color = uDot;
  }
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}`;

/** A robot's body. Move `centre` (a point in the scene), set how much of it shows, and it draws itself. */
export interface Cloud {
  mesh: Mesh;
  centre: Vector3;
  /** 0 hides it, 1 shows all of it. */
  show(amount: number): void;
}

export interface Contour {
  /** The one material every solid is painted with. */
  paint: ShaderMaterial;
  /** The floor: a plane to put in the scene. `trail` says which tiles the robots are over. */
  floor: Mesh;
  trail(cells: readonly TrailCell[]): void;
  /** A flat patch for the floor under a robot, `radius` across: scale it, place it. */
  shadow(radius: number): Mesh;
  /** A robot's body, `width` by `height` in the scene's units. Each `seed` gives its own pattern. */
  cloud(width: number, height: number, seed: number): Cloud;
  /** The canvas changed size: `width` and `height` in CSS pixels. */
  resize(width: number, height: number): void;
  /** Draw a frame. `time` is the clouds' clock, in seconds; `anchor` is a point of the floor their pattern is
   *  fixed to. */
  render(scene: Scene, camera: PerspectiveCamera, time: number, anchor: Vector3): void;
  dispose(): void;
}

const rgb = (color: number): Color => {
  // The colours go to the screen as they are written here.
  const c = new Color();
  c.setRGB(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255);
  return c;
};

/** The tints as the colours rig.ts writes into a part's vertices. */
export function tintColors(ink: FloorInk): Record<Tint, Color> {
  const out = {} as Record<Tint, Color>;
  for (const key of Object.keys(ink.tints) as Tint[]) out[key] = rgb(ink.tints[key]);
  return out;
}

export function createContour(renderer: WebGLRenderer, ink: FloorInk): Contour {
  renderer.autoClear = false;

  const paint = new ShaderMaterial({
    uniforms: { uLight: { value: LIGHT }, uStep: { value: LIGHT_STEP }, uShade: { value: ink.shade }, uFlat: { value: rgb(ink.tints.accent) } },
    vertexShader: SOLID_VERTEX,
    fragmentShader: PAINT_FRAGMENT,
    side: DoubleSide,
  });
  const marking = new ShaderMaterial({ vertexShader: SOLID_VERTEX, fragmentShader: MARK_FRAGMENT, side: DoubleSide, blending: NoBlending });

  const depth = new DepthTexture(1, 1);
  const marks = new WebGLRenderTarget(1, 1, { minFilter: NearestFilter, magFilter: NearestFilter, depthTexture: depth, depthBuffer: true });

  const lineUniforms = {
    uMarks: { value: marks.texture },
    uDepth: { value: depth },
    uPixel: { value: new Vector2(1, 1) },
    uWidth: { value: LINE_WIDTH },
    uColor: { value: rgb(ink.line) },
    uCrease: { value: CREASE },
    uDepthStep: { value: DEPTH_STEP },
    uPlanes: { value: new Vector2(1, 96) },
  };
  const lines = new ShaderMaterial({ uniforms: lineUniforms, vertexShader: SCREEN_VERTEX, fragmentShader: LINE_FRAGMENT, depthTest: false, depthWrite: false });
  // One triangle that covers the screen.
  const screen = new BufferGeometry();
  screen.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const post = new Scene();
  const postMesh = new Mesh(screen, lines);
  postMesh.frustumCulled = false;
  post.add(postMesh);
  const postCamera = new Camera();

  // The frame is drawn into a multisampled buffer (smooth edges on the solids), then copied to the canvas through
  // FXAA, which smooths the lines' steps as well.
  const frame = new WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: true });
  const finishUniforms = { tDiffuse: { value: frame.texture }, resolution: { value: new Vector2(1, 1) } };
  const finish = new ShaderMaterial({
    uniforms: finishUniforms, vertexShader: SCREEN_VERTEX, fragmentShader: FXAAShader.fragmentShader,
    depthTest: false, depthWrite: false, blending: NoBlending,
  });
  const finishScene = new Scene();
  const finishMesh = new Mesh(screen, finish);
  finishMesh.frustumCulled = false;
  finishScene.add(finishMesh);

  const cells = Array.from({ length: TRAIL_CELLS }, () => new Vector3(0, 0, 0));
  const floorUniforms = {
    uFloor: { value: rgb(ink.floor) },
    uGrid: { value: rgb(ink.grid) },
    uTrail: { value: rgb(ink.trail) },
    uTile: { value: TILE },
    uHalfLine: { value: GRID_LINE / 2 },
    uCells: { value: cells },
  };
  const floorMaterial = new ShaderMaterial({ uniforms: floorUniforms, vertexShader: FLOOR_VERTEX, fragmentShader: FLOOR_FRAGMENT });
  const plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const floor = new Mesh(plane, floorMaterial);
  floor.scale.set(400, 1, 400);
  floor.layers.set(LAYER.ground);
  floor.renderOrder = -2;

  const shadowMaterial = new ShaderMaterial({
    uniforms: { uColor: { value: rgb(ink.shadow) }, uOpacity: { value: 1 } },
    vertexShader: PLAIN_VERTEX, fragmentShader: SHADOW_FRAGMENT, transparent: true, depthWrite: false,
  });
  const disc = new BufferGeometry();
  {
    const n = 48;
    const p = new Float32Array((n + 2) * 3);
    const index: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      p[(i + 1) * 3] = Math.cos(a);
      p[(i + 1) * 3 + 2] = Math.sin(a);
      if (i < n) index.push(0, i + 2, i + 1);
    }
    disc.setAttribute("position", new BufferAttribute(p, 3));
    disc.setIndex(index);
  }

  const size = new Vector2(1, 1);
  const pan = new Vector2(0, 0);
  const ratio = { value: 1 };
  const patternScale = { value: 1 };
  const clock = { value: 0 };
  const cloudPlane = new PlaneGeometry(2, 2);
  const cloudMaterials: ShaderMaterial[] = [];
  const projected = new Vector3();
  let unit = 1;

  return {
    paint,
    floor,
    trail(list) {
      for (let i = 0; i < TRAIL_CELLS; i++) {
        const c = list[i];
        if (c) cells[i].set(c.x, c.z, c.strength * c.strength);
        else cells[i].set(0, 0, 0);
      }
    },
    shadow(radius) {
      const m = new Mesh(disc, shadowMaterial);
      m.scale.set(radius, 1, radius);
      m.position.y = 0.004;
      m.layers.set(LAYER.ground);
      m.renderOrder = -1;
      return m;
    },
    cloud(width, height, seed) {
      const centre = new Vector3();
      const half = new Vector2(1, 1);
      const show = { value: 1 };
      const material = new ShaderMaterial({
        uniforms: {
          uCentre: { value: centre }, uHalf: { value: half }, uSize: { value: size }, uPan: { value: pan }, uRatio: ratio, uScale: patternScale,
          uTime: clock, uSeed: { value: seed }, uShow: show,
          uDot: { value: rgb(ink.dot) }, uSquare: { value: rgb(ink.square) }, uCross: { value: rgb(ink.cross) },
        },
        vertexShader: CLOUD_VERTEX, fragmentShader: CLOUD_FRAGMENT, transparent: true, depthWrite: false,
      });
      cloudMaterials.push(material);
      const mesh = new Mesh(cloudPlane, material);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.over);
      // The rectangle's half size in buffer pixels follows the canvas: set before each frame.
      mesh.onBeforeRender = () => { half.set((width / 2) * unit, (height / 2) * unit); };
      return { mesh, centre, show(amount) { show.value = amount; mesh.visible = amount > 0.01; } };
    },
    resize(width, height) {
      renderer.getDrawingBufferSize(size);
      marks.setSize(size.x, size.y);
      frame.setSize(size.x, size.y);
      finishUniforms.resolution.value.set(1 / size.x, 1 / size.y);
      ratio.value = size.x / Math.max(1, width);
      lineUniforms.uPixel.value.set(1 / size.x, 1 / size.y);
      lineUniforms.uWidth.value = (LINE_WIDTH * ratio.value) / 2;
      floorUniforms.uHalfLine.value = (GRID_LINE * ratio.value) / 2;
      void height;
    },
    render(scene, camera, time, anchor) {
      clock.value = time;
      lineUniforms.uPlanes.value.set(camera.near, camera.far);
      // How many buffer pixels one unit of the scene is, at the distance the camera looks from.
      unit = size.y / (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(anchor));
      patternScale.value = Math.min(1.25, Math.max(0.45, unit / ratio.value / FULL_UNIT));
      projected.copy(anchor).project(camera);
      pan.set((projected.x * 0.5 + 0.5) * size.x, (projected.y * 0.5 + 0.5) * size.y);

      renderer.setRenderTarget(marks);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      camera.layers.set(LAYER.solid);
      scene.overrideMaterial = marking;
      renderer.render(scene, camera);
      scene.overrideMaterial = null;

      renderer.setRenderTarget(frame);
      renderer.clear();
      camera.layers.set(LAYER.ground);
      renderer.render(scene, camera);
      camera.layers.set(LAYER.solid);
      renderer.render(scene, camera);
      renderer.render(post, postCamera);
      camera.layers.set(LAYER.over);
      renderer.render(scene, camera);

      renderer.setRenderTarget(null);
      renderer.render(finishScene, postCamera);
    },
    dispose() {
      paint.dispose();
      marking.dispose();
      marks.dispose();
      depth.dispose();
      frame.dispose();
      finish.dispose();
      lines.dispose();
      screen.dispose();
      floorMaterial.dispose();
      plane.dispose();
      shadowMaterial.dispose();
      disc.dispose();
      cloudPlane.dispose();
      for (const m of cloudMaterials) m.dispose();
    },
  };
}
