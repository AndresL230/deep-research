// OWNER: subagent A. The home screen (batch cards, the new batch panel with its estimate and Start) and the header cost bar.
import "./home.css";
import type { BatchConfig, BatchListItem, Costs, Health, ScopeCost, TrapInfo } from "../api";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { pct, tokens, usd } from "./format";
import { ACT, type HomeVm, type Loadable } from "./model";
import { DEFAULT_PLANTED, chosenTrap } from "./trap";

// ── home screen ──────────────────────────────────────────────────────────────

/** What the batch runs on, drawn by dataset-input.ts: its rows for the panel and a one-line summary. */
export interface HomeInputs { html: string; label: string }

/** The home screen: the batches to open, then one panel to start a new one. Labels only, no prose. */
export function homeView(vm: HomeVm, inputs?: HomeInputs): string {
  const trap = chosenTrap(vm.defaults, vm.draft?.trap);
  return `<div class="hm" data-morph-key="home">
    ${batchesSection(vm.batches)}
    <section class="hm-panel" data-morph-key="new" aria-labelledby="hm-new-h">
      <div class="hm-panel-h" data-morph-key="head">
        <h2 class="hm-h2" id="hm-new-h">New batch</h2>
        <span class="hm-fixed">${esc(summaryLabel(inputs?.label ?? `Pima diabetes · ${DEFAULT_PLANTED}`, trap))}</span>
      </div>
      ${inputs?.html ?? ""}
      ${vm.draft ? trapRow(vm.draft, vm.defaults?.traps ?? []) : ""}
      ${vm.draft ? mainRow(vm.draft, trap) : mainSkeleton(defaultsFailed(vm))}
      ${advancedBlock(vm)}
      ${footer(vm)}
    </section>
  </div>`;
}

/** The panel's one-line summary, saying what the chosen trap plants. The summary is written for the default trap. */
function summaryLabel(label: string, trap: TrapInfo | null): string {
  if (!trap?.planted) return label;
  return label.split(" · ").map((part) => (part === DEFAULT_PLANTED ? `planted ${trap.planted}` : part)).join(" · ");
}

/** Why Start is disabled, as a few words, or null when it can be pressed. */
export function startBlocked(vm: HomeVm): string | null {
  if (!vm.draft) return defaultsFailed(vm) ? "Defaults did not load" : "Loading defaults";
  if (vm.starting) return "Starting";
  const missing = missingKeys(vm.health);
  if (missing.length) return missing.map((k) => `${k} key missing`).join(", ");
  if (vm.estimate?.state === "ready" && vm.estimate.value.over_budget) return "Over budget";
  return null;
}

function missingKeys(h: Health | null): string[] {
  if (!h) return [];
  const out: string[] = [];
  if (!h.keys.anthropic) out.push("Anthropic");
  if (!h.keys.daytona) out.push("Daytona");
  return out;
}

/** The batches and the defaults load together, so no draft once the list has settled means the defaults failed. */
const defaultsFailed = (vm: HomeVm): boolean => !vm.draft && vm.batches.state !== "loading";

function batchesSection(b: Loadable<BatchListItem[]>): string {
  let body: string;
  if (b.state === "loading") {
    body = `<div class="hm-note" data-morph-key="loading">${askSpinner(12)}<span>Loading batches</span></div>`;
  } else if (b.state === "error") {
    body = `<div class="hm-err" data-morph-key="error" role="alert"><span>${esc(b.message)}</span>
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.home}">Retry</button></div>`;
  } else if (!b.value.length) {
    body = `<div class="hm-note" data-morph-key="empty">No batches yet</div>`;
  } else {
    const cards = b.value.map((it) => {
      // Live: running here. Ready: saved at its split, Investigate brings it back. Otherwise a replay.
      const kind = it.kind === "live" ? "live" : it.resumable ? "ready" : "replay";
      const word = kind === "live" ? "Live" : kind === "ready" ? "Ready to investigate" : "Replay";
      return `<button type="button" class="hm-batch" data-morph-key="${attr(it.id)}" data-act="${ACT.openBatch}" data-arg="${attr(it.id)}" title="${attr(it.id)}">
        <span class="hm-batch-id">${esc(it.id)}</span>
        <span class="hm-kind" data-kind="${kind}">${word}</span>
      </button>`;
    }).join("");
    body = `<div class="hm-batches" data-morph-list data-morph-key="list">${cards}</div>`;
  }
  return `<section class="hm-sec" data-morph-key="batches" aria-labelledby="hm-batches-h">
    <h2 class="hm-h2" id="hm-batches-h">Batches</h2>
    ${body}
  </section>`;
}

