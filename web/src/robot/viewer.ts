// The 3D robot replay (three.js). Loaded on demand by robot/mount.ts.
//
// The server sends the scene once (every visual geom with its body, shape, pose and color) and, per motion file, the
// world pose of each moving body in every frame (deep_research/robot_view.py). Here each body is a group of meshes
// whose pose is set straight from those numbers, interpolated between frames. The world is z up, as in MuJoCo: the
// robot base at the origin, the floor at z = 0.
//
// Two ways to show it:
//   mountPlayer   the run page: its own renderer, orbit controls, play / pause, speed, scrubber, loop, the result,
//                 and a picker of the run's motion files
//   mountThumb    a run tile on the batch page: a small looping replay. Every thumbnail shares ONE renderer and one
//                 world (browsers cap WebGL contexts at about 16): each is posed, drawn, and copied to its own 2D
//                 canvas in turn, only while on screen, at most 24 times a second.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { attr, esc } from "../ui";
import { fetchMotion, fetchScene, fetchSummaries, type MotionData, type MotionSummary, type SceneData, type SceneGeom } from "./data";
import { SUCCESS_LEGEND, SUCCESS_RADIUS_CM, cm, motionName, noWebglView, resultFacts, resultText, resultTone, seconds, xy } from "./markup";

// ── WebGL, checked once ──────────────────────────────────────────────────────

let webgl: boolean | null = null;

function probeWebgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch { return false; }
}

/** Whether this browser can draw the 3D view. Asked once per page and remembered, so a browser without WebGL is not
 *  asked again for every thumbnail and every frame (each failed try logs an error). */
export function webglAvailable(probe: () => boolean = probeWebgl): boolean {
  webgl ??= probe();
  return webgl;
}

/** A renderer, or null (and WebGL marked missing for the page) when one cannot be made. */
function makeRenderer(): THREE.WebGLRenderer | null {
  if (!webglAvailable()) return null;
  try {
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    return r;
  } catch {
    webgl = false;
    return null;
  }
}

/** For the tests: forget the answer. */
export function resetWebglCheck(): void { webgl = null; }

// ── the world ────────────────────────────────────────────────────────────────

type Theme = "light" | "dark";
const PALETTE: Record<Theme, { bg: number; floor: number; grid: number }> = {
  light: { bg: 0xe9ecf0, floor: 0xdde1e7, grid: 0xc3c9d2 },
  dark: { bg: 0x16191d, floor: 0x1e2227, grid: 0x3a4149 },
};
/** Where the camera looks: between the base, the can and the place zone. */
const TARGET = new THREE.Vector3(0.36, -0.06, 0.24);
const CAMERA_AT = new THREE.Vector3(1.45, -1.02, 0.8);
const THUMB_CAMERA_AT = new THREE.Vector3(1.5, -1.08, 0.86);
const CREASE = Math.PI / 5;

/** The success area (markup.ts SUCCESS_RADIUS_CM), in meters. */
const SUCCESS_R = SUCCESS_RADIUS_CM / 100;
/** The marks on the floor sit just above the place zone disc (its top is at 1 mm) so they never z-fight with it. */
const MARK_Z = 0.0016;
/** The success ring and the center mark: a crisp dark green on the light floor, a bright one on the dark. */
const RING: Record<Theme, number> = { light: 0x0b6b35, dark: 0x5be38f };
const END_TONE = { ok: 0x15803d, bad: 0xdc2626, none: 0x6b7480 };

const themeOf = (el: Element): Theme => (el.closest<HTMLElement>("[data-cnpy-theme]")?.dataset.cnpyTheme === "dark" ? "dark" : "light");

const geometries = new Map<string, THREE.BufferGeometry>();
const materials = new Map<string, THREE.Material>();

function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometries.get(key);
  if (!g) { g = make(); geometries.set(key, g); }
  return g;
}

function material(rgba: number[], name: string): THREE.Material {
  const key = `${rgba.join(",")}|${name === "place_zone" ? "zone" : ""}`;
  let m = materials.get(key);
  if (!m) {
    const [r, g, b, a] = rgba;
    const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    const zone = name === "place_zone";
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: name === "can" ? 0.35 : 0.5,
      metalness: name === "can" ? 0.15 : 0.05,
      transparent: a < 1,
      opacity: zone ? 0.8 : a,
      depthWrite: a >= 1,
      polygonOffset: zone,
      polygonOffsetFactor: zone ? -2 : 0,
      polygonOffsetUnits: zone ? -2 : 0,
    });
    materials.set(key, m);
  }
  return m;
}

