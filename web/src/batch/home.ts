// OWNER: subagent A. The home screen (batch list + config form + estimate + Start) and the header cost bar.
import "./home.css";
import type { BatchConfig, BatchListItem, Costs, Estimate, Health, ScopeCost } from "../api";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { pct, tokens, usd } from "./format";
import { ACT, type HomeVm, type Loadable } from "./model";

// ── home screen ──────────────────────────────────────────────────────────────

/** The home screen: saved and live batches to open, and the config screen to start a new one. */
export function homeView(vm: HomeVm): string {
  return `<div class="hm" data-morph-key="home">
    <p class="hm-lead">Run one data science agent many times, find the step where its results go wrong, and prove it by forking the VM.</p>
    ${batchesSection(vm.batches)}
    <section class="hm-sec" data-morph-key="new">
      <div class="hm-sec-h">
        <h2 class="hm-h2">New batch</h2>
        ${keysRow(vm.health)}
      </div>
      ${vm.draft ? configForm(vm.draft) : formSkeleton()}
      ${vm.draft ? estimateBlock(vm) : ""}
      ${startRow(vm)}
    </section>
  </div>`;
}

/** Why Start is disabled, or null when it can be pressed. */
export function startBlocked(vm: HomeVm): string | null {
  if (!vm.draft) return "Loading the defaults.";
  if (vm.starting) return "Starting.";
  const missing = missingKeys(vm.health);
  if (missing.length) return `Live batches cannot start: add the ${missing.join(" and ")} key to .env.`;
  if (vm.estimate?.state === "ready" && vm.estimate.value.over_budget) return "The estimate is over the budget cap.";
  return null;
}

function missingKeys(h: Health | null): string[] {
  if (!h) return [];
  const out: string[] = [];
  if (!h.keys.anthropic) out.push("Anthropic");
  if (!h.keys.daytona) out.push("Daytona");
  return out;
}

function batchesSection(b: Loadable<BatchListItem[]>): string {
  let body: string;
  if (b.state === "loading") {
    body = `<div class="hm-note" data-morph-key="loading">${askSpinner(13)}<span>Loading batches</span></div>`;
  } else if (b.state === "error") {
    body = `<div class="hm-err" data-morph-key="error" role="alert"><span>${esc(b.message)}</span>
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.home}">Retry</button></div>`;
  } else if (!b.value.length) {
    body = `<div class="hm-note" data-morph-key="empty">No batches yet. Start one below.</div>`;
  } else {
    const rows = b.value.map((it) => {
      const live = it.kind === "live";
      return `<button type="button" class="hm-batch" data-morph-key="${attr(it.id)}" data-act="${ACT.openBatch}" data-arg="${attr(it.id)}">
        <span class="hm-batch-id">${esc(it.id)}</span>
        <span class="hm-kind" data-kind="${live ? "live" : "replay"}">${live ? "Live" : "Replay"}</span>
        <span class="hm-batch-go">${askIcon("chevRight", 14)}</span>
      </button>`;
    }).join("");
    body = `<div class="hm-batches" data-morph-list data-morph-key="list">${rows}</div>`;
  }
  return `<section class="hm-sec" data-morph-key="batches">
    <div class="hm-sec-h"><h2 class="hm-h2">Batches</h2></div>
    ${body}
  </section>`;
}

function keysRow(h: Health | null): string {
  if (!h) return `<div class="hm-keys" data-morph-key="keys-loading">${askSpinner(11)}<span>Checking keys</span></div>`;
  const pill = (name: string, ok: boolean) =>
    `<span class="hm-key" data-ok="${ok ? "1" : "0"}"><span class="hm-dot" aria-hidden="true"></span>${name} key ${ok ? "set" : "missing"}</span>`;
  return `<div class="hm-keys" data-morph-key="keys">${pill("Anthropic", h.keys.anthropic)}${pill("Daytona", h.keys.daytona)}</div>`;
}

// ── the config form ──────────────────────────────────────────────────────────

type Field = keyof BatchConfig;

const fid = (f: Field) => `hm-f-${f}`;

