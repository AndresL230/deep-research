// OWNER: subagent C. The Split, Fork and Verdict states, and the investigator's panel.
//
// Every export is a pure `(vm) => html` function that returns "" until its state is reached, so main.ts can stack
// them unconditionally. Classes are prefixed `ln-`; the look lives in lanes.css.
import "./lanes.css";
import {
  isPendingForks, type AgentEvent, type ArmSummary, type CaseFile, type ForkArm, type ForkChild, type ForkExperiment,
  type PendingForks, type RunRecord, type SplitFinding,
} from "../api";
import { askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { duration, pct, usd } from "./format";
import { ACT, childKey, type BatchVm } from "./model";

// ── pure helpers (exported for the tests) ────────────────────────────────────

/** The phase in words for the investigator panel. `blocked: x` and `error: x` keep their reason. */
export function phaseText(phase: string): string {
  const m = /^(blocked|error):\s*(.*)$/s.exec(phase);
  if (m) return `${m[1] === "blocked" ? "Blocked" : "Error"}: ${m[2] || "no reason given"}`;
  switch (phase) {
    case "config": return "Not started";
    case "running": return "Agents are running";
    case "analyzing": return "Scoring runs and finding the split";
    case "ready": return "Split found. Ready to investigate";
    case "no_split": return "No step separates honest and inflated runs";
    case "investigating": return "The investigator is working";
    case "awaiting_approval": return "Waiting for approval to fork";
    case "forking": return "Forking the run into control and forced arms";
    case "forked": return "Forks finished. Writing the verdict";
    case "done": return "Done";
    case "stopped": return "Stopped";
    default: return phase;
  }
}

/** True for `blocked: ...` and `error: ...` phases. */
export const isProblemPhase = (phase: string): boolean => /^(blocked|error):/.test(phase);

/**
 * The main label of one action's step labels: `highlight` (the split label) when present, then "split", then the
 * first label that is not "load", then "load". "" for an action with no labels (drawn as a dot).
 */
export function laneLabel(labels: readonly string[], highlight?: string | null): string {
  if (highlight && labels.includes(highlight)) return highlight;
  if (labels.includes("split")) return "split";
  return labels.find((l) => l !== "load") ?? labels[0] ?? "";
}

/** The index of a run's first action that splits the data, or the action count when it never splits. */
export function splitIndex(labels: readonly (readonly string[])[]): number {
  const i = labels.findIndex((a) => a.includes("split"));
  return i < 0 ? labels.length : i;
}

/** "Honest runs did deduplicate before splitting 100% of the time, inflated runs 0%". */
export function splitSentence(s: Pick<SplitFinding, "label" | "honest_rate" | "inflated_rate">): string {
  return `Honest runs did ${s.label} before splitting ${pct(s.honest_rate, 0)} of the time, inflated runs ${pct(s.inflated_rate, 0)}`;
}

/** "3 of 4 inflated, mean reported 87.8% vs true 73.5%" (plus failed runs when any). */
export function armSummaryText(a: ArmSummary): string {
  const failed = a.failed ? `, ${a.failed} failed` : "";
  const means = a.mean_reported != null || a.mean_true != null
    ? `, mean reported ${pct(a.mean_reported)} vs true ${pct(a.mean_true)}` : "";
  return `${a.inflated} of ${a.scored} inflated${failed}${means}`;
}

/** One line, at most `n` characters: whitespace collapsed, an ellipsis when cut. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/** A tool call's args in short: `command="cd x && python3 a.py", n=4`. */
export function shortArgs(args: Record<string, unknown>, n = 90): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const val = typeof v === "string" ? `"${clip(v, 60)}"` : clip(JSON.stringify(v) ?? String(v), 40);
    return `${k}=${val}`;
  });
  return clip(parts.join(", "), n);
}

/** An investigator event as one compact line: what kind it is and its text. */
export function eventLine(ev: AgentEvent): { kind: string; text: string } {
  switch (ev.type) {
    case "thought": return { kind: "thought", text: clip(ev.text, 160) };
    case "tool_call": return { kind: "call", text: `${ev.name}(${shortArgs(ev.args)})` };
    case "tool_result": return { kind: "result", text: clip(`${ev.name ? `${ev.name}: ` : ""}${ev.content}`, 120) };
    case "todos": {
      const done = ev.todos.filter((t) => t.status === "completed").length;
      return { kind: "plan", text: `Plan: ${done} of ${ev.todos.length} done` };
    }
    case "forced": return { kind: "forced", text: clip(`Forced: ${ev.command}`, 120) };
  }
}

