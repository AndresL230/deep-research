// Ported from Trov (~/Projects/trov/web/src/ask-conversation.ts)
//
// The conversation:
//   the question   a right-aligned bubble, then the CSV that went with it as the composer's chip
//   the answer     in stream order: activity steps (a running step spins; done, it shows its result line; a step with
//                  results opens to them — `write_todos` results are the plan, drawn as a checklist, the latest plan
//                  open), thinking ("Thinking… Ns" the client counts → "Thought for Ns", which opens to the summary),
//                  then the parts: markdown (headings, lists, tables, code) with Trov's tail-settling while it
//                  streams, and image blocks (a chart; a click opens it full size in a new tab), with a soft cursor
//                  while it streams; Stopped / the error
//   the empty state  "Drop a CSV to start" and Try the sample
// Dropped from Trov: refs and ref chips, hover cards, cites / sources, the footer (Copy, Regenerate, Save as
// artifact, Wrong?), follow-ups, Edit-and-resend, write cards, the Trov blocks (items / chart / themes / diagram /
// not found / save form), the inspector, sharing, the phone, the ⌘J panel, the motion module (the scroll rule it
// held, `stickAfterScroll`, is here).
//
// Every message, part and step is a keyed child of a `data-morph-list` (morph.ts): a streamed part is inserted once
// and a text part only grows; an image never reloads.

import { esc, attr, fmtBytes } from "./ui";
import { askIcon, askSpinner, ACTIVITY_ICON } from "./ask-icons";
import { isTodoStep, parseTodo, turnLive, type AskAnswer, type AskConvo, type AskQuestion, type AskStep, type AskTurn, type AskPartVm } from "./ask-stream";
import { thinkingOrb, type OrbState } from "./thinking-orb";

export interface ConversationUi {
  /** Disclosures by key (`<answerKey>:s<step>`, `<answerKey>:think`): true open, false closed, absent = default. */
  open: Record<string, boolean>;
  /** Stick to the bottom while an answer streams (false once the person scrolls up). */
  stick: boolean;
  /** Scrolled up away from the bottom: the jump-to-latest arrow shows (`jumpButton`). */
  away: boolean;
}
export const initialConversationUi = (): ConversationUi => ({ open: {}, stick: true, away: false });

export interface CvView { convo: AskConvo; ui: ConversationUi; sampleLoading: boolean }

/** Past this far from the bottom, the jump-to-latest arrow shows. */
export const AWAY_PX = 160;
/** How close to the bottom counts as AT the bottom (Trov's ask-motion.ts `ASK_BOTTOM_SLACK`). */
export const ASK_BOTTOM_SLACK = 4;

/** Ported from Trov's ask-motion.ts: whether to keep to the bottom after a scroll — a person scrolling UP lets go,
 *  coming back to the bottom holds on again. */
export function stickAfterScroll(stick: boolean, prevTop: number, s: { top: number; height: number; client: number }): boolean {
  if (s.height - s.top - s.client <= ASK_BOTTOM_SLACK) return true;
  if (s.top < prevTop) return false;
  return stick;
}

/** The jump-to-latest arrow: it sits on the scroller's bottom edge (a 0-height sticky row, so it changes no height),
 *  shows once the person scrolled up, and while an answer streams below it is in the accent (`data-busy`). */
export function jumpButton(v: CvView): string {
  const away = v.ui.away;
  return `<div class="ask-jump-w" data-morph-key="jump"><button type="button" class="ask-jump" data-act="jump" aria-label="Jump to the latest" title="Jump to the latest" data-away="${away ? "1" : "0"}" data-busy="${v.convo.busy ? "1" : "0"}"${away ? "" : ` tabindex="-1" aria-hidden="true"`}>${askIcon("chevDown", 16, null, 2.2)}</button></div>`;
}

// ── markdown (the answer's text: headings, lists, tables, code; tolerant of a half-streamed line) ─────────────

export type MdNode =
  | { t: "h"; text: string }
  | { t: "p"; lines: string[] }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[]; start: number }
  | { t: "table"; head: string[] | null; rows: string[][] }
  | { t: "code"; text: string };

