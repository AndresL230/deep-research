// A run's event log as a notebook: each tool call is a cell whose code is typed out, runs, then shows its output and
// any chart it saved. Used small on the wall tiles (the last few cells, like a terminal tail), full size on a run's
// page, and side by side in the "what changed" view.
//
// `notebookCells` is pure: (log, clock) -> cells. In a replay the whole log is known, so a cell is typed during the
// gap BEFORE its call lands (that gap is the model writing it). Live, the code only arrives with the call, so it is
// typed quickly right after.

import "./notebook.css";
import { batchFileUrl, isPendingForks, labPageUrl, type ForkChild, type RunRecord } from "../api";
import { attr, esc } from "../ui";
import { mdView } from "../ask-conversation";
import { codeKind, highlightLines, type CodeKind } from "./highlight";
import type { BatchVm, EventKey, LogView } from "./model";

export type CellState = "typing" | "running" | "done";
export type CellLang = "python" | "shell" | "file" | "tool";

export interface NbCell {
  /** Stable across paints: the tool call id, else the event index. */
  key: string;
  kind: "code" | "note" | "forced";
  /** The index among ALL tool calls, as the backend counts actions (run.labels, split.fork_at). Null for notes. */
  action: number | null;
  tool: string;
  lang: CellLang;
  /** The file a cell writes ("model.py"). */
  title: string | null;
  code: string;
  /** A command that runs after the file is written, in the same call ("python3 model.py"). */
  then: string | null;
  /** How many characters of `code` are on screen. */
  typed: number;
  state: CellState;
  output: string | null;
  /** File names of the charts this cell saved. */
  images: string[];
  /** A fork child's copy of its source run's history, before its own work starts. */
  inherited: boolean;
}

// ── reading a tool call ──────────────────────────────────────────────────────

const base = (p: string): string => p.split("/").filter(Boolean).at(-1) ?? p;
const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));

/** `a; b; c` on one line -> three lines, leaving semicolons inside strings and brackets alone. */
export function splitStatements(line: string): string {
  if (line.includes("\n") || !line.includes(";")) return line;
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.join("\n");
}

export interface ParsedCall { lang: CellLang; title: string | null; code: string; then: string | null }