function rangeField(cfg: BatchConfig, f: Field, label: string, min: number, max: number, step: number, shown: string, help?: string): string {
  const v = cfg[f] as number;
  return `<div class="hm-field">
    <div class="hm-lbl-row"><label class="hm-lbl" for="${fid(f)}">${esc(label)}</label><output class="hm-out" for="${fid(f)}">${esc(shown)}</output></div>
    <input class="hm-range" id="${fid(f)}" type="range" min="${min}" max="${max}" step="${step}" value="${attr(String(v))}" data-cfg="${f}">
    ${help ? `<p class="hm-help">${esc(help)}</p>` : ""}
  </div>`;
}

function numberField(cfg: BatchConfig, f: Field, label: string, o: { min?: number; max?: number; step?: number | "any"; prefix?: string; help?: string }): string {
  const v = cfg[f] as number;
  const bounds = `${o.min != null ? ` min="${o.min}"` : ""}${o.max != null ? ` max="${o.max}"` : ""} step="${o.step ?? 1}"`;
  return `<div class="hm-field">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <div class="hm-inwrap">${o.prefix ? `<span class="hm-prefix" aria-hidden="true">${esc(o.prefix)}</span>` : ""}<input class="hm-input${o.prefix ? " hm-input--pre" : ""}" id="${fid(f)}" type="number" inputmode="decimal"${bounds} value="${attr(String(v))}" data-cfg="${f}"></div>
    ${o.help ? `<p class="hm-help">${esc(o.help)}</p>` : ""}
  </div>`;
}

