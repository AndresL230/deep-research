// The diagrams of How it works (how.ts), as inline SVG: the loop, the harness, and the fork. Colors are classes
// (how.css) on the theme's tokens, so both themes work; every label is real text; each SVG is `role="img"` with a
// title and a description. The loop and the harness come in two layouts, wide and narrow, and how.css shows one: a
// wide diagram shrunk to a phone would leave its words too small to read.

import type { ForkArm, ForkExperiment } from "../api";
import { attr, esc } from "../ui";
import { sortedChildren } from "./lanes";

type Tone = "plain" | "accent" | "strong" | "dash" | "ok";

interface Box { x: number; y: number; w: number; h: number; title: string; lines?: readonly string[]; tone?: Tone }

const r1 = (v: number): string => String(Math.round(v * 10) / 10);

/** A box with its title and lines centered in it. */
function box(b: Box): string {
  const lines = b.lines ?? [];
  const block = 13 + lines.length * 15;
  const top = b.y + (b.h - block) / 2 + 11;
  const cx = b.x + b.w / 2;
  return `<g class="hw-d-box hw-d-box--${b.tone ?? "plain"}">`
    + `<rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" rx="6"/>`
    + `<text class="hw-d-t" x="${r1(cx)}" y="${r1(top)}" text-anchor="middle">${esc(b.title)}</text>`
    + lines.map((l, i) => `<text class="hw-d-s" x="${r1(cx)}" y="${r1(top + 15 * (i + 1))}" text-anchor="middle">${esc(l)}</text>`).join("")
    + `</g>`;
}

/** A frame with its title at the top, for boxes that hold other boxes. */
function frame(b: Omit<Box, "lines">, sub?: string): string {
  const cx = b.x + b.w / 2;
  return `<g class="hw-d-box hw-d-box--${b.tone ?? "plain"}"><rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" rx="8"/>`
    + `<text class="hw-d-t" x="${r1(cx)}" y="${r1(b.y + 22)}" text-anchor="middle">${esc(b.title)}</text>`
    + (sub ? `<text class="hw-d-s" x="${r1(cx)}" y="${r1(b.y + 38)}" text-anchor="middle">${esc(sub)}</text>` : "")
    + `</g>`;
}

/** A pill with one word in it. */
const pill = (x: number, y: number, w: number, word: string): string =>
  `<g class="hw-d-pill"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="22" rx="11"/>`
  + `<text x="${r1(x + w / 2)}" y="${r1(y + 15)}" text-anchor="middle">${esc(word)}</text></g>`;

/** A line through `pts`, with an arrowhead at its end. */
const arrow = (id: string, pts: readonly [number, number][], cls = ""): string =>
  `<path class="hw-d-a${cls ? ` ${cls}` : ""}" d="${pts.map(([x, y], i) => `${i ? "L" : "M"}${r1(x)} ${r1(y)}`).join(" ")}" marker-end="url(#${id}-ah)"/>`;

const label = (x: number, y: number, words: string, anchor: "start" | "middle" | "end" = "middle", cls = "", extra = ""): string =>
  `<text class="hw-d-l${cls ? ` ${cls}` : ""}" x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}"${extra}>${esc(words)}</text>`;

