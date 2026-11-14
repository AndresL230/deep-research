// The two devices in the section under the hero, one for each item of the list beside them. Only one shows at a
// time, and `show()` swaps them.
//
//   0  the terminal: a small screen on a stand that plays one batch from the first command to the verdict
//      (terminal.ts), with a light for each stage, keys to tell it from the command line or over the API, and a
//      ticket that prints at the end.
//   1  the data bench: what happens to a table before any agent sees it (bench.ts). A holdout slides into a sealed
//      drawer, a scanner plants duplicate rows in what is left, and a sheet of glass behind says what was done.
//
// Like scene.ts this is loaded on demand and owns one canvas in `host`. Both devices are built lying on their
// backs, out of the same swept outlines as the hero's pads (shapes.ts); the terminal's is then stood up.

import { CircleGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene, Vector2, type Object3D } from "three";
import { BENCH_LOOP, HELD, ROWS, SHEET, TWINS, benchAt, benchDone, type BenchView } from "./bench";
import { easeOutCubic } from "./ease";
import { CODE_FONT, LABEL_FONT, createKit, join, loopWhileSeen, type Loop, type SceneTone } from "./kit";
import { PX, SCREEN, SHEET_SIZE, TICKET, paintCaption, paintSheet, paintTerminal, paintTicket } from "./screens";
import { band, circle, loop, prism, roundedRect } from "./shapes";
import { SCRIPTS, STAGES, TERMINAL_HOLD, scriptSeconds, terminalAt, type Light, type Mode, type TerminalView } from "./terminal";

export interface DevicesOptions {
  /** Which palette to draw in. */
  tone: SceneTone;
  /** Which device shows first. */
  shown: number;
}

export interface Devices {
  /** Swap to device `index`, and start it from the beginning. */
  show(index: number): void;
  dispose(): void;
}

const FOV = 18;
/** How far a casing's edges are rounded. */
const EDGE = 0.022;
/** The canvas is drawn for this shape (width over height); a narrower one zooms out to keep the device whole. */
const FRAME = 576 / 526;
const FONTS = { label: LABEL_FONT, code: CODE_FONT };
/** How long the canvas takes to fade out, and back in, when the device is swapped. */
const SWAP_MS = 170;

/** Mount the devices in `host` and start the one that shows. `host` gets `data-ready` once it has drawn, and
 *  `data-swap` while one device is fading out for the other. */
