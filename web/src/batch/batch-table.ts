// The home screen's batch table (home.ts `batchesSection`): one row per batch with what it came to, from each list
// item's `summary` (deep_research/batch_summary.py). A pure view like the others: the sort and the domain filter
// live in main.ts state (`HomeVm.table`) and change through the `BT_ACT` actions. Words only, never a raw label.
import "./batch-table.css";
import type { BatchListItem, BatchSummary } from "../api";
import { attr, esc } from "../ui";
import { modelShort, tokens, usd, wholePct } from "./format";
import { ACT } from "./model";

/** The table's actions, handled in main.ts: sort by a column (`data-arg` = a `SortKey`; the same one again turns the
 *  order round), and show one domain only (`data-arg` = a domain name, "" for every domain). */
export const BT_ACT = { sort: "bt-sort", domain: "bt-domain" } as const;

export const SORT_KEYS = ["batch", "domain", "started", "runs", "claim", "step", "verdict", "models", "spend"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface TableView {
  sort: SortKey;
  dir: SortDir;
  /** Show this domain's batches only; null for all. */
  domain: string | null;
}

/** Newest first, simulated fixtures last: the order the table opens in. */
export const DEFAULT_VIEW: TableView = { sort: "started", dir: "desc", domain: null };

/** The view after a header is pressed: that column, or the same column the other way round. A new column starts in
 *  the order that reads best for it: newest, most runs, biggest gap, most spend first; names A to Z. */
export function sortBy(v: TableView, key: string): TableView {
  if (!(SORT_KEYS as readonly string[]).includes(key)) return v;
  const k = key as SortKey;
  if (v.sort === k) return { ...v, dir: v.dir === "asc" ? "desc" : "asc" };
  return { ...v, sort: k, dir: FIRST_DIR[k] };
}

const FIRST_DIR: Record<SortKey, SortDir> = {
  batch: "asc", domain: "asc", started: "desc", runs: "desc", claim: "desc", step: "asc", verdict: "desc", models: "asc", spend: "desc",
};

/** Short names for the domains the app knows; a domain added later shows its own title. */
const DOMAIN_SHORT: Record<string, string> = { tabular: "Data science", robot_arm: "Robot arm", humanoid: "Humanoid strike", humanoid_push: "Humanoid push", humanoid_track: "Humanoid tracking" };

export function domainName(s: BatchSummary | null | undefined): string | null {
  const d = s?.domain;
  if (!d) return null;
  return DOMAIN_SHORT[d.name] ?? d.title ?? null;
}

/** The domain to filter on: only once the list holds more than one. */
function domainsIn(items: readonly BatchListItem[]): { name: string; label: string; n: number }[] {
  const seen = new Map<string, { name: string; label: string; n: number }>();
  for (const it of items) {
    const name = it.summary?.domain?.name;
    const label = domainName(it.summary);
    if (!name || !label) continue;
    const d = seen.get(name) ?? { name, label, n: 0 };
    d.n++;
    seen.set(name, d);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ── sorting ──────────────────────────────────────────────────────────────────

/** Verdict states from least to most settled, for the Verdict column's sort. */
const VERDICT_RANK: Record<string, number> = {
  none: 0, fork_stopped: 1, awaiting_approval: 2, fork_running: 3, forked: 4, open: 5, supported: 6,
};

const isSim = (it: BatchListItem): boolean => !!it.summary?.simulated;

/** A row's value in a column, or null when it has none (those go last either way). */
function sortValue(it: BatchListItem, key: SortKey): string | number | null {
  const s = it.summary;
  switch (key) {
    case "batch": return it.id;
    case "domain": return domainName(s);
    case "started": return s?.started_at ?? null;
    case "runs": return s ? s.n_runs : null;
    case "claim": return s?.claim ? s.claim.claimed - s.claim.measured : null;
    case "step": return s?.step?.name ?? null;
    case "verdict": return s ? VERDICT_RANK[s.verdict?.state] ?? 0 : null;
    case "models": return s?.analyst_models.length ? s.analyst_models.map(modelShort).join(", ") : null;
    case "spend": return s ? s.spend.usd ?? null : null;
  }
}

/** The rows in the view's order. Simulated batches always come after the real ones, and a row with nothing in the
 *  sorted column after the rows that have something; ties keep newest first, then the id. */
export function sortItems(items: readonly BatchListItem[], v: TableView = DEFAULT_VIEW): BatchListItem[] {
  const sign = v.dir === "asc" ? 1 : -1;
  const cmp = (a: string | number, b: string | number): number =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
  return [...items].sort((a, b) => {
    if (isSim(a) !== isSim(b)) return isSim(a) ? 1 : -1;
    const x = sortValue(a, v.sort);
    const y = sortValue(b, v.sort);
    if (x == null || y == null) {
      if (x != null) return -1;
      if (y != null) return 1;
    } else {
      const c = cmp(x, y);
      if (c) return c * sign;
    }
    const ta = a.summary?.started_at ?? "";
    const tb = b.summary?.started_at ?? "";
    return ta !== tb ? (ta < tb ? 1 : -1) : a.id.localeCompare(b.id);
  });
}

// ── cells ────────────────────────────────────────────────────────────────────

/** An empty cell: quiet words, never a dash. */
const none = (words = "none yet"): string => `<span class="bt-none">${esc(words)}</span>`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "12 min ago", "5 h ago" within a day; else "Nov 14" (with the year when it is not this one). */
export function startedLabel(iso: string | null | undefined, now: Date = new Date()): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso) : null;
  if (!m) return null;
  const when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  const s = (now.getTime() - when.getTime()) / 1000;
  if (s >= 0 && s < 60) return "just now";
  if (s >= 0 && s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s >= 0 && s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const day = `${MONTHS[when.getMonth()]} ${when.getDate()}`;
  return when.getFullYear() === now.getFullYear() ? day : `${day}, ${when.getFullYear()}`;
}

/** The kind of row, as its badge says it. */
function badges(it: BatchListItem): string {
  const s = it.summary;
  const kind = it.kind === "live" ? "live" : it.resumable ? "ready" : "replay";
  const word = kind === "live" ? "Live" : kind === "ready" ? "Ready to investigate" : "Replay";
  const sim = s?.simulated ? `<span class="hm-kind" data-kind="sim">Simulated</span>` : "";
  return `<span class="bt-badges"><span class="hm-kind" data-kind="${kind}">${word}</span>${sim}</span>`;
}

function batchCell(it: BatchListItem): string {
  const from = it.remote && it.machine ? `<span class="bt-from" title="Run on ${attr(it.machine)}, read from the team hub">${esc(it.machine)}</span>` : "";
  return `<th scope="row" class="bt-c bt-c-batch">
    <button type="button" class="bt-id" data-act="${ACT.openBatch}" data-arg="${attr(it.id)}" title="Open ${attr(it.id)}">${esc(it.id)}</button>
    <span class="bt-meta">${from}${badges(it)}</span>
  </th>`;
}

/** The runs as one stacked bar, then their counts in words. */
function runsCell(s: BatchSummary): string {
  const c = s.counts;
  const parts: [string, number, string][] = [
    ["honest", c.honest, "honest"], ["inflated", c.inflated, "inflated"], ["unclear", c.unclear, "unclear"],
    ["failed", c.failed, "failed"], ["running", c.running, "running"], ["queued", c.queued, "queued"],
    ["stopped", c.stopped, "stopped"],
  ];
  const total = parts.reduce((a, [, n]) => a + n, 0);
  if (!total) return s.n_runs ? `${none(`${s.n_runs} planned`)}` : none();
  const said = parts.filter(([, n]) => n > 0).map(([, n, w]) => `${n} ${w}`).join(", ");
  const segs = parts.filter(([, n]) => n > 0)
    .map(([k, n]) => `<i class="bt-seg" data-k="${k}" style="flex-grow:${n}"></i>`).join("");
  // The bar is for the eye; the counts under it say the same in words, so the bar itself is hidden from readers.
  const words = parts.filter(([, n]) => n > 0)
    .map(([k, n, w]) => `<span class="bt-n" data-k="${k}"><b>${n}</b> ${w}</span>`).join("");
  return `<span class="bt-bar" aria-hidden="true" title="${attr(`${total} ${total === 1 ? "run" : "runs"}: ${said}`)}">${segs}</span>
    <span class="bt-counts">${words}</span>`;
}

/** "99% → 59%" and the gap in points under it, for the inflated runs. */
function claimCell(s: BatchSummary): string {
  const cl = s.claim;
  if (!cl) {
    const over = s.counts.running + s.counts.queued === 0;
    return none(over ? "n/a" : "none yet");
  }
  const gap = Math.round(cl.claimed * 100) - Math.round(cl.measured * 100);
  const gapWords = gap > 0 ? `${gap} pts over` : gap < 0 ? `${-gap} pts under` : "no gap";
  const who = cl.of === "inflated"
    ? `${cl.n} inflated ${cl.n === 1 ? "run" : "runs"}`
    : "no run inflated";
  const tip = `Claimed ${wholePct(cl.claimed)}, measured ${wholePct(cl.measured)}${cl.n_hidden ? ` on ${cl.n_hidden} hidden cases` : ""}: mean of ${who === "no run inflated" ? "the honest runs, none inflated" : `the ${who}`}`;
  return `<span class="bt-claim${cl.of === "inflated" ? "" : " bt-claim--even"}" title="${attr(tip)}">
      <span class="bt-claim-v">${wholePct(cl.claimed)}<span class="bt-arrow" aria-hidden="true">${ARROW_RIGHT}</span><span class="mo-sr"> measured </span>${wholePct(cl.measured)}</span>
      <span class="bt-sub">${esc(cl.of === "inflated" ? gapWords : "no run inflated")}</span>
    </span>`;
}

/** The arrow between the claim and the truth, drawn so it sits on the numbers' middle in any font. */
const ARROW_RIGHT = `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 6h8.5M7 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const capital = (x: string): string => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);

function stepCell(s: BatchSummary): string {
  if (s.step) return `<span class="bt-step">${esc(capital(s.step.name))}</span>`;
  if (s.phase === "no_split") return none("no split found");
  const going = s.counts.running + s.counts.queued > 0 || s.phase === "running" || s.phase === "analyzing";
  return none(going ? "none yet" : "n/a");
}

function verdictCell(s: BatchSummary): string {
  const v = s.verdict ?? { state: "none" };
  const pairs = v.pairs != null && v.needed_pairs != null ? `${v.pairs} of ${v.needed_pairs} pairs` : v.pairs != null ? `${v.pairs} pairs` : "";
  switch (v.state) {
    case "supported": return `<span class="bt-chip" data-v="supported">Supported</span>${v.pairs != null ? `<span class="bt-sub">${v.pairs} pairs</span>` : ""}`;
    case "open": return `<span class="bt-chip" data-v="open">Open</span>${pairs ? `<span class="bt-sub">${esc(pairs)}</span>` : ""}`;
    case "cleared": return `<span class="bt-chip" data-v="quiet">Cleared</span>${v.pairs != null ? `<span class="bt-sub">${v.pairs} pairs</span>` : ""}`;
    case "inconclusive": return `<span class="bt-chip" data-v="quiet">Inconclusive</span><span class="bt-sub">no control copy reproduced it</span>`;
    case "fork_running": return `<span class="bt-chip" data-v="running"><i class="bt-pulse" aria-hidden="true"></i>Fork running</span>`;
    case "awaiting_approval": return `<span class="bt-chip" data-v="wait">Fork to approve</span>`;
    case "forked": return `<span class="bt-chip" data-v="quiet">Fork done</span><span class="bt-sub">no verdict yet</span>`;
    case "fork_stopped": return none("fork stopped");
    default: {
      const over = ["done", "no_split", "stopped"].includes(s.phase ?? "") || /^(error|blocked):/.test(s.phase ?? "");
      return none(over ? "no fork" : "not yet");
    }
  }
}

function modelsCell(s: BatchSummary): string {
  if (!s.analyst_models.length && !s.investigator_model) return none("n/a");
  const analysts = s.analyst_models.length ? s.analyst_models.map(modelShort).join(", ") : null;
  const tip = [s.analyst_models.length ? `Analyst: ${s.analyst_models.join(", ")}` : "", s.investigator_model ? `Investigator: ${s.investigator_model}` : ""]
    .filter(Boolean).join(". ");
  return `<span class="bt-models" title="${attr(tip)}">${analysts ? `<span>${esc(analysts)}</span>` : none("n/a")}${s.investigator_model ? `<span class="bt-sub">${esc(modelShort(s.investigator_model))} investigates</span>` : ""}</span>`;
}

function spendCell(s: BatchSummary): string {
  const sp = s.spend;
  if (!sp.usd && !sp.tokens) return none(s.counts.running + s.counts.queued ? "none yet" : "n/a");
  if (sp.usd != null) {
    return `<span class="bt-usd">${esc(usd(sp.usd))}${sp.usd_partial ? `<span class="bt-plus" title="Some prices were missing, so the real figure is higher">+</span>` : ""}</span>`;
  }
  if (sp.tokens > 0) return `<span class="bt-tok" title="${attr(`${sp.tokens.toLocaleString("en-US")} tokens, input and output${s.simulated ? "; simulated, so no dollars" : "; no prices for this batch"}`)}">${esc(tokens(sp.tokens))} tokens</span>`;
  return none("n/a");
}

function row(it: BatchListItem, now: Date): string {
  const s = it.summary;
  const cls = `bt-row${s?.simulated ? " bt-row--sim" : ""}${it.kind === "live" ? " bt-row--live" : ""}`;
  const head = batchCell(it);
  const td = (k: string, label: string, body: string): string =>
    `<td class="bt-c bt-c-${k}" data-label="${attr(label)}">${body}</td>`;
  if (!s) {
    // A case file that could not be read (null) says so once; a server older than the table (absent) says nothing.
    const why = s === null ? `<span class="bt-none">Case file could not be read</span>` : "";
    return `<tr class="${cls}" data-morph-key="${attr(it.id)}" data-act="${ACT.openBatch}" data-arg="${attr(it.id)}">${head}
      <td class="bt-c bt-c-empty" colspan="8">${why}</td></tr>`;
  }
  const started = startedLabel(s.started_at, now);
  return `<tr class="${cls}" data-morph-key="${attr(it.id)}" data-act="${ACT.openBatch}" data-arg="${attr(it.id)}">${head}
    ${td("domain", "Domain", domainName(s) ? esc(domainName(s)!) : none("n/a"))}
    ${td("started", "Started", started ? `<time datetime="${attr(s.started_at!)}" title="${attr(s.started_at!.replace("T", " "))}">${esc(started)}</time>` : none("no date"))}
    ${td("runs", "Runs", runsCell(s))}
    ${td("claim", "Claimed vs measured", claimCell(s))}
    ${td("step", "Step found", stepCell(s))}
    ${td("verdict", "Verdict", verdictCell(s))}
    ${td("models", "Models", modelsCell(s))}
    ${td("spend", "Spend", spendCell(s))}
  </tr>`;
}

const COLUMNS: [SortKey, string][] = [
  ["batch", "Batch"], ["domain", "Domain"], ["started", "Started"], ["runs", "Runs"], ["claim", "Claimed vs measured"],
  ["step", "Step found"], ["verdict", "Verdict"], ["models", "Models"], ["spend", "Spend"],
];

const ARROW = {
  asc: `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2v6M2.5 4.5 5 2l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  desc: `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8V2M2.5 5.5 5 8l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function headRow(v: TableView): string {
  const cells = COLUMNS.map(([k, label]) => {
    const on = v.sort === k;
    const sort = on ? ` aria-sort="${v.dir === "asc" ? "ascending" : "descending"}"` : "";
    return `<th scope="col" class="bt-h bt-c-${k}"${sort}><button type="button" class="bt-sort${on ? " is-on" : ""}" data-act="${BT_ACT.sort}" data-arg="${k}">${esc(label)}<span class="bt-sort-i">${ARROW[on ? v.dir : FIRST_DIR[k]]}</span></button></th>`;
  }).join("");
  return `<thead><tr>${cells}</tr></thead>`;
}

function filterRow(items: readonly BatchListItem[], v: TableView): string {
  const ds = domainsIn(items);
  if (ds.length < 2) return "";
  const opt = (name: string, label: string, n: number): string => {
    const on = (v.domain ?? "") === name;
    return `<button type="button" class="bt-f" data-act="${BT_ACT.domain}" data-arg="${attr(name)}" aria-pressed="${on}">${esc(label)}<span class="bt-f-n">${n}</span></button>`;
  };
  return `<div class="bt-filter" role="group" aria-label="Show batches of one domain" data-morph-key="filter">
    ${opt("", "All", items.length)}${ds.map((d) => opt(d.name, d.label, d.n)).join("")}
  </div>`;
}

/** The section's body: the domain filter and the table. `now` is for the Started column's "5 h ago". */
export function batchTable(items: readonly BatchListItem[], v: TableView = DEFAULT_VIEW, now: Date = new Date()): string {
  // A filter on a domain no batch has any more shows everything.
  const domain = v.domain && items.some((it) => it.summary?.domain?.name === v.domain) ? v.domain : null;
  const view = { ...v, domain };
  const shown = sortItems(domain ? items.filter((it) => it.summary?.domain?.name === domain) : items, view);
  const order = view.sort === "started" && view.dir === "desc" ? "newest first" : `sorted by ${COLUMNS.find(([k]) => k === view.sort)![1].toLowerCase()}`;
  return `${filterRow(items, view)}
    <div class="bt-wrap" data-morph-key="table">
      <table class="bt">
        <caption class="bt-cap">${shown.length} ${shown.length === 1 ? "batch" : "batches"}${domain ? ` in ${esc(domainsIn(items).find((d) => d.name === domain)?.label ?? "")}` : ""}, ${esc(order)}, simulated last</caption>
        ${headRow(view)}
        <tbody data-morph-list>${shown.map((it) => row(it, now)).join("")}</tbody>
      </table>
    </div>`;
}
