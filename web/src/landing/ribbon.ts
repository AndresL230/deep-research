// The hero's shape: one band of glass in a closed loop with a half twist in it, turning slowly behind the title,
// after the iridescent ribbon on the Lifemed site.
//
// The band is a solid: a rounded, flat cross-section swept along the loop, so it has faces, rims and thickness for
// light to pass through. Its material is physical glass: it transmits and refracts what is behind it, splits light
// at its edges (dispersion), carries a thin iridescent film and a clear coat, and is tinted a breath of lilac inside.
// What it reflects is a small studio built for it, a pale room with coloured light panels round it (pink, magenta,
// violet, blue and a touch of orange), which is where the saturated colour along its rims and folds comes from.
// As the hero scrolls away the loop tips back and rises with it.
//
// Like the other scenes it is loaded on demand, owns one canvas in `host`, draws only while that is on screen, and
// holds still when motion is not welcome.

import {
  BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, FrontSide, Group, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, NeutralToneMapping, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Scene,
  SphereGeometry, SRGBColorSpace, Vector3, WebGLRenderer, type Texture,
} from "three";
import { smooth } from "./ease";
import { loopWhileSeen, type SceneTone } from "./kit";

export interface RibbonOptions {
  tone: SceneTone;
  /** The element the page scrolls in, or null for the window: how far the hero has gone up tips the loop. */
  scroller: Element | null;
}

export interface Ribbon {
  dispose(): void;
}

/** The loop's centre line, at `t` from 0 to 2π: a ring that rises and falls twice on the way round. */
function centre(t: number, out: Vector3): Vector3 {
  return out.set(1.75 * Math.cos(t), 0.62 * Math.sin(2 * t), 1.05 * Math.sin(t));
}

/** Rings along the loop, points round each ring, the band's width and its thickness. */
const ALONG = 640;
const AROUND = 36;
const WIDTH = 0.86;
const THICK = 0.14;
/** How square the cross-section's corners are: 2 is an ellipse, higher is a flatter band with rounder rims. */
const SQUARE = 4.5;

/** The band as a closed solid. Each ring is a rounded, flat outline (a superellipse) turned half a turn on the way
 *  round, so the last ring meets the first the other way up: it is joined to it with its points shifted by half. */
