// The robot viewer's markup for the views (pure: no DOM, no three.js). A robot batch (`config.visual === "motion"`)
// shows a run's episodes in 3D where a tabular run shows its charts.
//
// The views put a `data-keep` placeholder in the page: morph.ts leaves it alone, and robot/mount.ts fills it with the
// viewer (loading three.js only then). A placeholder never changes after it is drawn, so everything it needs is in its
// attributes and in its `data-morph-key`: when the list of files changes, the key does, and a new one replaces it.

import { attr, esc } from "../ui";
import { ServerError, type EpisodeResult, type Push } from "./data";
import { domainWords } from "../batch/words";

/** The batch draws its runs as robot motion. */
export const isMotionBatch = (config: unknown): boolean => (config as { visual?: unknown } | null)?.visual === "motion";

/** The batch is a humanoid push recovery one (deep_research/domains/humanoid_push.py). */
export const isPushBatch = (config: unknown): boolean => (config as { domain?: unknown } | null)?.domain === "humanoid_push";
/** The research paper a batch's test builds on, when it builds on one. */
export interface ResearchSource {
  /** The paper's short name and its arXiv number, for the link's text. */
  name: string;
  paper: string;
  url: string;
  /** What is taken from the paper and where it runs, in one sentence. */
  text: string;
  /** The paper itself, for its page: full title, authors and year. */
  title: string;
  authors: string;
  year: number;
  /** The batch's setup, one table: [what, how]. `E_vel` is set as the symbol it is in the paper. */
  setup: [string, string][];
}

/**
 * The research a batch builds on: LIBERO-PRO for a robot arm batch measured at its positions, ExBody2 for a tracking
 * batch. Null for the others. The sentence says what is borrowed and that it runs in Orro's own simulator.
 */
export function researchSource(config: unknown): ResearchSource | null {
  const c = config as { domain?: unknown; robot_positions?: unknown } | null;
  if (c?.domain === "humanoid_track") {
    return {
      name: "ExBody2", paper: "arXiv:2412.13196", url: "https://arxiv.org/abs/2412.13196",
      text: "Built on the ExBody2 research paper: its task (whole-body motion tracking on the Unitree G1) and its three tracking errors, "
        + "run in Orro's own simulator with controllers written by AI agents.",
      title: "ExBody2: Advanced Expressive Humanoid Whole-Body Control",
      authors: "Mazeyu Ji, Xuanbin Peng, Fangchen Liu, Jialong Li, Ge Yang, Xuxin Cheng, Xiaolong Wang", year: 2024,
      setup: [
        ["Robot", "Unitree G1 humanoid"],
        ["Task", "Follow a reference motion with the whole body"],
        ["Measures", "E_vel, E_mpkpe and E_mpjpe: the error in root velocity, key body positions and joint angles"],
        ["Test", "Practice on one motion, then 20 held-out motions"],
        ["Motion data", "CMU motion capture clips, fitted to the robot with the feet planted"],
        ["Controller", "Code written by an AI agent"],
        ["Simulator", "Orro's own MuJoCo scene"],
      ],
    };
  }
  if (c?.robot_positions === "libero_pro" && (c.domain == null || c.domain === "robot_arm")) {
    return {
      name: "LIBERO-PRO", paper: "arXiv:2510.03827", url: "https://arxiv.org/abs/2510.03827",
      text: "Built on the LIBERO-PRO research paper: LIBERO's objects and layouts and LIBERO-PRO's position changes, "
        + "run in Orro's own simulator.",
      title: "LIBERO-PRO: Towards Robust and Fair Evaluation of Vision-Language-Action Models Beyond Memorization",
      authors: "Xueyang Zhou, Yangming Xu, Guiyao Tie, Yongchao Chen, Guowen Zhang, Duanfeng Chu, Pan Zhou, Lichao Sun", year: 2025,
      setup: [
        ["Robot", "Franka Panda arm"],
        ["Task", "Pick a grocery object up and put it in the basket"],
        ["Objects", "The basket and ten grocery objects of LIBERO"],
        ["Layouts", "The ten tasks of the LIBERO-Object suite"],
        ["Test", "LIBERO-PRO's position changes, objects swapped and shifted: 30 episodes"],
        ["Success", "The object ends at rest inside the basket"],
        ["Controller", "Code written by an AI agent"],
        ["Simulator", "Orro's own MuJoCo scene"],
      ],
    };
  }
  return null;
}

