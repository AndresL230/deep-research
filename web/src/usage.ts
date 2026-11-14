// The Usage view (NEW, not from Trov): what each agent run cost, when it ran, and the total. Reads GET /api/usage,
// which the server builds from runs/usage.jsonl (one line per turn). Prices are Anthropic's; Daytona time is not in it.

import { esc, attr } from "./ui";

export interface UsageRun {
  at: string;
  conversation: string;
  question: string;
  status: "done" | "error" | "stopped" | string;
  seconds: number;
  model: string;
  tokens: { in: number; out: number; cache_read: number; cache_write: number };
  cost: number | null;
}

export interface UsageSummary {
  runs: UsageRun[];
  totalCost: number;
  totalRuns: number;
  totalTokens: { in: number; out: number };
}

export type UsageState =
  | { state: "idle" }
  | { state: "loading"; last: UsageSummary | null }
  | { state: "ready"; data: UsageSummary }
  | { state: "error"; message: string; last: UsageSummary | null };

export async function fetchUsage(): Promise<UsageSummary> {
  let res: Response;
  try { res = await fetch("/api/usage", { cache: "no-store" }); } catch { throw new Error("Couldn't reach the server. Is it running on port 8000?"); }
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
  return (await res.json()) as UsageSummary;
}

/** "$0.0412" under a dollar (runs are cents), "$12.34" above. */
export function fmtCost(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const whenFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : whenFmt.format(d);
}

const STATUS_WORD: Record<string, string> = { done: "Done", error: "Failed", stopped: "Stopped" };

function statsView(d: UsageSummary): string {
  const avg = d.totalRuns ? d.totalCost / d.totalRuns : 0;
  const stat = (label: string, value: string, sub = "") =>
    `<div class="use-stat"><div class="use-stat-l">${esc(label)}</div><div class="use-stat-v">${esc(value)}</div>${sub ? `<div class="use-stat-s">${esc(sub)}</div>` : ""}</div>`;
  return `<div class="use-stats" data-morph-key="stats">
    ${stat("Total cost", fmtCost(d.totalCost))}
    ${stat("Runs", String(d.totalRuns), d.totalRuns ? `${fmtCost(avg)} average` : "")}
    ${stat("Tokens", `${fmtTokens(d.totalTokens.in)} in`, `${fmtTokens(d.totalTokens.out)} out`)}
  </div>`;
}

function rowView(r: UsageRun, i: number): string {
  const cacheNote = r.tokens.cache_read ? ` · ${fmtTokens(r.tokens.cache_read)} cached` : "";
  const status = STATUS_WORD[r.status] ?? r.status;
  return `<tr data-morph-key="r${i}-${attr(r.at)}">
    <td class="use-when">${esc(fmtWhen(r.at))}</td>
    <td class="use-q" title="${attr(r.question)}"><span class="use-q-t">${esc(r.question)}</span>${r.status !== "done" ? `<span class="use-badge is-${attr(r.status)}">${esc(status)}</span>` : ""}</td>
    <td class="use-num">${esc(fmtDuration(r.seconds))}</td>
    <td class="use-num" title="${attr(`${r.tokens.in.toLocaleString()} in (${r.tokens.cache_read.toLocaleString()} cache read, ${r.tokens.cache_write.toLocaleString()} cache write) · ${r.tokens.out.toLocaleString()} out`)}">${esc(fmtTokens(r.tokens.in))} / ${esc(fmtTokens(r.tokens.out))}<span class="use-sub">${esc(cacheNote)}</span></td>
    <td class="use-num use-cost">${esc(fmtCost(r.cost))}</td>
  </tr>`;
}

export function usageView(u: UsageState): string {
  const data = u.state === "ready" ? u.data : u.state === "loading" || u.state === "error" ? u.last : null;
  const head = `<div class="use-head" data-morph-key="head"><h2 class="use-h">Usage</h2>
    <button type="button" class="ask-ghostbtn" data-act="usageRefresh"${u.state === "loading" ? " disabled" : ""}>${u.state === "loading" ? "Refreshing…" : "Refresh"}</button></div>`;
  const err = u.state === "error" ? `<p class="ask-empty-err use-err" role="alert" data-morph-key="err">${esc(u.message)}</p>` : "";
  if (!data) {
    return `<div class="use-col">${head}${err}${u.state === "error" ? "" : `<p class="use-empty" data-morph-key="wait">Loading…</p>`}</div>`;
  }
  const table = data.runs.length
    ? `<div class="use-tbl-w" data-morph-key="tbl"><table class="ask-tbl use-tbl">
        <thead><tr><th>When</th><th>Question</th><th class="use-num">Time</th><th class="use-num">Tokens in / out</th><th class="use-num">Cost</th></tr></thead>
        <tbody data-morph-list>${data.runs.map(rowView).join("")}</tbody>
      </table></div>`
    : `<p class="use-empty" data-morph-key="none">No runs yet. Ask the agent something and it will show up here.</p>`;
  return `<div class="use-col">${head}${err}${statsView(data)}${table}
    <p class="use-foot" data-morph-key="foot">Anthropic API cost at Claude Sonnet 5.5 rates ($2 / $10 per million tokens in / out; cache reads $0.10, cache writes $2.50). Daytona sandbox time is not included. Times are local.</p></div>`;
}