/** A shell command as a notebook cell: inline Python and heredocs become the code they carry. */
export function parseCommand(command: string): ParsedCall {
  // Setup that says nothing (cd into the workspace, mkdir -p live) is dropped from the front.
  const cmd = command.replace(/^\s*(?:(?:cd|mkdir)\s+[^&\n]*&&\s*)+/, "").trim();
  // cat > model.py <<'EOF' ... EOF [&& python3 model.py]
  const file = cmd.match(/^cat\s*>>?\s*(\S+)\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\2[ \t]*(?:\n|&&|;|$)\s*([\s\S]*)$/);
  if (file) return { lang: "file", title: base(file[1]), code: file[3], then: file[4].replace(/^&&\s*/, "").trim() || null };
  // python3 - <<'EOF' ... EOF
  const here = cmd.match(/^python3?\s+-\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1\s*$/);
  if (here) return { lang: "python", title: null, code: here[2], then: null };
  // python3 -c "..." [; more shell]
  const inline = cmd.match(/^python3?\s+-c\s+(["'])/);
  if (inline) {
    const quote = inline[1];
    const from = inline[0].length;
    let end = -1;
    for (let i = from; i < cmd.length; i++) {
      if (quote === '"' && cmd[i] === "\\") { i++; continue; }
      if (cmd[i] === quote) { end = i; break; }
    }
    if (end > 0) {
      const raw = cmd.slice(from, end);
      const body = quote === '"' ? raw.replace(/\\(["\\$`])/g, "$1") : raw;
      const rest = cmd.slice(end + 1).replace(/^\s*(?:;|&&)\s*/, "").trim();
      return { lang: "python", title: null, code: splitStatements(body.trim()), then: rest || null };
    }
  }
  return { lang: "shell", title: null, code: `!${cmd}`, then: null };
}

export function parseCall(name: string, args: Record<string, unknown>): ParsedCall {
  if (name === "execute") return parseCommand(str(args.command));
  if (name === "write_file") return { lang: "file", title: base(str(args.file_path)), code: str(args.content), then: null };
  if (name === "edit_file") {
    const minus = str(args.old_string).split("\n").map((l) => `- ${l}`).join("\n");
    const plus = str(args.new_string).split("\n").map((l) => `+ ${l}`).join("\n");
    return { lang: "file", title: base(str(args.file_path)), code: `${minus}\n${plus}`, then: null };
  }
  const target = str(args.file_path ?? args.path ?? args.pattern ?? "");
  return { lang: "tool", title: null, code: target ? `${name} ${target}` : name, then: null };
}

/** Charts a piece of code saves: the file names passed to savefig. */
export function savedCharts(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/savefig\(\s*f?["']([^"']+)["']/g)) {
    const name = base(m[1]);
    if (/\.(png|jpe?g|svg)$/i.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** A tool result as cell output: without the harness's exit line, trimmed. */
export function cleanOutput(content: string): string {
  return content.replace(/\n?\[Command (?:succeeded|failed)[^\]]*\]\s*$/i, "").replace(/\s+$/, "");
}

// ── log -> cells ─────────────────────────────────────────────────────────────

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** The log to draw for `key`: the clocked one when main.ts provides it, else everything, finished. */
export function logOf(vm: BatchVm, key: EventKey): LogView | null {
  const given = vm.logs?.[key];
  if (given) return given;
  const events = vm.events[key];
  if (!events) return null;
  return { events, times: events.map((e) => e.t), clock: Infinity, lookahead: false };
}

export function notebookCells(log: LogView): NbCell[] {
  const { events, times, clock, lookahead } = log;
  const cells: NbCell[] = [];
  const byId = new Map<string, NbCell>();
  const written = new Map<string, string>();
  let action = 0;
  let typingAhead = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const at = times[i] ?? ev.t;
    const seen = at <= clock;
    const inherited = at === 0 && ev.t > 0;

    if (ev.type === "tool_call") {
      const index = action++;
      if (ev.name === "write_todos") continue; // the plan is the tile's progress strip, not a cell
      let typed: number | null = null;
      let state: CellState = "running";
      const parsed = parseCall(ev.name, ev.args ?? {});
      const len = parsed.code.length;
      if (!seen) {
        // A replay knows what comes next: type the next call during the gap before it lands.
        if (!lookahead || typingAhead) continue;
        typingAhead = true;
        const lead = Math.max(1.5, Math.min(8, len / 40));
        const start = Math.max(i > 0 ? times[i - 1] ?? 0 : 0, at - lead);
        if (clock <= start) continue;
        typed = Math.round(len * clamp01((clock - start) / (at - start)));
        state = "typing";
      } else if (!lookahead && Number.isFinite(clock)) {
        // Live: the code arrived whole with the call; type it quickly now.
        const dur = Math.max(0.4, Math.min(2.5, len / 300));
        const frac = clamp01((clock - at) / dur);
        if (frac < 1) { typed = Math.round(len * frac); state = "typing"; }
      }
      const cell: NbCell = {
        key: ev.id ?? `e${i}`, kind: "code", action: index, tool: ev.name, lang: parsed.lang, title: parsed.title,
        code: parsed.code, then: parsed.then, typed: typed ?? len, state, output: null, images: [], inherited,
      };
      if (ev.name === "write_file" && parsed.title) written.set(parsed.title, parsed.code);
      if (parsed.lang === "file" && parsed.title && ev.name === "execute") written.set(parsed.title, parsed.code);
      cells.push(cell);
      if (ev.id) byId.set(ev.id, cell);
      continue;
    }
    if (!seen) continue;

    if (ev.type === "tool_result") {
      const cell = (ev.id ? byId.get(ev.id) : undefined) ?? [...cells].reverse().find((c) => c.kind === "code" && c.output === null && c.tool === ev.name);
      if (!cell || cell.state === "typing") continue;
      cell.output = cleanOutput(ev.content ?? "");
      cell.state = "done";
      // The charts are saved by the code that ran: this cell's, or the script it ran.
      const script = `${cell.code}\n${cell.then ?? ""}`.match(/python3?\s+(\S+\.py)/);
      const ran = script && cell.lang !== "file" ? written.get(base(script[1])) ?? "" : "";
      cell.images = savedCharts(`${cell.code}\n${ran}`);
    } else if (ev.type === "thought") {
      const text = ev.text.trim();
      if (text) cells.push({ key: `e${i}`, kind: "note", action: null, tool: "", lang: "tool", title: null, code: text, then: null, typed: text.length, state: "done", output: null, images: [], inherited });
    } else if (ev.type === "forced") {
      const parsed = parseCommand(ev.command);
      cells.push({ key: `e${i}`, kind: "forced", action: null, tool: "execute", lang: parsed.lang, title: parsed.title, code: parsed.code, then: parsed.then, typed: parsed.code.length, state: "done", output: cleanOutput(ev.output ?? ""), images: [], inherited: false });
    }
  }
  // The log is over: nothing is still running.
  if (!Number.isFinite(clock)) for (const c of cells) if (c.state === "running") c.state = "done";
  return cells;
}

// ── what the run is doing ───────────────────────────────────────────────────

const ACTIVITY: [string, string][] = [
  ["report", "Writing the report"],
  ["predict", "Predicting the holdout"],
  ["evaluate", "Evaluating the model"],
  ["train", "Training the model"],
  ["split", "Splitting train and test"],
  ["preprocess", "Preparing the features"],
  ["clean", "Cleaning the data"],
  ["deduplicate", "Checking for duplicate rows"],
  ["plot", "Drawing charts"],
  ["inspect", "Inspecting the data"],
  ["load", "Loading the data"],
];

/** In a few words, what the latest cell is doing: the furthest step its code reaches. */
export function activityOf(cells: NbCell[]): string | null {
  const cell = [...cells].reverse().find((c) => c.kind !== "note");
  if (!cell) return null;
  const text = `${cell.code}\n${cell.then ?? ""}`;
  for (const [label, phrase] of ACTIVITY) {
    // Reading holdout_features.csv to look at it is not predicting yet.
    const rx = label === "predict" ? /\.predict\(|predictions\.csv/ : LABEL_PATTERNS[label];
    if (rx.test(text)) return phrase;
  }
  return cell.lang === "file" && cell.title ? `Writing ${cell.title}` : "Looking around";
}

export const STAGES = ["load", "split", "train", "evaluate", "report"] as const;

/** How far the run has got, for a progress strip when the agent keeps no todo list. */
export function stagesOf(cells: NbCell[]): ("completed" | "in_progress" | "pending")[] {
  const done = cells.filter((c) => c.kind !== "note" && c.state === "done").map((c) => `${c.code}\n${c.then ?? ""}`).join("\n");
  const open = cells.filter((c) => c.kind !== "note" && c.state !== "done").map((c) => `${c.code.slice(0, c.typed)}\n`).join("\n");
  return STAGES.map((s) => (LABEL_PATTERNS[s].test(done) ? "completed" : LABEL_PATTERNS[s].test(open) ? "in_progress" : "pending"));
}

// ── where a cell's charts are ────────────────────────────────────────────────

/** The run or fork child record behind an event key. */
export function recordOf(vm: BatchVm, key: EventKey): (RunRecord | ForkChild) | null {
  const slash = key.indexOf("/");
  if (slash < 0) return vm.case.runs[key] ?? null;
  const f = vm.case.forks[key.slice(0, slash)];
  return f && !isPendingForks(f) ? f.children?.[key.slice(slash + 1)] ?? null : null;
}

/** The URL of a chart a run saved: from the batch's saved files, else (live) from the VM's lab page. */
export function chartUrl(vm: BatchVm, key: EventKey, name: string): string | null {
  const rec = recordOf(vm, key) as { charts?: string[]; lab_url?: string | null } | null;
  const saved = rec?.charts?.find((p) => base(p) === name);
  if (saved) return batchFileUrl(vm.id, saved);
  if (vm.live && rec?.lab_url) return `${labPageUrl(vm.id, key)}live/${encodeURIComponent(name)}`;
  return null;
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** What marks a step in code, as the backend labels it (deep_research/analysis.py _RULES). */
export const LABEL_PATTERNS: Record<string, RegExp> = {
  load: /read_csv/,
  inspect: /\.describe\(|\.info\(|\.head\(|value_counts|\.isnull\(|\.isna\(|\.shape\b/,
  deduplicate: /drop_duplicates|\.duplicated\(/,
  clean: /fillna|dropna|replace\(\s*0|\.median\(\)/,
  split: /train_test_split|KFold|StratifiedKFold|\.sample\(\s*frac/,
  preprocess: /StandardScaler|MinMaxScaler|fit_transform|SimpleImputer/,
  train: /\.fit\(/,
  evaluate: /accuracy_score|\.score\(|classification_report|confusion_matrix|cross_val_score/,
  plot: /savefig|plt\.|matplotlib/,
  predict: /holdout_features|predictions\.csv/,
  report: /report\.json/,
};

export interface CellOpts {
  /** Resolve a saved chart's file name to a URL (null: do not draw it). */
  image?: (name: string) => string | null;
  /** Lines matching this are highlighted (the step under test). */
  mark?: RegExp | null;
  /** Tile size: only the tail of long code and output. */
  compact?: boolean;
}

const COMPACT_CODE = 9;
const COMPACT_OUT = 4;
const FULL_OUT = 40;

function gutter(c: NbCell, n: number): string {
  if (c.kind === "note") return "";
  const mark = c.state === "typing" ? " " : c.state === "running" ? "*" : String(n);
  return `<span class="nb-gut" aria-hidden="true">[${mark}]</span>`;
}

function codeLines(text: string, kind: CodeKind, opts: CellOpts, caret: boolean): string {
  let lines = text.split("\n");
  let colored = highlightLines(text, kind);
  let cut = 0;
  if (opts.compact && lines.length > COMPACT_CODE) { cut = lines.length - COMPACT_CODE; lines = lines.slice(cut); colored = colored.slice(cut); }
  const body = lines.map((l, i) => {
    const hit = opts.mark?.test(l);
    const last = i === lines.length - 1;
    return `<span class="nb-ln${hit ? " nb-hl" : ""}">${colored[i] ?? esc(l)}${last && caret ? `<span class="nb-caret" aria-hidden="true"></span>` : ""}</span>`;
  }).join("\n");
  return (cut ? `<span class="nb-more">… ${cut} more line${cut === 1 ? "" : "s"} above</span>\n` : "") + body;
}

function outputView(c: NbCell, opts: CellOpts): string {
  if (c.state !== "done") return "";
  let html = "";
  if (c.output) {
    const all = c.output.split("\n");
    const max = opts.compact ? COMPACT_OUT : FULL_OUT;
    const lines = all.slice(0, max);
    const more = all.length - lines.length;
    html += `<pre class="nb-out">${esc(lines.join("\n"))}${more > 0 ? `\n<span class="nb-more">… ${more} more line${more === 1 ? "" : "s"}</span>` : ""}</pre>`;
  }
  const imgs = c.images.map((name) => [name, opts.image?.(name) ?? null] as const).filter(([, url]) => url);
  if (imgs.length) {
    html += `<div class="nb-imgs">${imgs.map(([name, url]) => `<img class="nb-img" data-morph-key="img:${attr(name)}" src="${attr(url!)}" alt="${attr(`Chart ${name}`)}" loading="lazy" decoding="async">`).join("")}</div>`;
  }
  return html;
}

/** One cell. `n` is its execution count. */
export function cellView(c: NbCell, n: number, opts: CellOpts = {}): string {
  const cls = `nb-cell nb-cell--${c.kind} is-${c.state}${c.inherited ? " is-inherited" : ""}`;
  if (c.kind === "note") {
    // Full size: the agent's note as the markdown it wrote. On a tile: its first words.
    if (!opts.compact) return `<div class="${cls}" data-morph-key="c:${attr(c.key)}"><div class="nb-note nb-md ask-md">${mdView(c.code, false)}</div></div>`;
    const flat = c.code.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
    const text = flat.length > 160 ? `${flat.slice(0, 159).trimEnd()}…` : flat;
    return `<div class="${cls}" data-morph-key="c:${attr(c.key)}"><p class="nb-note">${esc(text)}</p></div>`;
  }
  const shown = c.code.slice(0, c.typed);
  const head = (c.kind === "forced" ? `<span class="nb-tag nb-tag--forced">Forced by the experiment</span>` : "")
    + (c.title ? `<span class="nb-file">${esc(c.title)}</span>` : "");
  const then = c.then && c.state !== "typing" ? `<pre class="nb-code nb-then"><span class="nb-ln${opts.mark?.test(c.then) ? " nb-hl" : ""}">${highlightLines(`!${c.then}`, "shell").join("\n")}</span></pre>` : "";
  return `<div class="${cls}" data-morph-key="c:${attr(c.key)}">${gutter(c, n)}<div class="nb-body">`
    + (head ? `<div class="nb-head">${head}</div>` : "")
    + `<pre class="nb-code nb-lang-${c.lang}">${codeLines(shown, codeKind(c.lang, c.title, c.code), opts, c.state === "typing")}</pre>`
    + then
    + outputView(c, opts)
    + `</div></div>`;
}

/** The execution count of each code cell, by cell key. */
export function counts(cells: NbCell[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const c of cells) if (c.kind !== "note") out.set(c.key, ++n);
  return out;
}

/** A whole notebook. */
export function notebookView(cells: NbCell[], opts: CellOpts = {}): string {
  const n = counts(cells);
  return `<div class="nb${opts.compact ? " nb--compact" : ""}" data-morph-list>${cells.map((c) => cellView(c, n.get(c.key) ?? 0, opts)).join("")}</div>`;
}

/** The end of a notebook for a tile: the last `keep` cells, the latest at the bottom. */
export function notebookTail(cells: NbCell[], opts: CellOpts = {}, keep = 3): string {
  const n = counts(cells);
  const tail = cells.slice(-keep);
  return `<div class="nb nb--compact nb--tail" data-morph-list>${tail.map((c) => cellView(c, n.get(c.key) ?? 0, { ...opts, compact: true })).join("")}</div>`;
}
