// The robot viewer's markup for the views (pure: no DOM, no three.js). A robot batch (`config.visual === "motion"`)
// shows a run's episodes in 3D where a tabular run shows its charts.
//
// The views put a `data-keep` placeholder in the page: morph.ts leaves it alone, and robot/mount.ts fills it with the
// viewer (loading three.js only then). A placeholder never changes after it is drawn, so everything it needs is in its
// attributes and in its `data-morph-key`: when the list of files changes, the key does, and a new one replaces it.

import { attr, esc } from "../ui";
import type { EpisodeResult } from "./data";

/** The batch draws its runs as robot motion. */
export const isMotionBatch = (config: unknown): boolean => (config as { visual?: unknown } | null)?.visual === "motion";

/** "runs/r01/outputs/live/far_left_tuned.motion.json" -> "far_left_tuned". */
export function motionName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.motion\.json$/i, "").replace(/\.json$/i, "") || base;
}

const cm = (x: number): string => `${x < 10 ? x.toFixed(1) : Math.round(x)} cm`;

/** One line for an episode: "Placed 0.8 cm from target", "Dropped the can", "Missed by 12 cm". */
export function resultText(r: EpisodeResult | null | undefined): string {
  if (!r) return "";
  if (r.exception) return "Controller error";
  const err = typeof r.place_error_cm === "number" ? r.place_error_cm : null;
  if (r.success) return err != null ? `Placed ${cm(err)} from target` : "Placed";
  if (r.dropped) return "Dropped the can";
  if (r.upright === false || r.tipped) return "Can tipped over";
  // Close enough but not a success: say what else was wrong (sim/episode.py: within 3 cm, upright, resting, released).
  if (err != null && err > 3) return `Missed by ${cm(err)}`;
  if (r.released === false) return "Still holding the can";
  if (r.resting === false) return r.end_reason === "max_time" ? "Ran out of time" : "Can not resting";
  if (err != null) return `Missed by ${cm(err)}`;
  return "Not placed";
}

export type ResultTone = "ok" | "bad" | "none";
export const resultTone = (r: EpisodeResult | null | undefined): ResultTone => (!r || r.success == null ? "none" : r.success ? "ok" : "bad");

/** The small facts under the result: "upright", "lifted 13 cm", "settled". */
export function resultFacts(r: EpisodeResult | null | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (typeof r.place_error_cm === "number") out.push(`${cm(r.place_error_cm)} from target`);
  if (r.dropped) out.push("dropped");
  if (r.upright === true) out.push("upright");
  else if (r.upright === false) out.push(typeof r.tilt_deg === "number" ? `tipped ${Math.round(r.tilt_deg)}°` : "tipped");
  if (typeof r.max_height_cm === "number" && r.max_height_cm > 0.5) out.push(`lifted ${cm(r.max_height_cm)}`);
  // How it ended, when that is news (most episodes end because the controller finished or the can settled).
  if (r.end_reason && !["controller_done", "settled"].includes(r.end_reason)) out.push(r.end_reason.replace(/_/g, " "));
  return out;
}

/** "(0.50, -0.10)". */
export const xy = (p: number[] | null | undefined): string => (p && p.length >= 2 ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : "");

/** "3.2 s". */
export const seconds = (t: number): string => `${(Math.max(0, t)).toFixed(1)} s`;

/**
 * The run page's viewer: the 3D replay of one of `files` (the last by default), its controls and the file picker.
 * `files` are batch-relative paths (`RunRecord.motion_files`).
 */
export function robotView(batch: string, key: string, files: string[]): string {
  if (!files.length) {
    return `<div class="rb-none" data-morph-key="rb-none:${attr(key)}">No motion files from this run: it did not record an episode.</div>`;
  }
  const morphKey = `rb:${key}:${files.length}:${files.at(-1)}`;
  return `<div class="rb" data-keep data-robot-view data-batch="${attr(batch)}" data-files="${attr(JSON.stringify(files))}" data-morph-key="${attr(morphKey)}">`
    + `<div class="rb-stage"><div class="rb-loading">Loading the robot…</div></div>`
    + `</div>`;
}

/** A small looping replay of one motion file, for a run's tile on the batch page. */
export function robotThumb(batch: string, file: string): string {
  return `<div class="rb-thumb" data-keep data-robot-thumb data-batch="${attr(batch)}" data-file="${attr(file)}" data-morph-key="${attr(`rbt:${file}`)}">`
    + `<span class="rb-thumb-l">${esc(motionName(file))}</span>`
    + `</div>`;
}
