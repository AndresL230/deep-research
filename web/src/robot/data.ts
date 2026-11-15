// What the 3D robot viewer reads from the server (deep_research/robot_view.py): the scene once, and each motion file
// as body poses per frame. MuJoCo runs on the server; the browser only places shapes where it is told.

export type GeomType = "mesh" | "cylinder" | "plane" | "box" | "sphere" | "capsule";

export interface SceneGeom {
  /** The body it is attached to (an index into the compiled model's bodies; 0 is the world). */
  body: number;
  type: GeomType;
  name: string;
  /** MuJoCo geom size: a cylinder's radius and half height, a box's half sizes. */
  size: number[];
  /** Position and orientation (w, x, y, z) in the body's frame. */
  pos: number[];
  quat: number[];
  rgba: number[];
  /** Key into `SceneData.meshes`, for type "mesh". */
  mesh?: string;
}

/** How to look at a scene (robot_view.VIEWS): where the camera looks and starts, the fog, and for the humanoid the body
 *  a push hits (the arrow points at it). */
export interface SceneView {
  target: number[];
  camera: number[];
  thumb_camera: number[];
  fog: number[];
  /** Half the side of the square the key light casts shadows in, meters. */
  shadow?: number;
  /** The floor grid: its size in meters and how many squares along a side. */
  grid?: number[];
  push_body?: string;
  push_body_id?: number;
}

export interface SceneData {
  model_id: string;
  bodies: { id: number; name: string }[];
  /** Decimated meshes as flat arrays: `v` x, y, z per vertex, `f` three vertex indices per triangle. */
  meshes: Record<string, { v: number[]; f: number[] }>;
  geoms: SceneGeom[];
  /** Absent from servers older than the humanoid: the arm's view is used. */
  view?: SceneView;
}

/** The arm's scene, the one a motion file without a `model_id` was recorded in. */
export const ARM_MODEL = "panda-can-v1";
/** The humanoid's (sim/humanoid/scene.py). */
export const G1_MODEL = "g1-push-v1";

/** A humanoid episode's push (sim/humanoid/episode.py): a force on the torso, pointing `angle_deg` counterclockwise
 *  from the robot's forward direction (0 pushes it forward: a shove from behind), for `duration_s` from `time_s`. */
export interface Push {
  angle_deg: number;
  force_n: number;
  time_s: number;
  duration_s: number;
}

/** The episode result of a motion file (sim/MOTION_FORMAT.md), the keys the viewer shows. */
export interface EpisodeResult {
  success?: boolean;
  place_error_cm?: number | null;
  upright?: boolean;
  dropped?: boolean;
  max_height_cm?: number;
  time_taken?: number;
  exception?: string | null;
  end_reason?: string;
  resting?: boolean;
  released?: boolean;
  tipped?: boolean;
  tilt_deg?: number;
  seed?: number;
  /** In a scene with a basket: whether the can's center ended inside it. */
  in_basket?: boolean;
  /** What was picked, when it is not the can: "milk". */
  target?: string;
  // Both humanoid sims say whether the robot fell.
  fell?: boolean;
  // The push recovery sim's (sim/humanoid/episode.py). `outcome` is one word: upright, stumbled, fell or error.
  outcome?: HumanoidOutcome;
  stumbled?: boolean;
  fall_time?: number | null;
  /** Push recovery: the first body other than a foot that touched the floor, such as "torso_link". Strike: whether
   *  anything touched the bag. */
  touched?: string | boolean | null;
  max_tilt_deg?: number | null;
  max_foot_shift_cm?: number | null;
  // The tracking sim's (sim/g1/track/episode.py): ExBody2's three errors against the reference (null when nothing was
  // measured), the reference's name and kind, and when the robot fell.
  e_vel?: number | null;
  e_mpkpe?: number | null;
  e_mpkpe_upper?: number | null;
  e_mpkpe_lower?: number | null;
  e_mpjpe?: number | null;
  e_mpjpe_upper?: number | null;
  e_mpjpe_lower?: number | null;
  tracked_s?: number | null;
  fell_at?: number | null;
  motion?: string | null;
  kind?: string | null;
  // The strike sim's (sim/g1/episode.py): the bag swung far enough, what touched it first ("right foot"), how far it
  // swung at most, and whether the robot ended on both feet.
  struck?: boolean;
  struck_with?: string | null;
  bag_peak_cm?: number;
  standing?: boolean;
}

/** sim/humanoid/outcome.py OUTCOMES. */
export type HumanoidOutcome = "upright" | "stumbled" | "fell" | "error";

/** What a tracking episode followed (sim/g1/track/motions.py): a motion capture clip fitted to the robot. */
export interface Reference {
  name: string;
  kind: string | null;
  description: string;
  seconds?: number | null;
  lead_in?: number;
}

