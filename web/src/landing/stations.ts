// The four stations of the robot floor, and what happens at each. A station is its furniture (one fused mesh
// that never moves), the things that do move (a cart, the parts on a belt, a lamp that changes colour) and a
// robot. `update(t)` puts all of that where it is `t` seconds into the station's loop; factory.ts keeps the time.
//
// Every position is in the floor's own units, with the stations where floorplan.ts WAYPOINTS has the camera rest.
// On the screen +x runs down and to the left, +z up and to the left, and y is up.

import { Group, Mesh, Quaternion, Shape, Vector3, type Color, type Object3D, type Scene } from "three";
import { REACH, buildRobot, type ArmPose, type Robot, type V3 } from "./arms";
import { LAYER, type Contour, type Tint } from "./contour";
import { clamp01, smooth } from "./ease";
import type { Trail } from "./floorplan";
import {
  BLOCK, CART, CARTON, DRIVER_TIP, GEAR_THICK, PLATE, TRUCK, barrel, bolt, cable, cablePoints, cart, carton, controls, conveyor,
  curtain, dash, dice, driver, frame, gate, gear, gearShape, lampBar, lampDisc, motor, panel, plate, portal, shelves, truck,
  tub, wiredBlock,
} from "./props";
import { Sculpt } from "./rig";

export interface Stage {
  contour: Contour;
  tints: Record<Tint, Color>;
  scene: Scene;
  trail: Trail;
  /** Every mesh made here, for factory.ts to free. */
  meshes: Mesh[];
}

