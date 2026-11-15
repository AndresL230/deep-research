// OWNER: subagent A. The home screen (Needs you from needs-you.ts, the batch table from batch-table.ts), the New batch
// form with its estimate and Start (shown in a dialog, new-batch-dialog.ts), and the header cost bar.
import "./home.css";
import type { BatchConfig, BatchListItem, ControllerInfo, Costs, Defaults, Health, ScopeCost, TrapInfo } from "../api";
import { askIcon, askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { pct, tokens, usd } from "./format";
import { DEFAULT_VIEW, batchTable, type TableView } from "./batch-table";
import { ACT, type HomeVm, type Loadable } from "./model";
import { needsView } from "./needs-you";
import { DEFAULT_PLANTED, chosenTrap } from "./trap";

// ── home screen ──────────────────────────────────────────────────────────────

/** What the batch runs on, drawn by dataset-input.ts: its rows for the panel and a one-line summary (tabular), and
 *  the robot arm domain's controller row with the uploaded controller it shows, if any. */
export interface HomeInputs { html: string; label: string; controllerHtml?: string; controller?: ControllerInfo | null }

/** The home screen: what needs a person, then the batches to open. A new batch starts from the header's "+ New batch"
 *  (`newBatchView`, in a dialog). Labels only, no prose. */
export function homeView(vm: HomeVm): string {
  return `<div class="hm" data-morph-key="home">
    ${needsView(vm.batches, vm.needs)}
    ${batchesSection(vm.batches, vm.table)}
  </div>`;
}

/** The id of the New batch dialog's title, which the <dialog> names itself by (`aria-labelledby`). */
export const NEW_BATCH_TITLE = "nbd-title";

/**
 * The New batch form, as the inside of its dialog (main.ts, new-batch-dialog.ts): the title and what the batch runs
 * on, the form, then the estimate and Start in a footer that stays in view while the form scrolls.
 */
export function newBatchView(vm: HomeVm, inputs?: HomeInputs): string {
  const trap = chosenTrap(vm.defaults, vm.draft?.trap);
  // What the batch runs on, the trap and its strength only mean something in the tabular domain.
  const tabular = isTabular(vm.draft);
  // Uploaded controllers are the robot arm's: the humanoid starts from its template or the colleague's controller.
  const uploads = takesUploads(vm.draft);
  const controller = uploads ? inputs?.controller ?? null : null;
  const summary = tabular
    ? summaryLabel(inputs?.label ?? `Pima diabetes · ${DEFAULT_PLANTED}`, trap)
    : controller ? `Starting from ${controller.name}` : "";
  return `<div class="nbd-h" data-morph-key="nbd-head">
      <div class="nbd-t">
        <h2 class="hm-h2" id="${NEW_BATCH_TITLE}">New batch</h2>
        ${summary ? `<span class="hm-fixed">${esc(summary)}</span>` : ""}
      </div>
      <button type="button" class="nbd-x" data-act="${ACT.closeNewBatch}" aria-label="Close" title="Close">${askIcon("close", 16)}</button>
    </div>
    <div class="nbd-body" data-morph-key="nbd-body">
      ${vm.draft ? domainRow(vm.draft, vm.defaults, vm.starting) : ""}
      ${tabular ? inputs?.html ?? "" : uploads ? inputs?.controllerHtml ?? "" : ""}
      ${vm.draft && tabular ? trapRow(vm.draft, vm.defaults?.traps ?? []) : ""}
      ${vm.draft ? mainRow(vm.draft, trap, vm.starting) : mainSkeleton(defaultsFailed(vm))}
      ${advancedBlock(vm, controller)}
    </div>
    ${footer(vm)}`;
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

function batchesSection(b: Loadable<BatchListItem[]>, view: TableView = DEFAULT_VIEW): string {
  let body: string;
  if (b.state === "loading") {
    body = `<div class="hm-note" data-morph-key="loading">${askSpinner(12)}<span>Loading batches</span></div>`;
  } else if (b.state === "error") {
    body = `<div class="hm-err" data-morph-key="error" role="alert"><span>${esc(b.message)}</span>
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.home}">Retry</button></div>`;
  } else if (!b.value.length) {
    body = `<div class="hm-note" data-morph-key="empty">No batches yet</div>`;
  } else {
    body = batchTable(b.value, view);
  }
  return `<section class="hm-sec hm-sec--batches" data-morph-key="batches" aria-labelledby="hm-batches-h">
    <h2 class="hm-h2" id="hm-batches-h">Batches</h2>
    ${body}
  </section>`;
}

// ── the domain ───────────────────────────────────────────────────────────────

/** The domain picker's action, handled in main.ts: `data-act="hm-domain" data-arg="<domain name>"`. */
export const HM_ACT = { domain: "hm-domain", model: "hm-model" } as const;

/** The domain of a config that names none (every batch saved before domains). */
export const DEFAULT_DOMAIN = "tabular";

export const domainOf = (c: Pick<BatchConfig, "domain"> | null | undefined): string => c?.domain || DEFAULT_DOMAIN;
const isTabular = (c: BatchConfig | null | undefined): boolean => domainOf(c) === DEFAULT_DOMAIN;
/** The domains whose agents can start from an uploaded controller (deep_research/controllers.py): the robot arm. */
const takesUploads = (c: BatchConfig | null | undefined): boolean => domainOf(c) === "robot_arm";

/** Settings only the tabular domain reads: what the agents get (dataset, target, script) and the planted flaw. */
export const TABULAR_ONLY = [
  "dataset", "target", "script", "trap", "trap_strength", "trap_noise", "trap_hidden_share", "model_hint", "holdout_fraction",
] as const;

/** Settings only the robot domain reads: what the agents' controller.py starts as, and the uploaded controller. */
export const ROBOT_ONLY = ["robot_start", "robot_controller"] as const;

/** A domain's default config: the server's top-level one for the tabular domain, as before domains. */
export function domainDefaults(d: Defaults, name: string): BatchConfig | null {
  if (name === DEFAULT_DOMAIN) return d.config;
  return d.domains?.find((x) => x.name === name)?.config ?? null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft for domain `name`. With no `from`, its defaults. With `from` (the draft being edited), that draft with
 * every setting whose default differs between the two domains (the domain itself, the inflation threshold) set to the
 * new domain's default: runs, budget, hint and models carry over, and so do tabular settings a round trip leaves alone.
 */
export function domainDraft(d: Defaults, name: string, from?: BatchConfig | null): BatchConfig | null {
  const to = domainDefaults(d, name);
  if (!to) return from ?? null;
  if (!from) return { ...to };
  const was = domainDefaults(d, domainOf(from)) ?? d.config;
  const out: Record<string, unknown> = { ...from };
  for (const k of new Set([...Object.keys(to), ...Object.keys(was)])) {
    const a = (was as unknown as Record<string, unknown>)[k];
    const b = (to as unknown as Record<string, unknown>)[k];
    if (!same(a, b)) out[k] = b;
  }
  return out as unknown as BatchConfig;
}

/** The first draft once the defaults load: the remembered domain's when the server has it, else the defaults. */
export function initialDraft(d: Defaults, remembered: string | null): BatchConfig {
  const known = remembered && remembered !== DEFAULT_DOMAIN && d.domains?.some((x) => x.name === remembered);
  return (known && domainDraft(d, remembered)) || { ...d.config };
}

/** The home screen after the domain picker is pressed. Nothing changes while a batch is starting. */
export function pickDomain(vm: HomeVm, name: string): HomeVm {
  if (!vm.defaults || !vm.draft || vm.starting || name === domainOf(vm.draft)) return vm;
  const draft = domainDraft(vm.defaults, name, vm.draft);
  return draft && draft !== vm.draft ? { ...vm, draft, error: null } : vm;
}

/** Reset: the chosen domain's defaults. */
export function resetDraft(vm: HomeVm): BatchConfig | null {
  return vm.defaults ? domainDraft(vm.defaults, domainOf(vm.draft)) : vm.draft;
}

/**
 * The body of POST /api/batches. Tabular: the draft with what dataset-input.ts chose, as before domains, and its
 * robot-only settings at the tabular defaults (an uploaded controller never reaches a tabular batch). Any other
 * domain: the draft with its tabular-only settings at that domain's defaults, so the case file never shows a dataset or
 * a trap the batch did not use.
 */
export function startPayload(draft: BatchConfig, inputs: Pick<BatchConfig, "dataset" | "target" | "script">, defaults: Defaults | null): BatchConfig {
  const tabular = isTabular(draft);
  const own = defaults ? domainDefaults(defaults, domainOf(draft)) : null;
  const reset: Record<string, unknown> = {};
  if (own) for (const k of tabular ? ROBOT_ONLY : TABULAR_ONLY) if (k in own) reset[k] = (own as unknown as Record<string, unknown>)[k];
  if (tabular) {
    // Even on a server whose defaults do not name the keys.
    if (draft.robot_controller) reset.robot_controller = null;
    if (draft.robot_start === "uploaded" && !("robot_start" in reset)) reset.robot_start = "blank";
    return { ...draft, ...inputs, ...reset, mode: "live" } as BatchConfig;
  }
  return { ...draft, ...reset, mode: "live" } as BatchConfig;
}

const DOMAIN_KEY = "orro.domain";

/** The domain chosen last time on this browser, or null. */
export function recallDomain(): string | null {
  try { return localStorage.getItem(DOMAIN_KEY); } catch { return null; }
}

export function rememberDomain(name: string): void {
  try { localStorage.setItem(DOMAIN_KEY, name); } catch { /* private window or storage off: not remembered */ }
}

/** Short names for the picker. A domain added later shows its own title. */
const DOMAIN_SHORT: Record<string, string> = { tabular: "Data science", robot_arm: "Robot arm", humanoid_push: "Humanoid push" };

/** The choice of domain, with the chosen one's line under it. Only when the server offers more than one. */
function domainRow(c: BatchConfig, d: Defaults | null, locked: boolean): string {
  // The default domain first, as the form was before there was a choice; the others in the server's order.
  const list = [...(d?.domains ?? [])].sort((x, y) => Number(y.name === DEFAULT_DOMAIN) - Number(x.name === DEFAULT_DOMAIN));
  if (list.length < 2) return "";
  const cur = domainOf(c);
  const chosen = list.find((x) => x.name === cur);
  const opts = list.map((x) => {
    const on = x.name === cur;
    return `<button type="button" class="hm-dom-o" role="radio" aria-checked="${on}" data-act="${HM_ACT.domain}" data-arg="${attr(x.name)}" title="${attr(x.title)}"${locked ? " disabled" : ""}>${esc(DOMAIN_SHORT[x.name] ?? x.title)}</button>`;
  }).join("");
  return `<div class="hm-dom" data-morph-key="domain">
    <div class="hm-dom-seg" role="radiogroup" aria-label="Task">${opts}</div>
    ${chosen?.description ? `<span class="hm-dom-d">${esc(chosen.description)}</span>` : ""}
  </div>`;
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

/** A two or three option choice as radio inputs: main.ts reads the picked one's value, and morph.ts keeps `checked` in
 *  step. The options in `off` cannot be picked yet. */
function choiceField(cfg: BatchConfig, f: Field, label: string, opts: [string, string][], off: readonly string[] = []): string {
  const v = String(cfg[f]);
  return `<div class="hm-field" data-f="${f}"${opts.length > 2 ? ' data-w="wide"' : ""} role="radiogroup" aria-labelledby="${fid(f)}-l">
    <span class="hm-lbl" id="${fid(f)}-l">${esc(label)}</span>
    <div class="hm-seg${opts.length > 2 ? " hm-seg--3" : ""}">${opts.map(([val, text]) =>
      `<label class="hm-seg-o"><input type="radio" name="${f}" data-cfg="${f}" value="${attr(val)}"${val === v ? " checked" : ""}${off.includes(val) ? " disabled" : ""}><span>${esc(text)}</span></label>`).join("")}</div>
  </div>`;
}

function textField(cfg: BatchConfig, f: Field, label: string): string {
  return `<div class="hm-field" data-f="${f}" data-w="wide">
    <label class="hm-lbl" for="${fid(f)}">${esc(label)}</label>
    <div class="hm-ctl"><input class="hm-input hm-input--code" id="${fid(f)}" type="text" spellcheck="false" autocomplete="off" value="${attr(String(cfg[f]))}" data-cfg="${f}"></div>
  </div>`;
}

/** The analyst models the Models control offers, in its order. A model the draft names that is not here shows too. */
export const MODEL_CHOICES: readonly [string, string][] = [
  ["anthropic:claude-haiku-5-5", "Haiku 5.5"],
  ["anthropic:claude-sonnet-5-5", "Sonnet 5.5"],
];

/** The draft's lineup: `analyst_models`, else `analyst_model` alone. */
export const draftModels = (c: BatchConfig): string[] => (c.analyst_models?.length ? [...c.analyst_models] : [c.analyst_model]);

/** The draft with `model` added to or taken out of its lineup, kept in the control's order. The last model stays. */
export function toggleModel(c: BatchConfig, model: string): BatchConfig {
  const cur = draftModels(c);
  const on = cur.includes(model);
  if (on && cur.length === 1) return c;
  const next = on ? cur.filter((m) => m !== model) : [...cur, model];
  const order = (m: string) => { const i = MODEL_CHOICES.findIndex(([id]) => id === m); return i < 0 ? MODEL_CHOICES.length : i; };
  next.sort((a, b) => order(a) - order(b));
  return { ...c, analyst_models: next };
}

/** Which analyst models the runs take in turn: one chip per model, at least one on. */
function modelsField(c: BatchConfig, locked: boolean): string {
  const cur = draftModels(c);
  const extra: [string, string][] = cur.filter((m) => !MODEL_CHOICES.some(([id]) => id === m)).map((m) => [m, m]);
  const chips = [...MODEL_CHOICES, ...extra].map(([id, label]) => {
    const on = cur.includes(id);
    // The last model on cannot be turned off: a batch needs one.
    const last = on && cur.length === 1;
    return `<button type="button" class="hm-chip" aria-pressed="${on}" data-act="${HM_ACT.model}" data-arg="${attr(id)}" title="${attr(id)}"${locked || last ? " disabled" : ""}>${esc(label)}</button>`;
  }).join("");
  return `<div class="hm-field" data-f="analyst_models" role="group" aria-labelledby="${fid("analyst_models")}-l">
    <span class="hm-lbl" id="${fid("analyst_models")}-l">Models</span>
    <div class="hm-chips">${chips}</div>
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

/** The four settings that matter, on one row. The strength slider is named by the chosen trap. Other domains plant
 *  nothing, so they have the analyst models in its place. */
function mainRow(c: BatchConfig, trap: TrapInfo | null, locked = false): string {
  const tabular = isTabular(c);
  return `<div class="hm-main${tabular ? "" : " hm-main--models"}" data-morph-key="main">
    ${numberField(c, "n_runs", "Runs", { min: 1, max: 48 })}
    ${tabular ? rangeField(c, "trap_strength", trap?.strength_label || "Duplicated rows", 0, 1, 0.05, pct(c.trap_strength, 0)) : modelsField(c, locked)}
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

/** The Advanced toggle and, when it is open, the rest of the settings and Reset. `controller` is the robot domain's
 *  uploaded controller, which its "Your upload" start needs. */
function advancedBlock(vm: HomeVm, controller: ControllerInfo | null = null): string {
  const c = vm.draft;
  const open = !!vm.advanced && !!c;
  const toggle = `<button type="button" class="hm-adv-t" data-act="${ACT.toggleAdvanced}" aria-expanded="${open}"${open ? ` aria-controls="hm-adv"` : ""}${c ? "" : " disabled"}>${askIcon("chevRight", 13)}<span>Advanced</span></button>`;
  if (!c || !open) return `<div class="hm-adv" data-morph-key="adv"><div class="hm-adv-h">${toggle}</div></div>`;
  const head = `<div class="hm-adv-h">${toggle}<button type="button" class="ask-ghostbtn hm-reset" data-act="${ACT.resetConfig}"${vm.starting ? " disabled" : ""}>Reset</button></div>`;
  if (!isTabular(c)) {
    // A success rate gap, wider than an accuracy gap: the robot default is 27.5 points (sim/CALIBRATION.md).
    return `<div class="hm-adv" data-morph-key="adv">
    ${head}
    <div class="hm-adv-grid" id="hm-adv" data-morph-key="adv-grid">
      ${choiceField(c, "robot_start", "Controller start", [["blank", "Blank"], ["colleague", "Colleague's"], ["uploaded", "Your upload"]], takesUploads(c) && (controller || c.robot_controller) ? [] : ["uploaded"])}
      ${choiceField(c, "robot_prompt", "Prompt", [["default", "Default"], ["practice", "Practice focus"]])}
      ${rangeField(c, "inflation_threshold", "Inflation threshold", 0.05, 0.5, 0.025, points(c.inflation_threshold))}
      ${numberField(c, "forks_per_choice", "Forks per arm", { min: 1, max: 8 })}
      ${numberField(c, "seed", "Seed", { min: 0 })}
      ${textField(c, "investigator_model", "Investigator model")}
    </div>
  </div>`;
  }
  return `<div class="hm-adv" data-morph-key="adv">
    ${head}
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
      : key.startsWith("investigator") ? "Investigator" : key === "commentary" ? "Commentary" : key;
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
    // The page's one Simulated marker: the sections and the run page no longer repeat it.
    inner = `<span class="hm-cb-sim" title="Simulated batch: the agents' choices are scripted, the scores and charts are real. Token counts only, no real spend.">Simulated</span>${tok}`;
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
