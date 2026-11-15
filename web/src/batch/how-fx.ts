// The moving recap on the tour's last stop (how.ts draws the canvas; this runs it). Particles, each one a thing the
// batch really had: every agent is a dot that crosses the stage from the left. Before the "Measure" line a dot wears
// the claim's colour; past it, the colour of what was measured (inflated, honest, or neither), and an inflated dot
// sheds sparks in proportion to how far its claim sat above the truth. At the "Fork" line the one run that was copied
// splits into its pairs: one copy left alone, one changed, each in the colour it came out. The other dots fade there.
//
// It is decoration over the two buttons, hidden from assistive technology, and it never carries a number the page
// does not say in words. Colours are read from the theme's tokens. With reduced motion it is one still frame.
//
// DOM only. Called after every paint, like tour.ts: it starts when the canvas appears, keeps running while the page
// repaints around it, measures again when the stage changes size, and stops when the canvas leaves the page.

interface FxData { runs: string; gaps: number[]; follow: number; pairs: [number, number][] }

const TOKENS = { claim: "--pu-hi", bad: "--bad", ok: "--ok", dim: "--fg-40", line: "--border-strong", text: "--fg-55" } as const;
type Palette = Record<keyof typeof TOKENS, string>;

/** Where the two lines stand, as shares of the stage's width. */
const GATE_MEASURE = 0.34;
const GATE_FORK = 0.66;
/** A dot's tail, in past positions: about three quarters of a second of them. */
const TAIL = 44;

interface Agent { i: number; x: number; lane: number; speed: number; phase: number; st: string; gap: number; tail: number[]; gone: boolean }
interface Copy { x: number; y: number; to: number; bad: boolean; pair: number; speed: number; tail: number[] }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }
interface Dust { x: number; y: number; speed: number; r: number }

interface Running { canvas: HTMLCanvasElement; key: string; measure(): void; stop(): void }
let running: Running | null = null;

/** A small seeded generator, so the dots take the same lanes every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parse(raw: string): FxData {
  try {
    const d = JSON.parse(raw) as Partial<FxData>;
    if (typeof d.runs === "string" && d.runs.length) {
      return { runs: d.runs, gaps: Array.isArray(d.gaps) ? d.gaps : [], follow: typeof d.follow === "number" ? d.follow : -1, pairs: Array.isArray(d.pairs) ? d.pairs : [] };
    }
  } catch { /* no case yet: only the dust is drawn */ }
  return { runs: "", gaps: [], follow: -1, pairs: [] };
}

/** Start, keep or stop the recap for the stage inside `root`. */
export function syncHowFx(root: ParentNode): void {
  const host = root.querySelector<HTMLElement>("[data-how-fx]");
  const canvas = host?.querySelector("canvas") ?? null;
  if (!host || !canvas) { running?.stop(); running = null; return; }
  const key = host.dataset.fx ?? "";
  if (running && running.canvas === canvas && running.key === key) { running.measure(); return; }
  running?.stop();
  running = start(host, canvas, key);
}

