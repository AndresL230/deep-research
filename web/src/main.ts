// The shell and its controller (structure after Trov's ~/Projects/trov/web/src/ask-screen.ts, one column only):
//
//   header        the title (and "› <the CSV>" once one is in the conversation), New conversation
//   conversation  the empty state ("Drop a CSV to start", Try the sample), else the messages and jump-to-latest
//   composer      under the conversation (centred under the empty state, as Trov's)
//
// Rendering: state → markup → morph.ts patches the three regions in place on every change (batched to a frame), so
// the composer keeps its focus and caret, images never reload and the scroll holds while an answer streams.
// Sending: POST /api/ask (multipart), read with ask-sse.ts, folded with ask-stream.ts (docs/api-contract.md).
// Dropped from Trov's shell: the thread list, the inspector, the ⌘J panel, the phone drawer, settings, modes.

import "./style.css";
import { esc } from "./ui";
import { askIcon } from "./ask-icons";
import { morphInner } from "./morph";
import { readAskStream } from "./ask-sse";
import { failTurn, foldAskEvent, newTurn, stopTurn, withLastTurn, type AskConvo, type AskQuestion } from "./ask-stream";
import {
  AWAY_PX, conversationView, emptyView, initialConversationUi, jumpButton, stickAfterScroll, thinkingLabel, type ConversationUi,
} from "./ask-conversation";
import { attachFiles, canSend, composerView, grow, initialComposerUi, type ComposerUi } from "./ask-composer";
import { AskHttpError, deleteConversation, fetchSample, isAbort, newConversationId, postAsk } from "./api";
import { scheduleOrbs } from "./thinking-orb";
import { fetchUsage, usageView, type UsageState } from "./usage";

// ── state ────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
/** Dev only: `?fixture=1` replays a canned answer instead of calling the server (fixture.ts). */
const FIXTURE = import.meta.env.DEV && params.has("fixture");

interface AppState {
  convo: AskConvo;
  cv: ConversationUi;
  composer: ComposerUi;
  sampleLoading: boolean;
  sampleError: string | null;
  /** `#usage` shows the Usage view; the conversation keeps running underneath. */
  view: "chat" | "usage";
  usage: UsageState;
}
const viewFromHash = (): AppState["view"] => (location.hash === "#usage" ? "usage" : "chat");
const S: AppState = {
  convo: { id: newConversationId(), messages: [], busy: false },
  cv: initialConversationUi(),
  composer: initialComposerUi(),
  sampleLoading: false,
  sampleError: null,
  view: viewFromHash(),
  usage: { state: "idle" },
};
let seq = 0;
let inflight: AbortController | null = null;

const SAMPLE_QUESTION = "Give me an overview of this data, then chart the most interesting trend.";

// ── the shell (rendered once; its three regions are patched) ─────────────────

const app = document.getElementById("app")!;
const themeQ = matchMedia("(prefers-color-scheme: dark)");
const forcedTheme = params.get("theme");
const theme = (): "light" | "dark" => (forcedTheme === "dark" || forcedTheme === "light" ? forcedTheme : themeQ.matches ? "dark" : "light");
app.innerHTML = `<div class="app-root" data-cnpy-theme="${theme()}">
  <header class="cnpy-hdr" data-region="header"></header>
  <div class="ask-screen">
    <section class="ask-conv" aria-label="Conversation" data-ask-drop>
      <div class="ask-scroll" data-ask-scroll data-morph-list data-region="scroll"></div>
      <div class="ask-composer" data-morph-list data-region="composer"></div>
      <div class="ask-empty-tail" aria-hidden="true"></div>
    </section>
  </div>
  <main class="use-screen" data-region="usage" aria-label="Usage" hidden></main>
</div>`;
const root = app.firstElementChild as HTMLElement;
const headerEl = root.querySelector<HTMLElement>("[data-region=header]")!;
const scrollEl = root.querySelector<HTMLElement>("[data-region=scroll]")!;
const composerEl = root.querySelector<HTMLElement>("[data-region=composer]")!;
const screenEl = root.querySelector<HTMLElement>(".ask-screen")!;
const usageEl = root.querySelector<HTMLElement>("[data-region=usage]")!;
themeQ.addEventListener("change", () => { root.dataset.cnpyTheme = theme(); scheduleOrbs(); });

