// The overall cost screen (#/costs): what every batch cost, from GET /api/costs (deep_research/cost_report.py).
// Pure: `(vm) => html string`, like every view here. main.ts loads the report and handles the clicks.
//
// One color per spend group, the same in every bar, legend and row: runs blue, forks purple, the investigator amber.
// Model spend against VM time is the other way to cut the same total, so it uses no hue: solid ink and a hatch.
import "./costs.css";
import type { BatchCost, CostReport, CostTokens, ModelCost } from "../api";
import { askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { duration, tokens, usd } from "./format";
import { ACT, type Loadable } from "./model";

export interface CostsVm {
  report: Loadable<CostReport>;
  /** The batch this screen was opened from, to go back to. Null: back goes home. */
  back: string | null;
}

// ── numbers and labels ───────────────────────────────────────────────────────

/** Dollars to the cent with thousands separators: 1234.5 -> "$1,234.50". Under a cent shows "<$0.01". */
export function money(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return "-";
  if (x > 0 && x < 0.01) return "<$0.01";
  const [whole, cents] = x.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** VM time: 39720 -> "11h 02m"; under an hour it reads like `duration` ("9m 30s"). */
export function vmTime(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "-";
  const m = Math.round(seconds / 60);
  return seconds < 3600 ? duration(seconds) : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-14T09:30:12" -> "Nov 14, 09:30". Read as written (the server's local time), never shifted by a time zone. */
export function whenLabel(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso) : null;
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[4]}:${m[5]}` : "No date";
}

/** A part's share of a total as text: "64%", "<1%" for a sliver, "0%" for nothing. */
export function share(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return "0%";
  const p = (part / total) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** "anthropic:claude-haiku-5-5" -> "claude-haiku-5-5". */
export const modelName = (model: string): string => model.replace(/^[a-z0-9_-]+:/i, "");

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const exact = (n: number): string => `${n.toLocaleString("en-US")} tokens`;

// ── the bars ─────────────────────────────────────────────────────────────────

export interface Part { key: string; label: string; usd: number; note?: string }

const GROUP_LABEL: Record<string, string> = { runs: "Runs", forks: "Forks", investigator: "Investigator", commentary: "Commentary", other: "Other" };

/** The spend groups of one dollar split, in their fixed order. `Commentary` and `Other` show only when they hold
 *  something. */
export function groupParts(u: { runs: number; forks: number; investigator: number; commentary?: number; other?: number }): Part[] {
  const parts: Part[] = (["runs", "forks", "investigator"] as const).map((key) => ({ key, label: GROUP_LABEL[key], usd: u[key] }));
  if ((u.commentary ?? 0) > 0) parts.push({ key: "commentary", label: GROUP_LABEL.commentary, usd: u.commentary! });
  if ((u.other ?? 0) > 0) parts.push({ key: "other", label: GROUP_LABEL.other, usd: u.other! });
  return parts;
}

/** A stacked bar. `scale` (0 to 1) is how much of the track the whole bar fills: 1 for a split of one total, the
 *  batch's share of the most expensive batch in a row. A part with no spend draws nothing. */
export function stackedBar(parts: Part[], opts: { scale?: number; small?: boolean; label: string } ): string {
  const total = parts.reduce((n, p) => n + p.usd, 0);
  const scale = total > 0 ? Math.min(1, Math.max(0, opts.scale ?? 1)) : 0;
  const segs = parts.filter((p) => p.usd > 0).map((p) =>
    `<span class="cs-seg" data-k="${attr(p.key)}" style="flex-grow:${((p.usd / total) * 100).toFixed(2)}" title="${attr(`${p.label}: ${usd(p.usd)}`)}"></span>`).join("");
  const described = parts.filter((p) => p.usd > 0).map((p) => `${p.label} ${usd(p.usd)}`).join(", ") || "nothing yet";
  return `<div class="cs-bar${opts.small ? " cs-bar--sm" : ""}" role="img" aria-label="${attr(`${opts.label}: ${described}`)}"><div class="cs-bar-fill" style="width:${(scale * 100).toFixed(2)}%">${segs}</div></div>`;
}

function legend(parts: Part[]): string {
  const total = parts.reduce((n, p) => n + p.usd, 0);
  return `<ul class="cs-legend">${parts.map((p) => `<li class="cs-leg">
    <span class="cs-sw" data-k="${attr(p.key)}"></span><span class="cs-leg-n">${esc(p.label)}${p.note ? `<span class="cs-leg-x">${esc(p.note)}</span>` : ""}</span>
    <span class="cs-leg-v">${esc(money(p.usd))}</span><span class="cs-leg-p">${esc(share(p.usd, total))}</span>
  </li>`).join("")}</ul>`;
}

function splitCard(key: string, title: string, parts: Part[]): string {
  return `<section class="cs-card" data-morph-key="${key}">
    <h2 class="cs-h2">${esc(title)}</h2>
    ${stackedBar(parts, { label: title })}
    ${legend(parts)}
  </section>`;
}

// ── sections ─────────────────────────────────────────────────────────────────

const OUTCOMES = [["honest", "honest"], ["inflated", "inflated"], ["unclear", "unclear"], ["failed", "failed"]] as const;

/** Outcome counts as chips: honest green, inflated red, unclear and failed grey. Runs with no score yet get a plain chip. */
export function outcomeChips(c: { runs: number; honest: number; inflated: number; unclear?: number; failed: number }): string {
  const chips = OUTCOMES.filter(([k]) => (c[k] ?? 0) > 0).map(([k, word]) => `<span class="cs-chip" data-s="${k}">${c[k]} ${word}</span>`);
  const open = c.runs - c.honest - c.inflated - (c.unclear ?? 0) - c.failed;
  if (open > 0) chips.push(`<span class="cs-chip" data-s="open">${open} not scored</span>`);
  return chips.length ? `<span class="cs-chips">${chips.join("")}</span>` : `<span class="cs-dim">No runs</span>`;
}

function hero(r: CostReport): string {
  const t = r.totals;
  const behind = [plural(t.batches, "batch", "batches"), plural(t.runs, "run")];
  if (t.fork_runs) behind.push(plural(t.fork_runs, "fork run"));
  const plus = t.usd_partial ? `<span class="cs-plus" title="Some prices were missing, so the real total is higher">+</span>` : "";
  return `<header class="cs-hero" data-morph-key="hero">
    <span class="cs-eyebrow">Total spend</span>
    <div class="cs-total">${esc(money(t.usd.total))}${plus}</div>
    <div class="cs-behind"><span>${esc(behind.join(" · "))}</span>${t.runs ? outcomeChips(t) : ""}</div>
    ${t.usd_partial ? `<p class="cs-warn" role="note">Some prices were missing when these ran. This is what is known, so the real total is higher.</p>` : ""}
  </header>`;
}

function tokenStrip(t: CostTokens, vmSeconds: number): string {
  const cell = (label: string, value: string, title: string, sub = ""): string =>
    `<div class="cs-stat"><span class="cs-stat-l">${esc(label)}</span><span class="cs-stat-v" title="${attr(title)}">${esc(value)}</span>${sub ? `<span class="cs-stat-s">${esc(sub)}</span>` : ""}</div>`;
  return `<section class="cs-sec" data-morph-key="tokens" aria-labelledby="cs-tok-h">
    <h2 class="cs-h2" id="cs-tok-h">Tokens and VM time</h2>
    <div class="cs-stats">
      ${cell("Input", tokens(t.input), exact(t.input), "whole prompts, cached parts included")}
      ${cell("Cache read", tokens(t.cache_read), exact(t.cache_read), `${share(t.cache_read, t.input)} of input`)}
      ${cell("Cache write", tokens(t.cache_write), exact(t.cache_write), `${share(t.cache_write, t.input)} of input`)}
      ${cell("Output", tokens(t.output), exact(t.output))}
      ${cell("VM time", vmTime(vmSeconds), `${Math.round(vmSeconds).toLocaleString("en-US")} seconds`, "from VM up to VM deleted")}
    </div>
  </section>`;
}

const ROLE: Record<string, string> = { analyst: "Analyst", investigator: "Investigator", commentary: "Commentary" };

function modelRows(models: ModelCost[]): string {
  if (!models.length) return "";
  const top = Math.max(...models.map((m) => m.usd));
  const rows = models.map((m) => `<li class="cs-model" data-morph-key="${attr(m.model)}">
    <span class="cs-model-n"><span class="cs-mono" title="${attr(m.model)}">${esc(modelName(m.model))}</span>${m.roles.map((role) => `<span class="cs-tag">${esc(ROLE[role] ?? role)}</span>`).join("")}</span>
    ${stackedBar(groupParts(m.usd_by_group), { scale: top > 0 ? m.usd / top : 0, small: true, label: modelName(m.model) })}
    <span class="cs-model-t" title="${attr(`${exact(m.tokens.input)} in, ${exact(m.tokens.output)} out`)}">${esc(tokens(m.tokens.input))} in · ${esc(tokens(m.tokens.output))} out</span>
    <span class="cs-num">${esc(money(m.usd))}${m.usd_partial ? `<span class="cs-plus" title="Some prices were missing, so the real figure is higher">+</span>` : ""}</span>
  </li>`).join("");
  return `<section class="cs-sec" data-morph-key="models" aria-labelledby="cs-mod-h">
    <h2 class="cs-h2" id="cs-mod-h">By model<span class="cs-h2-x">model spend only</span></h2>
    <ul class="cs-models" data-morph-list>${rows}</ul>
  </section>`;
}

const tokensLine = (t: CostTokens): string => `${tokens(t.input)} in · ${tokens(t.output)} out`;

/** One batch: id (opens it), when, what it ran on, outcomes, its spend against the most expensive batch, its total. */
export function batchRow(b: BatchCost, maxUsd: number): string {
  const total = b.usd?.total ?? 0;
  // No dollars to show: a simulated batch, or one that ran with no prices at all.
  const tokensOnly = b.usd === null || (b.usd_partial && total === 0);
  const tags = `${b.kind === "live" ? `<span class="cs-tag" data-t="live">Live</span>` : ""}${b.simulated ? `<span class="cs-tag" data-t="sim">Simulated</span>` : ""}`;
  const phase = b.phase && b.phase !== "done" ? `<span class="cs-phase">${esc(String(b.phase).split(":")[0].replace(/_/g, " "))}</span>` : "";
  const what = [b.dataset, b.trap].filter((x): x is string => !!x).join(" · ") || "-";
  const spend = tokensOnly
    ? `<span class="cs-dim" title="${attr(`${exact(b.tokens.input)} in, ${exact(b.tokens.output)} out`)}">${esc(tokensLine(b.tokens))} tokens</span>`
    : stackedBar(groupParts(b.usd!), { scale: maxUsd > 0 ? total / maxUsd : 0, small: true, label: "Spend" });
  const amount = tokensOnly
    ? `<span class="cs-dim">${b.simulated ? "Tokens only" : "No prices"}</span>`
    : `${esc(usd(total))}${b.usd_partial ? `<span class="cs-plus" title="Some prices were missing, so the real figure is higher">+</span>` : ""}`;
  return `<li class="cs-row${b.simulated ? " cs-row--sim" : ""}" data-morph-key="${attr(b.id)}">
    <span class="cs-c cs-c-id"><button type="button" class="cs-id" data-act="${ACT.openBatch}" data-arg="${attr(b.id)}" title="Open ${attr(b.id)}">${esc(b.id)}</button>${tags}${phase}</span>
    <span class="cs-c cs-c-when" title="${attr(b.started_at ? b.started_at.replace("T", " ") : "This batch has no date")}">${esc(whenLabel(b.started_at))}</span>
    <span class="cs-c cs-c-what">${esc(what)}</span>
    <span class="cs-c cs-c-out">${outcomeChips(b.counts)}</span>
    <span class="cs-c cs-c-bar">${spend}</span>
    <span class="cs-c cs-c-total cs-num">${amount}</span>
  </li>`;
}

function batchTable(r: CostReport): string {
  const maxUsd = Math.max(0, ...r.batches.map((b) => b.usd?.total ?? 0));
  const sim = r.simulated.batches;
  return `<section class="cs-sec" data-morph-key="batches" aria-labelledby="cs-bat-h">
    <h2 class="cs-h2" id="cs-bat-h">Batches<span class="cs-h2-x">newest first${sim ? ", simulated last" : ""}</span></h2>
    <div class="cs-table">
      <div class="cs-head" aria-hidden="true"><span>Batch</span><span>Started</span><span>Dataset and trap</span><span>Runs</span><span>Spend</span><span class="cs-num">Total</span></div>
      <ul class="cs-rows" data-morph-list>${r.batches.map((b) => batchRow(b, maxUsd)).join("")}</ul>
    </div>
  </section>`;
}

function notCounted(items: string[]): string {
  if (!items.length) return "";
  return `<aside class="cs-note" data-morph-key="note" aria-labelledby="cs-note-h">
    <h2 class="cs-h2" id="cs-note-h">Not counted</h2>
    <ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </aside>`;
}

// ── the screen ───────────────────────────────────────────────────────────────

function body(r: CostReport): string {
  if (!r.batches.length) {
    return `<div class="cs-empty" data-morph-key="empty"><h2>No batches yet</h2><p>Start a batch and what it costs shows up here.</p></div>`;
  }
  const t = r.totals;
  if (!t.batches) {
    return `${hero(r)}
      <p class="cs-quiet" data-morph-key="none">No real batch has run yet. Simulated batches are listed below with their token counts and add nothing to the total.</p>
      ${batchTable(r)}${notCounted(r.not_counted)}`;
  }
  const kinds: Part[] = [
    { key: "model", label: "Model", usd: t.usd.model },
    { key: "vm", label: "VM time", usd: t.usd.vm, note: vmTime(t.vm_seconds) },
  ];
  return `${hero(r)}
    <div class="cs-split" data-morph-key="split">
      ${splitCard("groups", "Where it went", groupParts(t.usd))}
      ${splitCard("kinds", "Model spend and VM time", kinds)}
    </div>
    ${tokenStrip(t.tokens, t.vm_seconds)}
    ${modelRows(r.by_model)}
    ${batchTable(r)}
    ${notCounted(r.not_counted)}`;
}

/** The cost screen: the grand total, where it went, tokens, models, then every batch. */
export function costsView(vm: CostsVm): string {
  const rep = vm.report;
  let inner: string;
  if (rep.state === "loading") {
    inner = `<div class="cs-state" data-morph-key="loading">${askSpinner(13)}<span>Adding up the batches</span></div>`;
  } else if (rep.state === "error") {
    inner = `<div class="cs-err" data-morph-key="error" role="alert"><span>${esc(rep.message)}</span>
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="${ACT.openCosts}">Retry</button></div>`;
  } else {
    inner = body(rep.value);
  }
  // No back button: the navbar links to Batches, and the browser goes back to a batch.
  return `<div class="cs" data-morph-key="costs">${inner}</div>`;
}