export function mountDevices(host: HTMLElement, options: DevicesOptions): Devices {
  const kit = createKit(host, options.tone);
  if (!kit) return { show() { /* no WebGL: the list beside it still reads */ }, dispose() { /* nothing was made */ } };
  const { renderer, canvas, ink, keep, own, matte, gloss, stroke, solid, strokes, brow, flat, blob } = kit;

  const scene = new Scene();
  kit.lights(scene, [-3, 6, 9]);
  const ground = kit.floor(scene, 0.64, [1, 2.4, 9]);

  const casing = gloss(ink.casing);
  const seat = matte(ink.ledSeat);
  const plate = matte(ink.keyPlate);
  const L = { casing: stroke(ink.padLine, 1), fine: stroke(ink.screenLine, 1), glass: stroke(ink.glassLine, 1) };
  const at = <T extends Object3D>(o: T, x: number, y: number, z: number): T => { o.position.set(x, y, z); return o; };

  // Words are painted in the page's type, which may not have loaded yet: these paint them again once it has.
  const repaint: (() => void)[] = [];

  /** Words lying on a face: painted white, and tinted by the material's colour. */
  const caption = (text: string, width: number, size: number, tint: string): { mesh: Mesh; material: MeshBasicMaterial } => {
    const height = size * 2.2;
    const s = kit.surface(width * PX, height * PX);
    const paint = (): void => {
      paintCaption(s.ctx, s.canvas.width, s.canvas.height, text, size * PX, LABEL_FONT);
      s.texture.needsUpdate = true;
    };
    paint();
    repaint.push(paint);
    const material = keep(new MeshBasicMaterial({ map: s.texture, transparent: true, depthWrite: false, color: tint }));
    const mesh = new Mesh(flat, material);
    mesh.scale.set(width, 1, height);
    return { mesh, material };
  };

  /** A small light with its caption under it. */
  interface Lamp { set(state: Light, seconds: number): void }
  const round = own(new CircleGeometry(1, 40).rotateX(-Math.PI / 2));
  const lamp = (parent: Group, x: number, y: number, z: number, text: string): Lamp => {
    const g = at(new Group(), x, y, z);
    const glass = gloss(ink.led, 0x6a6a6a, 30);
    const glow = keep(new MeshBasicMaterial({ color: ink.halo, transparent: true, opacity: 0, depthWrite: false }));
    const halo = at(new Mesh(round, glow), 0, 0.001, 0);
    halo.scale.setScalar(0.115);
    const words = caption(text, 0.62, 0.085, ink.caption);
    g.add(halo, solid(prism(circle(0.052, 28), 0.006), seat), at(solid(prism(circle(0.04, 28), 0.02, 0.012), glass), 0, 0.006, 0), at(words.mesh, 0, 0.002, 0.19));
    parent.add(g);
    return {
      set(state, seconds) {
        glass.color.setHex(state === "off" ? ink.led : ink.ledLit);
        glow.opacity = state === "on" ? 0.2 + 0.07 * Math.sin(seconds * 7) : 0;
        words.material.color.set(state === "off" ? ink.caption : ink.captionLit);
      },
    };
  };

  /** A key in its plate. `set` says whether it is the one that is on, and how far it is pressed right now. */
  interface Key { cap: Mesh; set(on: boolean, press: number): void }
  const key = (parent: Group, x: number, y: number, z: number, text: string): Key => {
    const capO = roundedRect(0.23, 0.15, 0.06, 6);
    const face = gloss(ink.key);
    const cap = at(solid(prism(capO, 0.112, 0.016), face), 0, 0.012, 0);
    const words = caption(text, 0.42, 0.085, ink.keyInk);
    cap.add(strokes(join(brow(capO, 0.112, 0.016), loop(capO, 0.014)), L.casing), at(words.mesh, 0, 0.114, 0));
    parent.add(at(new Group().add(solid(prism(roundedRect(0.27, 0.19, 0.07, 6), 0.024), plate), cap), x, y, z));
    return {
      cap,
      set(on, press) {
        face.color.setHex(on ? ink.keyOn : ink.key);
        words.material.color.set(on ? ink.keyOnInk : ink.keyInk);
        cap.scale.y = 1 - 0.125 * Math.max(on ? 1 : 0, press);
      },
    };
  };

  // ── the terminal ───────────────────────────────────────────────────────────

  const tv = at(new Group(), 0.297, 0, 0);
  tv.scale.setScalar(1.11);
  tv.add(at(blob(7.6, 0.002, 5.2, 1.6), 0, 0.002, -0.17), at(blob(6.2, 0.004, 1.6, 2), 0, 0.004, 0.85));
  const tvTurned = new Group();
  tvTurned.rotation.y = -0.14;
  tv.add(tvTurned);

  const standO = roundedRect(2.4, 0.55, 0.16);
  const stand = at(solid(prism(standO, 0.46, EDGE), casing), 0, 0, -0.49);
  stand.add(strokes(join(brow(standO, 0.46, EDGE), loop(standO, 0.006)), L.casing));
  // The head leans back a little on its stand. Its front is built lying face up, then stood on its lower edge.
  const head = at(new Group(), 0, 0.46, 0);
  head.rotation.x = -0.105;
  const front = at(new Group(), 0, 2.1, -0.34);
  front.rotation.x = Math.PI / 2;
  tvTurned.add(stand, head.add(front));

  /** How thick the head is: everything on its front sits at this height while it lies face up. */
  const F = 0.34;
  const headO = roundedRect(2.7, 2.1, 0.44, 16);
  const headBody = solid(prism(headO, F, 0.03), casing);
  headBody.add(strokes(join(loop(headO, F, 0.03), loop(headO, 0.02)), L.casing));
  const screen = kit.surface(SCREEN.width * PX, SCREEN.height * PX);
  const screenMesh = at(new Mesh(flat, keep(new MeshBasicMaterial({ map: screen.texture, transparent: true }))), 0, F + 0.002, -0.34);
  screenMesh.scale.set(SCREEN.width, 1, SCREEN.height);
  const screenEdge = at(strokes(loop(roundedRect(SCREEN.width / 2, SCREEN.height / 2, SCREEN.corner, 8), F + 0.003), L.fine), 0, 0, -0.34);
  const slot = at(new Mesh(flat, keep(new MeshBasicMaterial({ color: ink.slot }))), 0, F + 0.001, 1.98);
  slot.scale.set(1.66, 1, 0.045);
  front.add(headBody, screenMesh, screenEdge, slot);
  const lamps = STAGES.map((name, k) => lamp(front, -2.28 + 0.54 * k, F, 1.5, name));
  const keys = (["CLI", "API", "↻"] as const).map((text, k) => key(front, 1.13 + 0.54 * k, F, 1.55, text));

  // The ticket slides out of the slot, down and toward the viewer.
  const chute = at(new Group(), 0, 0.12, 0);
  chute.rotation.x = 0.723;
  const paperO = roundedRect(TICKET.width / 2, TICKET.height / 2, 0.07, 6);
  const paper = solid(prism(paperO, 0.006), matte(ink.paper));
  const print = kit.surface(TICKET.width * PX, TICKET.height * PX);
  const printMesh = at(new Mesh(flat, keep(new MeshBasicMaterial({ map: print.texture, transparent: true, depthWrite: false }))), 0, 0.008, 0);
  printMesh.scale.set(TICKET.width, 1, TICKET.height);
  paper.add(strokes(loop(paperO, 0.007), L.fine), printMesh);
  head.add(chute.add(paper));

  // ── the data bench ─────────────────────────────────────────────────────────

  const bench = new Group();
  bench.add(blob(8, 0.002, 5.6, 1.25), at(blob(6.6, 0.004, 2, 1.4), 0, 0.004, 1.75));
  const benchTurned = new Group();
  benchTurned.rotation.y = -0.244;
  bench.add(benchTurned);

  /** The slab's top: everything on the bench stands on it. */
  const T = 0.34;
  /** The tray's middle, and where row `i` lies in it. */
  const TRAY = -0.62;
  const rowZ = (i: number): number => -0.95 + i * 0.2;
  const swept = ROWS - HELD.length;
  const held = HELD as readonly number[];

  /** The drawer the held rows slide into: where its lid is, how tall, and how far the rows travel to be under it.
   *  The lid is low so that it does not hide the rows waiting behind it. */
  const DRAWER = { z: 1.33, depth: 0.27, height: 0.14, slide: 0.6 };

  const slabO = roundedRect(2.6, 1.7, 0.36, 14);
  const slab = solid(prism(slabO, T, EDGE), casing);
  slab.add(strokes(join(brow(slabO, T, EDGE), loop(slabO, 0.006)), L.casing));
  // The tray runs from behind the first row to the drawer's lid.
  const trayBack = rowZ(0) - 0.16;
  const trayFront = DRAWER.z - DRAWER.depth;
  const trayEdge = at(solid(band(roundedRect(1.5, (trayFront - trayBack) / 2, 0.1, 6), 0.016, 0.008), matte(ink.screenLine)), TRAY, T, (trayFront + trayBack) / 2);
  benchTurned.add(slab, trayEdge);

  // The rows of the table: plain, or held out. They share one shape.
  const rowO = roundedRect(1.3, 0.07, 0.035, 4);
  const rowShape = solid(prism(rowO, 0.035, 0.008), matte(ink.row));
  const heldRow = matte(ink.held);
  const twinRow = matte(ink.twin);
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const m = at(new Mesh(rowShape.geometry, held.includes(i) ? heldRow : rowShape.material), TRAY, T, rowZ(i));
    benchTurned.add(m);
    return m;
  });
  // A planted duplicate lies on top of its row, a little off it, so it reads as a second copy.
  const twins = TWINS.map((row) => {
    const m = at(new Mesh(rowShape.geometry, twinRow), TRAY + 0.09, T + 0.037, rowZ(row) + 0.034);
    benchTurned.add(m);
    return m;
  });

  // The scanner: a bar on two posts that crosses the rows, with a line of light under it.
  const gantry = new Group();
  const postO = roundedRect(0.055, 0.055, 0.022, 3);
  const barO = roundedRect(1.47, 0.05, 0.024, 3);
  const bar = at(solid(prism(barO, 0.05, 0.01), casing), TRAY, T + 0.19, 0);
  bar.add(strokes(join(brow(barO, 0.05, 0.01), loop(barO, 0.004)), L.casing));
  const beamLight = keep(new MeshBasicMaterial({ color: ink.beam, transparent: true, opacity: 0, depthWrite: false }));
  const beamGlow = keep(new MeshBasicMaterial({ color: ink.beam, transparent: true, opacity: 0, depthWrite: false }));
  const beam = at(new Mesh(flat, beamLight), TRAY, T + 0.041, 0);
  beam.scale.set(2.68, 1, 0.03);
  const glow = at(new Mesh(flat, beamGlow), TRAY, T + 0.04, 0);
  glow.scale.set(2.68, 1, 0.26);
  gantry.add(at(solid(prism(postO, 0.2, 0.008), casing), TRAY - 1.42, T, 0), at(solid(prism(postO, 0.2, 0.008), casing), TRAY + 1.42, T, 0), bar, glow, beam);
  benchTurned.add(gantry);

  // The drawer's lid. Nothing comes back out from under it until the bench resets.
  const drawerO = roundedRect(1.5, DRAWER.depth, 0.1, 6);
  const drawer = at(solid(prism(drawerO, DRAWER.height, EDGE), gloss(ink.collar)), TRAY, T, DRAWER.z);
  drawer.add(strokes(join(brow(drawerO, DRAWER.height, EDGE), loop(drawerO, 0.004)), L.casing));
  benchTurned.add(drawer);
  const holdLamp = lamp(benchTurned, TRAY - 1.05, T + DRAWER.height, DRAWER.z - 0.1, "Holdout");
  const plantLamp = lamp(benchTurned, 1.72, T, -0.25, "Duplicates");
  const upload = key(benchTurned, 1.72, T, 0.55, "Upload");

  // The sheet of glass standing behind: built lying down like the terminal's front, then stood up and leant back.
  const sheetAt = at(new Group(), TRAY + 0.32, T, -1.36);
  sheetAt.rotation.x = -0.22;
  const pane = at(new Group(), 0, SHEET_SIZE.height / 2 + 0.02, 0);
  pane.rotation.x = Math.PI / 2;
  const paneO = roundedRect(SHEET_SIZE.width / 2, SHEET_SIZE.height / 2, 0.16, 8);
  const glass = solid(prism(paneO, 0.03), keep(new MeshBasicMaterial({ color: ink.glass, transparent: true, opacity: ink.glassOpacity, depthWrite: false })));
  glass.renderOrder = 1;
  glass.add(strokes(join(loop(paneO, 0.03), loop(paneO, 0)), L.glass));
  const sheet = kit.surface(SHEET_SIZE.width * PX, SHEET_SIZE.height * PX);
  const sheetMesh = at(new Mesh(flat, keep(new MeshBasicMaterial({ map: sheet.texture, transparent: true, depthWrite: false }))), 0, 0.032, 0);
  sheetMesh.scale.set(SHEET_SIZE.width, 1, SHEET_SIZE.height);
  sheetMesh.renderOrder = 2;
  benchTurned.add(sheetAt.add(pane.add(glass, sheetMesh)));

  scene.add(tv, bench);

  // ── cameras ────────────────────────────────────────────────────────────────

  const tvCamera = new PerspectiveCamera(FOV, FRAME, 1, 80);
  tvCamera.position.set(0, 9.496, 18.986);
  tvCamera.lookAt(0, 2.656, 0.186);
  const benchCamera = new PerspectiveCamera(FOV, FRAME, 1, 80);
  benchCamera.position.set(-0.3, 12.896, 16.345);
  benchCamera.lookAt(-0.3, 0.548, -0.644);
  const cameras = [tvCamera, benchCamera];

  // ── what each device shows ─────────────────────────────────────────────────

  let shown = options.shown === 1 ? 1 : 0;
  let clock = 0;
  let mode: Mode = "cli";
  /** When the replay or upload key was last pressed, on the device's clock: it stays down for a moment. */
  let tapped = -1;
  let paintedScreen = "";
  let paintedSheet = "";

  const printTicket = (): void => {
    paintTicket(print.ctx, SCRIPTS[mode].ticket, { bar: ink.paperBar, ink: ink.paperInk, dim: ink.paperDim }, LABEL_FONT);
    print.texture.needsUpdate = true;
  };
  const restart = (): void => {
    clock = 0;
    paintedScreen = "";
    paintedSheet = "";
  };
  const tap = (): number => (tapped >= 0 && clock - tapped < 0.22 ? 1 : 0);

  const applyTerminal = (view: TerminalView): void => {
    view.lights.forEach((state, k) => lamps[k].set(state, clock));
    keys[0].set(mode === "cli", 0);
    keys[1].set(mode === "api", 0);
    keys[2].set(false, tap());
    paper.visible = view.ticket > 0.001;
    paper.position.z = -0.62 + 0.98 * easeOutCubic(view.ticket);
    // Paint only when what is on the screen changes: a typed character, a turn of the spinner, a blink of the caret.
    const spins = view.lines.some((l) => l.mark === "spin");
    const blinks = view.lines.some((l) => l.caret);
    const now = JSON.stringify(view.lines) + view.title + (spins ? Math.floor(clock * 30) : "") + (blinks ? clock % 1 < 0.6 : "");
    if (now !== paintedScreen) {
      paintedScreen = now;
      paintTerminal(screen.ctx, view, ink, FONTS, clock);
      screen.texture.needsUpdate = true;
    }
  };

  const applyBench = (view: BenchView): void => {
    rows.forEach((m, i) => {
      const p = view.rows[i];
      m.visible = p > 0.01;
      m.scale.set(0.9 + 0.1 * p, Math.max(p, 0.01), 1);
      m.position.z = rowZ(i) + (held.includes(i) ? DRAWER.slide * view.held : 0);
    });
    twins.forEach((m, k) => {
      const p = view.twins[k];
      m.visible = p > 0.01;
      m.scale.setScalar(Math.max(p, 0.01));
    });
    gantry.position.z = rowZ(0) - 0.12 + view.scan * (rowZ(swept - 1) - rowZ(0) + 0.24);
    beamLight.opacity = 0.8 * view.beam;
    beamGlow.opacity = 0.16 * view.beam;
    // Each light pulses while its step is under way, and stays on once it is done.
    holdLamp.set(view.sealed ? "lit" : view.held > 0.02 ? "on" : "off", clock);
    plantLamp.set(view.beam > 0.02 ? "on" : view.scan > 0.99 ? "lit" : "off", clock);
    upload.set(false, Math.max(view.key, tap()));
    const writing = view.written.some((n, i) => n > 0 && n < SHEET.lines[i][1].length);
    const now = `${view.written.join(",")}|${view.sheet.toFixed(2)}|${writing ? clock % 0.8 < 0.5 : ""}`;
    if (now !== paintedSheet) {
      paintedSheet = now;
      paintSheet(sheet.ctx, view, ink, FONTS, clock);
      sheet.texture.needsUpdate = true;
    }
  };

  const draw = (still: boolean): void => {
    tv.visible = shown === 0;
    bench.visible = shown === 1;
    if (shown === 0) {
      const script = SCRIPTS[mode];
      const played = scriptSeconds(script);
      applyTerminal(terminalAt(script, still ? played : clock % (played + TERMINAL_HOLD)));
    } else {
      applyBench(still ? benchDone() : benchAt(clock % BENCH_LOOP));
    }
    renderer.render(scene, cameras[shown]);
    if (!host.dataset.ready) host.dataset.ready = "1";
  };

  // ── the page around it ─────────────────────────────────────────────────────

  let runner: Loop | null = null;
  let disposed = false;
  let swapping = 0;

  const resize = (): void => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    for (const camera of cameras) {
      camera.aspect = width / height;
      camera.zoom = Math.min(1, width / height / FRAME);
      camera.updateProjectionMatrix();
    }
    ground.resize(width, [0.16, 0.12, 0.16, 0.18]);
    runner?.redraw();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(host);

  // The keys can be pressed: the terminal's pick how the batch is told and play it again, the bench's loads again.
  const ray = new Raycaster();
  const pointer = new Vector2();
  const pressable = (): Key[] => (shown === 0 ? keys : [upload]);
  const keyUnder = (e: PointerEvent | MouseEvent): number => {
    const box = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - box.left) / box.width) * 2 - 1, 1 - ((e.clientY - box.top) / box.height) * 2);
    ray.setFromCamera(pointer, cameras[shown]);
    const caps = pressable().map((k) => k.cap);
    const hit = ray.intersectObjects(caps, false)[0];
    return hit ? caps.indexOf(hit.object as Mesh) : -1;
  };
  const onMove = (e: PointerEvent): void => { canvas.style.cursor = keyUnder(e) >= 0 ? "pointer" : ""; };
  const onClick = (e: MouseEvent): void => {
    const k = keyUnder(e);
    if (k < 0) return;
    if (shown === 0 && k < 2) mode = k === 0 ? "cli" : "api";
    restart();
    printTicket();
    tapped = shown === 0 && k < 2 ? -1 : 0;
    runner?.redraw();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("click", onClick);

  printTicket();
  resize();
  runner = loopWhileSeen(host, (seconds, still) => {
    clock += seconds;
    draw(still);
  });
  void document.fonts?.ready.then(() => {
    if (disposed) return;
    for (const paint of repaint) paint();
    paintedScreen = "";
    paintedSheet = "";
    printTicket();
    runner?.redraw();
  });

  return {
    show(index) {
      const next = index === 1 ? 1 : 0;
      if (disposed || next === shown) return;
      const swap = (): void => {
        swapping = 0;
        shown = next;
        tapped = -1;
        restart();
        delete host.dataset.swap;
        runner?.redraw();
      };
      window.clearTimeout(swapping);
      // Fade the canvas out, change what is on it, and let it fade back in. Without motion, just change it.
      if (!runner?.running) { swap(); return; }
      host.dataset.swap = "1";
      swapping = window.setTimeout(swap, SWAP_MS);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(swapping);
      runner?.dispose();
      sizes.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("click", onClick);
      kit.dispose();
      delete host.dataset.ready;
      delete host.dataset.swap;
    },
  };
}