function selectField(cfg: BatchConfig, f: Field, label: string, opts: [string, string][], help?: string): string {
  const v = String(cfg[f]);
  return `<div class="hm-field">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <select class="hm-input hm-select" id="${fid(f)}" data-cfg="${f}">${opts.map(([val, text]) =>
      `<option value="${attr(val)}"${val === v ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>
    ${help ? `<p class="hm-help">${esc(help)}</p>` : ""}
  </div>`;
}

function textField(cfg: BatchConfig, f: Field, label: string, help?: string): string {
  return `<div class="hm-field">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <input class="hm-input hm-input--code" id="${fid(f)}" type="text" spellcheck="false" autocomplete="off" value="${attr(String(cfg[f]))}" data-cfg="${f}">
    ${help ? `<p class="hm-help">${esc(help)}</p>` : ""}
  </div>`;
}

const fixedField = (label: string, value: string) =>
  `<div class="hm-field"><span class="hm-lbl">${esc(label)}</span><span class="hm-fixed">${esc(value)}</span></div>`;

/** "8 pts" from 0.08: the threshold as whole accuracy points. */
const points = (x: number) => `${Math.round(x * 1000) / 10} pts`;

function configForm(c: BatchConfig): string {
  const group = (key: string, title: string, inner: string) =>
    `<fieldset class="hm-group" data-morph-key="${key}"><legend class="hm-legend">${title}</legend><div class="hm-grid">${inner}</div></fieldset>`;
  return `<div class="hm-form" data-morph-key="form">
    ${group("task", "Task", [
      fixedField("Dataset", "Pima diabetes"),
      fixedField("Trap", "Planted duplicate rows"),
      rangeField(c, "trap_strength", "Trap strength", 0, 1, 0.05, `${pct(c.trap_strength, 0)} of rows duplicated`,
        "Share of the agent's rows that get copied once more."),
      rangeField(c, "trap_noise", "Trap noise", 0, 0.5, 0.05, c.trap_noise === 0 ? "Exact copies" : String(c.trap_noise),
        "Small noise on the copies so exact duplicate checks miss them."),
      selectField(c, "hint_level", "Hint level", [["none", "None"], ["light", "Light"]], "How much the task hints at the trap."),
      selectField(c, "model_hint", "Model hint", [["random_forest", "Random forest"], ["any", "Any model"]],
        "Duplicates inflate tree models far more than linear ones."),
      rangeField(c, "holdout_fraction", "Holdout", 0.05, 0.45, 0.05, `${pct(c.holdout_fraction, 0)} of rows`,
        "Rows kept back to measure true accuracy. The agent never sees them."),
      numberField(c, "seed", "Seed", { min: 0, step: 1 }),
    ].join(""))}
    ${group("agents", "Agents", [
      numberField(c, "n_runs", "Runs", { min: 1, max: 24, help: "Analyst runs, each in its own VM." }),
      numberField(c, "forks_per_choice", "Forks per arm", { min: 1, max: 8, help: "VM forks for each of the control and forced arms." }),
      textField(c, "analyst_model", "Analyst model"),
      textField(c, "investigator_model", "Investigator model"),
    ].join(""))}
    ${group("budget", "Budget", [
      numberField(c, "budget_usd", "Budget cap", { min: 0, step: "any", prefix: "$", help: "The batch stops spending when it reaches this." }),
      rangeField(c, "inflation_threshold", "Inflation threshold", 0.01, 0.2, 0.01, points(c.inflation_threshold),
        "A run counts as inflated when reported accuracy beats true accuracy by more than this."),
    ].join(""))}
  </div>`;
}

function formSkeleton(): string {
  const bar = (w: number) => `<span class="hm-skel" style="width:${w}%"></span>`;
  return `<div class="hm-form hm-form--skel" data-morph-key="skeleton" aria-busy="true">
    <div class="hm-note">${askSpinner(13)}<span>Loading the defaults</span></div>
    ${[0, 1, 2].map(() => `<div class="hm-group hm-group--skel">${bar(22)}${bar(64)}${bar(48)}</div>`).join("")}
  </div>`;
}

// ── estimate and Start ───────────────────────────────────────────────────────

function estimateBlock(vm: HomeVm): string {
  const pricesNote = vm.defaults?.prices_missing
    ? `<p class="hm-warn" data-morph-key="prices">Some prices are missing from prices.json, so the budget cap cannot be enforced.</p>`
    : "";
  const e = vm.estimate;
  let body = "";
  if (!e || e.state === "loading") {
    body = `<div class="hm-note" data-morph-key="est-loading">${askSpinner(13)}<span>Estimating cost</span></div>`;
  } else if (e.state === "error") {
    body = `<p class="hm-errtext" data-morph-key="est-error">Could not estimate the cost. ${esc(e.message)}</p>`;
  } else {
    body = estimateReady(e.value, vm.draft!.budget_usd);
  }
  return `<div class="hm-est" data-morph-key="estimate">
    <div class="hm-est-h">Estimated cost</div>
    ${body}
    ${pricesNote}
  </div>`;
}

function estimateReady(e: Estimate, budget: number): string {
  if (e.total_usd == null) {
    return `<p class="hm-help" data-morph-key="est-none">There are no earlier runs to estimate from, so there is no estimate yet.</p>`;
  }
  const cell = (k: string, v: string) => `<div class="hm-est-cell"><span class="hm-est-k">${k}</span><span class="hm-est-v">${esc(v)}</span></div>`;
  return `<div class="hm-est-row" data-morph-key="est-ready" data-over="${e.over_budget ? "1" : "0"}">
      ${cell("Runs", usd(e.runs_usd))}${cell("Forks", usd(e.forks_usd))}${cell("Total", usd(e.total_usd))}${cell("Budget", usd(budget))}
    </div>
    <p class="hm-help">Basis: ${esc(e.basis)}${e.avg_run_usd != null ? `, ${esc(usd(e.avg_run_usd))} per run` : ""}.</p>
    ${e.over_budget ? `<p class="hm-errtext" role="alert">Over the ${esc(usd(budget))} budget. Lower the runs or forks, or raise the cap.</p>` : ""}`;
}

function startRow(vm: HomeVm): string {
  const blocked = startBlocked(vm);
  const missing = missingKeys(vm.health);
  const why = missing.length
    ? `<p class="hm-errtext" data-morph-key="why">Live batches cannot start: the ${missing.join(" and ")} key ${missing.length > 1 ? "are" : "is"} missing. Add ${missing.length > 1 ? "them" : "it"} to .env.</p>`
    : "";
  return `<div class="hm-start" data-morph-key="start">
    <div class="hm-start-btns">
      <button type="button" class="hm-go" data-act="${ACT.start}"${blocked ? ` disabled title="${attr(blocked)}"` : ""}>${vm.starting ? `${askSpinner(13)}<span>Starting</span>` : "<span>Start batch</span>"}</button>
      <button type="button" class="ask-ghostbtn" data-act="${ACT.resetConfig}"${vm.draft && !vm.starting ? "" : " disabled"}>Reset</button>
    </div>
    ${why}
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