/** Child ids in arm order and by number: control-1, control-2, ..., forced-1, ... */
export function sortedChildren(children: Record<string, ForkChild>, arm: ForkArm): [string, ForkChild][] {
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return Object.entries(children).filter(([, c]) => c.arm === arm).sort((a, b) => num(a[0]) - num(b[0]));
}

/** The pending fork request, or null. */
export function pendingForks(c: CaseFile): PendingForks | null {
  const p = c.forks?.pending;
  return p && isPendingForks(p) ? p : null;
}

/** The fork experiments (not the pending request), in id order. */
export function forkExperiments(c: CaseFile): ForkExperiment[] {
  return Object.values(c.forks ?? {})
    .filter((f): f is ForkExperiment => !isPendingForks(f))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Simulated fixtures (scripts/make_fixture.py): the agents' choices are scripted. */
export const isSimulated = (c: CaseFile): boolean =>
  (c.config as { simulated?: boolean }).simulated === true || c.costs?.simulated === true;

/** "control_inflated" -> "Control inflated". */
export const numberLabel = (k: string): string => {
  const t = k.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const numberValue = (x: number): string => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));

// ── small pieces ─────────────────────────────────────────────────────────────

type Tone = "honest" | "inflated" | "failed" | "running" | "muted";

const toneOf = (status: string): Tone =>
  status === "honest" || status === "inflated" || status === "failed" ? status
    : status === "running" || status === "starting" ? "running" : "muted";

const pill = (status: string, text = status, tone: Tone = toneOf(status)): string =>
  `<span class="ln-pill ln-pill--${tone}">${tone === "running" ? askSpinner(10) : `<i class="ln-pill-dot"></i>`}${esc(text)}</span>`;

const simTag = (c: CaseFile): string =>
  isSimulated(c) ? `<span class="ln-sim" title="The agents' choices in this batch are scripted, not real agent runs">Simulated</span>` : "";

const head = (title: string, c: CaseFile, extra = ""): string =>
  `<div class="ln-head"><h2 class="ln-h">${esc(title)}</h2>${simTag(c)}${extra}</div>`;

const code = (label: string, text: string | null, tone: Tone): string =>
  `<figure class="ln-code ln-code--${tone}"><figcaption class="ln-code-cap"><i class="ln-pill-dot"></i>${esc(label)}</figcaption>` +
  `<pre class="ln-code-pre">${text ? esc(text) : `<span class="ln-muted">No example</span>`}</pre></figure>`;

const runLabels = (c: CaseFile, r: RunRecord): string[][] => (r.labels ?? c.step_labels?.[r.id] ?? []) as string[][];

// ── 1. the split ─────────────────────────────────────────────────────────────

const GROUPS: { status: "honest" | "inflated" | "failed"; title: string }[] = [
  { status: "honest", title: "Honest" },
  { status: "inflated", title: "Inflated" },
  { status: "failed", title: "Failed" },
];

