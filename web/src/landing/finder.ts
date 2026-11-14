// The split finder's chapter: one canvas that plays chapter.ts as the page scrolls through its pinned section.
//
//   the coins   one for each run of a batch, with a tick or a warning and the run's name. They turn in a ring,
//               then fly in and shrink until each is a point.
//   the web     net.ts's sphere of points and ties: every action of every run. It grows out of the points the
//               coins became, stands whole, then thins down to the one point where the runs split.
//   the tag     the split's name, how many runs of each kind took that step, and a line of the code that is the
//               step, on the point that is left.
//
// Like scene.ts and devices.ts this is loaded on demand and owns one canvas in `host` (and the tag, which is
// HTML over it). The coins and the web are two scenes with a camera each, drawn one over the other: the coins
// are seen from close with a wide lens, the web from farther off, and a coin lands on a seed by aiming at where
// the web's camera puts that seed on the screen.

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Euler, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Points,
  Quaternion, Scene, ShaderMaterial, Vector2, Vector3,
} from "three";
import { CHAPTER, REVEAL_SOFT, REVEAL_SPAN, chapterAt, chapterPoster, clockAt, type ChapterView } from "./chapter";
import { smooth } from "./ease";
import { VERDICT_GLYPHS, paintGlyph } from "./glyphs";
import { LABEL_FONT, createKit, css, join, loopWhileSeen, type Loop, type SceneTone } from "./kit";
import { linksWithin, nearest, orders, pickSpread, spherePoints, turn, walk } from "./net";
import { circle, loop, prism } from "./shapes";

export interface FinderOptions {
  /** Which palette to draw in. */
  tone: SceneTone;
  /** The tall element the chapter is pinned in. How far the page has scrolled through it is the chapter's clock;
   *  without it (or when it is no taller than the screen) the chapter is its still picture. */
  pin: HTMLElement | null;
  /** The element the page scrolls in, or null for the window. */
  scroller: Element | null;
  /** Play the chapter on its own clock instead of the page's: through in `PLAY_SECONDS`, a rest on the found split,
   *  then again from the coins. For a card that does not pin. */
  play?: boolean;
  /** One coin for each run: its name, and whether its score was honest. */
  runs: readonly { id: string; honest: boolean }[];
  /** The split's tag: the step's name, the share of each kind of run that took it, and a line of code that is it. */
  split: { step: string; honest: string; inflated: string; code: string };
}

export interface Finder {
  /** Start the played chapter again from its coins (when its card is shown again). */
  restart(): void;
  dispose(): void;
}

/** A played chapter: how long it takes, and how long it rests on the split before it starts again. */
const PLAY_SECONDS = 9;
const PLAY_REST = 3.5;

/** The web: how many points, and how near each other two must be to be tied. */
const POINTS = 120;
const REACH = 0.745;
/** Its camera's angle of view, and how far that stands from the middle of the sphere, whose radius is 1. */
const NET_FOV = 60;
const NET_EYE = 2.2;
/** How far the sphere leans toward the viewer. */
const TILT = 0.192;
/** The web fades with distance from the eye, from here to here: the far side of the sphere is all but gone. */
const FOG: [number, number] = [1.28, 2.99];
/** A point's radius is its own size (1 to 2.5) times this, plus a pulse. */
const POINT_SIZE = 0.0029;
const PULSE = 0.9;
/** A tie's width, in CSS pixels. */
const TIE_WIDTH = 1.1;
/** How near the pointer, in half canvases, the web brightens. */
const POINTER_REACH = 0.65;
/** The farthest point from a seed comes on this far through the growing. */
const GROW_LAST = 0.9;
/** A point this far from the split along the ties, or farther, goes as soon as the thinning starts. */
const THIN_FULL = 1.3;
/** Where on the sphere, as the viewer sees it at the end, the split's point is looked for: left of the middle, so
 *  its tag has room beside it. */
const SPLIT_FACES: [number, number, number] = [-0.36, 0.1, 0.93];

/** The coins: a ring of this radius, seen with this angle of view from this far. A coin's radius is 1. */
const RING = 4.445;
const COIN_FOV = 84;
const COIN_EYE = 6.667;
const COIN_THICK = 0.1;
const COIN_EDGE = 0.026;

/** How quickly what is drawn catches up with the page's scrolling, per second: a wheel's steps become one motion. */
const CATCH_UP = 9;

