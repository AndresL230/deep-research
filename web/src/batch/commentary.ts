// The live commentary (deep_research/commentary.py) on screen: a run tile's latest caption under its picture, the
// captions inline in a run's notebook, and the batch's feed of notable moments.
//
// Captions are `caption` events in a run's log, so everything here reads the logs the page already has: live they
// arrive over the websocket, and in a replay `vm.events` / `vm.logs` are cut to the replay clock, so a caption shows
// at the moment it was written. The feed is the case file's `feed` section; `replay.ts caseAt` keeps the items whose
// `t` has passed (a feed item's `t` is on its run's clock, and every run starts at 0 on the replay timeline).
//
// Views are pure (vm) -> html, like the rest of web/src/batch.

import "./commentary.css";
import type { AgentEvent, FeedItem, RunRecord } from "../api";
import { attr, esc } from "../ui";
import { duration } from "./format";
import { ACT, type BatchVm, type LogView } from "./model";
import { cellView, counts, type CellOpts, type NbCell } from "./notebook";

export interface Caption {
  /** Index of the caption event in its log: stable, so a new caption is a new element (it fades in). */
  i: number;
  t: number;
  text: string;
  /** The last caption, written once the run was scored. */
  final: boolean;
}

/** Every caption of a log, oldest first. */
export function captionsOf(events: readonly AgentEvent[] | undefined): Caption[] {
  const out: Caption[] = [];
  (events ?? []).forEach((e, i) => {
    if (e.type === "caption" && e.text?.trim()) out.push({ i, t: e.t, text: e.text.trim(), final: e.final === true });
  });
  return out;
}

/** The run's latest caption, or null. */
export function latestCaption(events: readonly AgentEvent[] | undefined): Caption | null {
  const all = captionsOf(events);
  return all.length ? all[all.length - 1] : null;
}

/** Whether this batch has commentary: its config says so, or a caption or feed item is already there (a replay of a
 *  batch saved by a server whose default differed). */
export function hasCommentary(vm: BatchVm): boolean {
  if ((vm.case.config as { commentary?: boolean }).commentary === true) return true;
  return (vm.case.feed?.length ?? 0) > 0;
}

/** The line under a run tile's picture: its latest caption, one line with an ellipsis. Empty but kept in place while
 *  a commentated run has none yet, so the tiles keep one height; nothing at all in a batch without commentary. */
export function tileCaption(vm: BatchVm, run: RunRecord): string {
  const cap = latestCaption(vm.events[run.id]);
  if (!cap) {
    return hasCommentary(vm) && run.status !== "queued"
      ? `<p class="cm-cap is-empty" data-morph-key="cap:none" aria-hidden="true"></p>`
      : "";
  }
  return `<p class="cm-cap${cap.final ? " is-final" : ""}" data-morph-key="cap:${cap.i}" title="${attr(cap.text)}">${esc(cap.text)}</p>`;
}

// ── the run page: captions inline in the notebook ───────────────────────────

/** The key of the notebook cell an event makes (notebook.ts `notebookCells`), or null when it makes none. */
function cellKey(e: AgentEvent, i: number): string | null {
  if (e.type === "tool_call") return e.name === "write_todos" ? null : e.id ?? `e${i}`;
  if (e.type === "thought") return e.text.trim() ? `e${i}` : null;
  if (e.type === "forced") return `e${i}`;
  return null;
}

/** The captions that have happened by the log's clock, each under the cell made by the latest event before it. */
export function captionPlacement(log: LogView): { top: Caption[]; after: Map<string, Caption[]> } {
  const top: Caption[] = [];
  const after = new Map<string, Caption[]>();
  let anchor: string | null = null;
  log.events.forEach((e, i) => {
    const key = cellKey(e, i);
    if (key) { anchor = key; return; }
    if (e.type !== "caption" || !e.text?.trim()) return;
    if ((log.times[i] ?? e.t) > log.clock) return;
    const cap: Caption = { i, t: e.t, text: e.text.trim(), final: e.final === true };
    if (anchor === null) top.push(cap);
    else after.set(anchor, [...(after.get(anchor) ?? []), cap]);
  });
  return { top, after };
}

function captionNote(c: Caption): string {
  return `<div class="cm-note${c.final ? " is-final" : ""}" data-morph-key="cap:${c.i}"><span class="cm-note-k">${c.final ? "Result" : "Commentary"}</span><span class="cm-note-t">${esc(c.text)}</span></div>`;
}