function start(host: HTMLElement, canvas: HTMLCanvasElement, key: string): Running | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const data = parse(key);
  const rand = seeded(7);
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let W = 0, H = 0, top = 0, bottom = 0;
  let pal: Palette = { claim: "#b07af2", bad: "#e2536a", ok: "#4ec08a", dim: "#999", line: "#888", text: "#888" };
  let font = "12px sans-serif";
  let agents: Agent[] = [];
  let copies: Copy[] = [];
  let sparks: Spark[] = [];
  let dust: Dust[] = [];
  let raf = 0, last = 0, frames = 0, t = 0, stopped = false;

  /** The theme's colours as the browser resolves them, through the canvas's own `color`. */
  function readPalette(): void {
    const cs = getComputedStyle(canvas);
    const next = { ...pal };
    for (const k of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      canvas.style.color = `var(${TOKENS[k]})`;
      const v = cs.color;
      if (v) next[k] = v;
    }
    canvas.style.color = "";
    pal = next;
    font = `500 12px ${getComputedStyle(host).fontFamily || "sans-serif"}`;
  }

  const laneY = (lane: number): number => top + 22 + lane * Math.max(0, bottom - top - 34);

  function seed(): void {
    const n = data.runs.length;
    agents = Array.from({ length: n }, (_, i): Agent => ({
      i, x: -24 + ((i * 0.618 + rand() * 0.2) % 1) * (W + 48), lane: n > 1 ? (i + (rand() - 0.5) * 0.5) / (n - 1) : 0.5,
      speed: 34 + rand() * 20, phase: rand() * 6.28, st: data.runs[i], gap: Math.max(0, data.gaps[i] ?? 0), tail: [], gone: false,
    }));
    for (const a of agents) a.lane = Math.max(0, Math.min(1, a.lane));
    copies = [];
    sparks = [];
    dust = Array.from({ length: 34 }, (): Dust => ({ x: rand() * W, y: top + rand() * Math.max(1, bottom - top), speed: 6 + rand() * 10, r: 0.6 + rand() * 0.9 }));
    // The copied run starts before the fork line, so the first split is seen soon and not skipped.
    const f = agents[data.follow];
    if (f) f.x = W * (GATE_FORK - 0.16);
  }

  /** The canvas takes the stage's size; the band the dots cross is what is left under the buttons and the bubble. */
  function measure(): void {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resized = w !== W || h !== H;
    if (resized) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const stage = host.closest<HTMLElement>("[data-how-stage]");
    const box = host.getBoundingClientRect();
    let under = 0;
    for (const el of stage?.querySelectorAll<HTMLElement>(".hw-pic, [data-how-tip]") ?? []) under = Math.max(under, el.getBoundingClientRect().bottom - box.top);
    const t0 = Math.round(under + 40), b0 = h - 18;
    const [nt, nb] = b0 - t0 >= 70 ? [t0, b0] : [18, b0];
    const moved = Math.abs(nt - top) > 2 || Math.abs(nb - bottom) > 2;
    W = w; H = h; top = nt; bottom = nb;
    if (resized || moved || !agents.length) { readPalette(); seed(); if (still) drawStill(); }
  }

  function splitInto(a: Agent, y: number): void {
    const n = data.pairs.length;
    if (!n) return;
    const room = bottom - top - 34;
    const gap = Math.min(34, room / Math.max(1, n));
    const mid = top + 22 + room / 2;
    data.pairs.forEach(([base, changed], k) => {
      const at = mid + (k - (n - 1) / 2) * gap;
      copies.push({ x: a.x, y, to: at - 5.5, bad: !!base, pair: k, speed: a.speed + 6, tail: [] });
      copies.push({ x: a.x, y, to: at + 5.5, bad: !!changed, pair: k, speed: a.speed + 6, tail: [] });
    });
  }

  function step(dt: number): void {
    t += dt;
    const xm = W * GATE_MEASURE, xf = W * GATE_FORK;
    for (const d of dust) { d.x += d.speed * dt; if (d.x > W + 4) { d.x = -4; d.y = top + rand() * Math.max(1, bottom - top); } }
    for (const a of agents) {
      const before = a.x;
      a.x += a.speed * dt;
      const y = laneY(a.lane) + Math.sin(t * 0.7 + a.phase) * 5;
      if (!a.gone) { a.tail.push(a.x, y); if (a.tail.length > TAIL * 2) a.tail.splice(0, 2); }
      if (before < xm && a.x >= xm && a.st === "i") {
        const n = Math.max(3, Math.min(12, Math.round(a.gap * 28)));
        for (let k = 0; k < n; k++) sparks.push({ x: xm, y, vx: 14 + rand() * 46, vy: -50 + rand() * 70, life: 0.5 + rand() * 0.5 });
      }
      if (!a.gone && a.i === data.follow && before < xf && a.x >= xf && data.pairs.length) { a.gone = true; a.tail = []; splitInto(a, y); }
      if (a.x > W + 24) { a.x = -24 - rand() * 60; a.gone = false; a.tail = []; }
    }
    for (const c of copies) {
      c.x += c.speed * dt;
      c.y += (c.to - c.y) * Math.min(1, dt * 3.2);
      c.tail.push(c.x, c.y); if (c.tail.length > TAIL * 2) c.tail.splice(0, 2);
    }
    copies = copies.filter((c) => c.x < W + 24);
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 90 * dt; s.life -= dt; }
    sparks = sparks.filter((s) => s.life > 0);
  }

  function dot(x: number, y: number, r: number, color: string, alpha: number, tail: number[]): void {
    ctx!.strokeStyle = color;
    ctx!.lineCap = "round";
    for (let k = 2; k < tail.length; k += 2) {
      ctx!.globalAlpha = alpha * 0.42 * (k / tail.length);
      ctx!.lineWidth = r * 1.5 * (k / tail.length);
      ctx!.beginPath(); ctx!.moveTo(tail[k - 2], tail[k - 1]); ctx!.lineTo(tail[k], tail[k + 1]); ctx!.stroke();
    }
    ctx!.globalAlpha = alpha;
    ctx!.fillStyle = color;
    ctx!.beginPath(); ctx!.arc(x, y, r, 0, 6.2832); ctx!.fill();
  }

  function draw(): void {
    const c = ctx!;
    c.clearRect(0, 0, W, H);
    const xm = Math.round(W * GATE_MEASURE) + 0.5, xf = Math.round(W * GATE_FORK) + 0.5;
    for (const d of dust) { c.globalAlpha = 0.4; c.fillStyle = pal.dim; c.beginPath(); c.arc(d.x, d.y, d.r, 0, 6.2832); c.fill(); }
    if (agents.length) {
      c.globalAlpha = 1; c.strokeStyle = pal.line; c.lineWidth = 1; c.setLineDash([3, 4]);
      for (const x of [xm, xf]) { c.beginPath(); c.moveTo(x, top + 6); c.lineTo(x, bottom); c.stroke(); }
      c.setLineDash([]);
      c.fillStyle = pal.text; c.font = font; c.textBaseline = "alphabetic";
      c.fillText("Run", 16, top);
      c.fillText("Measure", xm + 8, top);
      if (data.pairs.length) c.fillText("Fork", xf + 8, top);
    }
    for (const a of agents) {
      if (a.gone) continue;
      const y = a.tail.length ? a.tail[a.tail.length - 1] : laneY(a.lane);
      const measured = a.x >= xm;
      const color = !measured ? pal.claim : a.st === "i" ? pal.bad : a.st === "h" ? pal.ok : pal.dim;
      // Past the fork line only the copied run matters: the rest fade out.
      const fade = data.pairs.length && a.x > xf ? Math.max(0.14, 1 - (a.x - xf) / 90) : 1;
      const lead = a.i === data.follow;
      dot(a.x, y, lead ? 5.4 : 4.2, color, (a.st === "f" && measured ? 0.4 : 0.95) * fade, a.tail);
      if (lead && a.x < xf) { c.globalAlpha = 0.5; c.strokeStyle = color; c.lineWidth = 1; c.beginPath(); c.arc(a.x, y, 9.5, 0, 6.2832); c.stroke(); }
    }
    // Each pair's two copies are joined, so they read as a pair.
    for (let k = 0; k + 1 < copies.length; k += 2) {
      const a = copies[k], b = copies[k + 1];
      if (a.pair !== b.pair) continue;
      c.globalAlpha = 0.5; c.strokeStyle = pal.line; c.lineWidth = 1;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    for (const k of copies) dot(k.x, k.y, 3.4, k.bad ? pal.bad : pal.ok, 0.95, k.tail);
    for (const s of sparks) { c.globalAlpha = Math.max(0, Math.min(1, s.life * 1.6)); c.fillStyle = pal.bad; c.beginPath(); c.arc(s.x, s.y, 1.6, 0, 6.2832); c.fill(); }
    c.globalAlpha = 1;
  }

  /** Reduced motion: the same scene a little way in, drawn once. */
  function drawStill(): void {
    for (let k = 0; k < 220; k++) step(1 / 30);
    draw();
  }

  function frame(now: number): void {
    if (stopped) return;
    if (!canvas.isConnected) { stop(); return; }
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (W && H && !document.hidden) {
      if (++frames % 90 === 0) readPalette();
      step(dt);
      draw();
    }
    raf = requestAnimationFrame(frame);
  }

  function stop(): void {
    stopped = true;
    cancelAnimationFrame(raf);
    if (running && running.canvas === canvas) running = null;
  }

  measure();
  if (!still) raf = requestAnimationFrame(frame);
  return { canvas, key, measure, stop };
}
