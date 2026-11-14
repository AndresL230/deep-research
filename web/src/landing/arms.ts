// A robot on the floor: two arms with hands, and nothing else that is solid. Its body is a cloud of dots
// (contour.ts) between the shoulders, and it throws a round patch on the floor under it.
//
// A pose says where the body is and where each wrist should be; the elbows are worked out from that. Each arm is
// three groups (upper arm, forearm, hand) that are placed and turned every frame.

import { Group, Matrix4, Mesh, Quaternion, Vector3, type Color, type Material } from "three";
import { LAYER, type Cloud, type Contour, type Tint } from "./contour";
import { Sculpt, nextMark } from "./rig";

/** An arm's lengths: shoulder to elbow, elbow to wrist, and wrist to where a hand holds something. */
export const UPPER = 0.585;
export const FORE = 0.55;
export const REACH = 0.22;
/** Half the distance between the shoulders, and the cloud's size. */
export const SHOULDER = 0.3;
const CLOUD = { width: 1.0, height: 1.7, drop: 0.1 };

export type V3 = readonly [number, number, number];

export interface ArmPose {
  /** Where the wrist is, in the scene. */
  wrist: V3;
  /** How closed the hand is: 0 open, 1 a fist. */
  grip?: number;
  /** Which way the elbow leans, if not the usual way (out, back and down). */
  elbow?: V3;
  /** Which way the palm faces, if not down. */
  palm?: V3;
  /** Which way the fingers point, if not on along the forearm. */
  point?: V3;
}

export interface RobotPose {
  /** The point midway between the shoulders. */
  body: V3;
  /** Which way it faces: the angle of its front about the upright axis (0 faces +x, a quarter turn faces -z). */
  facing: number;
  left: ArmPose;
  right: ArmPose;
  /** How much of its cloud shows, 0 to 1. */
  show?: number;
}

export interface Robot {
  group: Group;
  shadow: Mesh;
  cloud: Cloud;
  pose(p: RobotPose): void;
  /** Where a hand holds something, and which way that hand is turned, after the last pose. */
  hold(side: "left" | "right"): { at: Vector3; turn: Quaternion };
}

interface Arm {
  upper: Group;
  fore: Group;
  hand: Group;
  knuckles: Group;
  tips: Group;
  thumb: Group;
  at: Vector3;
  turn: Quaternion;
}

const UP = new Vector3(0, 1, 0);
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const dir = new Vector3();
const side = new Vector3();
const elbow = new Vector3();
const basis = new Matrix4();
const X = new Vector3();
const Y = new Vector3();
const Z = new Vector3();

/** Turn `group` so its +y runs along `along` and its +z leans toward `lean`. */
function aim(group: Group, along: Vector3, lean: Vector3): void {
  Y.copy(along).normalize();
  Z.copy(lean).addScaledVector(Y, -lean.dot(Y));
  if (Z.lengthSq() < 1e-6) Z.set(Y.y, -Y.x, 0);
  if (Z.lengthSq() < 1e-6) Z.set(0, 0, 1);
  Z.normalize();
  X.crossVectors(Y, Z);
  basis.makeBasis(X, Y, Z);
  group.quaternion.setFromRotationMatrix(basis);
}

function buildArm(tints: Record<Tint, Color>, material: Material, redTips: boolean, mirror: number): Arm {
  const mesh = (s: Sculpt): Mesh => s.mesh(material);

  // The upper arm: a sleeve from the shoulder, round at the top, with the joint's ball showing beside it.
  const u = new Sculpt(tints);
  const sleeve = nextMark();
  u.cyl(0.105, UPPER - 0.07, 0, 0, 0, "arm", { mark: sleeve, seg: 26 });
  u.ball(0.105, 0, 0, 0, "arm", sleeve);
  u.ball(0.08, 0, 0.012, 0.056, "accent");
  u.ball(0.042, 0, 0.03, 0.106, "arm");
  // The elbow's ball.
  u.ball(0.092, 0, UPPER, 0, "accent");
  const upper = new Group();
  upper.add(mesh(u));

  // The forearm: a sleeve that narrows to the wrist, and the wrist's ball.
  const f = new Sculpt(tints);
  const cuff = nextMark();
  f.cyl(0.102, FORE - 0.1, 0, 0.05, 0, "arm", { top: 0.08, mark: cuff, seg: 26 });
  f.ball(0.1, 0, 0.06, 0, "arm", cuff);
  f.ball(0.068, 0, FORE - 0.01, 0, "accent");
  const fore = new Group();
  fore.add(mesh(f));

  // The hand: a pin, a palm, four fingers in two joints and a thumb. Its fingers run along +y and its palm
  // faces -z.
  const h = new Sculpt(tints);
  h.cyl(0.046, 0.17, 0, 0.045, -0.085, "steel", { axis: "z", seg: 14 });
  h.box(0.17, 0.13, 0.066, 0, 0.06, 0, "steel");
  const hand = new Group();
  hand.add(mesh(h));

  const fingers = [-0.064, -0.021, 0.021, 0.064];
  const k = new Sculpt(tints);
  for (const x of fingers) k.box(0.036, 0.09, 0.04, x, 0, 0, "steel");
  const knuckles = new Group();
  knuckles.position.set(0, 0.19, 0);
  knuckles.add(mesh(k));

  const t = new Sculpt(tints);
  for (const x of fingers) {
    t.box(0.032, 0.05, 0.036, x, 0, 0, "steel");
    t.box(0.032, 0.026, 0.036, x, 0.05, 0, redTips ? "red" : "steel");
  }
  const tips = new Group();
  tips.position.set(0, 0.09, 0);
  tips.add(mesh(t));
  knuckles.add(tips);
  hand.add(knuckles);

  const th = new Sculpt(tints);
  th.box(0.04, 0.08, 0.038, 0, 0, 0, "steel");
  th.box(0.035, 0.055, 0.034, 0, 0.08, 0, "steel");
  const thumb = new Group();
  thumb.position.set(mirror * 0.095, 0.09, -0.028);
  thumb.rotation.z = -mirror * 0.5;
  thumb.add(mesh(th));
  hand.add(thumb);

  return { upper, fore, hand, knuckles, tips, thumb, at: new Vector3(), turn: new Quaternion() };
}

