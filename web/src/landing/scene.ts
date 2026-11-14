// The landing page's 3D scene: five pads on a gridded floor, joined by four lines, running the loop in timeline.ts.
// The pads are the pipeline: a task comes in at the back, three steps work on it (run the agents, find where the
// runs split, fork the VM), and a verdict comes out at the front.
//
// This module is loaded on demand (landing.ts mounts it), so the app's other screens never pay for three.js.
// It owns one canvas inside `host` and nothing else; `dispose()` gives everything back.
//
// Units: one floor cell is 0.64, and the pads sit four cells apart. The camera never moves. The page's layout
// decides where the scene goes (fit.ts); it is placed by zooming the camera and sliding its view, which leaves the
// perspective exactly as it is.

import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  MathUtils, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Scene, Vector3, Vector4,
  type CanvasTexture, type Texture,
} from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { fitScene } from "./fit";
import {
  LABEL_HEIGHT, LABEL_PX, STEP_GLYPHS, TASK_GLYPHS, VERDICT_GLYPHS, layoutLabel, paintGlyph, paintLabel,
  type Glyph, type LabelLayout,
} from "./glyphs";
import { LABEL_FONT, createKit, css, join, loopWhileSeen, type Loop, type SceneTone } from "./kit";
import { band, circle, flanks, loop, prism, roundedPath, roundedSquare, tag } from "./shapes";
import { NODES, PATHS, bannerLetter, createFrame, frameAt, posterFrame, type Frame } from "./timeline";

export interface HeroSceneOptions {
  /** Which palette to draw in. */
  tone: SceneTone;
  /** The words on the four labels, in path order. */
  labels: readonly string[];
  /** The scene keeps clear of this element's bottom-right corner. */
  copy?: HTMLElement | null;
  /** The scene starts below this element. */
  nav?: HTMLElement | null;
}

export interface HeroScene {
  dispose(): void;
}

// ── the set ──────────────────────────────────────────────────────────────────

const FOV = 28.44;
const EYE = new Vector3(12.124, 11.824, 12.124);
const LOOK_AT = new Vector3(0, -0.3, 0);

const CELL = 0.64;
const SPAN = CELL * 4;
/** Where the five pads stand (x, z): the task at the back, the steps across the middle, the verdict in front. */
const NODE_AT: readonly (readonly [number, number])[] = [[-SPAN, -SPAN], [-SPAN, SPAN], [0, 0], [SPAN, -SPAN], [SPAN, SPAN]];
/** The four lines, each from one pad to the next. */
const PATH_CORNERS: [number, number][][] = [
  [[-SPAN, -SPAN], [-SPAN, SPAN]],
  [[-SPAN, SPAN], [0, SPAN], [0, 0]],
  [[0, 0], [0, -SPAN], [SPAN, -SPAN]],
  [[SPAN, -SPAN], [SPAN, SPAN]],
];
/** Where each line's label stands (x, z), and whether it runs along z (facing +x) or along x (facing +z). */
const LABEL_AT: readonly (readonly [number, number, boolean])[] = [[-SPAN, 0, true], [-1.14, SPAN, false], [0, -1.45, true], [SPAN, 0.2, true]];
const PATH_SEGMENTS = 120;
const PATH_BEND = 0.3;
/** How far a pad's top edges are rounded. */
const EDGE = 0.022;
/** The width of the icon on the task and the verdict. */
const PORT_ICON = 0.5;

/** The axis a tossed disc turns about: the screen's left-to-right, on the floor. */
const TOSS_AXIS = new Vector3(1, 0, -1).normalize();
/** An icon lies flat on its disc, its top toward the back of the scene so it reads upright on screen. */
const ICON_FACING = new Matrix4().makeBasis(new Vector3(1, 0, -1).normalize(), new Vector3(-1, 0, -1).normalize(), new Vector3(0, 1, 0));

