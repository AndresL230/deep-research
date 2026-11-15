// The home screen's "Needs you" list (home.ts `homeView`, above the batch table): one row per batch of this server
// that waits on a person, each with one action. A pure view like the others: what is in flight for a row (a quote, an
// open confirm, an error) lives in `HomeVm.needs`, keyed by `needKey`, so a repaint never loses it; main.ts runs the
// actions (`NY_ACT`) and the calls behind them, the same ones the batch page makes (resume, decide, more pairs).
import "./needs-you.css";
import { ApiError, type BatchListItem, type BatchSummary, type MorePairsQuote } from "../api";
import { askSpinner } from "../ask-icons";
import { attr, esc } from "../ui";
import { usd } from "./format";
import { ACT, type Loadable } from "./model";
import type { Role } from "../access";

/** The rows' actions, handled in main.ts. `data-arg` is the batch id. */
export const NY_ACT = {
  approve: "ny-approve",
  decline: "ny-decline",
  investigate: "ny-investigate",
  /** An open verdict's "Run 4 more": fetch the quote and open the confirm. */
  more: "ny-more",
  /** The confirm's Start: run the quoted pairs, then open the batch. */
  start: "ny-start",
  /** Close the confirm (or the refusal in its place). */
  cancel: "ny-cancel",
} as const;

/** What a batch needs, in the order the list shows them. */
export const NEED_KINDS = ["approve", "investigate", "open", "running"] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

export interface Need { id: string; kind: NeedKind; item: BatchListItem; summary: BatchSummary }

/** A row's state while a person acts on it. Absent: the row at rest. */
export type NeedUi =
  /** A call in flight: its button spins and the row's buttons are off. */
  | { state: "busy"; action: "approve" | "decline" | "investigate" | "quote" }
  /** More pairs quoted and within budget: the confirm with Start and Cancel. `starting` while the POST runs. */
  | { state: "confirm"; quote: MorePairsQuote; starting?: boolean }
  /** More pairs cannot run (over budget, or the server said why with a 409): the reason, and Cancel. */
  | { state: "refused"; message: string }
  /** The last action failed: why, under the row, with its buttons back to try again. */
  | { state: "error"; message: string }
  /** The action went through: a word on it until the list shows the batch's next state. */
  | { state: "done"; message: string };

/** The key of a row's state in `HomeVm.needs`: a batch's need, so a row that becomes another kind starts afresh. */
export const needKey = (kind: NeedKind, id: string): string => `${kind}:${id}`;

/** A batch this server can act on: one of its own (not the team hub's), real (not a fixture, not simulated), with a
 *  summary to read. */
export function actionable(it: BatchListItem): it is BatchListItem & { summary: BatchSummary } {
  return !it.remote && !it.fixture && !!it.summary && !it.summary.simulated;
}

const finished = (s: BatchSummary): number => s.counts.honest + s.counts.inflated + s.counts.unclear + s.counts.failed;

/** What a batch needs from a person, or null. One thing per batch, the most pressing. */
export function needOf(it: BatchListItem): NeedKind | null {
  if (!actionable(it)) return null;
  const s = it.summary;
  const live = it.kind === "live";
  const state = s.verdict?.state;
  // The decide endpoint answers a live batch only: a saved one waiting for approval is picked up by Investigate.
  if (live && (s.phase === "awaiting_approval" || state === "awaiting_approval")) return "approve";
  if (!live && it.resumable) return "investigate";
  if (!live && state === "open") return "open";
  if (live && (s.counts.running + s.counts.queued > 0 || s.phase === "forking" || s.phase === "investigating")) return "running";
  return null;
}

/** Every need in the list's order: approvals, then ready to investigate, open verdicts, then running; newest first
 *  within each. */
export function needsOf(items: readonly BatchListItem[]): Need[] {
  const out: Need[] = [];
  for (const it of items) {
    const kind = needOf(it);
    if (kind && it.summary) out.push({ id: it.id, kind, item: it, summary: it.summary });
  }
  const rank = (k: NeedKind): number => NEED_KINDS.indexOf(k);
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
    const ta = a.summary.started_at ?? "";
    const tb = b.summary.started_at ?? "";
    return ta !== tb ? (ta < tb ? 1 : -1) : a.id.localeCompare(b.id);
  });
}

/** How many batches wait on a person's action, for the header's count: the list's rows less the running ones (those
 *  only offer Open, nothing waits on the person). Null until the list has loaded. */
export function needsCount(batches: Loadable<readonly BatchListItem[]>): number | null {
  if (batches.state !== "ready") return null;
  return needsOf(batches.value).filter((n) => n.kind !== "running").length;
}

/** The rows' states after the list changed: a row's state goes once its batch no longer needs that, unless a call
 *  for it is still in flight (its answer lands on it). */