/** The dataset of this conversation: the last CSV sent with it. */
function datasetName(): string | null {
  for (let i = S.convo.messages.length - 1; i >= 0; i--) { const m = S.convo.messages[i]; if (m.role === "user" && m.file) return m.file.name; }
  return null;
}

function headerView(): string {
  const crumb = S.view === "usage" ? "Usage" : datasetName();
  const left = `<div class="ask-hdr-l"><span class="ask-hdr-mark">${askIcon("chart", 15, null, 2)}</span><h1 class="ask-h1"><span class="ask-h1-t${crumb ? " is-parent" : ""}">Data analyst</span></h1>${crumb ? `<span class="ask-crumb"><span class="ask-crumb-sep">›</span><span class="ask-crumb-t">${esc(crumb)}</span></span>` : ""}</div>`;
  const right = S.view === "usage"
    ? `<div class="ask-hdr-r"><button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="chat" aria-label="Back to the conversation">${askIcon("chevLeft", 14, null, 2)}<span>Back to chat</span></button></div>`
    : `<div class="ask-hdr-r"><button type="button" class="ask-ghostbtn" data-act="usage" aria-label="Usage and cost">${askIcon("clock", 14, null, 2)}<span>Usage</span></button>
      <button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="new" aria-label="New conversation">${askIcon("plus", 14, null, 2)}<span>New conversation</span></button></div>`;
  return left + right;
}

// ── paint ────────────────────────────────────────────────────────────────────