// ── the settings ─────────────────────────────────────────────────────────────

type Field = keyof BatchConfig;

const fid = (f: Field) => `hm-f-${f}`;

function rangeField(cfg: BatchConfig, f: Field, label: string, min: number, max: number, step: number, shown: string): string {
  return `<div class="hm-field" data-f="${f}">
    <div class="hm-lbl-row"><label class="hm-lbl" for="${fid(f)}">${esc(label)}</label><output class="hm-out" for="${fid(f)}">${esc(shown)}</output></div>
    <div class="hm-ctl"><input class="hm-range" id="${fid(f)}" type="range" min="${min}" max="${max}" step="${step}" value="${attr(String(cfg[f]))}" aria-valuetext="${attr(shown)}" data-cfg="${f}"></div>
  </div>`;
}

function numberField(cfg: BatchConfig, f: Field, label: string, o: { min?: number; max?: number; step?: number | "any"; prefix?: string }): string {
  const bounds = `${o.min != null ? ` min="${o.min}"` : ""}${o.max != null ? ` max="${o.max}"` : ""} step="${o.step ?? 1}"`;
  return `<div class="hm-field" data-f="${f}">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <div class="hm-ctl">${o.prefix ? `<span class="hm-prefix" aria-hidden="true">${esc(o.prefix)}</span>` : ""}<input class="hm-input${o.prefix ? " hm-input--pre" : ""}" id="${fid(f)}" type="number" inputmode="decimal"${bounds} value="${attr(String(cfg[f]))}" data-cfg="${f}"></div>
  </div>`;
}

/** A two or three option choice as radio inputs: main.ts reads the picked one's value, and morph.ts keeps `checked` in step. */
function choiceField(cfg: BatchConfig, f: Field, label: string, opts: [string, string][]): string {
  const v = String(cfg[f]);
  return `<div class="hm-field" data-f="${f}" role="radiogroup" aria-labelledby="${fid(f)}-l">
    <span class="hm-lbl" id="${fid(f)}-l">${esc(label)}</span>
    <div class="hm-seg">${opts.map(([val, text]) =>
      `<label class="hm-seg-o"><input type="radio" name="${f}" data-cfg="${f}" value="${attr(val)}"${val === v ? " checked" : ""}><span>${esc(text)}</span></label>`).join("")}</div>
  </div>`;
}

function textField(cfg: BatchConfig, f: Field, label: string): string {
  return `<div class="hm-field" data-f="${f}" data-w="wide">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <div class="hm-ctl"><input class="hm-input hm-input--code" id="${fid(f)}" type="text" spellcheck="false" autocomplete="off" value="${attr(String(cfg[f]))}" data-cfg="${f}"></div>
  </div>`;
}

/** "8 pts" from 0.08: the threshold as whole accuracy points. */
const points = (x: number) => `${Math.round(x * 1000) / 10} pts`;

/**
 * Which trap to plant: the server's list by title, with the chosen one's description under it. Nothing until the
 * server sends a list. main.ts writes the picked option's value into the draft like any other `data-cfg` input.
 */
function trapRow(c: BatchConfig, traps: readonly TrapInfo[]): string {
  if (!traps.length) return "";
  const chosen = traps.find((t) => t.name === c.trap);
  // A draft naming a trap the list does not have still shows what it holds.
  const items = chosen ? traps : [...traps, { name: c.trap, title: c.trap }];
  const options = items.map((t) =>
    `<option value="${attr(t.name)}"${t.name === c.trap ? " selected" : ""}>${esc(t.title)}</option>`).join("");
  return `<div class="hm-trap" data-morph-key="trap">
    <div class="hm-field" data-f="trap">
      <label class="hm-lbl" for="${fid("trap")}">Trap</label>
      <div class="hm-ctl"><select class="hm-input hm-select" id="${fid("trap")}" data-cfg="trap"${chosen ? ` aria-describedby="hm-trap-d"` : ""}>${options}</select></div>
    </div>
    ${chosen ? `<span class="hm-trap-d" id="hm-trap-d">${esc(chosen.description)}</span>` : ""}
  </div>`;
}

/** The four settings that matter, on one row. The strength slider is named by the chosen trap. */
function mainRow(c: BatchConfig, trap: TrapInfo | null): string {
  return `<div class="hm-main" data-morph-key="main">
    ${numberField(c, "n_runs", "Runs", { min: 1, max: 24 })}
    ${rangeField(c, "trap_strength", trap?.strength_label || "Duplicated rows", 0, 1, 0.05, pct(c.trap_strength, 0))}
    ${choiceField(c, "hint_level", "Hint", [["none", "None"], ["light", "Light"]])}
    ${numberField(c, "budget_usd", "Budget", { min: 0, step: "any", prefix: "$" })}
  </div>`;
}

