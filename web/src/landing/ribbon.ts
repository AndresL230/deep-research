// The hero's shape: one long band in a closed loop with a half twist in it, turning slowly behind the title.
//
// It is painted, not lit: the band is pale where it faces the camera and takes the purple gradient (pink, violet,
// blue, running along its length and slowly round it) where it turns away and along its two edges. Nothing is glass
// and nothing refracts. As the hero scrolls away the loop tips back and rises with it.
//
// Like the other scenes it is loaded on demand, owns one canvas in `host`, draws only while that is on screen,
// and holds still when motion is not welcome.

import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector3,
  WebGLRenderer,
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

/** Points along the loop, points across the band, and the band's half width. */
const ALONG = 420;
const ACROSS = 10;
const HALF = 0.42;

function bandGeometry(): BufferGeometry {
  const count = (ALONG + 1) * (ACROSS + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const p = new Vector3();
  const q = new Vector3();
  const tangent = new Vector3();
  const side = new Vector3();
  const lift = new Vector3();
  const up = new Vector3(0, 1, 0);
  let k = 0;
  for (let i = 0; i <= ALONG; i++) {
    const u = i / ALONG;
    const t = u * Math.PI * 2;
    centre(t, p);
    centre(t + 1e-3, q);
    tangent.subVectors(q, p).normalize();
    side.crossVectors(up, tangent).normalize();
    lift.crossVectors(tangent, side).normalize();
    // Half a turn on the way round, so the band comes back to itself the other way up.
    const a = t / 2 + 0.6;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let j = 0; j <= ACROSS; j++) {
      const v = (j / ACROSS) * 2 - 1;
      const s = v * HALF;
      positions[k * 3] = p.x + (lift.x * ca + side.x * sa) * s;
      positions[k * 3 + 1] = p.y + (lift.y * ca + side.y * sa) * s;
      positions[k * 3 + 2] = p.z + (lift.z * ca + side.z * sa) * s;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
      k++;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < ALONG; i++) {
    for (let j = 0; j < ACROSS; j++) {
      const a = i * (ACROSS + 1) + j;
      const b = a + ACROSS + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setAttribute("uv", new BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying vec2 vUv;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - world.xyz);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uDark;
uniform vec3 uPink;
uniform vec3 uViolet;
uniform vec3 uBlue;
uniform vec3 uFace;
varying vec3 vNormal;
varying vec3 vView;
varying vec2 vUv;

// The gradient along the band: pink, violet, blue and back, drifting slowly round.
vec3 hue(float x) {
  float f = fract(x) * 3.0;
  if (f < 1.0) return mix(uPink, uViolet, smoothstep(0.0, 1.0, f));
  if (f < 2.0) return mix(uViolet, uBlue, smoothstep(0.0, 1.0, f - 1.0));
  return mix(uBlue, uPink, smoothstep(0.0, 1.0, f - 2.0));
}

void main() {
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float turn = pow(1.0 - facing, 1.5);
  float edge = smoothstep(0.7, 1.0, abs(vUv.y));
  // A soft sheen that runs along the band, so the pale face is never flat.
  float sheen = 0.5 + 0.5 * sin(vUv.x * 18.0 + vUv.y * 2.4 - uTime * 0.6);
  vec3 tint = hue(vUv.x * 2.0 + vUv.y * 0.08 + uTime * 0.018);
  float amount = clamp(turn * 1.15 + edge * 0.9 + sheen * 0.08, 0.0, 1.0);
  vec3 color = mix(uFace, tint, amount);
  float alpha = clamp(mix(0.32, 0.18, uDark) + turn * 0.7 + edge * 0.55, 0.0, 0.97);
  gl_FragColor = vec4(color, alpha);
}`;

/** The two palettes: the band's face, and the three colours of its gradient. */
const INKS: Record<SceneTone, { face: [number, number, number]; pink: [number, number, number]; violet: [number, number, number]; blue: [number, number, number] }> = {
  light: { face: [0.975, 0.965, 1.0], pink: [0.93, 0.5, 0.96], violet: [0.56, 0.42, 0.95], blue: [0.42, 0.56, 0.98] },
  dark: { face: [0.2, 0.17, 0.32], pink: [0.95, 0.52, 0.98], violet: [0.66, 0.5, 1.0], blue: [0.5, 0.64, 1.0] },
};

export function mountRibbon(host: HTMLElement, options: RibbonOptions): Ribbon {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return { dispose() { /* no WebGL: the title stands on the plain ground */ } };
  }
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const ink = INKS[options.tone];
  const uniforms = {
    uTime: { value: 0 },
    uDark: { value: options.tone === "dark" ? 1 : 0 },
    uFace: { value: new Vector3(...ink.face) },
    uPink: { value: new Vector3(...ink.pink) },
    uViolet: { value: new Vector3(...ink.violet) },
    uBlue: { value: new Vector3(...ink.blue) },
  };
  const material = new ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, side: DoubleSide, transparent: true, depthWrite: false,
  });
  const geometry = bandGeometry();
  const band = new Mesh(geometry, material);
  const spin = new Group();
  spin.add(band);
  const tilt = new Group();
  tilt.add(spin);
  const scene = new Scene();
  scene.add(tilt);
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);

  let width = 0;
  let height = 0;
  const resize = (): void => {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Wide enough to fill most of the hero's width, never so near that it leaves the top and bottom.
    // On a narrow screen it runs off both sides rather than shrinking to a small thing in the middle.
    camera.position.set(0, 0, Math.min(12, Math.max(6.2, 10.4 / camera.aspect)));
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
    tilt.position.y = 0.15 + lift * 1.4;
    uniforms.uTime.value = time;
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
      renderer.dispose();
      canvas.remove();
      delete host.dataset.ready;
    },
  };
}