const TIE_VERTEX = /* glsl */ `
uniform vec2 uPixel;
uniform float uWidth;
uniform float uAspect;
uniform float uReveal;
uniform float uSpan;
uniform float uSoft;
uniform float uThin;
uniform vec2 uFog;
uniform vec3 uPointer;
uniform float uReach;
attribute vec3 aTo;
attribute vec2 aCorner;
attribute float aStrength;
attribute vec4 aOrders;
varying float vAlpha;
varying float vAlong;
varying float vGrow;
void main() {
  vec4 a = modelViewMatrix * vec4(position, 1.0);
  vec4 b = modelViewMatrix * vec4(aTo, 1.0);
  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  // A tie is a strip one line wide: its corners are pushed out sideways on the screen, by pixels.
  vec2 run = (cb.xy / cb.w - ca.xy / ca.w) / uPixel;
  vec2 side = normalize(vec2(-run.y, run.x) + vec2(1e-6)) * uPixel;
  vec4 at = mix(ca, cb, aCorner.x);
  at.xy += side * aCorner.y * uWidth * at.w;
  float fog = 1.0 - smoothstep(uFog.x, uFog.y, -mix(a.z, b.z, aCorner.x));
  vec2 away = (at.xy / at.w - uPointer.xy) * vec2(uAspect, 1.0);
  float near = (1.0 - smoothstep(0.0, uReach, length(away))) * uPointer.z;
  // It draws on from whichever of its ends comes first toward the other, over at least uSpan of the reveal, and is
  // whole by the reveal's end.
  vec2 order = mix(aOrders.xy, aOrders.zw, uThin);
  float first = min(order.x, order.y);
  float last = min(max(max(order.x, order.y), first + uSpan), 1.0 + uSoft);
  vGrow = clamp((uReveal - first) / max(last - first, 0.02), 0.0, 1.0);
  vAlong = order.x <= order.y ? aCorner.x : 1.0 - aCorner.x;
  vAlpha = aStrength * fog * (1.0 + near * 1.6);
  gl_Position = at;
}`;
const TIE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vAlong;
varying float vGrow;
void main() {
  // The growing tip is soft, and the whole tie fades in as it starts.
  float tip = vGrow * 1.12;
  float drawn = (1.0 - smoothstep(tip - 0.12, tip, vAlong)) * smoothstep(0.0, 0.3, vGrow);
  float alpha = vAlpha * 0.52 * uOpacity * drawn;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
}`;
const POINT_VERTEX = /* glsl */ `
uniform float uScale;
uniform float uSize;
uniform float uPulse;
uniform float uBeat;
uniform float uAspect;
uniform float uReveal;
uniform float uSpan;
uniform float uSoft;
uniform float uThin;
uniform vec2 uFog;
uniform vec3 uPointer;
uniform float uReach;
attribute vec3 aPulse;
attribute vec2 aOrders;
varying float vAlpha;
void main() {
  vec4 at = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * at;
  float depth = -at.z;
  float beat = (sin(uBeat * aPulse.y + aPulse.z) + 1.0) * 0.5;
  vec2 away = (gl_Position.xy / gl_Position.w - uPointer.xy) * vec2(uAspect, 1.0);
  float near = (1.0 - smoothstep(0.0, uReach, length(away))) * uPointer.z;
  float radius = (aPulse.x + beat * 1.8 * uPulse) * uSize * (1.0 + near * 0.9);
  gl_PointSize = max(1.0, radius * uScale / depth);
  // A point comes on when the reveal reaches its order, and no sooner than its first ties do. A seed is always on.
  float order = mix(aOrders.x, aOrders.y, uThin);
  float arrival = max(order, uSpan);
  float shown = order > 0.0 ? smoothstep(arrival - uSoft, arrival, uReveal) : 1.0;
  float fog = 1.0 - smoothstep(uFog.x, uFog.y, depth);
  vAlpha = clamp((0.4 + beat * 0.6) * (1.0 + near), 0.0, 1.0) * fog * shown;
}`;
const POINT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float alpha = vAlpha * (1.0 - smoothstep(0.7, 1.0, d)) * 0.9 * uOpacity;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
}`;