/** The same row as placeholders while the defaults load (still, not pulsing, when they failed). */
function mainSkeleton(failed: boolean): string {
  const cell = (f: Field) => `<div class="hm-field" data-f="${f}"><span class="hm-skel hm-skel--lbl"></span><span class="hm-skel hm-skel--box"></span></div>`;
  return `<div class="hm-main hm-main--skel" data-morph-key="skeleton" data-still="${failed ? "1" : "0"}" aria-hidden="true">
    ${cell("n_runs")}${cell("trap_strength")}${cell("hint_level")}${cell("budget_usd")}
  </div>`;
}

/** The Advanced toggle and, when it is open, the rest of the settings and Reset. */
function advancedBlock(vm: HomeVm): string {
  const c = vm.draft;
  const open = !!vm.advanced && !!c;
  const toggle = `<button type="button" class="hm-adv-t" data-act="${ACT.toggleAdvanced}" aria-expanded="${open}"${open ? ` aria-controls="hm-adv"` : ""}${c ? "" : " disabled"}>${askIcon("chevRight", 13)}<span>Advanced</span></button>`;
  if (!c || !open) return `<div class="hm-adv" data-morph-key="adv"><div class="hm-adv-h">${toggle}</div></div>`;
  return `<div class="hm-adv" data-morph-key="adv">
    <div class="hm-adv-h">${toggle}<button type="button" class="ask-ghostbtn hm-reset" data-act="${ACT.resetConfig}"${vm.starting ? " disabled" : ""}>Reset</button></div>
    <div class="hm-adv-grid" id="hm-adv" data-morph-key="adv-grid">
      ${rangeField(c, "trap_noise", "Trap noise", 0, 0.5, 0.05, c.trap_noise.toFixed(2))}
      ${rangeField(c, "holdout_fraction", "Holdout fraction", 0.05, 0.45, 0.05, pct(c.holdout_fraction, 0))}
      ${rangeField(c, "inflation_threshold", "Inflation threshold", 0.01, 0.2, 0.01, points(c.inflation_threshold))}
      ${choiceField(c, "model_hint", "Model hint", [["random_forest", "Random forest"], ["any", "Any"]])}
      ${numberField(c, "forks_per_choice", "Forks per arm", { min: 1, max: 8 })}
      ${numberField(c, "seed", "Seed", { min: 0 })}
      ${textField(c, "analyst_model", "Analyst model")}
      ${textField(c, "investigator_model", "Investigator model")}
    </div>
  </div>`;
}

// ── estimate and Start ───────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The estimate as one line. Each fork experiment runs a control and a forced arm, so forks are two per arm. */
function estimateLine(vm: HomeVm): string {
  const c = vm.draft;
  if (!c) {
    return defaultsFailed(vm)
      ? `<p class="hm-est" data-morph-key="est-nodefaults" data-tone="bad">Defaults did not load</p>`
      : `<p class="hm-est" data-morph-key="est-defaults">${askSpinner(12)}<span>Loading defaults</span></p>`;
  }
  const e = vm.estimate;
  if (!e || e.state === "loading") return `<p class="hm-est" data-morph-key="est-loading">${askSpinner(12)}<span>Estimating</span></p>`;
  if (e.state === "error") return `<p class="hm-est" data-morph-key="est-error" data-tone="bad">No estimate. ${esc(e.message)}</p>`;
  if (e.value.total_usd == null) return `<p class="hm-est" data-morph-key="est-none">No earlier runs to estimate from</p>`;
  return `<p class="hm-est" data-morph-key="est-ready"${e.value.over_budget ? ` data-tone="bad"` : ""}><span>About <b>${esc(usd(e.value.total_usd))}</b> for ${plural(c.n_runs, "run")} and ${plural(2 * c.forks_per_choice, "fork")}</span></p>`;
}