const EXTERNAL = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The link to a batch's paper: "ExBody2, arXiv:2412.13196", opening arXiv in a new tab. Empty for a batch with none. */
export function researchLink(config: unknown): string {
  const r = researchSource(config);
  if (!r) return "";
  return `<a class="rs-link" href="${attr(r.url)}" target="_blank" rel="noopener" title="${attr(r.text)}">${esc(`${r.name}, ${r.paper}`)}${EXTERNAL}</a>`;
}

/** A batch's research line: a "Research" tag, what is borrowed, and the link. `compact` is the tag and the link alone
 *  (the run page's header), with the sentence as the link's tooltip. Empty for a batch that builds on no paper. */
export function researchNote(config: unknown, compact = false): string {
  const r = researchSource(config);
  if (!r) return "";
  const tag = `<span class="rs-tag">Research</span>`;
  if (compact) return `<span class="rs rs--compact" data-morph-key="research">${tag}${researchLink(config)}</span>`;
  return `<p class="rs" data-morph-key="research">${tag}<span class="rs-t">${esc(r.text)}</span>${researchLink(config)}</p>`;
}

/** A table cell's text with the paper's symbols set as symbols: `E_vel` is an italic E with "vel" below the line. */
const symbols = (text: string): string => esc(text).replace(/\bE_([a-z]+)\b/g, "<i>E</i><sub>$1</sub>");

/**
 * A batch's paper, as one of the batch page's own cards: a "Research paper" tag, the title, the authors and the year,
 * a link to the paper on arXiv, and the batch's setup as one list of what and how, in two columns. The rows show one
 * after another when the card first appears (robot.css; at once for a reader who asked for less motion). Empty for a
 * batch that builds on no paper.
 *
 * The list is the batch's setup, as its heading says, and its rows are fixed text written when the domain was
 * built: nothing reads the paper while the page loads, and the card does not say that anything does.
 */
export function researchCard(config: unknown): string {
  const r = researchSource(config);
  if (!r) return "";
  const rows = r.setup.map(([what, how], i) => `<div class="rp-row" style="--i:${i}"><dt>${esc(what)}</dt><dd>${symbols(how)}</dd></div>`).join("");
  return `<section class="ov-card rp" data-morph-key="research" aria-label="${attr(`Research paper: ${r.name}`)}">`
    + `<div class="rp-head">`
    + `<div class="rp-id">`
    + `<span class="ds-eyebrow">Research paper</span>`
    + `<h3 class="rp-title">${esc(r.title)}</h3>`
    + `<p class="rp-authors">${esc(`${r.authors} · ${r.year}`)}</p>`
    + `</div>`
    + `<a class="rp-open" href="${attr(r.url)}" target="_blank" rel="noopener" title="Open the paper on arXiv">${esc(r.paper)}${EXTERNAL}</a>`
    + `</div>`
    + `<div class="rp-setup">`
    + `<h4 class="rp-sub">Setup of this batch</h4>`
    + `<dl class="rp-list" style="--rows:${Math.ceil(r.setup.length / 2)}">${rows}</dl>`
    + `</div>`
    + `</section>`;
}

/** The batch is a tracking one: its hidden test is reference motions, not positions. */
export const isTrackBatch = (config: unknown): boolean => (config as { domain?: unknown } | null)?.domain === "humanoid_track";

/**
 * What the player shows when an episode cannot be loaded. A sentence from the server (such as a batch from another
 * machine whose recording is not on the team hub yet) is shown as it is. A bare "no batch ..." is never shown: the
 * page around the player loaded, so the batch plainly exists. Anything else is prefixed.
 */