export interface MotionData {
  /** The scene it was recorded in (robot_view.MODELS). Absent from servers older than the humanoids: the arm. */
  model_id?: string;
  /** A strike episode: where the bag's center hung, x, y, z. */
  bag_pos?: number[] | null;
  /** A tracking episode: what it followed, and where the reference has every body of `bodies` at each frame's time
   *  (the layout of `frames`), drawn as a ghost behind the robot. No ghost when the server has not got the reference. */
  reference?: Reference | null;
  ghost?: number[][];
  fps: number;
  can_start: number[] | null;
  place_target: number[] | null;
  /** A humanoid episode's push; null or absent for the arm. */
  push?: Push | null;
  result: EpisodeResult;
  /** Frames. */
  n: number;
  /** Each frame's sim time, seconds. */
  t: number[];
  /** The moving bodies, in the order of each frame's poses. */
  bodies: number[];
  /** Per frame: x, y, z, qw, qx, qy, qz for each body in `bodies`, world frame (z up). */
  frames: number[][];
  /** Bodies that never move in this file (the base, the place zone), same seven numbers. */
  static: Record<string, number[]>;
  /** A file recorded in a scene with a basket and other objects: their geoms, drawn on top of the scene's own. Their
   *  bodies are in `bodies` like any other. Absent for the bare scene. */
  extra?: SceneGeom[];
  /** Names of scene geoms this file does not have: "place_zone" where a basket stands in its place. */
  hide?: string[];
}

export interface MotionSummary {
  /** A humanoid episode: where the bag's center hung. */
  bag_pos?: number[] | null;
  /** A tracking episode: what it followed. */
  reference?: Pick<Reference, "name" | "kind" | "description"> | null;
  can_start?: number[] | null;
  place_target?: number[] | null;
  push?: Push | null;
  duration?: number | null;
  n?: number;
  result?: EpisodeResult;
  /** Set instead of the rest when the file cannot be read. */
  error?: string;
}

/** The server's own reason a read failed (its `detail`), as opposed to a network error or a bare status. */
export class ServerError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try { const j = (await res.json()) as { detail?: unknown }; detail = typeof j.detail === "string" ? j.detail : ""; } catch { /* no body */ }
    if (detail) throw new ServerError(detail, res.status);
    throw new Error(`The server answered HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const batchPath = (id: string): string => `/api/batches/${encodeURIComponent(id)}`;

const scenes = new Map<string, Promise<SceneData>>();
/** The scene a motion file was recorded in (`MotionData.model_id`; absent: the arm's), fetched once per page. */
export function fetchScene(modelId?: string | null): Promise<SceneData> {
  const id = modelId || ARM_MODEL;
  let p = scenes.get(id);
  if (!p) {
    // The arm's is the route's default, asked for without a parameter so an older server answers it too.
    p = getJson<SceneData>(id === ARM_MODEL ? "/api/robot/scene" : `/api/robot/scene?model=${encodeURIComponent(id)}`);
    p.catch(() => { scenes.delete(id); });
    scenes.set(id, p);
  }
  return p;
}

const MOTION_CACHE = 80;
const motions = new Map<string, Promise<MotionData>>();
/** How many times a file has changed on the server since the page loaded (a live run saving it again). */
const revisions = new Map<string, number>();

/** One motion file's poses, kept for the page (the thumbnails and the run view share them). */
export function fetchMotion(batch: string, path: string): Promise<MotionData> {
  const key = `${batch}\n${path}`;
  let p = motions.get(key);
  if (p) { motions.delete(key); motions.set(key, p); return p; }
  const rev = revisions.get(key);
  p = getJson<MotionData>(`${batchPath(batch)}/motion?path=${encodeURIComponent(path)}${rev ? `&rev=${rev}` : ""}`);
  p.catch(() => motions.delete(key));
  motions.set(key, p);
  while (motions.size > MOTION_CACHE) motions.delete(motions.keys().next().value as string);
  return p;
}

/**
 * A live run's motion file arrived from its VM (a `motion` event): new, or saved again with new content under the same
 * path. Forget what was fetched for it, so the next `fetchMotion` gets the new content. Returns whether anything was
 * fetched before (a view showing it then needs to load it again).
 */
export function motionChanged(batch: string, path: string): boolean {
  const key = `${batch}\n${path}`;
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  return motions.delete(key);
}

/** Can start, place target, length and result of each file, for the picker. */
export function fetchSummaries(batch: string, paths: string[]): Promise<Record<string, MotionSummary>> {
  const q = paths.map((p) => `path=${encodeURIComponent(p)}`).join("&");
  return getJson<Record<string, MotionSummary>>(`${batchPath(batch)}/motion-summaries?${q}`);
}