function geomGeometry(g: SceneGeom, scene: SceneData): THREE.BufferGeometry | null {
  const s = g.size;
  switch (g.type) {
    case "mesh": {
      const mesh = g.mesh != null ? scene.meshes[g.mesh] : undefined;
      if (!mesh || !mesh.f.length) return null;
      return cachedGeometry(`mesh:${g.mesh}`, () => {
        const base = new THREE.BufferGeometry();
        base.setAttribute("position", new THREE.Float32BufferAttribute(mesh.v, 3));
        base.setIndex(mesh.f);
        const out = toCreasedNormals(base, CREASE);
        base.dispose();
        return out;
      });
    }
    // MuJoCo's cylinders and capsules run along their z axis, three.js's along y.
    case "cylinder": return cachedGeometry(`cyl:${s[0]}:${s[1]}`, () => new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 48).rotateX(Math.PI / 2));
    case "capsule": return cachedGeometry(`cap:${s[0]}:${s[1]}`, () => new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 24).rotateX(Math.PI / 2));
    case "box": return cachedGeometry(`box:${s.join(":")}`, () => new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]));
    case "sphere": return cachedGeometry(`sph:${s[0]}`, () => new THREE.SphereGeometry(s[0], 24, 16));
    case "plane": return null; // the floor: the world draws its own
  }
}

const setPose = (o: THREE.Object3D, p: ArrayLike<number>, at = 0): void => {
  o.position.set(p[at], p[at + 1], p[at + 2]);
  o.quaternion.set(p[at + 4], p[at + 5], p[at + 6], p[at + 3]);
};

/** The robot, the can and the place zone: one group per body, posed in world coordinates. */
class Bodies {
  readonly root = new THREE.Group();
  private readonly groups = new Map<number, THREE.Group>();
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private staticOf: MotionData | null = null;

  constructor(scene: SceneData, shadows: boolean) {
    for (const g of scene.geoms) {
      const geo = geomGeometry(g, scene);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material(g.rgba, g.name));
      setPose(mesh, [...g.pos, ...g.quat]);
      const zone = g.name === "place_zone";
      mesh.castShadow = shadows && !zone;
      mesh.receiveShadow = shadows && !zone;
      if (zone) mesh.renderOrder = 1;
      this.group(g.body).add(mesh);
    }
  }

  private group(id: number): THREE.Group {
    let grp = this.groups.get(id);
    if (!grp) { grp = new THREE.Group(); this.groups.set(id, grp); this.root.add(grp); }
    return grp;
  }

  /** Every body where `m` has it at time `t` (seconds), between the two frames around it. */
  pose(m: MotionData, t: number): void {
    if (this.staticOf !== m) {
      for (const [id, p] of Object.entries(m.static)) setPose(this.group(Number(id)), p);
      this.staticOf = m;
    }
    const ts = m.t;
    let lo = 0, hi = m.n - 1;
    if (t <= ts[0]) hi = 0;
    else if (t >= ts[hi]) lo = hi;
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    const span = ts[hi] - ts[lo];
    const a = span > 0 ? Math.min(1, Math.max(0, (t - ts[lo]) / span)) : 0;
    const fa = m.frames[lo], fb = m.frames[hi];
    m.bodies.forEach((id, k) => {
      const grp = this.groups.get(id);
      if (!grp) return;
      const o = k * 7;
      grp.position.set(fa[o] + (fb[o] - fa[o]) * a, fa[o + 1] + (fb[o + 1] - fa[o + 1]) * a, fa[o + 2] + (fb[o + 2] - fa[o + 2]) * a);
      this.qa.set(fa[o + 4], fa[o + 5], fa[o + 6], fa[o + 3]);
      this.qb.set(fb[o + 4], fb[o + 5], fb[o + 6], fb[o + 3]);
      grp.quaternion.slerpQuaternions(this.qa, this.qb, a);
    });
  }
}