export function pruneNeeds(ui: Readonly<Record<string, NeedUi>> | undefined, items: readonly BatchListItem[]): Record<string, NeedUi> {
  const keep = new Set(needsOf(items).map((n) => needKey(n.kind, n.id)));
  const out: Record<string, NeedUi> = {};
  for (const [k, v] of Object.entries(ui ?? {})) if (keep.has(k) || v.state === "busy" || (v.state === "confirm" && v.starting)) out[k] = v;
  return out;
}

// ── the confirm flow for more pairs ──────────────────────────────────────────

/** The row after the quote came back: the confirm, or why it cannot start when it is over the budget. */
export function quoteUi(q: MorePairsQuote): NeedUi {
  if (q.over_budget || q.budget_problem) {
    return { state: "refused", message: q.budget_problem ? `Over budget: ${q.budget_problem}.` : "Over budget." };
  }
  return { state: "confirm", quote: q };
}

/** The server's refusal in the row's words: "Can't run more pairs: <why>." without the HTTP status around it. */
export function refusalText(raw: string): string {
  let why = raw.replace(/^The server answered HTTP \d+:?\s*/i, "").replace(/^cannot run more pairs:?\s*/i, "").trim();
  why = why.replace(/\.$/, "");
  return why ? `Can't run more pairs: ${why}.` : "Can't run more pairs.";
}

/** The row after the quote or the start failed: a 409 is a refusal (the reason, and Cancel); anything else an error
 *  (the reason, and the button again). */