export interface Station {
  /** How long its loop is, in seconds. */
  period: number;
  update(t: number): void;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Fuse what `build` adds into one mesh, and put it in `parent`. */
function solid(stage: Stage, parent: Object3D, build: (s: Sculpt) => void): Mesh {
  const s = new Sculpt(stage.tints);
  build(s);
  const mesh = s.mesh(stage.contour.paint);
  mesh.layers.set(LAYER.solid);
  stage.meshes.push(mesh);
  parent.add(mesh);
  return mesh;
}

/** Something that moves: its own group in the scene, holding what `build` adds. */
function mover(stage: Stage, build: (s: Sculpt) => void): Group {
  const group = new Group();
  solid(stage, group, build);
  stage.scene.add(group);
  return group;
}

function robot(stage: Stage, seed: number): Robot {
  const r = buildRobot(stage.contour, stage.tints, seed);
  r.group.traverse((o) => { if ((o as Mesh).isMesh) stage.meshes.push(o as Mesh); });
  stage.scene.add(r.group, r.shadow, r.cloud.mesh);
  return r;
}

/** A row of numbers at a time: `[t, a, b, c, ...]`. */
type Key = readonly number[];

/** The numbers at `t` along `keys` (in order of time): eased from each key to the next, held before the first
 *  and after the last. */
function along(keys: readonly Key[], t: number): number[] {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const from = keys[i];
  const to = keys[Math.min(keys.length - 1, i + 1)];
  const span = to[0] - from[0];
  const u = span > 0 ? smooth((t - from[0]) / span) : 0;
  const out: number[] = [];
  for (let k = 1; k < from.length; k++) out.push(from[k] + (to[k] - from[k]) * u);
  return out;
}

/** How far `t` is from `from` to `to`, eased, 0 before and 1 after. */
const ramp = (t: number, from: number, to: number): number => smooth(clamp01((t - from) / (to - from)));

const arm = (v: number[], extra: Partial<ArmPose> = {}): ArmPose => ({ wrist: [v[0], v[1], v[2]], grip: v[3], ...extra });

/** A point `ahead` of, `above` and to the `side` (its right) of a body that faces `facing`. */
function from(body: readonly number[], facing: number, ahead: number, above: number, side: number): [number, number, number] {
  const fx = Math.cos(facing);
  const fz = -Math.sin(facing);
  return [body[0] + fx * ahead - fz * side, body[1] + above, body[2] + fz * ahead + fx * side];
}

const mix = (a: number, b: number, u: number): number => a + (b - a) * u;

// ── station 1: a gear goes on each motor, and the motor goes in a cart ──────────

function pickAndPlace(stage: Stage): Station {
  const period = 4.2;
  const scene = stage.scene;

  // Where things are.
  const beltTop = 0.94;
  const work: V3 = [0.05, beltTop, -0.1];
  const step = 1.02;
  const parked: V3 = [1.64, 0, -0.25];
  // In the cart the motor sits a little toward -x, so the gear on its +x end is clear of the cart's wall.
  const inCart: V3 = [parked[0] - 0.04, CART.lift + CART.h - 0.28 + 0.03, parked[2]];
  const seat: V3 = [work[0] + 0.43, work[1] + 0.3, work[2]];
  const pick: V3 = [1.4, 0.86, 1.25];

  solid(stage, scene, (s) => {
    // The conveyor, and the machine it comes out of.
    s.at(-0.86, 0, -0.03, 0, () => conveyor(s, 3.3, 1.06, beltTop));
    s.at(-1.017, 0, -0.257, 0, () => portal(s, 0.85, 1.915, 2.29));
    s.at(-1.07, 1.06, -1.214, 0, () => panel(s, 0.66, 0.78));
    // The gears' tub, heaped, and the motors' behind it.
    s.at(1.535, 0, 1.39, 0, () => {
      tub(s, 0.99, 1.68, 1.1, { handle: "x", deep: 0.28, r: 0.1 });
      const roll = dice(7);
      for (let layer = 0; layer < 2; layer++) {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 5; j++) {
            if (layer === 1 && roll() < 0.3) continue;
            const x = (i - 1) * 0.225 + (roll() - 0.5) * 0.03;
            const z = (j - 2) * 0.285 + (roll() - 0.5) * 0.03;
            gear(s, x, 0.85 + layer * 0.055 + roll() * 0.02, z, roll() * 3);
          }
        }
      }
    });
    s.at(-0.83, 0, 3.93, 0, () => {
      tub(s, 1.64, 0.96, 1.13, { handle: "z", deep: 0.48, r: 0.08 });
      for (const [x, ry] of [[-0.46, 0.3], [0.02, -0.2], [0.48, 0.5]] as const) s.at(x, 0.62, 0.04, ry, () => motor(s));
    });
    // A bare frame beyond the tubs, and an empty tub on the way to the next station.
    s.at(3.585, 0, 2.37, 0, () => frame(s, 1.25, 2.8, 1.67));
    s.at(0.01, 0, -3.53, 0, () => tub(s, 1.85, 1.05, 1.13, { handle: "z", deep: 0.7, r: 0.1 }));
  });

  // The lamp over the way through: amber while the belt moves, red while the robot works.
  const lamps = (["amber", "red"] as const).map((tint) => {
    const g = mover(stage, (s) => lampBar(s, tint));
    g.position.set(-0.59, 2.04, -0.18);
    return g;
  });

  // The motors on the belt: the one being worked on, the next, and the one after that.
  const piece = mover(stage, (s) => s.at(0, 0, 0, -Math.PI / 2, () => motor(s)));
  const fitted = mover(stage, (s) => { s.sweep(gearShape(0.19), GEAR_THICK, 0, 0, 0, "amber", { way: "along-x", seg: 6 }); });
  const next = mover(stage, (s) => s.at(0, 0, 0, -Math.PI / 2, () => motor(s)));
  const after = mover(stage, (s) => s.at(0, 0, 0, -Math.PI / 2, () => motor(s)));
  // The gear in the robot's hand.
  const held = mover(stage, (s) => { s.sweep(gearShape(0.19), GEAR_THICK, 0, 0, 0, "amber", { way: "along-x", seg: 6 }); });
  // The cart, and the finished motor that rides in it.
  const wagon = mover(stage, (s) => cart(s));
  const cargo = mover(stage, (s) => s.at(0, 0, 0, -Math.PI / 2, () => motor(s, true)));
  scene.remove(cargo);
  wagon.add(cargo);
  cargo.position.set(inCart[0] - parked[0], inCart[1], 0);

  const bot = robot(stage, 5);

  // The body leans toward whatever the hands are doing: the belt, the cart, the tub. Over the cart it stands far
  // enough along +x that the left hand reaches the cart without its arm crossing the right one.
  const BODY: Key[] = [
    [0.0, 0.24, 1.67, 0.85], [0.3, 0.5, 1.75, 0.72], [0.6, 1.6, 2.0, 0.55], [0.9, 1.55, 1.9, 0.55],
    [1.25, 0.82, 1.7, 0.95], [1.55, 0.8, 1.7, 0.95], [2.05, 0.26, 1.67, 0.85], [4.2, 0.24, 1.67, 0.85],
  ];
  // The hand that carries the motor (x, y, z, grip), its fingers on the block on top. It lifts the motor clear
  // of the cart's walls, over the cart's middle, and lowers it straight in.
  const LIFT = 0.94;
  const CARRY: Key[] = [
    [0.0, 0.05, work[1] + LIFT, -0.08, 0.8], [0.28, 0.3, 2.05, -0.1, 0.8], [0.56, inCart[0], 2.3, inCart[2], 0.8],
    [0.78, inCart[0], inCart[1] + LIFT, inCart[2], 0.8],
    [1.05, 1.3, 1.95, -0.15, 0.2], [1.5, 0.4, 1.88, -0.02, 0.2], [2.05, 0.05, work[1] + LIFT, -0.08, 0.7], [4.2, 0.05, work[1] + LIFT, -0.08, 0.8],
  ];
  // The hand that fetches the gear. Its palm faces -x throughout and the gear is held flat against it (`GEAR_OFF`
  // out from where the hand holds things), so on the shaft the wrist is just off the gear's outer face.
  const GEAR_OFF = 0.05;
  const at = [seat[0] + 0.06 + GEAR_OFF, seat[1] + REACH, seat[2]];
  const FETCH: Key[] = [
    [0.0, 0.55, 1.45, 0.1, 0.3], [0.3, 0.9, 1.5, 0.2, 0.3], [0.62, 2.25, 1.5, 0.45, 0.3], [0.85, 2.25, 1.5, 0.5, 0.3],
    [1.12, 1.4, 1.5, 1.0, 0.1], [1.38, pick[0], pick[1] + 0.36, pick[2], 0.1], [1.48, pick[0], pick[1] + 0.36, pick[2], 0.2],
    [1.72, 1.2, 1.6, 0.7, 0.2], [2.08, at[0], at[1], at[2], 0.2], [3.8, at[0], at[1], at[2], 0.2],
    [4.2, 0.55, 1.45, 0.1, 0.3],
  ];
  const palmOut = new Vector3();

  const update = (t: number): void => {
    const working = t >= 2.08 && t < 4.1;
    lamps[0].visible = !working;
    lamps[1].visible = working;

    const body = along(BODY, t);
    const carry = along(CARRY, t);
    const aside = ramp(t, 0.3, 0.55) * (1 - ramp(t, 0.9, 1.15));
    const fetch = along(FETCH, t);
    // While it fits the gear the fetching hand works it round a little.
    const fit = ramp(t, 2.1, 2.3) * (1 - ramp(t, 3.6, 3.85));
    const wob = fit * 0.03;
    fetch[1] += Math.sin(t * 9) * wob;
    fetch[2] += Math.cos(t * 9) * wob;
    carry[1] += Math.sin(t * 9 + 1) * fit * 0.012;
    bot.pose({
      body: [body[0], body[1], body[2]],
      facing: Math.PI / 2,
      left: arm(carry, { point: [0.1, -1, 0.05], palm: [1, 0, 0.3] }),
      // While the left hand puts the motor in the cart, the right waits out to the side with its elbow out, not
      // folded back over the gears' tub.
      right: arm(fetch, { point: [0.05, -1, 0.05], palm: [-1, 0, 0], elbow: [mix(0.55, 1, aside), mix(-0.45, -0.2, aside), mix(0.75, 0.1, aside)] }),
      show: 1,
    });
    stage.trail.visit(body[0], body[2]);

    // The cart rolls in along x, waits, and rolls off with its motor.
    // (Far enough that it is off the screen wherever the camera is on its way to the next station.)
    const FAR = 8.5;
    const leave = clamp01((t - 2.12) / 1.2);
    const coming = clamp01(((t < 1 ? t + period : t) - 3.34) / 1.2);
    const away = t >= 2.12 && t < 3.34 ? leave * leave * FAR : t >= 3.34 || t < 0.34 ? (1 - coming) * (1 - coming) * FAR : 0;
    wagon.position.set(parked[0] + away, 0, parked[2]);
    cargo.visible = t >= 0.78 && t < 3.34;

    // The belt steps the motors along once the finished one is off it.
    const move = ramp(t, 0.72, 1.3);
    const lifted = t < 0.78;
    const grasp = bot.hold("left").at;
    if (lifted) {
      // In the hand: from the belt, up and over, down into the cart.
      const take = ramp(t, 0, 0.12);
      const put = ramp(t, 0.66, 0.78);
      // The motor hangs from the hand by its top block, which is where the hand holds things.
      const hx = grasp.x;
      const hy = grasp.y - (LIFT - REACH * 0.99);
      const hz = grasp.z;
      const x = work[0] + (hx - work[0]) * take;
      const y = work[1] + (hy - work[1]) * take;
      const z = work[2] + (hz - work[2]) * take;
      piece.position.set(x + (inCart[0] - x) * put, y + (inCart[1] - y) * put, z + (inCart[2] - z) * put);
      piece.visible = true;
      fitted.visible = true;
    } else {
      piece.position.set(work[0], work[1], work[2]);
      piece.visible = t >= 1.3;
      fitted.visible = t >= 2.08;
    }
    fitted.position.set(piece.position.x + 0.43, piece.position.y + 0.3, piece.position.z);
    fitted.rotation.x = fit > 0 ? (t - 2.1) * 2.2 : 0;
    const shift = t < 1.3 ? move : 0;
    next.position.set(work[0] - step + step * shift, work[1], work[2]);
    after.position.set(work[0] - step * 2 + step * shift, work[1], work[2]);

    // The gear: out of the tub in the fetching hand, onto the motor's shaft.
    const fetching = t >= 1.44 && t < 2.08;
    held.visible = fetching;
    if (fetching) {
      // Flat against the palm, not through the fingers; it does not turn until it is on the shaft.
      const hand = bot.hold("right");
      const g = palmOut.set(0, 0, -1).applyQuaternion(hand.turn).multiplyScalar(GEAR_OFF).add(hand.at);
      const land = ramp(t, 1.92, 2.08);
      held.position.set(g.x + (seat[0] - g.x) * land, g.y + (seat[1] - g.y) * land, g.z + (seat[2] - g.z) * land);
      held.rotation.x = 0;
    }
  };

  return { period, update };
}