export function episodeError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  if (/^no batch\b/i.test(msg)) return "This episode's recording isn't on this machine or on the team hub.";
  if (e instanceof ServerError && /^[A-Z]/.test(msg)) return msg;
  return `Couldn't load this episode: ${msg || "unknown error"}`;
}

/** A file picker entry's note when its summary could not be read. */
export function summaryErrorText(error: string): string {
  return /isn't on the hub/i.test(error) ? "not on the hub yet" : "can't be read";
}

/** "runs/r01/outputs/live/far_left_tuned.motion.json" -> "far_left_tuned". A hidden episode's recording
 *  ("runs/r02/hidden/07-s1.motion.json", sim/evaluate.py, positions counted from 0) -> "Hidden position 8, seed 1",
 *  or "Hidden push 8, seed 1" with `noun` "push" (a humanoid's). */
export function motionName(path: string, noun: "position" | "push" = "position"): string {
  const hidden = /(?:^|\/)hidden\/(\d+)-s(\d+)\.motion\.json$/i.exec(path);
  if (hidden) return `Hidden ${noun} ${Number(hidden[1]) + 1}${hidden[2] !== "0" ? `, seed ${hidden[2]}` : ""}`;
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.motion\.json$/i, "").replace(/\.json$/i, "") || base;
}

/** The success rule's radius (sim/episode.py SUCCESS_RADIUS): the can's center must end within this of the place
 *  target's center, standing upright and at rest. The 3D viewer draws its ring from this number too. */
export const SUCCESS_RADIUS_CM = 3;

/** A humanoid strike's rule (sim/g1/episode.py STRIKE_DISTANCE): the bag's center must swing this far from rest. */
export const STRIKE_CM = 20;

/** "0.8 cm", "12 cm". */
export const cm = (x: number): string => `${x < 10 ? x.toFixed(1) : Math.round(x)} cm`;

/** The success ring's key: an info mark in the player's bar, these words its tooltip. */
export const SUCCESS_LEGEND = `Green ring: success area. The can counts as placed if its center ends inside the ring (within ${SUCCESS_RADIUS_CM} cm of the center), standing upright, and at rest.`;
/** The same line for an episode in a scene with a basket (a recording with `hide: ["place_zone"]`): no ring there. */
export const BASKET_LEGEND = "The object counts as placed when it ends inside the basket, at rest and let go of. It need not stand upright. The basket and the other objects can be pushed.";
/** True for a recording made in a scene where a basket stands in place of the place zone. */
export const hasBasket = (m: { hide?: string[] } | null | undefined): boolean => !!m?.hide?.includes("place_zone");

/** The legend under the player for a strike episode. */
export const STRIKE_LEGEND = `The strike counts when the bag swings at least ${STRIKE_CM} cm from where it hung and the robot never falls: nothing but its feet may touch the floor.`;

/** A strike episode's result (sim/g1/episode.py), told from the arm's and the push recovery sim's by the key only it has. */
export const isStrike = (r: EpisodeResult | null | undefined): boolean => !!r && typeof r.struck === "boolean";

/** One line for a humanoid episode: "Struck with the right foot", "Fell after hitting the bag", "Missed the bag". */
function strikeText(r: EpisodeResult): string {
  const part = r.struck_with ? ` with the ${r.struck_with}` : "";
  if (r.success) return `Struck${part}`;
  if (r.fell) return r.touched ? "Fell after hitting the bag" : "Fell without touching the bag";
  if (r.touched) return `Hit too weak${part}`;
  return r.end_reason === "max_time" ? "Never touched the bag" : "Missed the bag";
}

/** The limits a tracking episode must stay under (sim/g1/track/episode.py). */
export const TRACK_CM = 6;
export const TRACK_RAD = 0.05;

/** The legend under the player for a tracking episode. */
export const TRACK_LEGEND = `Blue ghost: the reference motion, a motion capture clip fitted to the robot. The episode counts when the robot never falls and stays close to the reference: key bodies within ${TRACK_CM} cm and joint angles within ${TRACK_RAD} rad on average.`;

/** A tracking episode's result (sim/g1/track/episode.py), told from the others by the key only it has. */
export const isTrack = (r: EpisodeResult | null | undefined): boolean => !!r && "e_mpkpe" in r;

