// Ported from Trov (~/Projects/trov/web/src/ask-composer.ts)
//
// The composer:
//   • the input grows as you type (46 → 220px, then it scrolls); Enter sends, Shift+Enter is a new line (never
//     mid-IME); while the agent answers, Send is Stop and aborts the request
//   • ONE CSV, attached by the paperclip (a file picker), by dragging it over the conversation (the "Drop a CSV to
//     attach" overlay), or by Try the sample; it shows as a chip ABOVE the box (×  removes it); another CSV replaces
//     it; a file that is not a CSV, or is over 50 MB, is refused with a note above the box
//   • the file goes with the NEXT question only (docs/api-contract.md: `file` only on the turn it is attached)
// Dropped from Trov: the @ picker and / commands, context chips, the mode menu and the Auto switch, the usage line and
// the blocked states, drafts per thread, uploads on attach, pasting files, the phone's + menu, sharing.

import { esc, attr, fmtBytes } from "./ui";
import { askIcon } from "./ask-icons";

/** The server's cap (docs/api-contract.md: over 50 MB → `error {code:"too_large"}`); checked here first. */
export const MAX_BYTES = 50 * 1024 * 1024;

/** The attached CSV. `too_large`: refused here (the chip stays red, Send is off, until it is removed). */
export interface ComposerFile { name: string; size: number; file: File; state: "ready" | "too_large" }

export interface ComposerUi {
  text: string;
  file: ComposerFile | null;
  /** The note above the box for a file that could not be attached. */
  notice: { kind: "too_large" | "unsupported" | "too_many"; name: string } | null;
  /** Files are being dragged over the conversation. */
  drag: boolean;
  /** The input's height (px), measured after a paint; null = not measured yet. */
  h: number | null;
  /** Its words are taller than the 220px cap: only then may it scroll. */
  full: boolean;
}
export const initialComposerUi = (): ComposerUi => ({ text: "", file: null, notice: null, drag: false, h: null, full: false });

export interface ComposerView { ui: ComposerUi; busy: boolean; empty: boolean }

export const isCsv = (f: { name: string; type?: string }): boolean => /\.csv$/i.test(f.name) || f.type === "text/csv";

/** Attach `files` (the picker's, a drop's): the first CSV is THE file; anything else says why it was not taken. */
export function attachFiles(ui: ComposerUi, files: File[]): ComposerUi {
  const csv = files.find(isCsv);
  if (!csv) return files.length ? { ...ui, notice: { kind: "unsupported", name: files[0].name } } : ui;
  const state = csv.size > MAX_BYTES ? "too_large" : "ready";
  const others = files.filter((f) => f !== csv);
  return {
    ...ui,
    file: { name: csv.name, size: csv.size, file: csv, state },
    notice: state === "too_large" ? { kind: "too_large", name: csv.name } : others.length ? { kind: "too_many", name: others[0].name } : null,
  };
}

/** Something to send: words (the contract's `message` is required), no refused file, nothing in flight. */
export function canSend(v: ComposerView): boolean {
  return !v.busy && v.ui.text.trim().length > 0 && v.ui.file?.state !== "too_large";
}

// ── the view ─────────────────────────────────────────────────────────────────

const X = askIcon("close", 10, null, 2.6);
const BAD = `<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style="flex:none"><path d="M5 .6 9.4 5 5 9.4.6 5z" fill="var(--red)"></path></svg>`;

function placeholderOf(v: ComposerView): string {
  if (v.busy) return "The agent is working…";
  if (v.empty) return v.ui.file ? `Ask a question about ${v.ui.file.name}` : "Attach a CSV, then ask a question about it";
  return "Ask a follow-up";
}

function fileChip(f: ComposerFile): string {
  const bad = f.state === "too_large";
  const meta = bad ? "Too large" : fmtBytes(f.size);
  return `<span class="ask-co-chip${bad ? " is-bad" : ""}" data-morph-key="f:${attr(f.name)}"><span class="ask-co-ico" style="color:${bad ? "var(--red)" : "var(--fg-55)"}">${askIcon("csv", 14, null, 1.8)}</span><span class="ask-co-chip-t"><span class="ask-co-chip-n">${esc(f.name)}</span><span class="ask-co-chip-m">${esc(meta)}</span></span><button type="button" class="ask-co-x" data-act="removeFile" aria-label="${attr(`Remove ${f.name}`)}">${X}</button></span>`;
}