function svg(id: string, w: number, h: number, title: string, desc: string, body: string, cls: string): string {
  return `<svg class="hw-svg ${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-t ${id}-d" focusable="false">`
    + `<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`
    + `<defs><marker id="${id}-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
    + `<path class="hw-d-ah" d="M0 0L10 5L0 10z"/></marker></defs>`
    + body + `</svg>`;
}

// ── the loop ─────────────────────────────────────────────────────────────────

const LOOP: readonly { title: string; line: string; tone?: Tone }[] = [
  { title: "Agents", line: "one sandbox each" },
  { title: "Score", line: "on hidden cases", tone: "accent" },
  { title: "Split", line: "honest vs inflated" },
  { title: "Investigator", line: "finds the step" },
  { title: "Fork", line: "four arms per copy" },
  { title: "Verdict", line: "suggests or caused", tone: "strong" },
];

const LOOP_TITLE = "The loop";
const LOOP_DESC = "Agents work in their own sandboxes. Orro scores each on hidden cases, splits honest runs from inflated ones, "
  + "and an investigator finds the step between them. After you approve, Orro forks runs at that step into four arms, and the "
  + "verdict follows. More pairs of copies can be run to firm up the verdict.";

function loopWide(): string {
  const id = "hw-loop-w";
  const w = 138;
  const gap = 30.4;
  const x = (i: number): number => i * (w + gap);
  const boxes = LOOP.map((s, i) => box({ x: x(i), y: 12, w, h: 66, title: s.title, lines: [s.line], tone: s.tone })).join("");
  const arrows = LOOP.slice(1).map((_, i) => arrow(id, [[x(i) + w + 2, 45], [x(i + 1) - 3, 45]])).join("");
  const gx = x(3) + w + gap / 2;
  const fork = x(4) + w / 2;
  const verdict = x(5) + w / 2;
  return svg(id, 980, 140, LOOP_TITLE, LOOP_DESC, boxes + arrows
    + `<path class="hw-d-a hw-d-a--dash" d="M${r1(gx)} 47 L${r1(gx)} 94"/>` + label(gx, 108, "you approve", "middle", "hw-d-l--accent")
    + arrow(id, [[verdict, 80], [verdict, 128], [fork, 128], [fork, 82]], "hw-d-a--loop")
    + label((fork + verdict) / 2, 121, "run more pairs"), "hw-svg--wide");
}

function loopNarrow(): string {
  const id = "hw-loop-n";
  const y = (i: number): number => 10 + i * 80;
  const boxes = LOOP.map((s, i) => box({ x: 50, y: y(i), w: 220, h: 50, title: s.title, lines: [s.line], tone: s.tone })).join("");
  const arrows = LOOP.slice(1).map((_, i) => arrow(id, [[160, y(i) + 52], [160, y(i + 1) - 3]])).join("");
  return svg(id, 340, 472, LOOP_TITLE, LOOP_DESC, boxes + arrows
    + label(168, y(3) + 69, "you approve", "start", "hw-d-l--accent")
    + arrow(id, [[272, y(5) + 25], [306, y(5) + 25], [306, y(4) + 25], [274, y(4) + 25]], "hw-d-a--loop")
    + label(322, y(4) + 65, "more pairs", "middle", "", ` transform="rotate(-90 322 ${r1(y(4) + 65)})"`), "hw-svg--narrow");
}

/** The whole loop: agents, scoring, the split, the investigator, the fork and the verdict. */
export const loopDiagram = (): string => loopWide() + loopNarrow();

// ── the harness ──────────────────────────────────────────────────────────────

const HARNESS_TITLE = "How Orro is built";
const HARNESS_DESC = "Each agent runs in its own Daytona VM with file tools, a shell and a plan. The Orro server in the middle collects "
  + "every run's events and outputs, scores the work on hidden cases that never enter a VM, and forks a VM at a step. The "
  + "investigator, with its step-tagger, hypothesis and code-tracer helpers, reads the case and the runs through read-only "
  + "views. Its fork request waits for a person to approve before the server forks.";

const SUBAGENTS = ["step-tagger", "hypothesis", "code-tracer"] as const;

function harnessWide(): string {
  const id = "hw-arch-w";
  const vmY = [30, 124, 218];
  const vms = ["r01", "r02", "r12"].map((r, i) => box({ x: 0, y: vmY[i], w: 240, h: 80, title: `VM ${r}`, lines: ["Analyst deep agent", "files, shell, plan"] })).join("");
  const server = frame({ x: 330, y: 30, w: 300, h: 268, title: "Orro server", tone: "strong" })
    + box({ x: 350, y: 66, w: 260, h: 58, title: "Collects each run", lines: ["its events and outputs"] })
    + box({ x: 350, y: 136, w: 260, h: 66, title: "Hidden cases", lines: ["scored here, never in a VM"], tone: "accent" })
    + box({ x: 350, y: 214, w: 260, h: 66, title: "Forks a VM at a step", lines: ["copy on write, history replayed"] });
  const inv = frame({ x: 720, y: 30, w: 260, h: 180, title: "Investigator" }, "Deep agent on Sonnet 5.5")
    + SUBAGENTS.map((s, i) => pill(770, 80 + i * 28, 160, s)).join("")
    + label(850, 196, "reads /case/ /runs/ /skills/ only");
  const gate = box({ x: 720, y: 238, w: 260, h: 60, title: "You approve", lines: ["each fork request"], tone: "dash" });
  const links = arrow(id, [[242, 70], [327, 70]])
    + arrow(id, [[242, 164], [327, 164]]) + label(285, 148, "events,") + label(285, 158, "outputs")
    + arrow(id, [[328, 258], [243, 258]]) + label(285, 242, "fork at") + label(285, 252, "a step")
    + arrow(id, [[632, 110], [717, 110]]) + label(675, 94, "read-only") + label(675, 104, "views")
    + arrow(id, [[850, 212], [850, 235]]) + label(858, 228, "fork request", "start")
    + arrow(id, [[718, 268], [633, 268]]) + label(675, 260, "approved");
  return svg(id, 980, 310, HARNESS_TITLE, HARNESS_DESC,
    label(120, 18, "Daytona VMs, one per agent", "middle", "hw-d-l--h") + vms + server + inv + gate + links, "hw-svg--wide");
}

function harnessNarrow(): string {
  const id = "hw-arch-n";
  const vms = ["r01", "r02", "r12"].map((r, i) => box({ x: i * 118, y: 42, w: 104, h: 64, title: `VM ${r}`, lines: ["Analyst", "deep agent"] })).join("");
  const server = frame({ x: 14, y: 166, w: 312, h: 248, title: "Orro server", tone: "strong" })
    + box({ x: 34, y: 200, w: 272, h: 56, title: "Collects each run", lines: ["its events and outputs"] })
    + box({ x: 34, y: 268, w: 272, h: 60, title: "Hidden cases", lines: ["scored here, never in a VM"], tone: "accent" })
    + box({ x: 34, y: 340, w: 272, h: 60, title: "Forks a VM at a step", lines: ["copy on write, history replayed"] });
  const inv = frame({ x: 34, y: 464, w: 272, h: 172, title: "Investigator" }, "Deep agent on Sonnet 5.5")
    + SUBAGENTS.map((s, i) => pill(90, 516 + i * 28, 160, s)).join("")
    + label(170, 620, "reads /case/ /runs/ /skills/ only");
  const gate = box({ x: 34, y: 702, w: 272, h: 56, title: "You approve", lines: ["each fork request"], tone: "dash" });
  const links = arrow(id, [[52, 108], [52, 163]])
    + arrow(id, [[170, 108], [170, 163]]) + label(178, 140, "events, outputs", "start")
    + arrow(id, [[288, 164], [288, 109]]) + label(280, 156, "forks", "end")
    + arrow(id, [[170, 416], [170, 461]]) + label(178, 444, "read-only views", "start")
    + arrow(id, [[170, 638], [170, 699]]) + label(178, 674, "fork request", "start")
    + arrow(id, [[32, 730], [6, 730], [6, 390], [12, 390]]);
  return svg(id, 340, 768, HARNESS_TITLE, HARNESS_DESC,
    label(170, 14, "Daytona VMs, one per agent", "middle", "hw-d-l--h")
    + label(170, 30, "each agent with files, a shell and a plan") + vms + server + inv + gate + links, "hw-svg--narrow");
}

/** The harness: the VMs, the server with the hidden cases, the investigator, and the person who approves forks. */
export const harnessDiagram = (): string => harnessWide() + harnessNarrow();

// ── the fork ─────────────────────────────────────────────────────────────────

export const FORK_ARMS: readonly { arm: ForkArm; title: string; line: string }[] = [
  { arm: "control", title: "Control", line: "unchanged" },
  { arm: "placebo", title: "Placebo", line: "a step that changes nothing" },
  { arm: "show", title: "Show", line: "told the step, nothing run" },
  { arm: "forced", title: "Forced", line: "the step is done" },
];

/** Each arm's copies by how they were scored, in child order: what the squares show. */
export function armStatuses(f: Pick<ForkExperiment, "children">, arm: ForkArm): string[] {
  return sortedChildren(f.children ?? {}, arm).map(([, k]) => String(k.status ?? "running"));
}

/**
 * One run's timeline cut before the step, branching into the four arms. With a fork, each arm ends in a square per
 * copy, red when that copy's claim came out inflated, green when honest. `step` names the step ("testing other can
 * positions").
 */
export function forkDiagram(step: string, run: string | null, f: Pick<ForkExperiment, "children"> | null): string {
  const id = "hw-fork";
  const ys = [76, 124, 172, 220];
  const steps = [16, 44, 72, 100].map((x) => `<circle class="hw-d-dot" cx="${x}" cy="28" r="4.5"/>`).join("");
  const timeline = `<path class="hw-d-run" d="M8 28 L120 28"/>` + steps
    + label(8, 12, run ? `Run ${run}, step by step` : "One inflated run, step by step", "start")
    + `<path class="hw-d-cut" d="M120 14 L120 44"/>` + label(126, 48, "cut before the step", "start", "hw-d-l--accent");
  const counts: string[] = [];
  const arms = FORK_ARMS.map((a, i) => {
    const y = ys[i];
    const sts = f ? armStatuses(f, a.arm) : [];
    const inflated = sts.filter((s) => s === "inflated").length;
    if (sts.length) counts.push(`${a.title}: ${inflated} of ${sts.length} inflated`);
    const squares = sts.map((s, k) => `<rect class="hw-d-sq hw-d-sq--${attr(s)}" x="${r1(336 - (sts.length - k) * 17)}" y="${r1(y - 22)}" width="13" height="13" rx="2"/>`).join("");
    return `<path class="hw-d-a${a.arm === "forced" ? " hw-d-a--ok" : ""}" d="M120 28 C 120 ${r1(y)}, 130 ${r1(y)}, 150 ${r1(y)}"/>`
      + `<g data-how-arm="${attr(a.arm)}"><circle class="hw-d-end${a.arm === "forced" ? " hw-d-end--ok" : ""}" cx="150" cy="${r1(y)}" r="4"/>`
      + `<text class="hw-d-t" x="160" y="${r1(y - 11)}">${esc(a.title)}</text>`
      + `<text class="hw-d-s" x="160" y="${r1(y + 5)}">${esc(a.line)}</text>` + squares + `</g>`;
  }).join("");
  const desc = `A run is copied just before ${step}. The copies go four ways: unchanged, with a step that changes nothing, `
    + `told about the step with nothing run, and with the step done.${counts.length ? ` ${counts.join(". ")}.` : ""}`;
  return svg(id, 340, 236, "The fork", desc, timeline + arms, "hw-svg--fork");
}