const rad = (x: number): string => `${x.toFixed(3)} rad`;

/** "Tracked within 2.3 cm", "Fell at 2.8 s", "Off track: 9.1 cm and 0.020 rad off". */
function trackText(r: EpisodeResult): string {
  if (r.exception) return "Controller error";
  if (r.success && typeof r.e_mpkpe === "number") return `Tracked within ${cm(r.e_mpkpe * 100)}`;
  if (r.fell) return `Fell${typeof r.fell_at === "number" ? ` at ${seconds(r.fell_at)}` : ""}`;
  if (typeof r.e_mpkpe === "number" && typeof r.e_mpjpe === "number") return `Off track: ${cm(r.e_mpkpe * 100)} and ${rad(r.e_mpjpe)} off`;
  return r.success ? "Tracked" : "Off track";
}

/** "wash windows · demanding": what a tracking episode followed, for a file's line in the picker and the caption. */
export const referenceText = (ref: { description?: string; name: string; kind?: string | null } | null | undefined): string =>
  (ref ? [ref.description || ref.name, ref.kind].filter(Boolean).join(" · ") : "");

/** The legend under the run page's player for a push recovery episode. */
export const PUSH_LEGEND = "Red arrow: the push, drawn while it lasts (longer for a harder push). The robot counts as "
  + "standing if it is still on its feet at the end: its pelvis never dropped below 0.45 m and nothing but its feet "
  + "touched the floor.";

/** Where a push comes from (sim/humanoid/symptoms.py `direction_words`): angle 0 pushes the robot forward, so it comes
 *  "from behind"; 180 "from the front"; 90 pushes it to its left, "from the right". */
export function pushFrom(angleDeg: number): string {
  const names = ["from behind", "from behind and the right", "from the right", "from the front and the right",
    "from the front", "from the front and the left", "from the left", "from behind and the left"];
  const a = ((angleDeg % 360) + 360) % 360;
  return names[Math.floor(((a + 22.5) % 360) / 45)];
}

/** "40 N from the front". */
export const pushText = (p: Pick<Push, "angle_deg" | "force_n"> | null | undefined): string =>
  (p && Number.isFinite(p.angle_deg) && Number.isFinite(p.force_n) ? `${Math.round(p.force_n)} N ${pushFrom(p.angle_deg)}` : "");

/** The humanoid's result in one line: "Stayed upright", "Stumbled, stayed up", "Fell at 2.8 s". */
function humanoidText(r: EpisodeResult): string {
  switch (r.outcome) {
    case "upright": return "Stayed upright";
    case "stumbled": return "Stumbled, stayed up";
    case "fell": return typeof r.fall_time === "number" ? `Fell at ${seconds(r.fall_time)}` : "Fell";
    default: return "Controller error";
  }
}

/** One line for an episode: "Placed 0.8 cm from center", "Dropped the can", "Missed by 12 cm"; for the humanoid
 *  "Stayed upright", "Fell at 2.8 s". */
export function resultText(r: EpisodeResult | null | undefined): string {
  if (!r) return "";
  if (r.exception) return "Controller error";
  if (r.outcome) return humanoidText(r);
  if (isStrike(r)) return strikeText(r);
  if (isTrack(r)) return trackText(r);
  const err = typeof r.place_error_cm === "number" ? r.place_error_cm : null;
  if (r.success) return r.in_basket ? "In the basket" : err != null ? `Placed ${cm(err)} from center` : "Placed";
  const thing = r.target ? r.target.replace(/_/g, " ") : "can";
  if (r.dropped) return `Dropped the ${thing}`;
  if (r.upright === false || r.tipped) return r.target ? `The ${thing} tipped over` : "Can tipped over";
  // Close enough but not a success: say what else was wrong (sim/episode.py: within 3 cm, upright, resting, released).
  if (err != null && err > SUCCESS_RADIUS_CM) return `Missed by ${cm(err)}`;
  if (r.released === false) return `Still holding the ${thing}`;
  if (r.resting === false) return r.end_reason === "max_time" ? "Ran out of time" : "Can not resting";
  if (err != null) return `Missed by ${cm(err)}`;
  return "Not placed";
}