/** The lane chart: one lane per run through the step labels, the split step lit, the two commands side by side. */
export function splitView(vm: BatchVm): string {
  const c = vm.case;
  const split = c.split;
  const runs = Object.values(c.runs ?? {}).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const anyLabels = runs.some((r) => runLabels(c, r).length > 0);
  const noSplit = c.phase === "no_split";
  if (!split && !anyLabels && !noSplit) return "";

  const hl = split?.label ?? null;
  const lanes = runs.filter((r) => (r.status === "honest" || r.status === "inflated" || r.status === "failed") && runLabels(c, r).length);

  let summary: string;
  if (split) {
    summary = `<p class="ln-lead">${esc(splitSentence(split))}.</p>` +
      `<p class="ln-sub">${split.n_honest} honest and ${split.n_inflated} inflated runs compared. The lit step is <b class="ln-lit-word">${esc(split.label)}</b>.</p>`;
  } else if (noSplit) {
    summary = `<p class="ln-lead">No step separates honest and inflated runs.</p>` +
      `<p class="ln-sub">Both groups did the same steps before splitting the data, so there is nothing to fork.</p>`;
  } else {
    summary = `<p class="ln-sub">Step labels per run. Finding the step that separates the groups.</p>`;
  }

  return `<section class="ln-sec ln-split" data-morph-key="ln-split" aria-label="Where the runs split">` +
    head("Where honest and inflated runs differ", c) + summary +
    (lanes.length ? laneChart(lanes, c, split) : "") +
    (split ? splitDetail(split) : "") +
    `</section>`;

  function laneChart(rows: RunRecord[], cs: CaseFile, s: SplitFinding | null): string {
    const per = rows.map((r) => {
      const labels = runLabels(cs, r);
      const at = splitIndex(labels);
      return { r, labels, at };
    });
    const before = Math.max(1, ...per.map((p) => p.at));
    const after = Math.max(1, ...per.map((p) => p.labels.length - p.at));
    const cols = `56px repeat(${before}, 84px) 22px repeat(${after}, 84px)`;

    const header = `<div class="ln-lrow ln-lrow--head" data-morph-key="head" aria-hidden="true">` +
      `<span class="ln-lh">Run</span><span class="ln-lh ln-lh--before" style="grid-column:2 / span ${before}">Before the split</span>` +
      `<span class="ln-lh ln-lh--mark" style="grid-column:${before + 2}"></span>` +
      `<span class="ln-lh" style="grid-column:${before + 3} / span ${after}">Split and after</span></div>`;

    let body = "";
    for (const g of GROUPS) {
      const inGroup = per.filter((p) => p.r.status === g.status);
      if (!inGroup.length) continue;
      body += `<div class="ln-group ln-group--${g.status}" data-morph-key="g-${g.status}">${esc(g.title)} <span class="ln-muted">${inGroup.length}</span></div>`;
      for (const p of inGroup) body += lane(p.r, p.labels, p.at, before, s);
    }
    return `<div class="ln-chart" role="group" aria-label="Steps per run"><div class="ln-lanes" data-morph-list style="--ln-cols:${cols}">${header}${body}</div></div>`;
  }

  function lane(r: RunRecord, labels: string[][], at: number, before: number, s: SplitFinding | null): string {
    const tone = toneOf(r.status);
    const did = hl ? labels.slice(0, at).some((a) => a.includes(hl)) : false;
    const isFork = s?.fork_run_id === r.id;
    const chip = (a: string[], i: number): string => {
      const main = laneLabel(a, hl);
      const lit = hl != null && a.includes(hl) && i < at;
      const title = `Action ${i + 1}: ${a.length ? a.join(", ") : "no step labels"}`;
      return main
        ? `<span class="ln-chip${lit ? " is-lit" : ""}${main === "split" ? " is-split" : ""}" title="${attr(title)}">${esc(main)}</span>`
        : `<span class="ln-chip ln-chip--empty" title="${attr(title)}"><i></i></span>`;
    };
    const pad = before - at;
    let cells = "";
    for (let i = 0; i < at; i++) cells += `<span class="ln-cell" style="grid-column:${pad + i + 2}">${chip(labels[i], i)}</span>`;
    cells += `<span class="ln-mark${isFork ? " is-fork" : ""}" style="grid-column:${before + 2}">${isFork ? `<b class="ln-fork-tag">fork</b>` : ""}</span>`;
    for (let i = at; i < labels.length; i++) cells += `<span class="ln-cell" style="grid-column:${before + 3 + i - at}">${chip(labels[i], i)}</span>`;
    const aria = `Run ${r.id}, ${r.status}${hl ? `, ${did ? "did" : "did not"} ${hl} before splitting` : ""}. Open the run.`;
    return `<button type="button" class="ln-lrow ln-lane ln-lane--${tone}" data-morph-key="lane-${attr(r.id)}" data-act="${ACT.openRun}" data-arg="${attr(r.id)}" aria-label="${attr(aria)}">` +
      `<span class="ln-run"><i class="ln-pill-dot"></i>${esc(r.id)}</span>${cells}</button>`;
  }
}