/** A robot. Add its `group`, its `shadow` and its cloud's mesh to the scene; `seed` gives its cloud its own
 *  pattern. */
export function buildRobot(contour: Contour, tints: Record<Tint, Color>, seed: number): Robot {
  const group = new Group();
  const arms = { left: buildArm(tints, contour.paint, true, 1), right: buildArm(tints, contour.paint, false, -1) };
  for (const arm of [arms.left, arms.right]) group.add(arm.upper, arm.fore, arm.hand);
  group.traverse((o) => { o.layers.set(LAYER.solid); o.frustumCulled = false; });
  const shadow = contour.shadow(0.42);
  const cloud = contour.cloud(CLOUD.width, CLOUD.height, seed);

  const front = new Vector3();
  const right = new Vector3();
  const shoulder = new Vector3();
  const wrist = new Vector3();
  const lean = new Vector3();
  const palm = new Vector3();

  const place = (arm: Arm, p: ArmPose, sign: number): void => {
    wrist.set(p.wrist[0], p.wrist[1], p.wrist[2]);
    dir.subVectors(wrist, shoulder);
    // The wrist cannot be farther than the arm is long, or nearer than it can fold.
    const most = UPPER + FORE - 0.004;
    const least = Math.abs(UPPER - FORE) + 0.05;
    let d = dir.length();
    if (d > most) { wrist.copy(shoulder).addScaledVector(dir, most / d); d = most; }
    if (d < least) { wrist.copy(shoulder).addScaledVector(dir.lengthSq() > 0 ? dir.normalize() : dir.set(0, -1, 0), least); d = least; }
    dir.subVectors(wrist, shoulder).normalize();
    // The elbow: on the circle both joints allow, on the side the lean asks for.
    if (p.elbow) lean.set(p.elbow[0], p.elbow[1], p.elbow[2]);
    else lean.copy(right).multiplyScalar(sign * 0.55).addScaledVector(front, -0.75).addScaledVector(UP, -0.45);
    side.copy(lean).addScaledVector(dir, -lean.dot(dir));
    if (side.lengthSq() < 1e-6) side.copy(UP).addScaledVector(dir, -dir.y);
    side.normalize();
    const along = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
    const off = Math.sqrt(Math.max(0, UPPER * UPPER - along * along));
    elbow.copy(shoulder).addScaledVector(dir, along).addScaledVector(side, off);

    arm.upper.position.copy(shoulder);
    aim(arm.upper, a.subVectors(elbow, shoulder), b.copy(right).multiplyScalar(sign));
    arm.fore.position.copy(elbow);
    aim(arm.fore, a.subVectors(wrist, elbow), b.copy(right).multiplyScalar(sign));

    // The hand goes on from the wrist, palm down unless told.
    if (p.point) a.set(p.point[0], p.point[1], p.point[2]).normalize();
    else a.subVectors(wrist, elbow).normalize();
    if (p.palm) palm.set(p.palm[0], p.palm[1], p.palm[2]);
    else palm.set(0, -1, 0);
    arm.hand.position.copy(wrist);
    // The hand's -z is its palm.
    aim(arm.hand, a, c.copy(palm).multiplyScalar(-1));
    const grip = p.grip ?? 0.25;
    arm.knuckles.rotation.x = -grip * 1.15;
    arm.tips.rotation.x = -grip * 1.25;
    arm.thumb.rotation.x = -grip * 0.7;
    arm.turn.copy(arm.hand.quaternion);
    arm.at.set(0, REACH, -0.06).applyQuaternion(arm.turn).add(wrist);
  };

  return {
    group,
    shadow,
    cloud,
    pose(p) {
      front.set(Math.cos(p.facing), 0, -Math.sin(p.facing));
      right.set(-front.z, 0, front.x);
      const [x, y, z] = p.body;
      shoulder.set(x, y, z).addScaledVector(right, -SHOULDER);
      place(arms.left, p.left, -1);
      shoulder.set(x, y, z).addScaledVector(right, SHOULDER);
      place(arms.right, p.right, 1);
      shadow.position.set(x, shadow.position.y, z);
      cloud.centre.set(x, y - CLOUD.drop, z).addScaledVector(front, -0.08);
      cloud.show(p.show ?? 1);
    },
    hold(which) { return arms[which]; },
  };
}