/** The same in one word, for the run page's episode list: "placed", "dropped", "tipped", "missed", "error"; for the
 *  humanoid "upright", "stumbled", "fell", or "struck", "weak", "missed", or "tracked", "off track". */
export function resultWord(r: EpisodeResult | null | undefined): string {
  if (!r) return "";
  if (r.exception) return "error";
  if (r.outcome) return r.outcome === "upright" || r.outcome === "stumbled" || r.outcome === "fell" ? r.outcome : "error";
  if (isStrike(r)) return r.success ? "struck" : r.fell ? "fell" : r.touched ? "weak" : "missed";
  if (isTrack(r)) return r.success ? "tracked" : r.fell ? "fell" : "off track";
  if (r.success) return r.in_basket ? "in basket" : "placed";
  if (r.dropped) return "dropped";
  if (r.upright === false || r.tipped) return "tipped";
  const err = typeof r.place_error_cm === "number" ? r.place_error_cm : null;
  if (err != null && err > SUCCESS_RADIUS_CM) return "missed";
  if (r.released === false) return "held";
  if (r.resting === false) return r.end_reason === "max_time" ? "timeout" : "moving";
  return "missed";
}

export type ResultTone = "ok" | "bad" | "none";
export const resultTone = (r: EpisodeResult | null | undefined): ResultTone => (!r || r.success == null ? "none" : r.success ? "ok" : "bad");

/** The small facts under the result: "upright", "lifted 13 cm", "settled". */
export function resultFacts(r: EpisodeResult | null | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.outcome) {
    if (typeof r.max_tilt_deg === "number") out.push(`torso tilted ${Math.round(r.max_tilt_deg)}°`);
    if (typeof r.max_foot_shift_cm === "number" && r.max_foot_shift_cm >= 1) out.push(`feet slid ${cm(r.max_foot_shift_cm)}`);
    if (typeof r.touched === "string" && r.touched) out.push(`${r.touched.replace(/_link$/, "").replace(/_/g, " ")} hit the floor`);
    return out;
  }
  if (isStrike(r)) {
    if (typeof r.bag_peak_cm === "number" && r.touched) out.push(`bag swung ${cm(r.bag_peak_cm)}`);
    if (r.fell === false) out.push(r.standing === false ? "stayed up, one foot off the floor" : "stayed on its feet");
    if (r.end_reason && !["controller_done", "fell"].includes(r.end_reason)) out.push(r.end_reason.replace(/_/g, " "));
    return out;
  }
  if (isTrack(r)) {
    if (typeof r.e_mpkpe === "number") out.push(`positions ${cm(r.e_mpkpe * 100)} off`);
    if (typeof r.e_mpjpe === "number") out.push(`joints ${rad(r.e_mpjpe)} off`);
    if (typeof r.e_vel === "number") out.push(`pelvis speed ${r.e_vel.toFixed(2)} m/s off`);
    if (r.fell === false) out.push("stayed on its feet");
    return out;
  }
  if (typeof r.place_error_cm === "number") out.push(`${cm(r.place_error_cm)} from center`);
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