function splitDetail(s: SplitFinding): string {
  let where: string;
  if (!s.fork_run_id || s.fork_at == null) where = `No inflated run skipped ${esc(s.label)}, so there is no run to fork.`;
  else where = `The fork copies run <b>${esc(s.fork_run_id)}</b> after action ${s.fork_at}, just before it splits the data.`;
  const iv = s.intervention
    ? ` The forced arm runs one extra step first: <span class="ln-iv">${esc(s.intervention)}</span>.`
    : ` No intervention is defined for ${esc(s.label)} yet, so the forced arm cannot run.`;
  return `<div class="ln-cmp">${code("An honest run did", s.honest_example, "honest")}${code("An inflated run did instead", s.inflated_example, "inflated")}</div>` +
    `<p class="ln-note">${where}${iv}</p>`;
}

// ── 2. the fork experiment ───────────────────────────────────────────────────

const FORK_STATUS: Record<ForkExperiment["status"], string> = {
  rebuilding: "Rebuilding the VM",
  running: "Running",
  done: "Done",
};

/** The fork experiment: the approval card (forks.pending), then control and forced arms fanning out. */
export function forkView(vm: BatchVm): string {
  const c = vm.case;
  const pending = pendingForks(c);
  const exps = forkExperiments(c);
  if (!pending && !exps.length) return "";
  return `<section class="ln-sec ln-forks" data-morph-key="ln-forks" aria-label="Fork experiment">` +
    head("Fork experiment", c) +
    `<div class="ln-stack" data-morph-list>${exps.map(experiment).join("")}${pending ? approvalCard(pending, vm) : ""}</div>` +
    `</section>`;
}