// ── station 2: cartons go from the pallet onto a truck, and the truck takes them away ──

function sorting(stage: Stage): Station {
  const period = 5;
  const scene = stage.scene;

  // The pallet's stack: two cartons along x, three along z, three high. The robot takes from one place on top,
  // and the carton beside that place has gone already, so the hand on that side has room.
  const columns = [4.68, 5.5];
  const rows = [-7.12, -6.6, -6.08];
  const layers = [0.1, 0.1 + CARTON.h, 0.1 + CARTON.h * 2];
  const slot: V3 = [columns[1], layers[2], rows[2]];
  const gone: V3 = [columns[1], layers[2], rows[1]];
  // Where the second truck stops, and where the carton goes on it: on top of the two it came with.
  const stop: V3 = [7.5, 0, -5.26];
  const load = TRUCK.deckFrom + TRUCK.deckLength / 2;
  const onTruck: V3 = [stop[0], TRUCK.deck + CARTON.h * 2, stop[2] - load];

  solid(stage, scene, (s) => {
    s.at(7.12, 0, -3.05, 0, () => shelves(s));
    // A truck that stays, loaded.
    s.at(4.6, 0, -3.7, 0, () => {
      truck(s);
      for (let i = 0; i < 2; i++) carton(s, load, TRUCK.deck + CARTON.h * i, 0, -Math.PI / 2);
    });
    // The pallet.
    s.box(1.78, 0.1, 1.7, 5.09, 0, -6.6, "white");
    for (const y of layers) for (const x of columns) for (const z of rows) {
      if (y === slot[1] && x === slot[0] && (z === slot[2] || z === gone[2])) continue;
      carton(s, x, y, z);
    }
    carton(s, 5.2, 0, -8.3, 0.35);
    for (let k = 0; k < 9; k++) dash(s, 2.45, -2.68 - k * 0.69, Math.PI / 2, 0.58);
    barrel(s, 9.42, -4.44);
    barrel(s, 10.08, -3.74);
    // Cartons two high, back toward the first station.
    for (const x of [12.08, 12.9]) for (const y of [0, CARTON.h]) carton(s, x, y, -1.67);
  });

  // The truck that comes and goes, with the two cartons it brings and the third it leaves with.
  const lorry = mover(stage, (s) => {
    truck(s, 1);
    for (let i = 0; i < 2; i++) carton(s, load, TRUCK.deck + CARTON.h * i, 0, -Math.PI / 2);
  });
  lorry.rotation.y = Math.PI / 2;
  const third = mover(stage, (s) => carton(s, load, TRUCK.deck + CARTON.h * 2, 0, -Math.PI / 2));
  scene.remove(third);
  lorry.add(third);
  // The carton on the pallet that is taken, and the same carton in the robot's hands.
  const waiting = mover(stage, (s) => carton(s, 0, 0, 0));
  waiting.position.set(slot[0], slot[1], slot[2]);
  const carried = mover(stage, (s) => carton(s, 0, 0, 0));

  const bot = robot(stage, 11);

  // Where the body is and which way it faces (x, y, z, facing): at the pallet, over to the truck, and back with
  // its arms hanging. It faces -x the whole way there, so the carton stays square to its hands, and it carries
  // the carton high enough to pass over the truck's load, coming at it from the far side of the mast. It backs
  // off before the truck leaves, and only crosses the truck's way once it has gone.
  const HOLD = 0.74;
  // The hands hold the carton this far under the body: the carton's middle.
  const UNDER = 0.4;
  const atPallet = [slot[0] + HOLD + 0.02, slot[1] + CARTON.h / 2 + UNDER, slot[2], Math.PI];
  const atTruck = [onTruck[0] + HOLD, onTruck[1] + CARTON.h / 2 + UNDER, onTruck[2], Math.PI];
  const high = onTruck[1] + 0.27 + UNDER + CARTON.h / 2;
  const BODY: Key[] = [
    [0, ...atPallet], [0.22, atPallet[0] + 0.1, 1.95, atPallet[2] - 0.05, Math.PI], [0.75, 7.6, high, -6.55, Math.PI],
    [1.2, atTruck[0], high, atTruck[2], Math.PI], [1.45, ...atTruck], [1.8, atTruck[0] + 0.65, 1.85, atTruck[2], Math.PI],
    [2.6, 8.6, 1.65, -6.5, 3.4], [3.3, 7.0, 1.62, -6.4, Math.PI], [4.0, atPallet[0] + 0.25, 1.75, atPallet[2] - 0.06, Math.PI],
    [4.6, ...atPallet], [5, ...atPallet],
  ];
  // The hands, in the body's own terms (ahead, above, out to the side, grip): on the carton, or hanging. On the way
  // back they come up in front of the stack before they reach in on either side of the carton.
  const HANDS: Key[] = [
    [0, HOLD - 0.08, -UNDER, 0.31, 0.5], [1.5, HOLD - 0.08, -UNDER, 0.31, 0.5], [1.85, 0.35, -0.5, 0.42, 0.15],
    [2.5, 0.08, -1.07, 0.32, 0.3], [3.9, 0.08, -1.07, 0.32, 0.3], [4.25, 0.3, -UNDER + 0.02, 0.42, 0.15],
    [4.55, HOLD - 0.08, -UNDER, 0.42, 0.1], [4.75, HOLD - 0.08, -UNDER, 0.31, 0.5], [5, HOLD - 0.08, -UNDER, 0.31, 0.5],
  ];

  const update = (t: number): void => {
    const b = along(BODY, t);
    const h = along(HANDS, t);
    const facing = b[3];
    const hanging = ramp(t, 1.9, 2.5) * (1 - ramp(t, 3.9, 4.5));
    // Hanging arms swing a little as the body drifts.
    const swing = Math.sin(t * 2.6) * 0.05 * hanging;
    const left = from(b, facing, h[0] + swing, h[1], -h[2]);
    const right = from(b, facing, h[0] - swing, h[1], h[2]);
    const inward = from([0, 0, 0], facing, 0, 0, 1);
    const ahead = from([0, 0, 0], facing, 1, 0, 0);
    const down = hanging > 0.5;
    bot.pose({
      body: [b[0], b[1], b[2]],
      facing,
      left: { wrist: left, grip: h[3], palm: down ? [inward[0], 0, inward[2]] : inward, point: down ? [0.05, -1, 0] : [ahead[0], -0.25, ahead[2]] },
      right: { wrist: right, grip: h[3], palm: down ? [-inward[0], 0, -inward[2]] : [-inward[0], 0, -inward[2]], point: down ? [0.05, -1, 0] : [ahead[0], -0.25, ahead[2]] },
      show: 1,
    });
    stage.trail.visit(b[0], b[2]);

    // The truck backs out along z with its load, and the next one drives in.
    const leave = ramp(t, 1.85, 2.75);
    const arrive = 1 - ramp(t, 4.0, 4.7);
    const away = t < 2.75 ? leave * leave * 9.5 : arrive * arrive * 9.5;
    lorry.position.set(stop[0], 0, stop[2] - away);
    lorry.visible = t < 2.75 || t > 4.0;
    third.visible = t >= 1.45 && t < 2.75;

    // The carton: taken off the pallet, carried over tilted, set down on the truck's stack.
    const held = from(b, facing, HOLD, -UNDER - CARTON.h / 2, 0);
    const take = ramp(t, 0.0, 0.2);
    const put = ramp(t, 1.25, 1.45);
    carried.visible = t < 1.45;
    const x = mix(mix(slot[0], held[0], take), onTruck[0], put);
    const y = mix(mix(slot[1], held[1], take), onTruck[1], put);
    const z = mix(mix(slot[2], held[2], take), onTruck[2], put);
    carried.position.set(x, y, z);
    const way = clamp01((t - 0.15) / 1.2);
    carried.rotation.set(0, 0, Math.sin(way * Math.PI) * 0.25);
    // The next carton is on the pallet by the time the robot is back.
    const back = ramp(t, 3.45, 3.6);
    waiting.visible = back > 0;
    waiting.scale.setScalar(Math.max(0.001, back));
  };

  return { period, update };
}