/** A scene with lights, the floor and the bodies, in one of the two themes. */
class World {
  readonly scene = new THREE.Scene();
  readonly bodies: Bodies;
  private readonly floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly startMark: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  /** The place target: a dot and a crosshair at its exact center, and the ring of the success area around it. */
  private readonly target = new THREE.Group();
  private readonly targetMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  /** Where the can's center ended (the player, at the end of an episode): a dot and a line from the target's center. */
  private readonly end = new THREE.Group();
  private readonly endMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false });
  private readonly endDot: THREE.Mesh;
  private readonly endLine: THREE.Mesh;
  private readonly canId: number | null;
  private theme: Theme | null = null;

  /** `thumb`: drawn small, so the target's lines are thicker and it has no crosshair. */
  constructor(data: SceneData, shadows: boolean, thumb = false) {
    const s = this.scene;
    s.background = new THREE.Color();
    s.fog = new THREE.Fog(0, 2.2, 4.6);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x80858f, 1.6);
    hemi.position.set(0, 0, 1);
    s.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1.2, -1.4, 2.4);
    key.target.position.copy(TARGET);
    s.add(key, key.target);
    if (shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const c = key.shadow.camera;
      c.left = -1; c.right = 1; c.top = 1; c.bottom = -1; c.near = 0.5; c.far = 6;
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.01;
    }
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-1.5, 1.2, 1.0);
    s.add(fill);

    this.floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }));
    this.floor.position.z = -0.0005;
    this.floor.receiveShadow = shadows;
    s.add(this.floor);
    // 10 cm squares over the reach of the arm.
    this.grid = new THREE.GridHelper(2.4, 24);
    this.grid.rotateX(Math.PI / 2);
    this.grid.position.z = 0.0002;
    s.add(this.grid);
    // Where the can started in this episode: a faint ring.
    this.startMark = new THREE.Mesh(new THREE.RingGeometry(0.028, 0.034, 40), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
    this.startMark.position.z = 0.0006;
    this.startMark.visible = false;
    s.add(this.startMark);

    // The success ring: a crisp outline, thicker on a thumbnail so it still reads at a few pixels.
    const w = thumb ? 0.003 : 0.0017;
    const flat = (g: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => { const m = new THREE.Mesh(g, mat); m.renderOrder = 3; return m; };
    this.target.add(flat(new THREE.RingGeometry(SUCCESS_R - w, SUCCESS_R + w, 96), this.targetMat));
    this.target.add(flat(new THREE.CircleGeometry(thumb ? 0.004 : 0.0028, 24), this.targetMat));
    if (!thumb) {
      // A crosshair through the center, clear of the dot, inside the ring.
      for (const [x, y, len, rot] of [[0.012, 0, 0.012, 0], [-0.012, 0, 0.012, 0], [0, 0.012, 0.012, Math.PI / 2], [0, -0.012, 0.012, Math.PI / 2]]) {
        const bar = flat(new THREE.PlaneGeometry(len, 0.0016), this.targetMat);
        bar.position.set(x, y, 0);
        bar.rotation.z = rot;
        this.target.add(bar);
      }
    }
    this.target.position.z = MARK_Z;
    this.target.visible = false;
    s.add(this.target);

    this.endDot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 24), this.endMat);
    this.endLine = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.0035), this.endMat);
    this.endDot.renderOrder = this.endLine.renderOrder = 4;
    this.end.add(this.endLine, this.endDot);
    this.end.position.z = MARK_Z + 0.0004;
    this.end.visible = false;
    s.add(this.end);
    this.canId = data.bodies.find((b) => b.name === "can")?.id ?? null;

    this.bodies = new Bodies(data, shadows);
    s.add(this.bodies.root);
  }

  /** Where the can's center is in the last frame of `m`, on the floor (x, y), or null. */
  canEnd(m: MotionData): [number, number] | null {
    if (this.canId == null) return null;
    const k = m.bodies.indexOf(this.canId);
    if (k >= 0 && m.n > 0) { const f = m.frames[m.n - 1]; return [f[k * 7], f[k * 7 + 1]]; }
    const st = m.static[String(this.canId)];
    return st ? [st[0], st[1]] : null;
  }

  /** Show (or hide, with null) the can's end mark: a dot under its final center and a line from the target's center.
   *  Returns the dot's world position, for the label. */
  showEnd(m: MotionData | null): { at: THREE.Vector3; mid: THREE.Vector3; far: boolean } | null {
    const tgt = m?.place_target;
    const at = m ? this.canEnd(m) : null;
    if (!m || !tgt || tgt.length < 2 || !at) { this.end.visible = false; return null; }
    this.endMat.color.setHex(END_TONE[resultTone(m.result)]);
    const dx = at[0] - tgt[0], dy = at[1] - tgt[1];
    const len = Math.hypot(dx, dy);
    this.endDot.position.set(at[0], at[1], 0);
    this.endLine.visible = len > 0.001;
    this.endLine.position.set((at[0] + tgt[0]) / 2, (at[1] + tgt[1]) / 2, 0);
    this.endLine.scale.set(Math.max(len, 0.0001), 1, 1);
    this.endLine.rotation.z = Math.atan2(dy, dx);
    this.end.visible = true;
    return { at: new THREE.Vector3(at[0], at[1], MARK_Z), mid: new THREE.Vector3((at[0] + tgt[0]) / 2, (at[1] + tgt[1]) / 2, MARK_Z), far: len > 0.06 };
  }

  setTheme(theme: Theme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    const p = PALETTE[theme];
    (this.scene.background as THREE.Color).setHex(p.bg);
    (this.scene.fog as THREE.Fog).color.setHex(p.bg);
    this.floor.material.color.setHex(p.floor);
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.color.setHex(p.grid);
    gm.vertexColors = false;
    gm.transparent = true;
    gm.opacity = 0.9;
    gm.needsUpdate = true;
    this.startMark.material.color.setHex(theme === "dark" ? 0x9aa3ad : 0x6b7480);
    this.targetMat.color.setHex(RING[theme]);
  }

  pose(m: MotionData, t: number): void {
    this.bodies.pose(m, t);
    const start = m.frames.length && m.bodies.length ? m.can_start : null;
    this.startMark.visible = !!start;
    if (start) this.startMark.position.set(start[0], start[1], 0.0006);
    const tgt = m.place_target;
    this.target.visible = !!tgt && tgt.length >= 2;
    if (tgt && tgt.length >= 2) { this.target.position.x = tgt[0]; this.target.position.y = tgt[1]; }
  }
}