let frame = 0;
function paint(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function render(): void {
  frame = 0;
  const empty = S.convo.messages.length === 0;
  const v = { convo: S.convo, ui: S.cv, sampleLoading: S.sampleLoading };
  screenEl.dataset.empty = empty ? "1" : "0";
  morphInner(headerEl, headerView());
  const onUsage = S.view === "usage";
  screenEl.hidden = onUsage;
  usageEl.hidden = !onUsage;
  if (onUsage) morphInner(usageEl, usageView(S.usage));
  morphInner(scrollEl, empty ? `${emptyView(v)}${S.sampleError ? `<p class="ask-empty-err" data-morph-key="serr" role="alert">${esc(S.sampleError)}</p>` : ""}` : `${conversationView(v)}${jumpButton(v)}`);
  morphInner(composerEl, composerView({ ui: S.composer, busy: S.convo.busy, empty }));
  afterPaint();
}

let ticker: ReturnType<typeof setInterval> | null = null;
function afterPaint(): void {
  const ta = composerEl.querySelector<HTMLTextAreaElement>("[data-ask-input]");
  if (ta) grow(ta, S.composer);
  // Keep to the bottom while the person has not scrolled up.
  if (S.cv.stick && S.convo.messages.length) scrollEl.scrollTop = scrollEl.scrollHeight;
  // "Thinking… Ns" counts between paints (the label alone; the next paint writes the same number).
  if (!ticker && scrollEl.querySelector("[data-ask-think]")) {
    ticker = setInterval(() => {
      const els = Array.from(scrollEl.querySelectorAll<HTMLElement>("[data-ask-think]"));
      if (!els.length) { if (ticker) clearInterval(ticker); ticker = null; return; }
      for (const el of els) el.textContent = thinkingLabel(Number(el.dataset.askThink));
    }, 500);
  }
}

const textarea = (): HTMLTextAreaElement | null => composerEl.querySelector<HTMLTextAreaElement>("[data-ask-input]");
function focusBox(): void {
  requestAnimationFrame(() => {
    const el = textarea();
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

// ── sending ──────────────────────────────────────────────────────────────────

async function ask(text: string, file: File | null): Promise<void> {
  if (S.convo.busy) return;
  const id = S.convo.id;
  seq += 1;
  const q: AskQuestion = { role: "user", key: `q${seq}`, text, file: file ? { name: file.name, size: file.size, file } : null };
  S.convo = { ...S.convo, busy: true, messages: [...S.convo.messages, q, { role: "assistant", key: `a${seq}`, turn: newTurn() }] };
  S.cv.stick = true;
  S.cv.away = false;
  paint();
  const ac = new AbortController();
  inflight = ac;
  const mine = () => S.convo.id === id && inflight === ac;
  const onEvent = (e: Parameters<typeof foldAskEvent>[1]) => {
    if (!mine()) return;
    S.convo = withLastTurn(S.convo, (t) => foldAskEvent(t, e, Date.now()));
    paint();
  };
  try {
    let res: Response;
    if (import.meta.env.DEV && FIXTURE) {
      const { fixtureResponse } = await import("./fixture");
      res = fixtureResponse(ac.signal);
    } else {
      res = await postAsk({ conversation: id, message: text, file, signal: ac.signal });
    }
    await readAskStream(res, onEvent, ac.signal);
    // The stream closed with no `done` and no `error`: the connection dropped.
    if (mine()) S.convo = withLastTurn(S.convo, (t) => failTurn(t));
  } catch (e) {
    if (mine()) {
      S.convo = withLastTurn(S.convo, (t) => isAbort(e) ? stopTurn(t)
        : failTurn(t, e instanceof AskHttpError ? e.message : "The connection to the server dropped."));
    }
  } finally {
    if (mine()) { inflight = null; S.convo = { ...S.convo, busy: false }; }
    paint();
  }
}

function send(): void {
  const v = { ui: S.composer, busy: S.convo.busy, empty: S.convo.messages.length === 0 };
  if (!canSend(v)) return;
  const text = S.composer.text.trim();
  const file = S.composer.file?.state === "ready" ? S.composer.file.file : null;
  S.composer = { ...S.composer, text: "", file: null, notice: null };
  // The focused box is never patched (morph.ts leaves the person's typing alone): clear it here.
  const ta = textarea();
  if (ta) ta.value = "";
  void ask(text, file);
}

function stop(): void {
  inflight?.abort();
}

/** Try again: the failed exchange goes and its question is asked again (with its CSV, if it had one). */
function retry(answerKey: string): void {
  if (S.convo.busy) return;
  const ms = S.convo.messages;
  const ai = ms.findIndex((m) => m.key === answerKey);
  const q = ms[ai - 1];
  if (ai < 1 || !q || q.role !== "user") return;
  S.convo = { ...S.convo, messages: ms.slice(0, ai - 1) };
  void ask(q.text, q.file?.file ?? null);
}

/** New conversation: stop what is running, tell the server to delete the sandbox, start fresh with a new id. */
function newConversation(): void {
  inflight?.abort();
  inflight = null;
  if (S.convo.messages.length) deleteConversation(S.convo.id);
  S.convo = { id: newConversationId(), messages: [], busy: false };
  S.cv = initialConversationUi();
  S.composer = initialComposerUi();
  S.sampleError = null;
  const ta = textarea();
  if (ta) ta.value = "";
  paint();
  focusBox();
}

// ── usage ────────────────────────────────────────────────────────────────────

async function loadUsage(): Promise<void> {
  if (S.usage.state === "loading") return;
  const last = S.usage.state === "ready" ? S.usage.data : S.usage.state === "error" ? S.usage.last : null;
  S.usage = { state: "loading", last };
  paint();
  try {
    S.usage = { state: "ready", data: await fetchUsage() };
  } catch (e) {
    S.usage = { state: "error", message: e instanceof Error ? e.message : "Couldn't load usage.", last };
  }
  paint();
}

function showView(view: AppState["view"]): void {
  S.view = view;
  if (view === "usage") void loadUsage();
  paint();
  if (view === "chat") focusBox();
}

window.addEventListener("hashchange", () => showView(viewFromHash()));

async function trySample(): Promise<void> {
  if (S.sampleLoading) return;
  S.sampleLoading = true;
  S.sampleError = null;
  paint();
  try {
    const file = await fetchSample();
    S.composer = attachFiles(S.composer, [file]);
    if (!S.composer.text.trim()) S.composer = { ...S.composer, text: SAMPLE_QUESTION };
    focusBox();
  } catch (e) {
    S.sampleError = e instanceof Error ? `Couldn't load the sample. ${e.message}` : "Couldn't load the sample.";
  } finally {
    S.sampleLoading = false;
    paint();
  }
}

// ── events (one delegate per kind on the root) ───────────────────────────────

root.addEventListener("click", (e) => {
  const el = (e.target as Element | null)?.closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const arg = el.dataset.arg ?? "";
  switch (el.dataset.act) {
    case "new": newConversation(); return;
    case "usage": location.hash = "usage"; return;
    case "chat": history.pushState(null, "", location.pathname + location.search); showView("chat"); return;
    case "usageRefresh": void loadUsage(); return;
    case "sample": void trySample(); return;
    case "attach": composerEl.querySelector<HTMLInputElement>("[data-co-file]")?.click(); return;
    case "removeFile": S.composer = { ...S.composer, file: null, notice: null }; paint(); focusBox(); return;
    case "send": send(); return;
    case "stop": stop(); return;
    case "retry": retry(arg); return;
    case "toggle": {
      // A step's results (its open default may be true: the latest plan) or the thinking summary.
      const was = el.getAttribute("aria-expanded") === "true";
      S.cv.open = { ...S.cv.open, [arg]: !was };
      paint();
      return;
    }
    case "jump": {
      S.cv.stick = true;
      S.cv.away = false;
      const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      paint();
      return;
    }
  }
});

root.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLTextAreaElement) || !el.hasAttribute("data-ask-input")) return;
  S.composer = { ...S.composer, text: el.value };
  grow(el, S.composer);
  paint();
});