// ── station 3: a bolt goes into each plate and is driven home ──────────────────

function fastening(stage: Stage): Station {
  const period = 5.2;
  const scene = stage.scene;

  const beltTop = 0.85;
  const z = -8.27;
  // Where a plate waits out of sight, comes out, is worked on, and where it has left the belt.
  const spots = [11.51, 12.98, 14.45, 15.92];
  const seat: V3 = [spots[2], beltTop + PLATE.h, z];
  // The crate the finished plates drop into: right at the belt's end and lower than the belt, so a plate slides
  // out over its near wall before it drops. A plate (with the drum on its trailing side, 0.4 out) is clear of
  // that wall once its middle is past `clear`, and lands at `drop`.
  const crate = { x: 15.6, z: -8.37, w: 0.76, d: 0.88, h: 0.78, wall: 0.035 };
  const landed = 0.07;
  const clear = crate.x - crate.w / 2 + crate.wall + 0.4 + 0.005;
  const drop = clear + 0.015;

  solid(stage, scene, (s) => {
    s.at(12.85, 0, -8.19, 0, () => conveyor(s, 4.68, 1.06, beltTop, { ends: "both" }));
    s.at(12.27, 0, -8.267, 0, () => portal(s, 0.9, 2.01, 2.24, { near: 0.3, far: 0.28, beam: 0.41 }));
    s.at(12.225, 0.985, -9.274, 0, () => panel(s, 0.63, 1.03, "red"));
    // The crate the finished plates drop into.
    s.at(crate.x, 0, crate.z, 0, () => tub(s, crate.w, crate.d, crate.h, { wall: crate.wall, r: 0.012, deep: crate.h - landed + 0.03 }));
    // The bolts' tub, heaped.
    s.at(15.04, 0, -5.9, 0, () => {
      tub(s, 1.77, 0.96, 1.12, { handle: "z", deep: 0.3, r: 0.1 });
      // Three layers of bolts lying every which way, the top one thinner.
      const roll = dice(23);
      for (let layer = 0; layer < 3; layer++) {
        for (let i = 0; i < 13; i++) {
          for (let j = 0; j < 6; j++) {
            if (layer === 2 && roll() < 0.45) continue;
            const x = (i - 6) * 0.118 + (roll() - 0.5) * 0.07;
            const zz = (j - 2.5) * 0.11 + (roll() - 0.5) * 0.06;
            const y = 0.8 + layer * 0.05 + roll() * 0.03;
            s.at(x, y, zz, roll() * 6.3, () => s.tipped((roll() - 0.5) * 2.4, (roll() - 0.5) * 2.4, () => bolt(s, 0.85)));
          }
        }
      }
    });
    // A barrier in front of the tub, with two bars running back from its far end.
    s.at(16.72, 0, -6.33, Math.PI / 2, () => gate(s, 2.3, 1.72, 0.075));
    for (const y of [0.16, 1.645]) s.box(1.0, 0.075, 0.075, 16.2, y, -5.22, "white");
    for (let k = 0; k < 12; k++) dash(s, 17.27, -5.6 - k * 0.7, Math.PI / 2, 0.58);
    // On the way to the last station: a cart of odds and ends, and cartons in a heap.
    s.at(12.49, 0, -10.89, 0, () => {
      cart(s, 0.34);
      const y = CART.lift + CART.h - 0.34 + 0.03;
      s.box(0.36, 0.22, 0.3, -0.2, y, 0.18, "white");
      s.box(0.36, 0.1, 0.3, -0.2, y + 0.22, 0.18, "white");
      for (const [x, zz] of [[0.2, 0.2], [0.26, -0.12], [-0.05, -0.2]] as const) for (let i = 0; i < 3; i++) s.box(0.2, 0.05, 0.16, x, y + i * 0.05, zz, "white");
      for (const [x, zz] of [[0.02, 0.06], [0.2, -0.3]] as const) s.ring(0.07, 0.03, x, y + 0.16, zz, "white");
    });
    carton(s, 17.22, 0, -10.63);
    carton(s, 16.5, 0, -11.3);
    carton(s, 16.6, CARTON.h, -10.86);
    carton(s, 15.3, 0, -12.8);
    carton(s, 14.44, 0, -12.62);
  });

  const lamps = (["amber", "red"] as const).map((tint) => {
    const g = mover(stage, (s) => lampBar(s, tint, true));
    g.position.set(12.72, 2.03, -8.24);
    return g;
  });

  // The plates on the belt: the one leaving, the one being worked on, and the one coming out of the machine.
  const leaving = mover(stage, (s) => plate(s, true));
  const working = mover(stage, (s) => plate(s, false));
  const coming = mover(stage, (s) => plate(s, false));
  // A bolt's head, in the hand and then in the plate, and the tool that drives it.
  const hexHead = (s: Sculpt): void => {
    const head = new Shape();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      if (i === 0) head.moveTo(Math.cos(a) * 0.085, Math.sin(a) * 0.085);
      else head.lineTo(Math.cos(a) * 0.085, Math.sin(a) * 0.085);
    }
    head.closePath();
    s.sweep(head, 0.06, 0, 0, 0, "amber");
  };
  const head = mover(stage, hexHead);
  const tool = mover(stage, (s) => driver(s));

  const bot = robot(stage, 17);

  const BODY: Key[] = [
    [0, 14.52, 1.67, -7.55], [0.5, 14.72, 1.67, -6.95], [1.0, 14.72, 1.67, -6.95], [1.6, 14.52, 1.67, -7.6], [5.2, 14.52, 1.67, -7.55],
  ];
  // The hand that fetches the bolt and then steadies the plate (x, y, z, grip). It goes in over the bolts' tub's
  // front wall (z -6.38, 1.12 high) and picks from the heap inside, not through the wall.
  const over: V3 = [seat[0], seat[1] + 0.3, seat[2] + 0.04];
  const FETCH: Key[] = [
    [0, 14.86, 1.36, -8.0, 0.3], [0.55, 14.96, 1.62, -6.45, 0.1], [0.85, 14.96, 1.3, -6.1, 0.1], [0.95, 14.96, 1.3, -6.1, 0.9],
    [1.25, 14.9, 1.62, -6.75, 0.9], [1.7, over[0], over[1], over[2], 0.9], [1.85, over[0], over[1], over[2], 0.9],
    [2.1, 14.8, 1.32, -8.08, 0.45], [4.6, 14.8, 1.32, -8.08, 0.45], [5.2, 14.86, 1.36, -8.0, 0.3],
  ];
  // The hand with the tool: held off to one side, then down on the bolt. On the bolt the tool stands upright
  // with its socket over the head, down to `ENGAGE` above the plate (the head is 0.06 tall), and turns about the
  // bolt's own axis. The wrist is where it must be for the hand to hold the tool there: the tool hangs `HANG`
  // below the wrist and `SIDE` toward the palm.
  const ENGAGE = 0.025;
  const HANG = REACH - 0.12;
  const SIDE = 0.06;
  const onBolt = new Vector3(seat[0], seat[1] + ENGAGE + DRIVER_TIP, seat[2]);
  const down: V3 = [onBolt.x - SIDE, onBolt.y + HANG, onBolt.z];
  const TOOL: Key[] = [
    [0, 14.02, 1.72, -7.98, 1], [1.9, 14.02, 1.72, -7.98, 1], [2.3, down[0], down[1] + 0.03, down[2], 1],
    [4.3, down[0], down[1], down[2], 1], [4.7, 14.02, 1.72, -7.98, 1], [5.2, 14.02, 1.72, -7.98, 1],
  ];

  const flip = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  const spin = new Quaternion();
  const upright = new Vector3(0, 1, 0);
  const fingers = new Vector3();
  const inHandAt = new Vector3();
  const inHandTurn = new Quaternion();
  // It drives the bolt a whole number of sixths of a turn, so the hex head ends as it began.
  const DRIVE_FROM = 2.3;
  const DRIVE_TO = 4.45;
  const TURNS = (29 * Math.PI) / 3;
  const driven = (t: number): number => (clamp01((t - DRIVE_FROM) / (DRIVE_TO - DRIVE_FROM)) * TURNS);

  const update = (t: number): void => {
    const driving = t >= DRIVE_FROM && t < DRIVE_TO;
    lamps[0].visible = !driving;
    lamps[1].visible = driving;

    const body = along(BODY, t);
    const fetch = along(FETCH, t);
    const hold = along(TOOL, t);
    const press = ramp(t, 1.9, 2.3) * (1 - ramp(t, 4.3, 4.7));
    const lifted = ramp(t, 0.15, 0.5) * (1 - ramp(t, 1.15, 1.55));
    if (driving) hold[1] += Math.sin(t * 16) * 0.008;
    bot.pose({
      body: [body[0], body[1], body[2]],
      facing: Math.PI / 2,
      left: arm(hold, { point: [mix(-0.55, 0, press), mix(-0.3, -1, press), mix(-0.78, 0, press)], palm: [1, 0, 0] }),
      // Over the bolts' tub the elbow is lifted up and out, so the forearm reaches down into the heap from above
      // instead of lying in it. The usual lean (out, back and down) is blended in and out of that.
      right: arm(fetch, {
        point: [0.05, -1, t > 1.9 && t < 4.8 ? -0.25 : 0.05],
        elbow: [0.55, mix(-0.45, 0.85, lifted), mix(0.75, 0.25, lifted)],
      }),
      show: 1,
    });
    stage.trail.visit(body[0], body[2]);

    // The tool rides in the hand, turned the way the fingers point. As the hand comes down on the bolt it is
    // settled upright onto the bolt's axis, socket over the head, and there it turns with the bolt.
    const grasp = bot.hold("left");
    fingers.set(0, 1, 0).applyQuaternion(grasp.turn);
    inHandAt.copy(grasp.at).addScaledVector(fingers, -0.12);
    inHandTurn.copy(grasp.turn).multiply(flip);
    tool.position.lerpVectors(inHandAt, onBolt, press);
    spin.setFromAxisAngle(upright, driven(t));
    tool.quaternion.slerpQuaternions(inHandTurn, spin, press);

    // The belt steps the plates along: the finished one runs off the end, out over the crate's wall, and drops
    // in. It lies in the crate until the next is nearly done, and goes before the belt brings that one.
    const move = ramp(t, 0.05, 0.9);
    const x = mix(spots[2], spots[3], move);
    const fall = clamp01((x - clear) / (spots[3] - clear));
    leaving.position.set(Math.min(x, clear) + (drop - clear) * smooth(fall), mix(beltTop, landed, fall * fall), z);
    leaving.rotation.z = -Math.sin(fall * Math.PI) * 0.15;
    const goes = 1 - ramp(t, 4.6, 4.9);
    leaving.visible = goes > 0;
    leaving.scale.setScalar(Math.max(0.001, goes));
    working.position.set(t < 0.9 ? mix(spots[1], spots[2], move) : spots[2], beltTop, z);
    coming.position.set(t < 0.9 ? mix(spots[0], spots[1], move) : spots[1], beltTop, z);

    // The bolt's head: in the hand from the tub, then in the plate.
    const inHand = t >= 0.95 && t < 1.8;
    head.visible = t >= 0.95;
    if (inHand) {
      // Pinched at the fingertips, on the palm's side of them.
      const hand = bot.hold("right");
      const g = fingers.set(0, 0.06, -0.05).applyQuaternion(hand.turn).add(hand.at);
      const land = ramp(t, 1.62, 1.8);
      head.position.set(mix(g.x, seat[0], land), mix(g.y - 0.03, seat[1], land), mix(g.z, seat[2], land));
    } else {
      head.position.set(seat[0], seat[1], seat[2]);
    }
    // The head turns with the tool while it is driven.
    head.rotation.y = inHand ? 0 : driven(t);
  };

  return { period, update };
}