/** A small repeatable source of numbers from 0 to 1, so the web's points pulse the same way on every visit. */
const noise = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Mount the chapter in `host` and start it. `host` gets `data-ready` once it has drawn. */
export function mountFinder(host: HTMLElement, options: FinderOptions): Finder {
  const kit = createKit(host, options.tone);
  if (!kit) return { restart() { /* nothing to play */ }, dispose() { /* no WebGL: the copy beside it still reads */ } };
  const { renderer, canvas, ink, keep, own, gloss, stroke, solid, strokes, flat } = kit;
  // Two scenes are drawn into one picture, so the canvas is cleared by hand.
  renderer.autoClear = false;

  // ── the web ────────────────────────────────────────────────────────────────

  const points = spherePoints(POINTS);
  const links = linksWithin(points, REACH);
  const ties = links.length.length;
  const yawAtStart = chapterAt(0).yaw;
  const yawAtEnd = chapterAt(CHAPTER).yaw;
  // The seeds are the points the coins land on: ones that face the viewer when the web first shows.
  const seenAtStart = turn(points, yawAtStart, TILT, yawAtStart / 3);
  const seeds = pickSpread(seenAtStart, options.runs.length, 0.42);
  const split = nearest(turn(points, yawAtEnd, TILT, yawAtEnd / 3), ...SPLIT_FACES);
  const fromRuns = walk(POINTS, links, seeds);
  const growing = orders(fromRuns, Math.max(...fromRuns) / GROW_LAST);
  const thinning = orders(walk(POINTS, links, [split]), THIN_FULL);

  const random = noise(7);
  const pulse = new Float32Array(POINTS * 3);
  const pointOrders = new Float32Array(POINTS * 2);
  for (let i = 0; i < POINTS; i++) {
    pulse.set([1 + 1.5 * random(), 0.9 + 1.2 * random(), random() * Math.PI * 2], i * 3);
    pointOrders.set([growing[i], thinning[i]], i * 2);
  }

  // Four corners to a tie: both ends, each pushed out to either side.
  const from = new Float32Array(ties * 12);
  const to = new Float32Array(ties * 12);
  const corner = new Float32Array(ties * 8);
  const strength = new Float32Array(ties * 4);
  const tieOrders = new Float32Array(ties * 16);
  const index = new Uint16Array(ties * 6);
  for (let k = 0; k < ties; k++) {
    const [a, b] = [links.pairs[k * 2], links.pairs[k * 2 + 1]];
    for (let c = 0; c < 4; c++) {
      from.set(points.subarray(a * 3, a * 3 + 3), (k * 4 + c) * 3);
      to.set(points.subarray(b * 3, b * 3 + 3), (k * 4 + c) * 3);
      corner.set([c >> 1, c & 1 ? 1 : -1], (k * 4 + c) * 2);
      strength[k * 4 + c] = links.strength[k];
      tieOrders.set([growing[a], growing[b], thinning[a], thinning[b]], (k * 4 + c) * 4);
    }
    index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4 + 2, k * 4 + 1, k * 4 + 3], k * 6);
  }

  // What the ties and the points both read.
  const shared = {
    uColor: { value: new Color(ink.net) },
    uAspect: { value: 1 },
    uReveal: { value: 0 },
    uSpan: { value: REVEAL_SPAN },
    uSoft: { value: REVEAL_SOFT },
    uThin: { value: 0 },
    uFog: { value: new Vector2(...FOG) },
    uPointer: { value: new Vector3(0, 0, 0) },
    uReach: { value: POINTER_REACH },
  };
  const tieUniforms = { ...shared, uPixel: { value: new Vector2(1, 1) }, uWidth: { value: 1 }, uOpacity: { value: 0 } };
  const pointUniforms = {
    ...shared, uScale: { value: 1 }, uSize: { value: POINT_SIZE }, uPulse: { value: PULSE }, uBeat: { value: 0 }, uOpacity: { value: 0 },
  };
  const flatOnScreen = { transparent: true, depthTest: false, depthWrite: false };

  const tieShape = own(new BufferGeometry());
  tieShape.setAttribute("position", new BufferAttribute(from, 3));
  tieShape.setAttribute("aTo", new BufferAttribute(to, 3));
  tieShape.setAttribute("aCorner", new BufferAttribute(corner, 2));
  tieShape.setAttribute("aStrength", new BufferAttribute(strength, 1));
  tieShape.setAttribute("aOrders", new BufferAttribute(tieOrders, 4));
  tieShape.setIndex(new BufferAttribute(index, 1));
  // A strip faces whichever way its tie happens to run on the screen, so both of its sides are drawn.
  const tieMesh = new Mesh(tieShape, keep(new ShaderMaterial({ uniforms: tieUniforms, vertexShader: TIE_VERTEX, fragmentShader: TIE_FRAGMENT, side: DoubleSide, ...flatOnScreen })));

  const pointShape = own(new BufferGeometry());
  pointShape.setAttribute("position", new BufferAttribute(points, 3));
  pointShape.setAttribute("aPulse", new BufferAttribute(pulse, 3));
  pointShape.setAttribute("aOrders", new BufferAttribute(pointOrders, 2));
  const pointCloud = new Points(pointShape, keep(new ShaderMaterial({ uniforms: pointUniforms, vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT, ...flatOnScreen })));
  // Both are placed by their own shaders, so there is nothing for three.js to cull them by.
  tieMesh.frustumCulled = pointCloud.frustumCulled = false;

  const web = new Group();
  // Yaw, then tilt, then roll: the turn net.ts's `turn` makes.
  web.rotation.order = "ZXY";
  web.add(tieMesh, pointCloud);
  const netScene = new Scene().add(web);
  const netCamera = new PerspectiveCamera(NET_FOV, 1, 0.1, 10);
  netCamera.position.set(0, 0, NET_EYE);
  const netFocal = 1 / Math.tan((NET_FOV * Math.PI) / 360);

  // ── the coins ──────────────────────────────────────────────────────────────

  const coinScene = new Scene();
  kit.lights(coinScene, [-3, 6, 9]);
  const coinCamera = new PerspectiveCamera(COIN_FOV, 1, 0.1, 40);
  coinCamera.position.set(0, 0, COIN_EYE);
  const coinReach = Math.tan((COIN_FOV * Math.PI) / 360) * COIN_EYE;
  const ring = new Group();
  coinScene.add(ring);

  const coinO = circle(1, 56);
  const coinColor = new Color(ink.coin);
  const surfaceColor = new Color(ink.surface);
  const netColor = new Color(ink.net);
  const pointColor = new Color();
  const edge = stroke(ink.coinLine, 1);
  edge.transparent = true;
  const coinSolid = prism(coinO, COIN_THICK, COIN_EDGE, { y0: -COIN_THICK / 2, closed: true });
  /** The coins share one shape: the first one made owns it. */
  let coinShape: BufferGeometry | null = null;
  const rims = join(loop(coinO, COIN_THICK / 2, COIN_EDGE), loop(coinO, -COIN_THICK / 2));
  const glyphColors = { ink: ink.glyph, disc: css(ink.disc) };
  const repaint: (() => void)[] = [];

  interface Coin {
    slot: Group;
    turned: Group;
    /** Its own colour: it ends as bright as the point it becomes, and no two points are alike. */
    body: ReturnType<typeof gloss>;
    /** Its place in the ring. */
    home: Vector2;
    /** The point of the web it lands on. */
    seed: number;
  }
  const faces: MeshBasicMaterial[] = [];
  const coins: Coin[] = options.runs.map((run, i) => {
    const around = (i / options.runs.length) * Math.PI * 2;
    const slot = new Group();
    // Each coin is turned a little further round than the last, so no two tumble alike.
    slot.rotation.z = around;
    const turned = new Group();
    const face = kit.surface(256, 256);
    const paint = (): void => {
      const { ctx } = face;
      ctx.clearRect(0, 0, 256, 256);
      // A dark disc set into the coin, with the run's result on it and its name under that.
      ctx.fillStyle = css(ink.disc);
      ctx.beginPath();
      ctx.arc(128, 128, 101, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = css(ink.discLine);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.save();
      ctx.translate(128 - 48, 128 - 48 - 16);
      paintGlyph(ctx, VERDICT_GLYPHS[run.honest ? 0 : 1], 96, glyphColors);
      ctx.restore();
      ctx.font = `500 27px ${LABEL_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = ink.coinInk;
      ctx.fillText(run.id, 128, 185);
      face.texture.needsUpdate = true;
    };
    paint();
    repaint.push(paint);
    const print = keep(new MeshBasicMaterial({ map: face.texture, transparent: true, depthWrite: false }));
    faces.push(print);
    // The same face on both sides: one lying on the coin, one turned over under it.
    const heads = new Mesh(flat, print);
    heads.scale.set(2, 1, 2);
    heads.position.y = COIN_THICK / 2 + 0.003;
    const tails = new Mesh(flat, print);
    tails.scale.set(2, 1, 2);
    tails.rotation.x = Math.PI;
    tails.position.y = -COIN_THICK / 2 - 0.003;
    const body = gloss(ink.coin);
    body.transparent = true;
    const disc = coinShape ? new Mesh(coinShape, body) : solid(coinSolid, body);
    coinShape = disc.geometry;
    turned.add(disc, strokes(rims, edge), heads, tails);
    ring.add(slot.add(turned));
    return { slot, turned, body, home: new Vector2(RING * Math.cos(around + Math.PI / 4), RING * Math.sin(around + Math.PI / 4)), seed: seeds[i % seeds.length] };
  });
  const scratch = new Vector3();

  // ── the split's tag ────────────────────────────────────────────────────────

  const tag = document.createElement("div");
  tag.className = "lp-tag";
  tag.innerHTML = `<span class="lp-tag-dot"></span><span class="lp-tag-card"><span class="lp-tag-step"></span><span class="lp-tag-line"><b class="lp-tag-honest"></b> honest runs · <b class="lp-tag-inflated"></b> inflated</span><code class="lp-tag-code"></code></span>`;
  for (const [part, words] of Object.entries(options.split)) tag.querySelector(`.lp-tag-${part}`)!.textContent = words;
  host.appendChild(tag);
  const card = tag.querySelector<HTMLElement>(".lp-tag-card")!;
  /** The card's width, measured when the canvas is sized and again once the page's type has loaded. */
  let cardWidth = 0;
  const splitAt = new Vector3(points[split * 3], points[split * 3 + 1], points[split * 3 + 2]);

  // ── drawing ────────────────────────────────────────────────────────────────

  const { pin, scroller } = options;
  let played = 0;
  /** Where the page stands in the chapter, or null when the chapter is not pinned and shows its still picture. */
  const readClock = (): number | null => {
    if (options.play) return Math.min(1, (played % (PLAY_SECONDS + PLAY_REST)) / PLAY_SECONDS) * CHAPTER;
    if (!pin) return null;
    const box = pin.getBoundingClientRect();
    const portTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const portHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const travel = box.height - portHeight;
    return travel > 1 ? clockAt(portTop - box.top, travel) : null;
  };

  const tumbling = new Quaternion();
  const facing = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));
  const euler = new Euler();
  const buffer = new Vector2();
  let width = 0;
  let height = 0;
  /** Where what is drawn stands on the chapter's clock; it trails the page a little. NaN before the first frame. */
  let clock = NaN;
  let ringAngle = 0;
  let tumbleAngle = 0;
  const pointer = { x: 0, y: 0, over: false };
  let hover = 0;
  /** What the last frame drew, to skip a frame that would draw the same again. */
  let last = "";

  const frame = (seconds: number, still: boolean): void => {
    if (options.play && !still) played += seconds;
    const want = still ? null : readClock();
    let view: ChapterView;
    if (want === null) {
      view = chapterPoster();
      clock = NaN;
    } else {
      // Played on its own clock it starts again from the coins at once; following the page it trails it a little.
      clock = Number.isNaN(clock) || options.play ? want : want + (clock - want) * Math.exp(-seconds * CATCH_UP);
      if (Math.abs(clock - want) < 0.05) clock = want;
      view = chapterAt(clock);
    }
    const reach = pointer.over ? 1 : 0;
    hover = Math.abs(reach - hover) < 0.002 ? reach : reach + (hover - reach) * Math.exp(-seconds * 7);
    const coinsShow = view.coins > 0.003;
    // The coins move on their own; everything else only when the page scrolls or the pointer does.
    const now = coinsShow ? "" : `${want === null ? "still" : clock}|${hover}|${pointer.x}|${pointer.y}|${width}|${height}`;
    if (now && now === last) return;
    last = now;

    // The web.
    web.rotation.set(TILT, view.yaw, view.yaw / 3);
    shared.uReveal.value = view.reveal;
    shared.uThin.value = view.thinning ? 1 : 0;
    shared.uPointer.value.set(pointer.x, pointer.y, hover);
    tieUniforms.uOpacity.value = view.ties;
    pointUniforms.uOpacity.value = view.points;
    pointUniforms.uBeat.value = view.beat;

    // The coins.
    ring.visible = coinsShow;
    if (coinsShow) {
      ringAngle -= view.spin * seconds;
      tumbleAngle += view.tumble * seconds;
      ring.rotation.z = ringAngle;
      tumbling.setFromEuler(euler.set(tumbleAngle, tumbleAngle + 0.285, tumbleAngle + 1.57)).slerp(facing, view.settle);
      const [c, s] = [Math.cos(-ringAngle), Math.sin(-ringAngle)];
      web.updateMatrixWorld();
      for (const coin of coins) {
        // A coin is aimed at its seed as the web's camera sees it right now, and ends as that seed's point: as
        // big, and as bright, as the point is at this moment of its pulse. So the web's points can come up
        // under the coins without anything seeming to change.
        const at = coin.seed * 3;
        scratch.set(points[at], points[at + 1], points[at + 2]).applyMatrix4(web.matrixWorld);
        const depth = NET_EYE - scratch.z;
        const beat = (Math.sin(view.beat * pulse[at + 1] + pulse[at + 2]) + 1) / 2;
        const small = (((pulse[at] + beat * 1.8 * PULSE) * POINT_SIZE * netFocal) / depth) * coinReach * 0.85;
        const glow = (0.4 + beat * 0.6) * 0.9 * (1 - smooth((depth - FOG[0]) / (FOG[1] - FOG[0])));
        scratch.project(netCamera);
        // The ring keeps turning under a coin that is flying to a place on the screen.
        const seenX = scratch.x * coinReach * coinCamera.aspect;
        const seenY = scratch.y * coinReach;
        const aimX = seenX * c - seenY * s;
        const aimY = seenX * s + seenY * c;
        coin.slot.position.set(coin.home.x + (aimX - coin.home.x) * view.gather, coin.home.y + (aimY - coin.home.y) * view.gather, 0);
        coin.slot.scale.setScalar(1 + (small - 1) * view.gather);
        coin.turned.quaternion.copy(tumbling);
        coin.body.color.copy(coinColor).lerp(pointColor.copy(surfaceColor).lerp(netColor, glow), view.grey);
        coin.body.opacity = view.coins;
      }
      edge.opacity = view.faces * view.coins;
      edge.visible = edge.opacity > 0.003;
      for (const print of faces) {
        print.opacity = view.faces;
        print.visible = view.faces > 0.003;
      }
    }

    renderer.clear();
    if (view.points > 0.003 || view.ties > 0.003) renderer.render(netScene, netCamera);
    if (coinsShow) {
      renderer.clearDepth();
      renderer.render(coinScene, coinCamera);
    }

    // The tag sits on the split's point: beside it where there is room, under it where there is not.
    if (view.mark > 0.003 && width) {
      web.updateMatrixWorld();
      scratch.copy(splitAt).applyMatrix4(web.matrixWorld).project(netCamera);
      const x = ((scratch.x + 1) / 2) * width;
      const y = ((1 - scratch.y) / 2) * height;
      const beside = x + 26 + cardWidth <= width;
      tag.dataset.side = beside ? "beside" : "under";
      // Under the point the card is centred on it, as far as the canvas's edges allow.
      const half = cardWidth / 2;
      card.style.setProperty("--lp-tag-shift", beside ? "0px" : `${(Math.min(Math.max(x, half), width - half) - x).toFixed(1)}px`);
      tag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      tag.style.setProperty("--lp-tag-in", view.mark.toFixed(3));
      tag.style.opacity = view.mark.toFixed(3);
      tag.style.visibility = "visible";
    } else {
      tag.style.opacity = "0";
      tag.style.visibility = "hidden";
    }
    if (!host.dataset.ready) host.dataset.ready = "1";
  };

  // ── the page around it ─────────────────────────────────────────────────────

  let runner: Loop | null = null;
  let disposed = false;

  const resize = (): void => {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(density);
    renderer.setSize(width, height, false);
    for (const camera of [coinCamera, netCamera]) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    renderer.getDrawingBufferSize(buffer);
    shared.uAspect.value = width / height;
    tieUniforms.uPixel.value.set(2 / buffer.x, 2 / buffer.y);
    tieUniforms.uWidth.value = (TIE_WIDTH * density) / 2;
    pointUniforms.uScale.value = buffer.y * netFocal;
    cardWidth = card.offsetWidth;
    netCamera.updateMatrixWorld();
    runner?.redraw();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(host);

  const onMove = (e: PointerEvent): void => {
    const box = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - box.left) / box.width) * 2 - 1;
    pointer.y = 1 - ((e.clientY - box.top) / box.height) * 2;
    pointer.over = true;
  };
  const onLeave = (): void => { pointer.over = false; };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);

  resize();
  runner = loopWhileSeen(host, frame);
  void document.fonts?.ready.then(() => {
    if (disposed) return;
    for (const paint of repaint) paint();
    cardWidth = card.offsetWidth;
    last = "";
    runner?.redraw();
  });

  return {
    restart() { played = 0; },
    dispose() {
      if (disposed) return;
      disposed = true;
      runner?.dispose();
      sizes.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      tag.remove();
      kit.dispose();
      delete host.dataset.ready;
    },
  };
}