function bandGeometry(): BufferGeometry {
  const positions = new Float32Array(ALONG * AROUND * 3);
  const p = new Vector3();
  const q = new Vector3();
  const tangent = new Vector3();
  const side = new Vector3();
  const lift = new Vector3();
  const across = new Vector3();
  const through = new Vector3();
  const up = new Vector3(0, 1, 0);
  const outline: [number, number][] = [];
  for (let k = 0; k < AROUND; k++) {
    const a = (k / AROUND) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    outline.push([
      (WIDTH / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / SQUARE),
      (THICK / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / SQUARE),
    ]);
  }
  let n = 0;
  for (let i = 0; i < ALONG; i++) {
    const t = (i / ALONG) * Math.PI * 2;
    centre(t, p);
    centre(t + 1e-3, q);
    tangent.subVectors(q, p).normalize();
    side.crossVectors(up, tangent).normalize();
    lift.crossVectors(tangent, side).normalize();
    // Half a turn on the way round.
    const a = t / 2 + 0.6;
    across.copy(lift).multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
    through.crossVectors(tangent, across).normalize();
    for (const [u, v] of outline) {
      positions[n++] = p.x + across.x * u + through.x * v;
      positions[n++] = p.y + across.y * u + through.y * v;
      positions[n++] = p.z + across.z * u + through.z * v;
    }
  }
  const index: number[] = [];
  const half = AROUND / 2;
  for (let i = 0; i < ALONG; i++) {
    const last = i === ALONG - 1;
    for (let k = 0; k < AROUND; k++) {
      const k2 = (k + 1) % AROUND;
      const a = i * AROUND + k;
      const b = i * AROUND + k2;
      // The next ring; after the last comes the first, half a turn round.
      const c = last ? (k + half) % AROUND : (i + 1) * AROUND + k;
      const d = last ? (k2 + half) % AROUND : (i + 1) * AROUND + k2;
      // Wound so each face looks outward.
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The studio the glass reflects: a pale room, and coloured light panels round the band. Colours past 1 are light
 *  brighter than white, which the tone mapping brings back. */
function studio(tone: SceneTone): Scene {
  const room = new Scene();
  const walls = new SphereGeometry(30, 48, 24);
  const top = new Color(tone === "dark" ? "#2a2440" : "#ffffff");
  const bottom = new Color(tone === "dark" ? "#120f1f" : "#ece4ff");
  const colors = new Float32Array(walls.attributes.position.count * 3);
  for (let i = 0; i < walls.attributes.position.count; i++) {
    const y = walls.attributes.position.getY(i) / 30;
    const c = bottom.clone().lerp(top, (y + 1) / 2);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  walls.setAttribute("color", new BufferAttribute(colors, 3));
  room.add(new Mesh(walls, new MeshBasicMaterial({ side: BackSide, vertexColors: true })));
  const panel = (color: string, strength: number, size: [number, number], at: [number, number, number]): void => {
    const m = new Mesh(new BoxGeometry(size[0], size[1], 0.1), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(strength) }));
    m.position.set(...at);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  // The key: a broad soft white over the band.
  panel("#ffffff", 2.2, [16, 5], [0, 12, 4]);
  // Magenta and pink to the right, violet behind, blue to the left, orange low in front: the reference's rims.
  panel("#ff3fd0", 3.2, [4, 14], [11, 1, 2]);
  panel("#ff8ad8", 2.4, [6, 3], [6, -6, 8]);
  panel("#7a4dff", 3.0, [14, 6], [0, 2, -12]);
  panel("#3f6dff", 3.4, [4, 12], [-11, 0, 3]);
  panel("#ff8a4a", 2.6, [3, 2.5], [-4, -7, 9]);
  panel("#bfe3ff", 1.8, [5, 5], [-6, 8, 9]);
  // Long thin strip lights all round, as in a product studio: a rounded rim at a glancing angle catches one of them
  // as a crisp, saturated line, which is what draws the band's two edges in the reference.
  const strips: [string, number, number][] = [["#ff3fd0", 4.5, 0], ["#4a74ff", 4.8, 1.2], ["#ff7ad9", 3.6, 2.3], ["#6a4dff", 4.2, 3.4], ["#ff3fd0", 4.2, 4.6], ["#3f8cff", 4.4, 5.6]];
  for (const [color, strength, angle] of strips) {
    for (const y of [-3.5, 0.5, 4.5]) panel(color, strength, [7, 0.55], [Math.cos(angle) * 10, y, Math.sin(angle) * 10]);
  }
  return room;
}

/** What the glass bends: a soft field of the reference's colours (pink, magenta, violet, blue, a little orange) on a
 *  pale ground. Only the glass ever shows it; everywhere else the page's own ground covers it. */
function colourField(tone: SceneTone): CanvasTexture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = tone === "dark" ? "#231d38" : "#fbf9ff";
  ctx.fillRect(0, 0, size, size);
  const blob = (x: number, y: number, r: number, color: string, alpha: number): void => {
    const g = ctx.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  };
  // Mostly clear: the colour sits in a few soft places, so the band's body stays pale and its colour gathers where
  // it bends the light most, at its rims and folds.
  // On white the colour has to carry the glass on its own, so it is a step stronger there.
  const k = tone === "dark" ? 1 : 1.35;
  blob(0.88, 0.26, 0.3, "#ff3fd0", 0.55 * k);
  blob(0.12, 0.66, 0.28, "#3f6dff", 0.5 * k);
  blob(0.52, 0.06, 0.26, "#8a5cff", 0.45 * k);
  blob(0.22, 0.94, 0.22, "#ff9a5c", 0.45 * k);
  blob(0.7, 0.86, 0.24, "#ff8fd6", 0.45 * k);
  blob(0.5, 0.5, 0.42, "#ffffff", 0.9);
  // Streaks across it, as the reference's glass shows: thin, soft, at a slant.
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 9; i++) {
    const x = (i / 9) * size;
    const g = ctx.createLinearGradient(x, 0, x + size * 0.06, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, i % 3 === 0 ? "#ff6be0" : i % 3 === 1 ? "#6f8dff" : "#ffffff");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-0.35);
    ctx.translate(-size / 2, -size / 2);
    ctx.fillRect(x, -size * 0.2, size * 0.06, size * 1.4);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function mountRibbon(host: HTMLElement, options: RibbonOptions): Ribbon {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch {
    return { dispose() { /* no WebGL: the title stands on the plain ground */ } };
  }
  renderer.outputColorSpace = SRGBColorSpace;
  // Neutral tone mapping keeps white white (what the band lets through is the white page) and only folds the
  // bright light panels back into range.
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  // What the glass refracts is a soft colour field: drawing it at half size each frame looks the same, at a quarter
  // of the pixels.
  renderer.transmissionResolutionScale = 0.5;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  // The ground behind the glass is the page's own, so what the band lets through and bends is the page.
  const ground = new Color(options.tone === "dark" ? "#15171b" : "#ffffff");
  const scene = new Scene();
  // The glass bends the colour field (three.js refracts what is drawn before the glass: the background). A plane
  // of the page's own ground stands behind the band and covers the field everywhere else: it is see-through as far
  // as three.js is concerned, so the glass's refraction pass never draws it, and it is drawn after the glass, so the
  // depth test keeps it off the band.
  const field = colourField(options.tone);
  scene.background = field;
  const coverMaterial = new MeshBasicMaterial({ color: ground, transparent: true, opacity: 1, toneMapped: false, depthWrite: false });
  const cover = new Mesh(new PlaneGeometry(400, 400), coverMaterial);
  cover.position.z = -9;
  scene.add(cover);

  const pmrem = new PMREMGenerator(renderer);
  const room = studio(options.tone);
  const environment: Texture = pmrem.fromScene(room, 0.035).texture;
  scene.environment = environment;

  const material = new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.05,
    transmission: 1,
    thickness: 1.4,
    ior: 1.5,
    // No dispersion or iridescence: dispersion samples the refraction three times a pixel and iridescence adds a
    // thin-film pass, together most of what made the hero crawl, for a rainbow edge hardly anyone sees.
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    specularIntensity: 1,
    attenuationColor: new Color(options.tone === "dark" ? "#d6c6ff" : "#f6f2ff"),
    attenuationDistance: 2.5,
    envMapIntensity: options.tone === "dark" ? 2.1 : 2.6,
    side: FrontSide,
  });
  const geometry = bandGeometry();
  const band = new Mesh(geometry, material);
  const spin = new Group();
  spin.add(band);
  const tilt = new Group();
  tilt.add(spin);
  scene.add(tilt);
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);

  let width = 0;
  let height = 0;
  const resize = (): void => {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    // The band fills the whole hero: past 1.5x the extra pixels cost more than they show.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Wide enough to fill most of the hero's width, never so near that it leaves the top and bottom.
    // On a narrow screen it runs off both sides rather than shrinking to a small thing in the middle.
    camera.position.set(0, 0, Math.min(13, Math.max(7, 11.6 / camera.aspect)));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    loop.redraw();
  };

  /** How far the hero has gone up out of the screen, 0 to 1. */
  const scrolled = (): number => {
    const box = host.getBoundingClientRect();
    const portTop = options.scroller ? options.scroller.getBoundingClientRect().top : 0;
    return Math.min(1, Math.max(0, (portTop - box.top) / Math.max(1, box.height)));
  };

  let time = 0;
  let lift = 0;
  const frame = (seconds: number, still: boolean): void => {
    if (!width || !height) return;
    time += seconds;
    const want = scrolled();
    lift = still ? want : lift + (want - lift) * (1 - Math.exp(-seconds * 6));
    // It comes in from a little nearer and settles, then turns slowly for ever.
    const arrive = still ? 1 : smooth(Math.min(1, time / 2.4));
    spin.rotation.y = 0.55 + time * 0.11;
    spin.scale.setScalar(1.18 - 0.18 * arrive);
    tilt.rotation.set(0.42 + lift * 0.55, 0, -0.16 + lift * 0.1);
    tilt.position.y = -0.3 + lift * 1.6;
    renderer.render(scene, camera);
  };
  const loop = loopWhileSeen(host, frame);
  const sizes = new ResizeObserver(resize);
  sizes.observe(host);
  const onScroll = (): void => loop.redraw();
  const scrollTarget: EventTarget = options.scroller ?? window;
  scrollTarget.addEventListener("scroll", onScroll, { passive: true });
  resize();
  host.dataset.ready = "1";

  return {
    dispose() {
      loop.dispose();
      sizes.disconnect();
      scrollTarget.removeEventListener("scroll", onScroll);
      geometry.dispose();
      material.dispose();
      field.dispose();
      cover.geometry.dispose();
      coverMaterial.dispose();
      environment.dispose();
      pmrem.dispose();
      room.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
      });
      renderer.dispose();
      canvas.remove();
      delete host.dataset.ready;
    },
  };
}