const LIST_RE = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isTableLine = (l: string): boolean => /^\s*\|/.test(l);
const isSepRow = (l: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(l);
const isBlockStart = (l: string): boolean => /^\s*```/.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || isTableLine(l) || LIST_RE.test(l);

/** A table row's cells, split on `|`. */
export function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").map((c) => c.trim());
}

export function parseMd(md: string): MdNode[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) { out.push({ t: "h", text: h[1].replace(/\s+#+\s*$/, "") }); i++; continue; }
    if (isTableLine(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(lines[i++]);
      // The first row heads the table once the separator follows it (or while it is the only row streamed yet).
      const headed = rows.length === 1 || isSepRow(rows[1]);
      const head = headed ? splitRow(rows[0]) : null;
      const body = (headed ? rows.slice(1) : rows).filter((r) => !isSepRow(r)).map(splitRow);
      out.push({ t: "table", head, rows: body });
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !m) { items[items.length - 1] += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      out.push(ordered ? { t: "ol", items, start: Number(li[1].replace(/\D/g, "")) || 1 } : { t: "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push({ t: "p", lines: para });
  }
  return out;
}

/** While a text part STREAMS, its last line may be half a piece of markdown — a `##` with no words yet, `**bo`, a
 *  `[link](ht`, a table row still being typed. Drawn as-is it shows the raw marks for a moment before they render.
 *  This settles that tail only: a bare heading / list / fence marker or a half table row waits for its words, an
 *  unclosed `**` / `*` / backtick is closed for now (so the words show bold as they come), a half link shows its
 *  text. A finished answer is never touched. */
export function settleTail(md: string): string {
  const cut = md.lastIndexOf("\n");
  const head = md.slice(0, cut + 1);
  let last = md.slice(cut + 1);
  // A bare block marker: "##", "- ", "1.", "`", "``" — nothing to show yet.
  if (/^\s{0,3}#{1,6}\s*$/.test(last) || /^\s*([-*+]|\d{1,3}[.)])\s*$/.test(last) || /^\s*`{1,2}$/.test(last)) return head;
  // A table row still being typed (not closed by its last bar): wait for the whole row.
  if (/^\s*\|/.test(last) && !/\|\s*$/.test(last)) return head;
  // A link still coming: its text so far.
  last = last.replace(/\[([^\]]*)\]\([^)]*$/, "$1").replace(/(^|[^[])\[([^\]]*)$/, "$1$2");
  // Unclosed emphasis and code, outside code spans: close them for now (a lone trailing mark just waits). A leading
  // list / heading marker ("* ", "- ", "## ") is not emphasis — it is set aside first.
  const lead = last.match(/^\s*(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+/)?.[0] ?? "";
  last = last.slice(lead.length);
  const ticks = (last.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) last = /`$/.test(last) ? last.slice(0, -1) : `${last}\``;
  const outside = last.split(/`[^`]*`/).join("");
  const bold = (outside.match(/\*\*/g) ?? []).length;
  if (bold % 2 === 1) last = /\*\*\s*$/.test(last) ? last.replace(/\*\*\s*$/, "") : `${last}**`;
  const singles = (last.split(/`[^`]*`/).join("").replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  if (singles % 2 === 1) last = /\*\s*$/.test(last) ? last.replace(/\*\s*$/, "") : `${last}*`;
  return head + lead + last;
}

/** Bold, italics, code and links on ESCAPED text. */
function emphasis(html: string): string {
  // Code spans first, as placeholders, so a mark AROUND code still pairs; what is inside a code span is never emphasis.
  const codes: string[] = [];
  return html
    .replace(/`([^`]+)`/g, (_, c: string) => `\u0001${codes.push(`<code class="ask-code">${c}</code>`) - 1}\u0001`)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/api\/files\/)[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`)
    .replace(/\u0001(\d+)\u0001/g, (_, n: string) => codes[Number(n)] ?? "");
}

/** A run of answer text, its markdown inline. */
export const inline = (md: string): string => emphasis(esc(md));

const CURSOR = `<span class="ask-cursor" aria-hidden="true"></span>`;

/** One table, scrolling inside its block. */
export function tableView(head: string[] | null, rows: string[][]): string {
  return `<div class="ask-tbl-scroll"><table class="ask-tbl">${head ? `<thead><tr>${head.map((h) => `<th scope="col">${inline(h)}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** A text part as markup; `cur` puts the soft cursor at the end of its last line. */
export function mdView(md: string, cur: boolean): string {
  // `cur`: this part is still streaming — its half-written tail is settled first (never a finished answer's).
  const nodes = parseMd(cur ? settleTail(md) : md);
  return nodes.map((n, i) => {
    const c = cur && i === nodes.length - 1 ? CURSOR : "";
    switch (n.t) {
      case "h": return `<h3 class="ask-h">${inline(n.text)}${c}</h3>`;
      case "p": return `<p class="ask-p">${n.lines.map((l) => inline(l)).join("<br>")}${c}</p>`;
      case "ul": return `<ul class="ask-ul">${n.items.map((it, k) => `<li>${inline(it)}${k === n.items.length - 1 ? c : ""}</li>`).join("")}</ul>`;
      case "ol": return `<ol class="ask-ul"${n.start !== 1 ? ` start="${n.start}"` : ""}>${n.items.map((it, k) => `<li>${inline(it)}${k === n.items.length - 1 ? c : ""}</li>`).join("")}</ol>`;
      case "code": return `<pre class="ask-pre"><code>${esc(n.text)}</code></pre>${c}`;
      case "table": return `<div class="ask-rich" data-rich="table">${tableView(n.head, n.rows)}</div>${c}`;
    }
  }).join("");
}

const chev = (open: boolean): string =>
  `<span class="ask-chev${open ? " is-open" : ""}" aria-hidden="true">${askIcon("chevRight", 11, null, 2.4)}</span>`;

// ── blocks ───────────────────────────────────────────────────────────────────

/** An image block: the chart, its alt as the caption; a click opens it full size in a new tab. */
function imageView(b: { url: string; alt: string }): string {
  const alt = b.alt || "Chart";
  return `<figure class="ask-fig ask-img">
    <a class="ask-img-a" href="${attr(b.url)}" target="_blank" rel="noopener noreferrer" aria-label="${attr(`Open ${alt} full size`)}" title="Open full size"><img class="ask-img-i" src="${attr(b.url)}" alt="${attr(alt)}" decoding="async"></a>
    ${b.alt ? `<figcaption class="ask-fig-foot">${askIcon("chart", 12, "var(--fg-40)", 2)}<span>${esc(b.alt)}</span><span style="flex:1"></span><a class="ask-img-open" href="${attr(b.url)}" target="_blank" rel="noopener noreferrer">${askIcon("external", 12, null, 2)}<span>Full size</span></a></figcaption>` : ""}
  </figure>`;
}

// ── the question ─────────────────────────────────────────────────────────────

/** A sent CSV: the composer's chip, with no ×. */
export function sentFileChip(f: { name: string; size: number }): string {
  return `<span class="ask-co-chip ask-q-chip"><span class="ask-co-ico" style="color:var(--fg-55)">${askIcon("csv", 14, null, 1.8)}</span><span class="ask-co-chip-t"><span class="ask-co-chip-n">${esc(f.name)}</span><span class="ask-co-chip-m">${esc(fmtBytes(f.size))}</span></span></span>`;
}

function question(q: AskQuestion): string {
  const files = q.file ? sentFileChip(q.file) : "";
  return `<div class="ask-q" data-morph-key="q:${attr(q.key)}"><div class="ask-q-col"><div class="ask-q-bubble">${esc(q.text)}</div>${files ? `<div class="ask-q-att">${files}</div>` : ""}</div></div>`;
}

// ── the answer ───────────────────────────────────────────────────────────────

/** What a running step's orb shows (thinking-orb.ts): looking things up searches, anything else works. */
const STEP_ORB: Partial<Record<AskStep["icon"], OrbState>> = { search: "searching", read: "searching", docs: "searching" };
const stepOrb = (s: Pick<AskStep, "icon">): OrbState => STEP_ORB[s.icon] ?? "working";

/** The plan (`write_todos`): one row per todo, done / in progress / to do. */
function todoList(results: string[]): string {
  return `<ul class="ask-todos">${results.map((r) => {
    const t = parseTodo(r);
    const mark = t.state === "done"
      ? `<span class="ask-todo-m is-done">${askIcon("check", 10, null, 3)}</span>`
      : t.state === "doing" ? `<span class="ask-todo-m is-doing"></span>` : `<span class="ask-todo-m"></span>`;
    return `<li class="ask-todo is-${t.state}">${mark}<span class="ask-todo-t">${inline(t.text)}</span></li>`;
  }).join("")}</ul>`;
}

function stepView(v: CvView, a: AskAnswer, s: AskStep, held: boolean, latestPlan: boolean): string {
  const key = `${a.key}:s${s.step}`;
  // `held`: the latest step reads as still running while the agent works with what it found — its result line and
  // toggle come once the next step starts or the answer begins. A notice (a result line and no results) is never held.
  const running = s.state === "run" || (held && !(s.resultLine && !s.results.length));
  const results = running ? [] : s.results;
  const has = results.length > 0;
  const todo = isTodoStep(s);
  // The latest plan is open unless the person closed it; anything else opens on a click.
  const open = has && (v.ui.open[key] ?? (todo && latestPlan));
  const run = running ? " is-run" : "";
  const icon = running ? askSpinner(13) : askIcon(ACTIVITY_ICON[s.icon] ?? "read", 14, "var(--fg-40)");
  const found = running ? null : s.resultLine ?? (has ? `${results.length} ${results.length === 1 ? "line" : "lines"}` : null);
  const line = found ? `<span class="ask-step-n">· ${esc(found)}</span>` : "";
  const head = has
    ? `<button type="button" class="ask-step${run}" data-act="toggle" data-arg="${attr(key)}" aria-expanded="${open}"><span class="ask-step-i">${icon}</span><span class="ask-step-l">${esc(s.label)}</span>${line}${chev(open)}</button>`
    : `<div class="ask-step${run}"><span class="ask-step-i">${icon}</span><span class="ask-step-l">${esc(s.label)}</span>${line}</div>`;
  const det = open
    ? `<div class="ask-step-det${todo ? " ask-step-det--plan" : ""}">${todo ? todoList(results) : results.map((r) => `<div class="ask-res"><span class="ask-res-t">${esc(r)}</span></div>`).join("")}</div>`
    : "";
  return `<div class="ask-step-w" data-morph-key="s:${s.step}">${head}${det}</div>`;
}

/** "Thinking… Ns" — the CLIENT counts from the run event (the ticker updates the number between paints). */
export const thinkingLabel = (startedAt: number, now = Date.now()): string => `Thinking… ${Math.max(0, Math.floor((now - startedAt) / 1000))}s`;

function thinkView(v: CvView, a: AskAnswer): string {
  const th = a.turn.thinking;
  if (!th) return "";
  const clock = `<span class="ask-step-i">${askIcon("clock", 14, "var(--fg-40)")}</span>`;
  if (th.state === "run") {
    return `<div class="ask-think"><div class="ask-step is-run"><span class="ask-step-i">${thinkingOrb("solving", 20, null)}</span><span class="ask-think-l" data-ask-think="${th.startedAt}">${thinkingLabel(th.startedAt)}</span></div></div>`;
  }
  // No summary: nothing to open.
  if (!th.summary.trim()) return `<div class="ask-think"><div class="ask-step">${clock}<span class="ask-step-l">Thought for ${th.seconds}s</span></div></div>`;
  const key = `${a.key}:think`;
  const open = v.ui.open[key] === true;
  return `<div class="ask-think">
    <button type="button" class="ask-step" data-act="toggle" data-arg="${attr(key)}" aria-expanded="${open}">${clock}<span class="ask-step-l">Thought for ${th.seconds}s</span>${chev(open)}</button>
    ${open ? `<div class="ask-think-sum">${esc(th.summary)}</div>` : ""}
  </div>`;
}

function partView(p: AskPartVm, i: number, cur: boolean): string {
  const key = `p${i}`;
  if (p.kind === "text") return `<div class="ask-text" data-morph-key="${key}">${mdView(p.md, cur)}</div>`;
  return `<div class="ask-part" data-morph-key="${key}" data-block="${attr(p.block.kind)}">${imageView(p.block)}</div>`;
}

const STOP_SQ = `<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style="flex:none;color:var(--fg-40)"><rect x=".8" y=".8" width="8.4" height="8.4" rx="1.2" fill="currentColor"></rect></svg>`;
const DIAMOND = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style="flex:none"><path d="M5 .6 9.4 5 5 9.4.6 5z" fill="var(--red)"></path></svg>`;
const SQUARE = `<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style="flex:none"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--fg-40)"></rect></svg>`;

/** The error's headline, by the contract's code (docs/api-contract.md). */
const ERROR_HEAD: Record<string, string> = {
  no_key: "The server is missing an API key.",
  timeout: "The analysis took too long.",
  too_large: "That file is too large.",
  failed: "Something went wrong.",
};

function answer(v: CvView, a: AskAnswer, last: boolean): string {
  const t: AskTurn = a.turn;
  const live = turnLive(t);
  const parts = t.parts;
  const steps = t.activity;
  // While nothing of the answer is out yet (and the Thinking row is not running), the latest step stays "running":
  // the tools finish fast, but the agent is still working with what that step found.
  const holdLast = live && !parts.length && t.thinking?.state !== "run";
  const lastPlan = steps.filter(isTodoStep).at(-1)?.step ?? null;
  const stepsHtml = steps.map((s, i) => stepView(v, a, s, holdLast && i === steps.length - 1, s.step === lastPlan)).join("");
  const think = thinkView(v, a);
  const end = parts.length - 1;
  const cursorIn = live && parts[end]?.kind === "text";
  const body = parts.map((p, i) => partView(p, i, cursorIn && i === end)).join("");
  // The wait row sits under the steps for the whole wait: before anything, while steps appear one by one, and after
  // them while the model reads what it found — gone only while words stream (the cursor is in them) or while the
  // Thinking row runs (it says the same, with its own orb).
  const running = holdLast ? steps.at(-1) : steps.filter((s) => s.state === "run").at(-1);
  const curAlone = live && !cursorIn && t.thinking?.state !== "run";
  const waitOrb: OrbState = running ? stepOrb(running) : parts.length ? "composing" : "solving";
  const retryable = last && !v.convo.busy && t.error?.code !== "too_large" && t.error?.code !== "no_key";
  const retry = retryable ? `<button type="button" class="ask-btn ask-btn--sm" data-act="retry" data-arg="${attr(a.key)}">Try again</button>` : "";
  const err = t.error
    ? `<div class="ask-err" role="alert">${DIAMOND}<span class="ask-err-t">${esc(ERROR_HEAD[t.error.code] ?? ERROR_HEAD.failed)}</span>${t.error.message ? `<span class="ask-err-s">${esc(t.error.message)}</span>` : ""}<span style="flex:1"></span>${retry}</div>`
    : "";
  const stopped = t.stopped ? `<div class="ask-stopped">${STOP_SQ}<span>Stopped. The answer above is partial.</span></div>` : "";
  const written = parts.some((p) => p.kind !== "text" || p.md.trim() !== "");
  const unwritten = t.done && !t.error && !t.stopped && !written
    ? `<div class="ask-err ask-err--none" role="status">${SQUARE}<span class="ask-err-t">The agent didn't write an answer.</span><span style="flex:1"></span>${retry}</div>`
    : "";
  const kids: [string, string][] = [
    // Thinking first: in this contract `thinking` opens every turn and ends as the first step or word begins (Trov
    // draws it after the steps, where its own thinking can come later in a turn).
    ["steps", stepsHtml || think ? `<div class="ask-steps" data-morph-list>${think ? `<div data-morph-key="think">${think}</div>` : ""}${stepsHtml}</div>` : ""],
    ["parts", `<div class="ask-parts" data-morph-list>${body}</div>`],
    ["cursor", curAlone ? `<div class="ask-cur-alone">${thinkingOrb(waitOrb, 20, null)}<span class="ask-wait-l">${waitOrb === "composing" ? "Writing…" : waitOrb === "searching" ? "Reading…" : "Working…"}</span></div>` : ""],
    ["err", err], ["none", unwritten], ["stopped", stopped],
  ];
  return `<div class="ask-a" data-morph-key="a:${attr(a.key)}" data-morph-list${live ? ` aria-busy="true"` : ""}>${kids.filter(([, h]) => h).map(([k, h]) => h.replace(/^<(\w+)/, `<$1 data-morph-key="${k}"`)).join("")}</div>`;
}

/** The scroller's contents: every message of the conversation. */
export function conversationView(v: CvView): string {
  const c = v.convo;
  const lastA = c.messages.map((m) => m.role).lastIndexOf("assistant");
  return `<div class="ask-col" data-morph-key="cv:${attr(c.id)}"><div class="ask-msgs" data-morph-list>${c.messages.map((m, i) => (m.role === "user" ? question(m) : answer(v, m, i === lastA))).join("")}</div></div>`;
}

/** A new conversation: the mark, the headline, Try the sample. */
export function emptyView(v: CvView): string {
  return `<div class="ask-empty" data-morph-key="empty:${attr(v.convo.id)}">
    <div class="ask-empty-mark">${askIcon("upload", 22, "var(--accent)", 1.8)}</div>
    <h2 class="ask-empty-h">Drop a CSV to start</h2>
    <p class="ask-empty-s">Attach a CSV and ask a question. The agent plans, writes and runs Python in a sandbox, and answers with findings and charts.</p>
    <div class="ask-empty-acts">
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="sample"${v.sampleLoading ? " disabled" : ""}>${v.sampleLoading ? askSpinner(13) : askIcon("csv", 14, null, 1.8)}<span>Try the sample</span></button>
      <button type="button" class="ask-ghostbtn" data-act="attach">${askIcon("attach", 14, null, 1.8)}<span>Choose a file</span></button>
    </div>
  </div>`;
}