function camera(at: THREE.Vector3): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(38, 4 / 3, 0.02, 20);
  c.up.set(0, 0, 1);
  c.position.copy(at);
  c.lookAt(TARGET);
  return c;
}

const duration = (m: MotionData): number => m.t[m.n - 1] ?? 0;

// ── the run page's player ────────────────────────────────────────────────────

const SPEEDS = [1, 2, 4, 8, 16];
/** The wheel zooms the view only when at least this share of it is on screen. */
const ZOOM_SHOWN = 0.8;
/** A wheel gesture that was scrolling the page keeps scrolling it until it pauses this long (ms). */
const SCROLL_PAUSE_MS = 500;
/** At the end of a looping episode, wait this long on the last frame before starting again. */
const LOOP_HOLD_S = 1.2;

const ICON = {
  play: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/></svg>`,
  loop: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>`,
  view: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`,
};

function parseFiles(el: HTMLElement): string[] {
  try {
    const v = JSON.parse(el.dataset.files ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function mountPlayer(el: HTMLElement): { dispose(): void } {
  const batch = el.dataset.batch ?? "";
  const files = parseFiles(el);
  const renderer = makeRenderer();
  if (!renderer) return mountPlayerWithoutGl(el, batch, files);
  el.innerHTML = `<div class="rb-result" data-rb-result aria-live="polite"></div>`
    + `<div class="rb-stage">`
    + `<div class="rb-loading" data-rb-loading>Loading the robot…</div>`
    + `<button type="button" class="rb-icon rb-reset" data-rb-reset title="Reset the view" aria-label="Reset the camera">${ICON.view}</button>`
    + `<div class="rb-endl" data-rb-endl hidden></div>`
    + `<div class="rb-hint">Drag to turn · scroll to zoom once the view is on screen · ctrl+scroll any time</div>`
    + `</div>`
    + `<div class="rb-bar" role="group" aria-label="Episode replay">`
    + `<button type="button" class="rb-icon rb-play" data-rb-play aria-label="Play">${ICON.play}</button>`
    + `<input class="rb-seek" type="range" data-rb-seek min="0" max="1" step="0.01" value="0" aria-label="Episode time">`
    + `<span class="rb-time" data-rb-time>0.0 s</span>`
    + `<span class="rb-speeds" role="group" aria-label="Speed">${SPEEDS.map((s) => `<button type="button" class="rb-speed" data-rb-speed="${s}" aria-pressed="${s === 1}">${s}x</button>`).join("")}</span>`
    + `<button type="button" class="rb-icon rb-loop" data-rb-loop aria-pressed="true" title="Loop" aria-label="Loop">${ICON.loop}</button>`
    + `</div>`
    + `<p class="rb-legend"><span class="rb-legend-ring" aria-hidden="true"></span><span>${esc(SUCCESS_LEGEND)}</span></p>`
    + (files.length > 1 ? `<div class="rb-files-h">Episodes <span>${files.length}</span></div>` : "")
    + `<div class="rb-files" role="listbox" aria-label="Motion files">${files.map((f, i) => fileButton(f, i, null)).join("")}</div>`;

  const stage = el.querySelector<HTMLElement>(".rb-stage")!;
  const q = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const resultEl = q<HTMLElement>("[data-rb-result]");
  const loadingEl = q<HTMLElement>("[data-rb-loading]");
  const playBtn = q<HTMLButtonElement>("[data-rb-play]");
  const seek = q<HTMLInputElement>("[data-rb-seek]");
  const timeEl = q<HTMLElement>("[data-rb-time]");
  const listEl = q<HTMLElement>(".rb-files");
  const endLabel = q<HTMLElement>("[data-rb-endl]");
  const projected = new THREE.Vector3();

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = "rb-canvas";
  renderer.domElement.setAttribute("aria-label", "3D replay of the robot arm");
  stage.prepend(renderer.domElement);
  const cam = camera(CAMERA_AT);
  const controls = new OrbitControls(cam, renderer.domElement);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.4;
  controls.maxDistance = 4;
  controls.maxPolarAngle = Math.PI * 0.495; // never under the floor
  // The wheel over the view zooms it, without a click first, but never traps the page's scrolling:
  //  - only while the view is mostly on screen (a wheel over a half-hidden view scrolls the page, bringing it in),
  //  - and not in the middle of a scroll: a gesture that was moving the page keeps moving it until it pauses,
  //    so scrolling past the view never gets caught by it.
  // Ctrl or cmd + wheel (and a trackpad pinch, which arrives as ctrl + wheel) always zooms; so does any wheel after a
  // click in the view, until the pointer leaves it. The decision is made in the capture phase, before OrbitControls'
  // own wheel listener reads `enableZoom` (it calls preventDefault only when zooming).
  let grabbed = false;
  let lastScroll = -Infinity;
  const shownShare = (): number => {
    const r = stage.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const h = Math.min(r.height, vh);
    return h > 0 ? Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / h : 0;
  };
  const onStageWheel = (e: WheelEvent): void => {
    const now = performance.now();
    const zoom = grabbed || e.ctrlKey || e.metaKey || (shownShare() >= ZOOM_SHOWN && now - lastScroll > SCROLL_PAUSE_MS);
    controls.enableZoom = zoom;
    if (!zoom) lastScroll = now;
  };
  // Wheels elsewhere on the page are scrolls too: the view may slide under a still pointer mid-scroll.
  const onPageWheel = (e: WheelEvent): void => {
    if (!stage.contains(e.target as Node)) lastScroll = performance.now();
  };
  stage.addEventListener("wheel", onStageWheel, { capture: true, passive: true });
  window.addEventListener("wheel", onPageWheel, { passive: true });
  const grab = (): void => { grabbed = true; stage.classList.add("is-grabbed"); };
  const letGo = (): void => { grabbed = false; stage.classList.remove("is-grabbed"); };
  renderer.domElement.addEventListener("pointerdown", grab);
  stage.addEventListener("pointerleave", letGo);
  controls.update();

  let world: World | null = null;
  let motion: MotionData | null = null;
  let current = -1;
  let t = 0;
  let playing = false;
  let speed = 1;
  let loop = true;
  let hold = 0;
  let dirty = true;
  let visible = true;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let seq = 0;
  const summaries: Record<string, MotionSummary> = {};

  const setPlaying = (on: boolean): void => {
    playing = on;
    playBtn.innerHTML = on ? ICON.pause : ICON.play;
    playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
    last = 0;
  };

  const showTime = (): void => {
    const d = motion ? duration(motion) : 0;
    if (document.activeElement !== seek) seek.value = String(t);
    seek.style.setProperty("--rb-p", `${d > 0 ? (t / d) * 100 : 0}%`);
    timeEl.textContent = `${seconds(t)} / ${seconds(d)}`;
  };

  const showResult = (m: MotionData | null, path: string): void => {
    if (!m) { resultEl.innerHTML = ""; return; }
    const tone = resultTone(m.result);
    const text = resultText(m.result);
    const facts = resultFacts(m.result).filter((f) => !(f.endsWith("from center") && text.includes(" cm")));
    resultEl.innerHTML = `<span class="rb-result-n" title="${attr(path)}">${esc(motionName(path))}</span>`
      + `<span class="rb-tag rb-tag--${tone}">${tone === "ok" ? "Success" : tone === "bad" ? "Fail" : "No result"}</span>`
      + `<span class="rb-result-t">${esc(text)}</span>`
      + facts.map((f) => `<span class="rb-result-f">${esc(f)}</span>`).join("");
  };

  const select = async (i: number): Promise<void> => {
    if (i < 0 || i >= files.length) return;
    current = i;
    const my = ++seq;
    for (const b of Array.from(listEl.children)) b.setAttribute("aria-selected", String(Number((b as HTMLElement).dataset.rbFile) === i));
    loadingEl.hidden = false;
    loadingEl.textContent = "Loading the episode…";
    try {
      const [scene, m] = await Promise.all([fetchScene(), fetchMotion(batch, files[i])]);
      if (disposed || my !== seq) return;
      if (!world) world = new World(scene, true);
      motion = m;
      t = 0;
      hold = 0;
      seek.max = String(duration(m));
      loadingEl.hidden = true;
      showResult(m, files[i]);
      if (m.can_start) stage.setAttribute("aria-label", `Episode ${motionName(files[i])}: can from ${xy(m.can_start)}`);
      setPlaying(true);
      dirty = true;
      showTime();
    } catch (e) {
      if (disposed || my !== seq) return;
      loadingEl.hidden = false;
      loadingEl.textContent = `Couldn't load this episode: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const resize = (): void => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  const io = new IntersectionObserver((es) => { visible = es.some((x) => x.isIntersecting); last = 0; });
  io.observe(stage);

  // At the end of the episode (or scrubbed to it): where the can's center ended, its distance from the target's center.
  const placeEnd = (w: World, m: MotionData): void => {
    const d = duration(m);
    const end = t >= d - 0.5 / (m.fps || 30) ? w.showEnd(m) : w.showEnd(null);
    if (!end) { endLabel.hidden = true; return; }
    const err = typeof m.result.place_error_cm === "number" ? m.result.place_error_cm
      : m.place_target ? Math.hypot(end.at.x - m.place_target[0], end.at.y - m.place_target[1]) * 100 : null;
    if (err == null) { endLabel.hidden = true; return; }
    // Close: under the can. Far off: beside the can's end, on the side away from the target, so the line shows.
    let side = "";
    if (end.far && m.place_target) {
      const from = projected.set(m.place_target[0], m.place_target[1], MARK_Z).project(cam).x;
      side = end.at.clone().project(cam).x >= from ? "right" : "left";
    }
    endLabel.dataset.side = side;
    projected.copy(end.at).project(cam);
    const behind = projected.z > 1;
    endLabel.hidden = behind;
    if (behind) return;
    endLabel.textContent = `${cm(err)} from center`;
    endLabel.dataset.tone = resultTone(m.result);
    endLabel.style.left = `${((projected.x + 1) / 2) * stage.clientWidth}px`;
    endLabel.style.top = `${((1 - projected.y) / 2) * stage.clientHeight}px`;
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = 0; return; }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (motion && playing) {
      const d = duration(motion);
      if (t >= d) {
        if (loop) { hold += dt; if (hold >= LOOP_HOLD_S) { t = 0; hold = 0; } }
        else setPlaying(false);
      } else {
        t = Math.min(d, t + dt * speed);
      }
      showTime();
      dirty = true;
    }
    if (controls.update()) dirty = true;
    if (!world || !motion || !dirty) return;
    world.setTheme(themeOf(el));
    world.pose(motion, t);
    placeEnd(world, motion);
    renderer.render(world.scene, cam);
    dirty = false;
  };
  raf = requestAnimationFrame(frame);
  controls.addEventListener("change", () => { dirty = true; });

  const onClick = (e: MouseEvent): void => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (!b || !el.contains(b)) return;
    if (b.hasAttribute("data-rb-play")) {
      if (motion && !playing && t >= duration(motion)) t = 0;
      setPlaying(!playing);
    } else if (b.dataset.rbSpeed) {
      speed = Number(b.dataset.rbSpeed) || 1;
      for (const s of Array.from(el.querySelectorAll<HTMLElement>("[data-rb-speed]"))) s.setAttribute("aria-pressed", String(s === b));
    } else if (b.hasAttribute("data-rb-loop")) {
      loop = !loop;
      b.setAttribute("aria-pressed", String(loop));
    } else if (b.hasAttribute("data-rb-reset")) {
      cam.position.copy(CAMERA_AT);
      controls.target.copy(TARGET);
      controls.update();
      dirty = true;
    } else if (b.dataset.rbFile != null) {
      void select(Number(b.dataset.rbFile));
    }
  };
  const onSeek = (): void => {
    if (!motion) return;
    t = Math.max(0, Math.min(duration(motion), Number(seek.value)));
    hold = 0;
    dirty = true;
    showTime();
  };
  const onKey = (e: KeyboardEvent): void => {
    if ((e.target as Element).closest("button, input")) return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); setPlaying(!playing); }
    else if (motion && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      t = Math.max(0, Math.min(duration(motion), t + (e.key === "ArrowLeft" ? -1 : 1) / (motion.fps || 30)));
      setPlaying(false);
      dirty = true;
      showTime();
    }
  };
  el.addEventListener("click", onClick);
  seek.addEventListener("input", onSeek);
  stage.tabIndex = 0;
  stage.addEventListener("keydown", onKey);

  resize();
  void select(files.length - 1);
  if (files.length > 1) {
    fetchSummaries(batch, files).then((s) => {
      if (disposed) return;
      Object.assign(summaries, s);
      listEl.innerHTML = files.map((f, i) => fileButton(f, i, summaries[f] ?? null)).join("");
      for (const b of Array.from(listEl.children)) b.setAttribute("aria-selected", String(Number((b as HTMLElement).dataset.rbFile) === current));
    }).catch(() => undefined);
  }

  return {
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      window.removeEventListener("wheel", onPageWheel);
      el.removeEventListener("click", onClick);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** The player without WebGL: the message with the episode's result, and the picker to read the others' results. */
function mountPlayerWithoutGl(el: HTMLElement, batch: string, files: string[]): { dispose(): void } {
  let disposed = false;
  let current = files.length - 1;
  el.innerHTML = `<div class="rb-stage rb-stage--nogl" data-rb-nogl></div>`
    + `<div class="rb-files" role="listbox" aria-label="Motion files">${files.map((f, i) => fileButton(f, i, null)).join("")}</div>`;
  const box = el.querySelector<HTMLElement>("[data-rb-nogl]")!;
  const listEl = el.querySelector<HTMLElement>(".rb-files")!;
  const mark = (): void => {
    for (const b of Array.from(listEl.children)) b.setAttribute("aria-selected", String(Number((b as HTMLElement).dataset.rbFile) === current));
  };
  const show = (i: number): void => {
    current = i;
    mark();
    box.innerHTML = noWebglView(motionName(files[i]), null);
    fetchMotion(batch, files[i]).then((m) => {
      if (!disposed && current === i) box.innerHTML = noWebglView(motionName(files[i]), m.result);
    }).catch(() => undefined);
  };
  const onClick = (e: MouseEvent): void => {
    const b = (e.target as Element).closest<HTMLElement>("[data-rb-file]");
    if (b && el.contains(b)) show(Number(b.dataset.rbFile));
  };
  el.addEventListener("click", onClick);
  show(current);
  if (files.length > 1) {
    fetchSummaries(batch, files).then((s) => {
      if (disposed) return;
      listEl.innerHTML = files.map((f, i) => fileButton(f, i, s[f] ?? null)).join("");
      mark();
    }).catch(() => undefined);
  }
  return { dispose(): void { disposed = true; el.removeEventListener("click", onClick); } };
}

function fileButton(path: string, i: number, s: MotionSummary | null): string {
  const tone = s?.error ? "none" : resultTone(s?.result);
  const meta = s && !s.error
    ? [s.can_start ? `can ${xy(s.can_start)}` : "", resultText(s.result)].filter(Boolean).join(" · ")
    : s?.error ? "can't be read" : "";
  return `<button type="button" class="rb-file" role="option" data-rb-file="${i}" aria-selected="false" title="${attr(path)}">`
    + `<span class="rb-dot rb-dot--${tone}" aria-hidden="true"></span>`
    + `<span class="rb-file-n">${esc(motionName(path))}</span>`
    + (meta ? `<span class="rb-file-m">${esc(meta)}</span>` : "")
    + `</button>`;
}

// ── thumbnails: one shared renderer ──────────────────────────────────────────

const THUMB_FPS = 24;

interface Thumb {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  motion: MotionData | null;
  visible: boolean;
  /** When it started looping (ms, performance.now()). */
  start: number;
}

class Thumbs {
  private renderer: THREE.WebGLRenderer | null = null;
  private world: World | null = null;
  private readonly cam = camera(THUMB_CAMERA_AT);
  private readonly items = new Set<Thumb>();
  private readonly io = new IntersectionObserver((es) => {
    for (const e of es) for (const th of this.items) if (th.el === e.target) th.visible = e.isIntersecting;
  }, { rootMargin: "120px" });
  private raf = 0;
  private last = 0;
  private readonly size = new THREE.Vector2();

  add(el: HTMLElement): { dispose(): void } {
    if (!webglAvailable()) return this.withoutGl(el);
    const canvas = document.createElement("canvas");
    canvas.className = "rb-thumb-c";
    el.prepend(canvas);
    const th: Thumb = { el, canvas, ctx: canvas.getContext("2d")!, motion: null, visible: false, start: 0 };
    this.items.add(th);
    this.io.observe(el);
    const batch = el.dataset.batch ?? "";
    const file = el.dataset.file ?? "";
    Promise.all([fetchScene(), fetchMotion(batch, file)]).then(([scene, m]) => {
      if (!this.items.has(th)) return;
      if (!this.world) this.world = new World(scene, true, true);
      th.motion = m;
      th.start = performance.now();
      el.classList.add("is-ready");
      const label = el.querySelector(".rb-thumb-l");
      const tone = resultTone(m.result);
      if (label) label.innerHTML = `<span class="rb-dot rb-dot--${tone}" aria-hidden="true"></span>${esc(motionName(file))}<span class="rb-thumb-r">${esc(resultText(m.result))}</span>`;
      this.run();
    }).catch(() => { el.classList.add("is-error"); });
    this.run();
    return {
      dispose: (): void => {
        this.items.delete(th);
        this.io.unobserve(el);
        if (!this.items.size) this.stop();
      },
    };
  }

  /** A thumbnail without WebGL: the message and its result line, and nothing to draw. */
  private withoutGl(el: HTMLElement): { dispose(): void } {
    let live = true;
    const file = el.dataset.file ?? "";
    el.classList.add("is-nogl");
    el.innerHTML = noWebglView(motionName(file), null);
    fetchMotion(el.dataset.batch ?? "", file).then((m) => { if (live) el.innerHTML = noWebglView(motionName(file), m.result); }).catch(() => undefined);
    return { dispose: (): void => { live = false; } };
  }

  /** WebGL turned out to be missing: every thumbnail becomes its stand-in, and the loop stops for good. */
  private fallBack(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const th of this.items) { th.canvas.remove(); this.io.unobserve(th.el); this.withoutGl(th.el); }
    this.items.clear();
  }

  private run(): void {
    if (!this.raf && webglAvailable()) this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Free the context when no thumbnail is on the page (a run page has its own).
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  private frame(now: number): void {
    this.raf = requestAnimationFrame((n) => this.frame(n));
    if (document.hidden || now - this.last < 1000 / THUMB_FPS || !this.world) return;
    this.last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const th of this.items) {
      if (!th.visible || !th.motion) continue;
      const w = Math.round(th.canvas.clientWidth * dpr), h = Math.round(th.canvas.clientHeight * dpr);
      if (!w || !h) continue;
      if (th.canvas.width !== w || th.canvas.height !== h) { th.canvas.width = w; th.canvas.height = h; }
      // One drawing buffer for thumbnails of every size (run tiles and the smaller fork children): grown to the
      // largest, each drawn into its bottom-left corner and copied from there, so it is never reallocated per frame.
      const r = this.renderer ?? this.makeRenderer();
      if (!r) { this.fallBack(); return; }
      const size = r.getSize(this.size);
      if (size.x < w || size.y < h) r.setSize(Math.max(w, size.x), Math.max(h, size.y), false);
      const bufH = r.getSize(this.size).y;
      r.setViewport(0, 0, w, h);
      r.setScissor(0, 0, w, h);
      r.setScissorTest(true);
      if (this.cam.aspect !== w / h) { this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
      const d = duration(th.motion);
      const loopS = d + LOOP_HOLD_S;
      const t = Math.min(d, (((now - th.start) / 1000) % loopS));
      this.world.setTheme(themeOf(th.el));
      this.world.pose(th.motion, t);
      r.render(this.world.scene, this.cam);
      th.ctx.drawImage(r.domElement, 0, bufH - h, w, h, 0, 0, w, h);
    }
  }

  private makeRenderer(): THREE.WebGLRenderer | null {
    const r = makeRenderer();
    r?.setPixelRatio(1);
    this.renderer = r;
    return r;
  }
}

let thumbs: Thumbs | null = null;
export function mountThumb(el: HTMLElement): { dispose(): void } {
  thumbs ??= new Thumbs();
  return thumbs.add(el);
}