export function moreFailedUi(e: unknown): NeedUi {
  const msg = e instanceof Error ? e.message : "That didn't work.";
  if (e instanceof ApiError && e.status === 409) return { state: "refused", message: refusalText(msg) };
  return { state: "error", message: msg };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "9 VMs, about $1.12. 4 pairs now, 8 after." */
export function quoteText(q: MorePairsQuote): string {
  const cost = q.estimate_usd != null ? `about ${usd(q.estimate_usd)}` : "cost unknown, prices missing";
  return `${plural(q.vm_count, "VM")}, ${cost}. ${plural(q.pairs_now, "pair")} now, ${q.pairs_after} after.`;
}

// ── the rows' words ──────────────────────────────────────────────────────────

/** "Fork waiting for approval: 17 VMs, about $2.10". */
export function approveText(s: BatchSummary): string {
  const p = s.pending;
  const what = p?.kind === "fix" ? "Fix test" : "Fork";
  const parts: string[] = [];
  if (p?.vm_count != null) parts.push(plural(p.vm_count, "VM"));
  if (p) parts.push(p.estimate_usd != null ? `about ${usd(p.estimate_usd)}` : "cost unknown");
  return `${what} waiting for approval${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/** "Scored, split found: removing duplicate rows. Ready to investigate". */
export function investigateText(s: BatchSummary): string {
  return `Scored, split found${s.step ? `: ${s.step.name}` : ""}. Ready to investigate`;
}

/** "Open at 4 of 8 pairs: removing duplicate rows". */
export function openText(s: BatchSummary): string {
  const { pairs, needed_pairs: needed } = s.verdict;
  const at = pairs != null && needed != null ? `Open at ${pairs} of ${needed} pairs` : pairs != null ? `Open at ${plural(pairs, "pair")}` : "Open verdict";
  return `${at}${s.step ? `: ${s.step.name}` : ""}`;
}

/** The pairs "Run 4 more" offers: the ones still needed, at least one (the server's default for the quote). */
export function morePairs(s: BatchSummary): number | null {
  const { pairs, needed_pairs: needed } = s.verdict;
  return pairs != null && needed != null ? Math.max(1, needed - pairs) : null;
}

/** A running batch: its words and how far along it is (0 to 1), or null for no bar. */
export function runningLine(s: BatchSummary): { text: string; share: number | null } {
  const fp = s.fork_progress;
  if (fp && fp.total > 0) return { text: `Fork running: ${fp.scored} of ${fp.total} copies scored`, share: fp.scored / fp.total };
  if (s.phase === "forking") return { text: "Fork running", share: null };
  if (s.phase === "investigating") return { text: "Investigator at work", share: null };
  const done = finished(s);
  const total = Math.max(s.n_runs, done + s.counts.running + s.counts.queued);
  return { text: `${done} of ${total} scored`, share: total ? done / total : null };
}

// ── the view ─────────────────────────────────────────────────────────────────

const spin = (on: boolean): string => (on ? askSpinner(12) : "");

function btn(act: string, id: string, label: string, o: { primary?: boolean; busy?: boolean; off?: boolean; focus?: boolean } = {}): string {
  return `<button type="button" class="ask-btn ny-btn${o.primary ? " ds-primary" : ""}" data-act="${act}" data-arg="${attr(id)}"` +
    `${o.off || o.busy ? " disabled" : ""}${o.busy ? ` aria-busy="true"` : ""}${o.focus ? " data-ny-focus" : ""}>${spin(!!o.busy)}<span>${esc(label)}</span></button>`;
}

/** The row's buttons and its live line (what the confirm or the last action says), for its kind and state. */
function actions(n: Need, ui: NeedUi | undefined): { buttons: string; say: string; tone: "" | "bad" } {
  const id = n.id;
  const busy = ui?.state === "busy" ? ui.action : null;
  const errorSay = ui?.state === "error" ? ui.message : "";
  switch (n.kind) {
    case "approve": {
      if (ui?.state === "done") return { buttons: "", say: ui.message, tone: "" };
      return {
        buttons: btn(NY_ACT.approve, id, "Approve", { primary: true, busy: busy === "approve", off: !!busy })
          + btn(NY_ACT.decline, id, "Decline", { busy: busy === "decline", off: !!busy }),
        say: errorSay, tone: errorSay ? "bad" : "",
      };
    }
    case "investigate":
      return { buttons: btn(NY_ACT.investigate, id, "Investigate", { primary: true, busy: busy === "investigate" }), say: errorSay, tone: errorSay ? "bad" : "" };
    case "open": {
      if (ui?.state === "confirm") {
        return {
          buttons: btn(NY_ACT.start, id, "Start", { primary: true, busy: !!ui.starting, focus: true })
            + btn(NY_ACT.cancel, id, "Cancel", { off: !!ui.starting }),
          say: quoteText(ui.quote), tone: "",
        };
      }
      if (ui?.state === "refused") return { buttons: btn(NY_ACT.cancel, id, "Cancel", { focus: true }), say: ui.message, tone: "bad" };
      const k = morePairs(n.summary);
      return {
        buttons: btn(NY_ACT.more, id, k != null ? `Run ${k} more` : "Run more", { busy: busy === "quote" }),
        say: errorSay, tone: errorSay ? "bad" : "",
      };
    }
    case "running":
      return { buttons: `<button type="button" class="ask-btn ny-btn" data-act="${ACT.openBatch}" data-arg="${attr(id)}">Open</button>`, say: "", tone: "" };
  }
}

function lineOf(n: Need): { text: string; share: number | null } {
  switch (n.kind) {
    case "approve": return { text: approveText(n.summary), share: null };
    case "investigate": return { text: investigateText(n.summary), share: null };
    case "open": return { text: openText(n.summary), share: null };
    case "running": return runningLine(n.summary);
  }
}

/** Someone who may not act on batches (access.ts): each row only opens its batch. */
const openOnly = (n: Need) => ({
  buttons: `<button type="button" class="ask-btn ny-btn" data-act="${ACT.openBatch}" data-arg="${attr(n.id)}">Open</button>`,
  say: "", tone: "" as const,
});

function row(n: Need, ui: NeedUi | undefined, role: Role): string {
  const { text, share } = lineOf(n);
  const a = role === "admin" ? actions(n, ui) : openOnly(n);
  const bar = share != null
    ? `<span class="ny-bar" role="progressbar" aria-label="${attr(text)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share * 100)}"><i style="width:${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%"></i></span>`
    : "";
  return `<li class="ny-row" data-morph-key="${attr(n.id)}" data-kind="${n.kind}">
    <span class="ny-dot" aria-hidden="true"></span>
    <button type="button" class="ny-name" data-act="${ACT.openBatch}" data-arg="${attr(n.id)}" title="Open ${attr(n.id)}">${esc(n.id)}</button>
    <div class="ny-body">
      <div class="ny-text">${esc(text)}</div>${bar}
      <div class="ny-say"${a.tone ? ` data-tone="${a.tone}"` : ""} aria-live="polite" data-morph-key="say">${esc(a.say)}</div>
    </div>
    <div class="ny-acts" data-morph-key="acts">${a.buttons}</div>
  </li>`;
}

/** The section: the rows, or one quiet line when nothing waits. Nothing at all until the list has loaded. */
export function needsView(batches: Loadable<BatchListItem[]>, ui: Readonly<Record<string, NeedUi>> = {}, role: Role = "admin"): string {
  if (batches.state !== "ready") return "";
  const needs = needsOf(batches.value);
  if (!needs.length) {
    return `<section class="hm-sec ny-sec" data-morph-key="needs" aria-label="Needs you"><div class="ny-none" data-morph-key="none">Nothing needs you.</div></section>`;
  }
  return `<section class="hm-sec ny-sec" data-morph-key="needs" aria-labelledby="ny-h">
    <h2 class="hm-h2" id="ny-h">Needs you</h2>
    <ul class="ny" data-morph-list>${needs.map((n) => row(n, ui[needKey(n.kind, n.id)], role)).join("")}</ul>
  </section>`;
}