function approvalCard(p: PendingForks, vm: BatchVm): string {
  const src = vm.case.split?.fork_run_id;
  const est = p.estimate_usd != null ? usd(p.estimate_usd) : "unknown, prices missing";
  const disabled = !vm.live || vm.busy != null;
  const btn = (act: string, label: string, primary: boolean): string =>
    `<button type="button" class="${primary ? "ask-btn ln-approve" : "ask-ghostbtn ask-ghostbtn--outline"}" data-act="${act}"${disabled ? " disabled" : ""}>` +
    `${vm.busy === act ? askSpinner(12) : ""}${esc(label)}</button>`;
  return `<div class="ln-card ln-approval" data-morph-key="pending" role="group" aria-label="Approve the fork">` +
    `<p class="ln-approval-t">The investigator wants to fork run ${esc(src ?? "?")} before its split: ` +
    `${p.n_per_arm} control and ${p.n_per_arm} forced runs, ${p.vm_count} VMs.</p>` +
    `<p class="ln-approval-est">Estimated cost <b>${esc(est)}</b></p>` +
    `<div class="ln-actions">${btn(ACT.approve, "Approve", true)}${btn(ACT.decline, "Decline", false)}` +
    (vm.live ? "" : `<span class="ln-muted">Approval happens on live batches.</span>`) + `</div>` +
    (vm.live && vm.error ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    `</div>`;
}

function experiment(f: ForkExperiment): string {
  const statusPill = pill(f.status, FORK_STATUS[f.status] ?? f.status, f.status === "done" ? "muted" : "running");
  const arm = (a: ForkArm): string => {
    const kids = sortedChildren(f.children ?? {}, a);
    const summary = f.arms?.[a];
    const sub = a === "control" ? "Continues unchanged" : `Runs first: ${f.intervention}`;
    const started = f.status !== "done" && kids.length < f.n_per_arm ? `<span class="ln-muted">${kids.length} of ${f.n_per_arm} started</span>` : "";
    return `<div class="ln-arm ln-arm--${a}" data-morph-key="arm-${a}">` +
      `<div class="ln-arm-h"><span class="ln-arm-t">${a === "control" ? "Control" : "Forced"}</span>${started}</div>` +
      `<p class="ln-arm-sub">${esc(sub)}</p>` +
      `<div class="ln-kids" data-morph-list>${kids.map(([id, k]) => childTile(f.id, id, k)).join("")}</div>` +
      (summary ? `<p class="ln-arm-sum">${esc(armSummaryText(summary))}</p>` : "") +
      `</div>`;
  };
  return `<div class="ln-card ln-exp" data-morph-key="exp-${attr(f.id)}">` +
    `<div class="ln-exp-h"><span class="ln-exp-id">Fork ${esc(f.id)}</span>${statusPill}</div>` +
    `<p class="ln-exp-t">Forked run <b>${esc(f.source_run)}</b> after action ${f.fork_at}, just before its split. Step under test: <b class="ln-lit-word">${esc(f.label)}</b>.</p>` +
    (f.status === "rebuilding" ? `<p class="ln-sub">Replaying the run's first ${f.fork_at} actions on a fresh VM.</p>` : "") +
    `<div class="ln-arms">${arm("control")}${arm("forced")}</div>` +
    `</div>`;
}

function childTile(forkId: string, id: string, k: ForkChild): string {
  const scored = k.status !== "running";
  const vals = scored && (k.reported_accuracy != null || k.true_accuracy != null)
    ? `<span class="ln-kid-v"><span class="ln-muted">reported</span> ${esc(pct(k.reported_accuracy))} <span class="ln-muted">true</span> ${esc(pct(k.true_accuracy))}</span>`
    : `<span class="ln-kid-v ln-muted">${k.status === "failed" ? esc(clip(k.reason || "Failed", 40)) : "Working"}</span>`;
  const key = childKey(forkId, id);
  return `<button type="button" class="ln-kid ln-kid--${toneOf(k.status)}" data-morph-key="${attr(key)}" data-act="${ACT.openChild}" data-arg="${attr(key)}" aria-label="${attr(`${id}, ${k.status}. Open the run.`)}">` +
    `<span class="ln-kid-h"><span class="ln-kid-id">${esc(id)}</span>${k.how ? `<span class="ln-tag" title="${k.how === "fork" ? "A copy-on-write fork of the VM" : "Rebuilt by replaying the actions"}">${esc(k.how)}</span>` : ""}</span>` +
    `${pill(k.status)}${vals}</button>`;
}

// ── 3. the verdict ───────────────────────────────────────────────────────────

interface ArmDots { statuses: string[]; inflated: number; total: number }

/** The dots per arm: from the verdict's fork children when there is one, else from the verdict's numbers. */
export function verdictArms(c: CaseFile): Record<ForkArm, ArmDots> | null {
  const v = c.verdict;
  if (!v) return null;
  const exps = forkExperiments(c);
  const f = [...exps].reverse().find((e) => e.label === v.step_label && e.status === "done") ?? exps[exps.length - 1];
  const out = {} as Record<ForkArm, ArmDots>;
  for (const arm of ["control", "forced"] as const) {
    const kids = f ? sortedChildren(f.children ?? {}, arm) : [];
    if (kids.length) {
      const statuses = kids.map(([, k]) => k.status);
      const s = f?.arms?.[arm];
      out[arm] = { statuses, inflated: s?.inflated ?? statuses.filter((x) => x === "inflated").length, total: s?.scored ?? statuses.filter((x) => x !== "failed" && x !== "running").length };
    } else {
      const inflated = v.numbers[`${arm}_inflated`] ?? 0;
      const total = v.numbers[`${arm}_total`] ?? 0;
      out[arm] = { statuses: Array.from({ length: total }, (_, i) => (i < inflated ? "inflated" : "honest")), inflated, total };
    }
  }
  return out;
}

/** The verdict: dots per arm colored by outcome, plus the one sentence. */
export function verdictView(vm: BatchVm): string {
  const c = vm.case;
  const v = c.verdict;
  if (!v) return "";
  const arms = verdictArms(c);
  const row = (arm: ForkArm): string => {
    const a = arms?.[arm];
    if (!a) return "";
    const dots = a.statuses.map((s, i) => `<i class="ln-dot ln-dot--${toneOf(s)}" title="${attr(`${arm}-${i + 1}: ${s}`)}"></i>`).join("");
    return `<div class="ln-vrow" data-morph-key="v-${arm}"><span class="ln-vrow-t">${arm === "control" ? "Control" : "Forced"}</span>` +
      `<span class="ln-dots" role="img" aria-label="${attr(`${a.inflated} of ${a.total} inflated`)}">${dots}</span>` +
      `<span class="ln-vrow-n">${a.inflated} of ${a.total} inflated</span></div>`;
  };
  const nums = Object.entries(v.numbers ?? {});
  return `<section class="ln-sec ln-verdict" data-morph-key="ln-verdict" aria-label="Verdict">` +
    head("Verdict", c) +
    `<p class="ln-sentence">${esc(v.sentence)}</p>` +
    `<div class="ln-vrows">${row("control")}${row("forced")}</div>` +
    `<div class="ln-legend" aria-hidden="true"><span><i class="ln-dot ln-dot--honest"></i>honest</span><span><i class="ln-dot ln-dot--inflated"></i>inflated</span><span><i class="ln-dot ln-dot--failed"></i>failed</span></div>` +
    (nums.length ? `<dl class="ln-stats">${nums.map(([k, n]) => `<div class="ln-stat"><dt>${esc(numberLabel(k))}</dt><dd>${esc(numberValue(n))}</dd></div>`).join("")}</dl>` : "") +
    (isSimulated(c) ? `<p class="ln-note ln-note--sim">Simulated batch: the agents' choices were scripted to show the method. These are not real agent runs.</p>` : "") +
    `</section>`;
}

// ── 4. the investigator ──────────────────────────────────────────────────────

const STOPPABLE = new Set(["running", "investigating", "forking"]);
const RECENT = 8;

/** The investigator: what it is doing (its events, hypotheses) and the live-only Investigate / Stop actions. */
export function investigatorView(vm: BatchVm): string {
  const c = vm.case;
  const phase = String(c.phase ?? "config");
  if (phase === "config") return "";
  const problem = isProblemPhase(phase);
  const working = ["running", "analyzing", "investigating", "forking"].includes(phase);

  let actions = "";
  if (vm.live) {
    const dis = vm.busy != null ? " disabled" : "";
    if (phase === "ready") {
      actions += `<button type="button" class="ask-btn ln-approve" data-act="${ACT.investigate}"${dis}>${vm.busy === ACT.investigate ? askSpinner(12) : ""}Investigate</button>`;
    }
    if (STOPPABLE.has(phase)) {
      actions += `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.stop}"${dis}>${vm.busy === ACT.stop ? askSpinner(12) : ""}Stop</button>`;
    }
  }

  const all = vm.events?.investigator ?? [];
  const start = Math.max(0, all.length - RECENT);
  const recent = all.slice(start);
  const events = recent.length
    ? `<ol class="ln-evs" data-morph-list>${recent.map((ev, j) => {
      const { kind, text } = eventLine(ev);
      const who = ev.agent && ev.agent !== "investigator" ? `<span class="ln-tag">${esc(ev.agent)}</span>` : "";
      return `<li class="ln-ev ln-ev--${kind}" data-morph-key="ev-${start + j}"><span class="ln-ev-t">${esc(duration(ev.t))}</span>` +
        `<span class="ln-ev-k">${esc(kind)}</span>${who}<span class="ln-ev-x">${esc(text)}</span></li>`;
    }).join("")}</ol>`
    : "";

  const hyps = c.hypotheses ?? [];
  const hypHtml = hyps.length
    ? `<div class="ln-hyps" data-morph-list>${hyps.map((h, i) =>
      `<div class="ln-card ln-hyp" data-morph-key="hyp-${attr(String(h.at ?? i))}">` +
      `<div class="ln-hyp-h"><span class="ln-hyp-k">Hypothesis</span><b class="ln-lit-word">${esc(h.step_label)}</b></div>` +
      `<p class="ln-hyp-e">${esc(h.evidence)}</p>` +
      `<div class="ln-cmp ln-cmp--sm">${code("Honest", h.honest_action, "honest")}${code("Inflated", h.inflated_action, "inflated")}</div>` +
      `</div>`).join("")}</div>`
    : "";

  return `<section class="ln-sec ln-inv" data-morph-key="ln-inv" aria-label="Investigator">` +
    `<div class="ln-head"><h2 class="ln-h">Investigator</h2>${simTag(c)}</div>` +
    `<div class="ln-inv-status">` +
    (problem ? `<p class="ln-err" role="alert">${esc(phaseText(phase))}</p>`
      : `<p class="ln-phase">${working ? askSpinner(12) : `<i class="ln-phase-dot"></i>`}<span>${esc(phaseText(phase))}</span></p>`) +
    (actions ? `<div class="ln-actions">${actions}</div>` : "") +
    `</div>` +
    // The approval card shows the error itself while a fork request is pending.
    (vm.error && !pendingForks(c) ? `<p class="ln-err" role="alert">${esc(vm.error)}</p>` : "") +
    events +
    (hypHtml ? `<h3 class="ln-h3">Hypotheses</h3>${hypHtml}` : "") +
    `</section>`;
}
