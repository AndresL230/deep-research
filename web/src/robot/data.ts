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

export interface SceneData {
  model_id: string;
  bodies: { id: number; name: string }[];
  /** Decimated meshes as flat arrays: `v` x, y, z per vertex, `f` three vertex indices per triangle. */
  meshes: Record<string, { v: number[]; f: number[] }>;
  geoms: SceneGeom[];
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
}

export interface MotionData {
  fps: number;
  can_start: number[] | null;
  place_target: number[] | null;
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
}

export interface MotionSummary {
  can_start?: number[] | null;
  place_target?: number[] | null;
  duration?: number | null;
  n?: number;
  result?: EpisodeResult;
  /** Set instead of the rest when the file cannot be read. */
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try { const j = (await res.json()) as { detail?: unknown }; detail = typeof j.detail === "string" ? j.detail : ""; } catch { /* no body */ }
    throw new Error(detail || `The server answered HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const batchPath = (id: string): string => `/api/batches/${encodeURIComponent(id)}`;

let scenePromise: Promise<SceneData> | null = null;
/** The scene, fetched once per page. */
export function fetchScene(): Promise<SceneData> {
  if (!scenePromise) {
    scenePromise = getJson<SceneData>("/api/robot/scene");
    scenePromise.catch(() => { scenePromise = null; });
  }
  return scenePromise;
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