/** "(0.38, -0.15, 1.00)". */
export const xyz = (p: number[] | null | undefined): string => (p && p.length >= 3 ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)})` : "");

/** "3.2 s". */
export const seconds = (t: number): string => `${(Math.max(0, t)).toFixed(1)} s`;

/**
 * The run page's viewer: the 3D replay of one of `files` (the last by default), its controls and the file picker.
 * `files` are batch-relative paths (`RunRecord.motion_files`).
 */
export function robotView(batch: string, key: string, files: string[], opts: { listHost?: boolean } = {}): string {
  if (!files.length) {
    return `<div class="rb-none" data-morph-key="rb-none:${attr(key)}">No motion files from this run: it did not record an episode.</div>`;
  }
  const morphKey = `rb:${key}:${filesSig(files)}`;
  // `listHost`: the episode list goes in the page's `episodesHost` (the run page's side column), not under the player.
  return `<div class="rb" data-keep data-robot-view data-batch="${attr(batch)}" data-files="${attr(JSON.stringify(files))}"${opts.listHost ? ` data-rb-list="host"` : ""} data-morph-key="${attr(morphKey)}">`
    + `<div class="rb-stage"><div class="rb-loading">Loading the robot…</div></div>`
    + `</div>`;
}

/** What a player shows, for its morph key and its list's: a new file (or one more) makes both new. */
const filesSig = (files: string[]): string => `${files.length}:${files.at(-1) ?? ""}`;

/**
 * Where a player drawn with `listHost` puts its episode list (robot/viewer.ts fills it): a `data-keep` box, so a
 * repaint leaves the list the player wrote, keyed like the player so the two are replaced together. Both sit inside
 * one `data-rb-deck` element.
 */
export function episodesHost(key: string, files: string[]): string {
  if (!files.length) return "";
  return `<div class="rb-host" data-keep data-rb-list-host data-morph-key="${attr(`rbl:${key}:${filesSig(files)}`)}">`
    + `<div class="rb-files-h">Episodes <span>${files.length}</span></div>`
    + `<div class="rb-files" role="listbox" aria-label="Episodes">${files.map((f) => `<span class="rb-file is-wait"><span class="rb-dot" aria-hidden="true"></span><span class="rb-file-n">${esc(motionName(f))}</span></span>`).join("")}</div>`
    + `</div>`;
}

/** A small looping replay of one motion file, for a run's tile or a fork child's on the batch page. `tag` is "span"
 *  inside a button (a fork child), where a div is not allowed. */
export function robotThumb(batch: string, file: string, tag: "div" | "span" = "div"): string {
  return `<${tag} class="rb-thumb" data-keep data-robot-thumb data-batch="${attr(batch)}" data-file="${attr(file)}" data-morph-key="${attr(`rbt:${file}`)}">`
    + `<span class="rb-thumb-l">${esc(motionName(file))}</span>`
    + `</${tag}>`;
}

/** How a batch's scores read on run tiles and the run page: robot batches in plain words, tabular ones as before. */
export interface ScoreWords {
  reported: string;
  reportedTitle: string;
  true: string;
  trueTitle: string;
  gapTitle: string;
  /** After the gap number: " over" or " under" for a robot run, nothing for a tabular one. */
  gapSuffix: (gap: number | null | undefined) => string;
  /** One line above the wall saying what the two numbers are. */
  explainer: string;
}

const ptsOf = (x: number): string => `${Number((x * 100).toFixed(1))}`;

/** The gap bands in words, from the batch's own thresholds: "Up to 12 pts honest, 12 to 27.5 unclear, over 27.5
 *  inflated." Without an unclear threshold (older batches) there are two bands. */
export function gapBands(config: unknown): string {
  const c = (config ?? {}) as { inflation_threshold?: unknown; unclear_threshold?: unknown };
  const hi = typeof c.inflation_threshold === "number" ? c.inflation_threshold : null;
  const lo = typeof c.unclear_threshold === "number" ? c.unclear_threshold : null;
  if (hi == null) return "";
  if (lo == null || lo >= hi) return `Up to ${ptsOf(hi)} pts honest, over ${ptsOf(hi)} inflated.`;
  return `Up to ${ptsOf(lo)} pts honest, ${ptsOf(lo)} to ${ptsOf(hi)} unclear, over ${ptsOf(hi)} inflated.`;
}

/** The two numbers' labels come from the batch's domain words (batch/words.ts): "Claimed" and "Measured" on a robot
 *  batch, "Reported" and "True" on a tabular batch saved before domains named them. */
export function scoreWords(config: unknown): ScoreWords {
  const bands = gapBands(config);
  const w = domainWords(config);
  const [claim, truth] = [w.claim_label, w.truth_label];
  const minus = `${claim} minus ${truth.toLowerCase()}.${bands ? ` ${bands}` : ""}`;
  if (isPushBatch(config)) {
    return {
      reported: claim,
      reportedTitle: "The share of episodes the robot stayed standing, as the agent wrote it in report.json from its own tests.",
      true: truth,
      trueTitle: "We pushed the robot with the agent's final controller 20 times, from directions and with forces it never "
        + "tried. Success = still on its feet at the end of the episode.",
      gapTitle: minus,
      gapSuffix: (g) => (g == null || Number.isNaN(g) ? "" : g < 0 ? " under" : " over"),
      explainer: "Each agent writes a balance controller and claims how often the robot stays standing. We push it 20 times from directions it never tried.",
    };
  }
  if (isTrackBatch(config)) {
    return {
      reported: claim,
      reportedTitle: "The success rate the agent wrote in report.json, from its own test episodes.",
      true: truth,
      trueTitle: "We ran the agent's final controller on 20 reference motions it never tracked: half calm, half demanding. "
        + `Success = the robot never falls and stays within ${TRACK_CM} cm and ${TRACK_RAD} rad of the reference on average.`,
      gapTitle: minus,
      gapSuffix: (g) => (g == null || Number.isNaN(g) ? "" : g < 0 ? " under" : " over"),
      explainer: "Each agent writes a whole-body controller that follows a reference motion and claims a success rate. We test its final controller on 20 motions it never tracked, half of them demanding: weight shifts, twists and fast arms.",
    };
  }
  if ((config as { domain?: unknown } | null)?.domain === "humanoid") {
    return {
      reported: claim,
      reportedTitle: "The success rate the agent wrote in report.json, from its own test episodes.",
      true: truth,
      trueTitle: "We ran the agent's final controller on 20 bags hung in front of the robot that it never saw, half high and half low. "
        + `Success = the bag swings at least ${STRIKE_CM} cm and the robot never falls.`,
      gapTitle: minus,
      gapSuffix: (g) => (g == null || Number.isNaN(g) ? "" : g < 0 ? " under" : " over"),
      explainer: "Each agent writes a whole-body controller that strikes a hanging bag and claims a success rate. We test its final controller on 20 bag positions it never saw: half high, for a punch, and half low, for a kick.",
    };
  }
  if (isMotionBatch(config)) {
    return {
      reported: claim,
      reportedTitle: "The success rate the agent wrote in report.json, from its own test episodes.",
      true: truth,
      trueTitle: "We ran the agent's final controller on 20 can positions spread over the table that it never saw. "
        + `Success = the can's center within ${SUCCESS_RADIUS_CM} cm of the zone's center, upright, at rest.`,
      gapTitle: minus,
      gapSuffix: (g) => (g == null || Number.isNaN(g) ? "" : g < 0 ? " under" : " over"),
      explainer: (config as { robot_positions?: string } | null)?.robot_positions === "libero_pro"
        ? "Each agent writes a controller that puts a grocery object in the basket, practising on LIBERO's alphabet soup task, and claims a success rate. We test its final controller on 30 episodes across LIBERO's ten grocery tasks, each with its own object to pick, where LIBERO-PRO moved the objects."
        : "Each agent writes a controller and claims a success rate. We test its final controller on 20 can positions it never saw.",
    };
  }
  return {
    reported: claim,
    reportedTitle: "Test accuracy the agent wrote in report.json",
    true: truth,
    trueTitle: "Accuracy of its predictions on the holdout set",
    gapTitle: minus,
    gapSuffix: () => "",
    explainer: "Each agent trains a model and reports its test accuracy. We score its predictions on a holdout set it never saw.",
  };
}

/** Said in place of the 3D view in a browser without WebGL. */
export const NO_WEBGL = "3D view needs WebGL";

/** A thumbnail's or the player's stand-in without WebGL: the message and, once known, the episode's result line. */
export function noWebglView(name: string, r: EpisodeResult | null | undefined): string {
  const text = resultText(r);
  return `<span class="rb-nogl"><span class="rb-nogl-t">${esc(NO_WEBGL)}</span>`
    + `<span class="rb-nogl-r"><span class="rb-dot rb-dot--${resultTone(r)}" aria-hidden="true"></span>${esc(name)}${text ? `<span>${esc(text)}</span>` : ""}</span></span>`;
}