const TILE_PARS = /* glsl */ `
attribute vec2 aCell;
uniform vec4 uWaves[${NODES}];
// How high a floor tile stands. Each pad's ripple is a ring that widens from the pad and dies down as it goes: a
// tile rises quickly as the ring's front reaches it and settles slowly once the front has passed.
float lpLift(vec2 cell) {
  float lift = 0.0;
  for (int i = 0; i < ${NODES}; i++) {
    float age = uWaves[i].z;
    if (age < 0.0) continue;
    float ahead = distance(cell, uWaves[i].xy) - (0.5 + 1.4 * age);
    float crest = ahead > 0.0 ? 1.0 - smoothstep(0.0, 0.4, ahead) : 1.0 - smoothstep(0.0, 0.9, -ahead);
    lift = max(lift, 0.28 * crest * exp(-age / 0.26));
  }
  return lift;
}`;
// A tile below the least height is folded to a point, so the still floor draws none of them.
const TILE_BEGIN = /* glsl */ `
float lpHeight = lpLift(aCell);
float lpShown = step(0.004, lpHeight);
vec3 transformed = vec3(aCell.x + position.x * lpShown, position.y * lpHeight * lpShown, aCell.y + position.z * lpShown);`;

// A risen tile fades toward the canvas's edges exactly as the floor's grid does (kit.ts), so a ripple near an edge
// dissolves with the floor instead of being cut off by it.
const TILE_FADE = /* glsl */ `
gl_FragColor.a *= smoothstep(0.0, uEdge.x, gl_FragCoord.x) * smoothstep(0.0, uEdge.z, uSize.x - gl_FragCoord.x)
  * smoothstep(0.0, uEdge.w, gl_FragCoord.y) * smoothstep(0.0, uEdge.y, uSize.y - gl_FragCoord.y);`;

interface StepPad {
  kind: "step";
  body: Mesh;
  top: Group;
  button: Mesh;
  seat: Group;
  spin: Group;
}
interface PortPad {
  kind: "port";
  body: Mesh;
  top: Group;
  icon: Mesh;
  iconMaterial: MeshBasicMaterial;
  glyphs: Texture[];
  shown: number;
}
type Pad = StepPad | PortPad;

interface Label {
  root: Group;
  hinge: Group;
  layout: LabelLayout;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  /** Each letter's opacity as last painted, to repaint only when one changes. */
  painted: Float32Array;
  width: number;
}