// ── station 4: the last cable of each block is plugged in ───────────────────────

/** The conveyor that turns a corner, seen from above as an outline for `sweep`: it comes down -z, turns, and
 *  runs off along -x. `grow` makes it that much bigger all round. */
function bentBelt(grow: number): Shape {
  const g = grow;
  const s = new Shape();
  const outer = 0.82 + g;
  const inner = Math.max(0.02, 0.2 - g);
  // Drawn as (x, -z).
  s.moveTo(16.65 + g, 14.7);
  s.lineTo(16.65 + g, 18.14 + g - outer);
  s.absarc(16.65 + g - outer, 18.14 + g - outer, outer, 0, Math.PI / 2, false);
  s.lineTo(14.0 - g, 18.14 + g);
  s.lineTo(14.0 - g, 17.1 - g);
  s.lineTo(15.57 - g - inner, 17.1 - g);
  s.absarc(15.57 - g - inner, 17.1 - g - inner, inner, Math.PI / 2, 0, true);
  s.lineTo(15.57 - g, 14.7);
  s.closePath();
  return s;
}

/** Where a block is, `d` along the middle of the bent belt from where it starts behind the machine, and the
 *  angle it is turned to (its loose cable trails). */
function onBelt(d: number): { x: number; z: number; turn: number } {
  const straight = 2.37;
  const r = 0.5;
  const bend = (Math.PI / 2) * r;
  if (d <= straight) return { x: 16.11, z: -14.75 - d, turn: -Math.PI / 2 };
  if (d <= straight + bend) {
    const a = (d - straight) / r;
    return { x: 15.61 + Math.cos(a) * r, z: -17.12 - Math.sin(a) * r, turn: -Math.PI / 2 + a };
  }
  return { x: 15.61 - (d - straight - bend), z: -17.62, turn: 0 };
}