/** notebook.ts `notebookView`, with the run's captions between the cells. */
export function notebookWithCaptions(cells: NbCell[], log: LogView | null, opts: CellOpts = {}): string {
  const n = counts(cells);
  const place = log ? captionPlacement(log) : { top: [], after: new Map<string, Caption[]>() };
  const shown = new Set(cells.map((c) => c.key));
  // A caption whose cell is not on screen (still typing in a replay) waits at the end.
  const orphans = [...place.after].filter(([k]) => !shown.has(k)).flatMap(([, caps]) => caps);
  const body = place.top.map(captionNote).join("")
    + cells.map((c) => cellView(c, n.get(c.key) ?? 0, opts) + (place.after.get(c.key) ?? []).map(captionNote).join("")).join("")
    + orphans.map(captionNote).join("");
  return `<div class="nb${opts.compact ? " nb--compact" : ""}" data-morph-list>${body}</div>`;
}

// ── the batch page: the feed ─────────────────────────────────────────────────

/** The feed as of now, newest first: live in the order it arrived, in a replay by time (only what has happened). */
export function feedItems(vm: BatchVm): FeedItem[] {
  const all = vm.case.feed ?? [];
  if (!vm.replay) return [...all].reverse();
  return all.filter((f) => f.t <= vm.replay!.t).map((f, i) => [f, i] as const)
    .sort((a, b) => b[0].t - a[0].t || b[1] - a[1]).map(([f]) => f);
}

/** "r07 · Sonnet · finished: reports 100%, reaches 35% on new spots". */
export function feedLine(f: FeedItem): string {
  return [f.run, f.model, f.text].filter(Boolean).join(" · ");
}

/** The colour of an item's dot: a finish takes its run's status. */
function tone(vm: BatchVm, f: FeedItem): string {
  if (f.kind === "finish") return vm.case.runs[f.run]?.status ?? "done";
  return f.kind;
}

const itemKey = (f: FeedItem, i: number, all: FeedItem[]): string => {
  // Stable while items arrive: the same run, time and kind make the same key; a repeat gets its rank among them.
  const same = all.slice(i + 1).filter((g) => g.run === f.run && g.t === f.t && g.kind === f.kind).length;
  return `f:${f.run}:${f.t}:${f.kind}:${same}`;
};

/** The live feed panel: a slim column beside the wall on a wide screen, a one-line bar that opens on a narrow one. */
export function feedView(vm: BatchVm, open: boolean): string {
  if (!hasCommentary(vm)) return "";
  const items = feedItems(vm);
  const latest = items[0];
  const head = `<button type="button" class="cm-feed-hd" data-act="${ACT.toggleFeed}" aria-expanded="${open}">`
    + `<span class="cm-feed-title"><span class="cm-live" aria-hidden="true"></span>Live feed</span>`
    + (items.length ? `<span class="cm-feed-n">${items.length}</span>` : "")
    + `<span class="cm-feed-latest">${latest ? esc(feedLine(latest)) : ""}</span>`
    + `<span class="cm-feed-chev" aria-hidden="true"></span></button>`;
  const list = items.length
    ? `<ol class="cm-feed-list" data-morph-list>${items.map((f, i) =>
      `<li class="cm-item" data-tone="${attr(tone(vm, f))}" data-morph-key="${attr(itemKey(f, i, items))}">`
      + `<span class="cm-dot" aria-hidden="true"></span>`
      + `<span class="cm-item-b"><span class="cm-item-who"><button type="button" class="cm-run" data-act="${ACT.openRun}" data-arg="${attr(f.run)}">${esc(f.run)}</button>${f.model ? ` · ${esc(f.model)}` : ""}<span class="cm-item-at">${esc(duration(f.t))}</span></span>`
      + `<span class="cm-item-t">${esc(f.text)}</span></span></li>`).join("")}</ol>`
    : `<p class="cm-feed-empty">Notable moments show up here as the runs go: a first success, a dropped can, a run that finishes.</p>`;
  return `<aside class="cm-feed" data-open="${open}" data-morph-key="feed" aria-label="Live feed">${head}${list}</aside>`;
}

/** The wall with the feed beside it (or above it, folded, on a narrow screen). Just the wall without commentary. */
export function wallWithFeed(wall: string, feed: string): string {
  return feed ? `<div class="cm-wrap">${wall}${feed}</div>` : wall;
}