/** Mount the scene in `host` and start it. The canvas fills `host`, and `host` gets `data-ready` once it has drawn. */
export function mountHeroScene(host: HTMLElement, options: HeroSceneOptions): HeroScene {
  const kit = createKit(host, options.tone);
  // No WebGL: the hero is its copy alone.
  if (!kit) return { dispose() { /* nothing was made */ } };
  const { renderer, ink, keep, own, matte, gloss, stroke, solid, strokes, brow, paintTexture, blob, square } = kit;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 90);
  camera.position.copy(EYE);
  camera.lookAt(LOOK_AT);
  camera.updateMatrixWorld();
  kit.lights(scene, [-3, 9, 4]);

  const M = {
    base: matte(ink.base), rim: matte(ink.rim), ledge: matte(ink.ledge),
    body: gloss(ink.body), collar: gloss(ink.collar), button: gloss(ink.button),
    disc: gloss(ink.disc, 0x484848, 3), port: gloss(ink.port), portRing: gloss(ink.portRing),
  };
  const L = { pad: stroke(ink.padLine, 1), port: stroke(ink.portLine, 1), disc: stroke(ink.discLine, 1), path: stroke(ink.path, 2) };

  const glyphColors = { ink: ink.glyph, disc: css(ink.disc) };
  const glyphTexture = (glyph: Glyph): Texture => paintTexture(256, (ctx) => paintGlyph(ctx, glyph, 256, glyphColors));

  const iconPlane = (size: number, y: number, map: Texture): { mesh: Mesh; material: MeshBasicMaterial } => {
    const material = keep(new MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
    const mesh = new Mesh(square, material);
    mesh.quaternion.setFromRotationMatrix(ICON_FACING);
    mesh.scale.setScalar(size);
    mesh.position.y = y;
    return { mesh, material };
  };

  // ── the pads ───────────────────────────────────────────────────────────────

  /** A step: a square pad whose body sinks while its button rises, with the step's icon on a disc that gets tossed. */
  const buildStep = (x: number, z: number, glyph: Glyph): { root: Group; pad: StepPad } => {
    const root = new Group();
    root.position.set(x, 0, z);
    const sight: [number, number] = [EYE.x - x, EYE.z - z];
    const baseO = roundedSquare(0.577, 0.216);
    const bodyO = roundedSquare(0.48, 0.145);
    const buttonO = circle(0.24);
    const discO = circle(0.16);

    const base = solid(prism(baseO, 0.1, EDGE), M.base);
    base.add(strokes(join(brow(baseO, 0.1, EDGE), loop(baseO, 0.006), flanks(baseO, ...sight, 0.006, 0.1 - EDGE)), L.pad));
    // A thin line drawn on the base, then the kerb the body stands in.
    const rim = solid(band(roundedSquare(0.527, 0.161), 0.02, 0.006), M.rim);
    const ledge = solid(band(roundedSquare(0.52, 0.19), 0.036, 0.024), M.ledge);
    rim.position.y = ledge.position.y = 0.1;

    const body = solid(prism(bodyO, 0.36, EDGE), M.body);
    body.position.y = 0.1;
    body.add(strokes(join(brow(bodyO, 0.36, EDGE), flanks(bodyO, ...sight, 0.026, 0.36 - EDGE)), L.pad));
    // The body's foot does not move when the body sinks, so its line is not the body's child.
    const foot = strokes(loop(bodyO, 0.126), L.pad);

    const top = new Group();
    top.position.y = 0.46;
    const inset = solid(band(roundedSquare(0.43, 0.097), 0.02, 0.006), M.rim);
    const collar = solid(band(circle(0.285), 0.043, 0.018), M.collar);
    const button = solid(prism(buttonO, 0.08, 0.014), M.button);
    button.add(strokes(join(brow(buttonO, 0.08, 0.014), flanks(buttonO, ...sight, 0.02, 0.066)), L.pad));
    const buttonFoot = strokes(loop(buttonO, 0.02), L.pad);

    const seat = new Group();
    seat.position.y = 0.08;
    const spin = new Group();
    const disc = solid(prism(discO, 0.02, 0.008, { y0: -0.01, closed: true }), M.disc);
    disc.add(strokes(join(brow(discO, 0.02, 0.008, -0.01), loop(discO, -0.009)), L.disc));
    spin.add(disc, iconPlane(0.26, 0.0112, glyphTexture(glyph)).mesh);
    seat.add(spin);
    top.add(inset, collar, button, buttonFoot, seat);

    root.add(blob(2.613, 0.002), base, rim, blob(1.833, 0.126), ledge, body, foot, top);
    return { root, pad: { kind: "step", body, top, button, seat, spin } };
  };

  /** The task or the verdict: a round purple pad whose body sinks, with an icon that changes each time it does. */
  const buildPort = (x: number, z: number, glyphs: Glyph[]): { root: Group; pad: PortPad } => {
    const root = new Group();
    root.position.set(x, 0, z);
    const sight: [number, number] = [EYE.x - x, EYE.z - z];
    const baseO = circle(0.64);
    const bodyO = circle(0.53);
    const discO = circle(0.36);

    const base = solid(prism(baseO, 0.1, EDGE), M.base);
    base.add(strokes(join(brow(baseO, 0.1, EDGE), loop(baseO, 0.006), flanks(baseO, ...sight, 0.006, 0.1 - EDGE)), L.port));
    const rim = solid(band(circle(0.59), 0.018, 0.006), M.rim);
    const ledge = solid(band(circle(0.57), 0.036, 0.024), M.ledge);
    rim.position.y = ledge.position.y = 0.1;

    const body = solid(prism(bodyO, 0.4, EDGE), M.port);
    body.position.y = 0.1;
    body.add(strokes(join(brow(bodyO, 0.4, EDGE), flanks(bodyO, ...sight, 0.026, 0.4 - EDGE)), L.port));
    const foot = strokes(loop(bodyO, 0.126), L.port);

    const top = new Group();
    top.position.y = 0.5;
    const ring = solid(band(circle(0.405), 0.043, 0.018), M.portRing);
    const disc = solid(prism(discO, 0.02, 0.008), M.disc);
    disc.add(strokes(brow(discO, 0.02, 0.008), L.disc));
    const maps = glyphs.map(glyphTexture);
    const icon = iconPlane(PORT_ICON, 0.0212, maps[0]);
    top.add(ring, disc, icon.mesh);

    root.add(blob(2.048, 0.002), base, rim, blob(1.431, 0.126), ledge, body, foot, top);
    return { root, pad: { kind: "port", body, top, icon: icon.mesh, iconMaterial: icon.material, glyphs: maps, shown: 0 } };
  };

  const pads: Pad[] = NODE_AT.map(([x, z], k) => {
    const built = k === 0 ? buildPort(x, z, TASK_GLYPHS) : k === NODES - 1 ? buildPort(x, z, VERDICT_GLYPHS) : buildStep(x, z, STEP_GLYPHS[k - 1]);
    scene.add(built.root);
    return built.pad;
  });

  // ── the floor ──────────────────────────────────────────────────────────────

  const ground = kit.floor(scene, CELL, [0.35, 0, 40]);

  // The tiles that can rise: every cell a ripple reaches, except the four under each pad.
  const waves = { value: NODE_AT.map(([x, z]) => new Vector4(x, z, -1, 0)) };
  const cells: number[] = [];
  const seen = new Set<string>();
  const reach = 4.4;
  for (const [nx, nz] of NODE_AT) {
    for (let i = Math.floor((nx - reach) / CELL); i <= Math.ceil((nx + reach) / CELL); i++) {
      for (let j = Math.floor((nz - reach) / CELL); j <= Math.ceil((nz + reach) / CELL); j++) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        const id = `${i},${j}`;
        if (seen.has(id) || Math.hypot(cx - nx, cz - nz) > reach) continue;
        if (NODE_AT.some(([px, pz]) => Math.hypot(cx - px, cz - pz) < 0.5)) continue;
        seen.add(id);
        cells.push(cx, cz);
      }
    }
  }
  const tileBox = new BoxGeometry(CELL - 0.012, 1, CELL - 0.012).translate(0, 0.5, 0);
  const tileGeometry = new InstancedBufferGeometry();
  tileGeometry.setIndex(tileBox.index);
  tileGeometry.setAttribute("position", tileBox.getAttribute("position"));
  tileGeometry.setAttribute("normal", tileBox.getAttribute("normal"));
  tileGeometry.setAttribute("aCell", new InstancedBufferAttribute(new Float32Array(cells), 2));
  tileGeometry.instanceCount = cells.length / 2;
  own(tileBox);
  own(tileGeometry);
  const tileMaterial = keep(new MeshLambertMaterial({ color: ink.tile, transparent: true }));
  tileMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uWaves = waves;
    shader.uniforms.uSize = ground.fade.uSize;
    shader.uniforms.uEdge = ground.fade.uEdge;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${TILE_PARS}`)
      .replace("#include <begin_vertex>", TILE_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec2 uSize;\nuniform vec4 uEdge;")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${TILE_FADE}`);
  };
  tileMaterial.customProgramCacheKey = () => "lp-tiles";
  const tiles = new Mesh(tileGeometry, tileMaterial);
  tiles.frustumCulled = false;
  scene.add(tiles);

  // ── the lines ──────────────────────────────────────────────────────────────

  const lit = PATH_CORNERS.map((corners) => {
    const laid = (y: number): LineGeometry => {
      const g = own(new LineGeometry());
      g.setPositions(roundedPath(corners, PATH_BEND, y, PATH_SEGMENTS));
      return g;
    };
    scene.add(new Line2(laid(0.004), L.path));
    // The dark line drawn over it as the work moves on. Each has its own material: they fade separately.
    const material = keep(new LineMaterial({ color: ink.pathLit, linewidth: 2.5, transparent: true, depthWrite: false }));
    const line = new Line2(laid(0.008), material);
    line.visible = false;
    scene.add(line);
    return { line, material };
  });

  // ── the labels ─────────────────────────────────────────────────────────────

  const labels: (Label | null)[] = options.labels.slice(0, PATHS).map(() => null);
  const labelMaterial = keep(new MeshBasicMaterial({ color: ink.label, side: DoubleSide }));
  const ruler = document.createElement("canvas").getContext("2d")!;
  const buildLabels = (): void => {
    if (disposed) return;
    options.labels.slice(0, PATHS).forEach((text, k) => {
      const layout = layoutLabel(ruler, text, LABEL_FONT);
      const { ctx, texture } = kit.surface(layout.width, layout.height);
      const width = layout.width / LABEL_PX;

      const shape = tag(width, LABEL_HEIGHT, 0.1);
      const panelGeometry = own(new BufferGeometry());
      panelGeometry.setAttribute("position", new BufferAttribute(shape.positions, 3));
      panelGeometry.setIndex(new BufferAttribute(shape.index, 1));
      const words = new Mesh(square, keep(new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })));
      words.scale.set(width, LABEL_HEIGHT, 1);
      words.position.set(0, LABEL_HEIGHT / 2, 0.004);

      // The label is hinged where it meets the floor: it lies on its back, then stands up.
      const hinge = new Group();
      hinge.add(new Mesh(panelGeometry, labelMaterial), words);
      const root = new Group();
      const [x, z, alongZ] = LABEL_AT[k];
      root.position.set(x, 0.02, z);
      root.rotation.y = alongZ ? Math.PI / 2 : 0;
      root.add(hinge);
      root.visible = false;
      scene.add(root);
      labels[k] = { root, hinge, layout, ctx, texture, painted: new Float32Array(text.length).fill(-1), width };
    });
    measure();
    resize();
  };

  // ── placing the scene on the page ──────────────────────────────────────────

  // The scene's extent as the camera sees it, in units of the camera's focal length, so it holds for any canvas.
  let bounds = { u0: -1, u1: 1, w0: -1, w1: 1 };
  let covered: [number, number][] = [];
  const measure = (): void => {
    const pts: Vector3[] = [];
    const around = (x: number, y: number, z: number, r: number): void => {
      for (let i = 0; i < 16; i++) pts.push(new Vector3(x + r * Math.cos((i / 16) * Math.PI * 2), y, z + r * Math.sin((i / 16) * Math.PI * 2)));
    };
    NODE_AT.forEach(([x, z], k) => {
      const step = k > 0 && k < NODES - 1;
      around(x, 0, z, step ? 0.74 : 0.66);
      around(x, step ? 0.56 : 0.53, z, step ? 0.62 : 0.54);
      // A step's disc at the top of its toss.
      if (step) around(x, 1.22, z, 0.16);
    });
    LABEL_AT.forEach(([x, z, alongZ], k) => {
      const half = (labels[k]?.width ?? 1.4) / 2;
      for (const side of [-half, half]) for (const y of [0.02, 0.02 + LABEL_HEIGHT]) pts.push(new Vector3(alongZ ? x : x + side, y, alongZ ? z + side : z));
    });
    pts.push(new Vector3(0, 0, SPAN), new Vector3(0, 0, -SPAN));

    const seenAt = pts.map((p) => {
      const v = p.applyMatrix4(camera.matrixWorldInverse);
      return [v.x / -v.z, v.y / -v.z] as [number, number];
    });
    const us = seenAt.map((p) => p[0]);
    const ws = seenAt.map((p) => p[1]);
    bounds = { u0: Math.min(...us), u1: Math.max(...us), w0: Math.min(...ws), w1: Math.max(...ws) };
    covered = seenAt.map(([u, w]) => [(u - bounds.u0) / (bounds.u1 - bounds.u0), (bounds.w1 - w) / (bounds.w1 - bounds.w0)]);
  };

  const resize = (): void => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);

    const hostAt = host.getBoundingClientRect();
    const copy = options.copy?.getBoundingClientRect();
    const nav = options.nav?.getBoundingClientRect();
    const box = fitScene({
      width, height,
      top: (nav ? nav.bottom - hostAt.top : 0) + 8,
      right: Math.max(width < 720 ? 12 : 28, (width - 1560) / 2),
      // Room under the lowest pad for its floor ripple: the tiles that rise round it are not in `measure`.
      bottom: Math.max(56, Math.round(height * 0.08)),
      left: 12,
      copyRight: copy ? copy.right - hostAt.left : 0,
      copyBottom: copy ? copy.bottom - hostAt.top : 0,
      gap: 22,
      aspect: (bounds.u1 - bounds.u0) / (bounds.w1 - bounds.w0),
      points: covered,
      maxHeight: height * 0.78,
    });

    // Zoom until the scene is the box's size, then slide the view until it is in the box.
    const focal = height / (2 * Math.tan(MathUtils.degToRad(FOV) / 2));
    const zoom = box.width / (focal * (bounds.u1 - bounds.u0));
    const dx = box.x + box.width / 2 - width / 2 - (focal * zoom * (bounds.u0 + bounds.u1)) / 2;
    const dy = box.y + box.height / 2 - height / 2 + (focal * zoom * (bounds.w0 + bounds.w1)) / 2;
    camera.aspect = width / height;
    camera.zoom = zoom;
    camera.setViewOffset(width, height, -dx, -dy, width, height);

    ground.resize(width, [0.1, 0.16, 0.1, 0.12]);
    runner?.redraw();
  };

  // ── the loop ───────────────────────────────────────────────────────────────

  const frame: Frame = createFrame();
  const apply = (f: Frame): void => {
    for (let k = 0; k < NODES; k++) {
      const s = f.nodes[k];
      const pad = pads[k];
      waves.value[k].z = s.wave;
      if (pad.kind === "step") {
        // The body sinks to 0.2 while the button grows to 0.28: the button's top ends a little higher than it began.
        const sink = 1 - 0.444 * s.press;
        const rise = 1 + 2.5 * s.press;
        pad.body.scale.y = sink;
        pad.top.position.y = 0.1 + 0.36 * sink;
        pad.button.scale.y = rise;
        pad.seat.position.y = 0.08 * rise + 0.006;
        pad.spin.position.y = s.lift;
        pad.spin.quaternion.setFromAxisAngle(TOSS_AXIS, s.turn);
      } else {
        const sink = 1 - 0.45 * s.press;
        pad.body.scale.y = sink;
        pad.top.position.y = 0.1 + 0.4 * sink;
        const next = s.fired % pad.glyphs.length;
        if (next !== pad.shown) { pad.shown = next; pad.iconMaterial.map = pad.glyphs[next]; }
        pad.iconMaterial.opacity = s.icon;
        pad.icon.scale.setScalar(PORT_ICON * (0.84 + 0.16 * s.icon));
        pad.icon.visible = s.icon > 0.002;
      }
    }
    for (let k = 0; k < PATHS; k++) {
      const { line, material } = lit[k];
      const drawn = Math.round(f.paths[k].draw * PATH_SEGMENTS);
      line.visible = drawn > 0 && f.paths[k].glow > 0.002;
      line.geometry.instanceCount = drawn;
      material.opacity = f.paths[k].glow;

      const label = labels[k];
      if (!label) continue;
      const { up, tau } = f.banners[k];
      label.root.visible = up > 0.001;
      if (!label.root.visible) continue;
      label.hinge.rotation.x = -(1 - up) * (Math.PI / 2);
      label.hinge.scale.y = up;
      const n = label.layout.text.length;
      let changed = false;
      for (let i = 0; i < n; i++) {
        const o = Math.round(bannerLetter(tau, i, n) * 40) / 40;
        if (o !== label.painted[i]) { label.painted[i] = o; changed = true; }
      }
      if (changed) {
        paintLabel(label.ctx, label.layout, ink.labelInk, (i) => label.painted[i]);
        label.texture.needsUpdate = true;
      }
    }
  };

  // The scene's clock starts just before the first task presses in.
  let clock = -0.9;
  let disposed = false;
  let runner: Loop | null = null;

  const sizes = new ResizeObserver(resize);
  sizes.observe(host);
  if (options.copy) sizes.observe(options.copy);

  measure();
  resize();
  runner = loopWhileSeen(host, (seconds, still) => {
    clock += seconds;
    apply(still ? posterFrame(frame) : frameAt(clock, frame));
    renderer.render(scene, camera);
    if (!host.dataset.ready) host.dataset.ready = "1";
  });

  // The labels are measured in the page's type, so they wait for it (but not for long).
  const fontReady = document.fonts?.load ? document.fonts.load(`500 16px ${LABEL_FONT}`).catch(() => undefined) : Promise.resolve();
  void Promise.race([fontReady, new Promise((done) => setTimeout(done, 1500))]).then(buildLabels);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      runner?.dispose();
      sizes.disconnect();
      kit.dispose();
      delete host.dataset.ready;
    },
  };
}