function connectors(stage: Stage): Station {
  const period = 4;
  const scene = stage.scene;

  const beltTop = 0.85;
  // Along the belt, 1.665 apart: behind the machine, out of it, where the robot works, and past the belt's end.
  const stops = [0.295, 1.96, 3.625, 5.29];
  // The cart at the belt's end is a low one, its walls under the belt's top, so a block slides out over its near
  // wall and drops in. The block is clear of that wall once its middle is past `clear`, and lands at `drop`.
  // The cart then rolls off with it and comes back empty.
  const wagonAt: V3 = [13.4, 0, -17.62];
  const walls = 0.55;
  const inner = 0.3;
  const landed = CART.lift + walls - inner + 0.03;
  const clear = wagonAt[0] + CART.w / 2 - CART.wall - BLOCK.w / 2 - 0.01;
  const drop = clear - 0.03;
  const place = onBelt(stops[2]);

  solid(stage, scene, (s) => {
    // The belt, the base under it and a rail along the base.
    s.sweep(bentBelt(0), 0.22, 0, beltTop - 0.22, 0, "white", { seg: 14 });
    s.sweep(bentBelt(0.05), beltTop - 0.22, 0, 0, 0, "white", { seg: 14 });
    s.sweep(bentBelt(0.07), 0.03, 0, beltTop - 0.36, 0, "white", { seg: 14 });
    s.cyl(0.1, 0.02, 14.1, beltTop - 0.11, -18.21, "accent", { axis: "z", seg: 24 });
    s.cyl(0.045, 0.012, 14.1, beltTop - 0.11, -18.222, "white", { axis: "z", seg: 16 });
    // A roller where the bend starts and one where it ends.
    s.cyl(0.1, 0.07, 16.65, beltTop - 0.11, -17.2, "accent", { axis: "x", seg: 24 });
    s.cyl(0.045, 0.02, 16.72, beltTop - 0.11, -17.2, "white", { axis: "x", seg: 16 });
    s.cyl(0.1, 0.07, 15.68, beltTop - 0.11, -18.21, "accent", { axis: "z", seg: 24 });
    s.cyl(0.045, 0.02, 15.68, beltTop - 0.11, -18.23, "white", { axis: "z", seg: 16 });
    // The machine the blocks come out of, with its lamp's seat, its strips and its controls.
    s.at(16.21, 0, -15.675, Math.PI / 2, () => portal(s, 0.81, 1.96, 2.0, { near: 0.285, far: 0.3, beam: 0.53, rNear: 0.05, rFar: 0.3 }));
    s.at(16.2, 1.47, -16.08, 0, () => curtain(s, 1.37));
    s.at(17.19, 1.08, -15.64, 0, () => controls(s));
    // Cartons, a barrier and two drums.
    carton(s, 17.41, 0, -14.01);
    carton(s, 17.41, CARTON.h, -14.01);
    carton(s, 16.16, 0, -13.69);
    s.at(17.83, 0, -16.15, Math.PI / 2, () => gate(s, 1.94, 0.98));
    barrel(s, 19.2, -16.38, 0.33);
    barrel(s, 19.25, -17.06, 0.33);
    // Finished blocks on a bench beyond the cart.
    s.box(1.6, 0.42, 1.0, 14.3, 0, -19.6, "white");
    for (const [x, turn] of [[13.8, 0.2], [14.6, -0.3]] as const) s.at(x, 0.42, -19.6, turn, () => { wiredBlock(s); cable(s, 1); });
  });

  const lamps = (["amber", "red"] as const).map((tint) => {
    const g = mover(stage, (s) => lampDisc(s, tint, 0.12));
    g.position.set(16.18, 1.7, -16.13);
    return g;
  });

  const wagon = mover(stage, (s) => cart(s, inner, walls));
  // The blocks on the belt: the one leaving (plugged), the one being worked on, the one coming (loose).
  const leaving = mover(stage, (s) => { wiredBlock(s); cable(s, 1); });
  const coming = mover(stage, (s) => { wiredBlock(s); cable(s, 0); });
  const working = mover(stage, (s) => wiredBlock(s));
  // The cable being plugged in, as a run of stills from loose to home.
  const STILLS = 18;
  const stills: Mesh[] = [];
  for (let i = 0; i < STILLS; i++) stills.push(solid(stage, working, (s) => cable(s, i / (STILLS - 1))));

  const bot = robot(stage, 29);

  const BODY: Key[] = [[0, 15.2, 1.72, -16.75], [0.8, 15.2, 1.72, -16.75], [1.3, 15.25, 1.72, -17.12], [3.5, 15.25, 1.72, -17.12], [4, 15.2, 1.72, -16.75]];
  // The hand that steadies the block (x, y, z, grip).
  const STEADY: Key[] = [
    [0, 14.95, 1.45, -17.0, 0.2], [0.85, 14.95, 1.45, -17.0, 0.2], [1.3, place.x - 0.26, 1.36, place.z + 0.12, 0.5],
    [3.4, place.x - 0.26, 1.36, place.z + 0.12, 0.5], [3.7, 14.95, 1.45, -17.0, 0.2], [4, 14.95, 1.45, -17.0, 0.2],
  ];
  // The hand that plugs: waiting, then to the cable's end; from there it follows the cable.
  const WAIT: Key[] = [[0, 15.55, 1.45, -17.0, 0.2], [0.85, 15.55, 1.45, -17.0, 0.2], [1.3, 0, 0, 0, 0.2]];
  const grab = (u: number): [number, number, number] => {
    const pts = cablePoints(u);
    const e = pts[pts.length - 1];
    return [place.x + e[0], beltTop + e[1] + 0.3, place.z + e[2] + 0.08];
  };

  const update = (t: number): void => {
    const plugging = t >= 0.8 && t < 3.55;
    lamps[0].visible = !plugging;
    lamps[1].visible = plugging;

    // The cart waits at the belt's end, rolls off along -x with the finished block, and comes back empty.
    // (Far enough that it is off the screen wherever the camera is on its way to this station.)
    const FAR = 8.5;
    const away = t < 1.2 ? 0 : t < 2.4 ? ramp(t, 1.2, 2.4) ** 2 * FAR : t < 2.6 ? FAR : (1 - ramp(t, 2.6, 3.8)) ** 2 * FAR;
    wagon.position.set(wagonAt[0] - away, 0, wagonAt[2]);

    // The belt steps the blocks along: the finished one goes off the end, out over the cart's wall, and drops in.
    const move = ramp(t, 0.02, 0.8);
    const out = onBelt(mix(stops[2], stops[3], move));
    const end = onBelt(stops[3]).x;
    const fall = clamp01((clear - out.x) / (clear - end));
    leaving.visible = t < 2.4;
    leaving.position.set(Math.max(out.x, clear) - (clear - drop) * smooth(fall) - away, mix(beltTop, landed, fall * fall), out.z);
    leaving.rotation.set(0, out.turn, Math.sin(fall * Math.PI) * 0.15);
    const here = onBelt(t < 0.8 ? mix(stops[1], stops[2], move) : stops[2]);
    working.position.set(here.x, beltTop, here.z);
    working.rotation.y = here.turn;
    const there = onBelt(t < 0.8 ? mix(stops[0], stops[1], move) : stops[1]);
    coming.position.set(there.x, beltTop, there.z);
    coming.rotation.y = there.turn;

    // The cable goes home as the hand carries its end across.
    const u = ramp(t, 1.5, 2.3);
    const shown = Math.round(u * (STILLS - 1));
    for (let i = 0; i < STILLS; i++) stills[i].visible = i === shown;

    const body = along(BODY, t);
    const steady = along(STEADY, t);
    let plug: number[];
    const start = grab(0);
    if (t < 1.3) {
      plug = along(WAIT, t);
      const reach = ramp(t, 0.85, 1.3);
      if (t > 0.85) plug = [mix(15.55, start[0], reach), mix(1.45, start[1], reach), mix(-17.0, start[2], reach), 0.2];
    } else if (t < 3.3) {
      const g = grab(u);
      plug = [g[0], g[1], g[2], t > 1.42 ? 0.9 : 0.2];
    } else {
      const end = grab(1);
      const back = ramp(t, 3.3, 3.8);
      plug = [mix(end[0], 15.55, back), mix(end[1], 1.45, back), mix(end[2], -17.0, back), 0.2];
    }
    // It works the plug a little once it is on the post.
    const seatIn = ramp(t, 2.3, 2.45) * (1 - ramp(t, 3.1, 3.3));
    plug[1] += Math.sin(t * 11) * 0.012 * seatIn;
    bot.pose({
      body: [body[0], body[1], body[2]],
      facing: Math.PI / 2,
      left: arm(steady, { point: [0.15, -1, -0.2], palm: [1, 0, 0] }),
      // Its palm faces away from the body, so the hand's narrow side is what goes down between the fixed loops.
      right: arm(plug, { point: [-0.05, -1, -0.25], palm: [0, -0.2, -1] }),
      show: 1,
    });
    stage.trail.visit(body[0], body[2]);
  };

  return { period, update };
}

/** Build every station into the stage. */
export function buildStations(stage: Stage): Station[] {
  return [pickAndPlace(stage), sorting(stage), fastening(stage), connectors(stage)];
}