function footer(vm: HomeVm): string {
  const blocked = startBlocked(vm);
  // The skeleton and the button's own spinner already say "loading" and "starting": only a missing key or the budget needs words.
  const why = blocked && vm.draft && !vm.starting ? blocked : null;
  return `<div class="hm-foot" data-morph-key="foot">
    <div class="hm-foot-l">
      ${estimateLine(vm)}
      ${vm.defaults?.prices_missing ? `<p class="hm-warn" data-morph-key="prices">Prices missing, budget not enforced</p>` : ""}
    </div>
    <div class="hm-foot-r" data-morph-list>
      ${why ? `<span class="hm-why" data-morph-key="why">${esc(why)}</span>` : ""}
      <button type="button" class="hm-go" data-morph-key="go" data-act="${ACT.start}"${blocked ? ` disabled title="${attr(blocked)}"` : ""}>${vm.starting ? `${askSpinner(13)}<span>Starting</span>` : "<span>Start batch</span>"}</button>
    </div>
    ${vm.error ? `<p class="hm-errtext" data-morph-key="error" role="alert">${esc(vm.error)}</p>` : ""}
  </div>`;
}

// ── the cost bar ─────────────────────────────────────────────────────────────

export interface CostGroup { name: string; tokens: number; usd: number | null }

/** All tokens in one scope: input and output, plus cache reads and writes when tracked. */
export const scopeTokens = (s: ScopeCost): number =>
  (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0);

/** Scopes folded into Runs, Forks and Investigator (in that order), plus any other scope by its own name. */
export function costGroups(costs: Costs): CostGroup[] {
  const groups = new Map<string, CostGroup>([["Runs", { name: "Runs", tokens: 0, usd: null }], ["Forks", { name: "Forks", tokens: 0, usd: null }], ["Investigator", { name: "Investigator", tokens: 0, usd: null }]]);
  const seen = new Set<string>();
  for (const [key, s] of Object.entries(costs.scopes ?? {})) {
    const name = key === "runs" || key.startsWith("run:") ? "Runs" : key === "forks" || key.startsWith("fork:") ? "Forks"
      : key.startsWith("investigator") ? "Investigator" : key;
    const g = groups.get(name) ?? { name, tokens: 0, usd: null };
    g.tokens += scopeTokens(s);
    if (s.total_usd != null) g.usd = (g.usd ?? 0) + s.total_usd;
    groups.set(name, g);
    seen.add(name);
  }
  return [...groups.values()].filter((g) => seen.has(g.name));
}

/** The cost bar shown in the header on every batch screen: spent so far against the budget. */
export function costBar(costs: Costs, opts: { simulated: boolean }): string {
  const groups = costGroups(costs);
  const total = groups.reduce((n, g) => n + g.tokens, 0);
  const simulated = opts.simulated || costs.simulated === true;
  const noPrices = costs.prices_missing === true || costs.spent_usd === null;
  const dollars = !simulated && !noPrices && costs.spent_usd != null;
  const budget = costs.budget_usd;

  const lines = groups.map((g) => `${g.name}: ${tokens(g.tokens)} tokens${dollars && g.usd != null ? `, ${usd(g.usd)}` : ""}`);
  if (!lines.length) lines.push("No cost yet");
  if (simulated) lines.unshift("Simulated batch: token counts only, no real spend");
  else if (noPrices) lines.push("Prices missing: token counts only, the budget cap is not enforced");
  else if (dollars && budget != null) lines.push(`Spent ${usd(costs.spent_usd)} of ${usd(budget)}`);
  const title = lines.join("\n");

  const tok = `<span class="hm-cb-tok">${esc(tokens(total))} tokens</span>`;
  let inner: string;
  if (simulated) {
    inner = `<span class="hm-cb-sim">Simulated</span>${tok}`;
  } else if (dollars) {
    const ratio = budget ? costs.spent_usd! / budget : 0;
    const level = ratio > 1 ? "over" : ratio > 0.75 ? "warn" : "ok";
    const meter = budget ? `<span class="hm-cb-meter" data-level="${level}" role="meter" aria-label="Budget used" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${costs.spent_usd}"><span class="hm-cb-fill" style="width:${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%"></span></span>` : "";
    inner = `<span class="hm-cb-usd" data-level="${level}">${esc(usd(costs.spent_usd))}${budget ? `<span class="hm-cb-of"> of ${esc(usd(budget))}</span>` : ""}</span>${meter}${tok}`;
  } else if (!groups.length && costs.spent_usd === undefined && !costs.prices_missing) {
    inner = `<span class="hm-cb-tok hm-cb-tok--keep">No cost yet</span>`;
  } else {
    inner = `<span class="hm-cb-tok hm-cb-tok--keep">${esc(tokens(total))} tokens</span><span class="hm-cb-hint">prices missing</span>`;
  }
  return `<div class="hm-cb" data-morph-key="costbar" title="${attr(title)}">${inner}</div>`;
}