function sendButton(v: ComposerView): string {
  const can = canSend(v);
  const label = v.busy ? "Stop answering" : "Send";
  return `<button type="button" class="ask-send${v.busy ? " is-busy" : can ? " is-on" : ""}" data-morph-key="send" data-act="${v.busy ? "stop" : "send"}" aria-label="${label}" title="${label}"${!v.busy && !can ? ` aria-disabled="true"` : ""}>${v.busy
    ? `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"></rect></svg>`
    : askIcon("send", 16, null, 2.2)}</button>`;
}

function boxView(v: ComposerView): string {
  const ui = v.ui;
  const style = ui.h !== null ? ` style="height:${ui.h}px"` : "";
  const full = ui.full ? ` data-full="1"` : "";
  const ta = `<textarea rows="1" class="ask-input" data-morph-key="ta" data-ask-input placeholder="${attr(placeholderOf(v))}" aria-label="Message the agent"${full}${style}>${esc(ui.text)}</textarea>`;
  const bar = `<div class="ask-box-bar" data-morph-key="bar" data-morph-list>
      <button type="button" class="ask-co-tool" data-morph-key="att" data-act="attach" aria-label="Attach a CSV" title="Attach a CSV, or drop one on the page">${askIcon("attach", 16, null, 1.8)}</button>
      <span class="ask-co-grow" data-morph-key="sp"></span>${sendButton(v)}
    </div>`;
  return `<div class="ask-box" data-morph-key="box" data-morph-list>${ta}${bar}</div>`;
}

/** The composer (its place under the conversation; centred under the empty state). */
export function composerView(v: ComposerView): string {
  const ui = v.ui;
  const inner: string[] = [];
  const note = ui.notice;
  if (note) {
    const what = note.kind === "too_large" ? ` is too large. Files can be up to ${fmtBytes(MAX_BYTES)}.`
      : note.kind === "unsupported" ? " can't be attached. CSV files only."
      : " was not attached. A message carries one CSV.";
    inner.push(`<div class="ask-co-note" data-morph-key="note:${note.kind}" role="status">${BAD}<span><b>${esc(note.name)}</b>${esc(what)}</span></div>`);
  }
  inner.push(`<div class="ask-co-chips" data-morph-key="chips" data-morph-list role="group" aria-label="Attached">${ui.file ? fileChip(ui.file) : ""}</div>`);
  inner.push(boxView(v));
  inner.push(`<div class="ask-co-foot" data-morph-key="foot"><span>Enter to send · Shift+Enter for a new line</span>${ui.file && !v.busy ? `<span>${esc(ui.file.name)} goes with your next message</span>` : ""}</div>`);
  const drop = ui.drag
    ? `<div class="ask-co-drop" data-morph-key="drop" aria-hidden="true"><div class="ask-co-drop-in">${askIcon("upload", 26, "var(--accent)", 1.7)}<span class="ask-co-drop-t">Drop a CSV to attach</span><span class="ask-co-drop-s">One .csv file, up to ${fmtBytes(MAX_BYTES)}</span></div></div>`
    : "";
  return `<div class="ask-co-in" data-morph-key="in" data-morph-list>${inner.join("")}</div>
    <input type="file" accept=".csv,text/csv" class="ask-co-file" data-morph-key="file" data-co-file aria-hidden="true" tabindex="-1">${drop}`;
}

/** Grow the box to its words (46 → 220px): measure at `auto`, then set the new height so the CSS transition plays. */
export function grow(el: HTMLTextAreaElement, ui: ComposerUi): void {
  if (!el.isConnected || !el.offsetParent) return;
  const cs = getComputedStyle(el);
  const min = parseFloat(cs.minHeight) || 46;
  const max = parseFloat(cs.maxHeight) || 220;
  const prev = el.style.height;
  const tr = el.style.transition;
  el.style.transition = "none";
  el.style.height = "auto";
  const words = el.scrollHeight;
  const want = Math.round(Math.min(max, Math.max(min, words)));
  el.style.height = prev;
  void el.offsetHeight;
  el.style.transition = tr;
  // Past the cap it scrolls; under it the box clips while its height glides (never a flashing scrollbar).
  const full = words > max + 1;
  if (ui.full !== full) { ui.full = full; if (full) el.setAttribute("data-full", "1"); else el.removeAttribute("data-full"); }
  if (ui.h !== want) { ui.h = want; el.style.height = `${want}px`; }
  if (full && document.activeElement === el && el.selectionEnd === el.value.length) el.scrollTop = el.scrollHeight;
}