root.addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLTextAreaElement) || !el.hasAttribute("data-ask-input")) return;
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  send();
});

root.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | null;
  if (!el?.hasAttribute?.("data-co-file") || !el.files) return;
  const files = Array.from(el.files);
  el.value = "";
  S.composer = attachFiles(S.composer, files);
  paint();
  focusBox();
});

// Dragging a CSV over the conversation: the overlay; dropping it attaches it.
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files");
const dropZone = root.querySelector<HTMLElement>("[data-ask-drop]")!;
dropZone.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  if (!S.composer.drag) { S.composer = { ...S.composer, drag: true }; paint(); }
});
dropZone.addEventListener("dragleave", (e) => {
  const to = e.relatedTarget as Node | null;
  if (to && dropZone.contains(to)) return;
  if (S.composer.drag) { S.composer = { ...S.composer, drag: false }; paint(); }
});
dropZone.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  S.composer = attachFiles({ ...S.composer, drag: false }, Array.from(e.dataTransfer?.files ?? []));
  paint();
  focusBox();
});
// A file dropped anywhere else never navigates the page away.
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });

// Scrolling: a person scrolling UP lets go of the bottom; the arrow shows once away from it.
let lastTop = 0;
scrollEl.addEventListener("scroll", () => {
  S.cv.stick = stickAfterScroll(S.cv.stick, lastTop, { top: scrollEl.scrollTop, height: scrollEl.scrollHeight, client: scrollEl.clientHeight });
  lastTop = scrollEl.scrollTop;
  const away = !S.cv.stick && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > AWAY_PX;
  if (S.cv.away !== away) { S.cv.away = away; paint(); }
}, { passive: true });

// Leaving the page ends the conversation (its id lives only in this page): the server deletes the sandbox.
window.addEventListener("pagehide", () => {
  if (S.convo.messages.length && !FIXTURE) deleteConversation(S.convo.id, true);
});

if (S.view === "usage") void loadUsage();
render();
focusBox();

// The fixture: ask at once, with a stand-in CSV, so the streamed turn shows without typing.
if (FIXTURE) {
  const csv = new File(["month,region,revenue\n"], "sales.csv", { type: "text/csv" });
  void ask("Which region grew fastest this year, and what drove it?", csv);
}
