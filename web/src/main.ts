// The shell (structure after Trov's ~/Projects/trov/web/src/ask-screen.ts, one column only):
//
//   header        the mark and the title
//   main region   for now: the batches the server has (GET /api/batches). The batch screens come next.
//
// The conversation view (ask-conversation.ts, folded by ask-stream.ts) stays: it will show one run's events.jsonl
// (thought, tool_call and tool_result, todos map onto thinking, activity run/done and the plan step). In dev,
// `?fixture=1` replays a canned turn through it (fixture.ts) so it can be looked at without the server.
//
// Rendering: state → markup → morph.ts patches the regions in place on every change (batched to a frame).

import "./style.css";
import { attr, esc } from "./ui";
import { askIcon, askSpinner } from "./ask-icons";
import { morphInner } from "./morph";
import { readAskStream } from "./ask-sse";
import { failTurn, foldAskEvent, newTurn, stopTurn, withLastTurn, type AskConvo } from "./ask-stream";
import { AWAY_PX, conversationView, emptyView, initialConversationUi, jumpButton, stickAfterScroll, thinkingLabel, type ConversationUi } from "./ask-conversation";
import { fetchBatches, isAbort, type BatchListItem } from "./api";
import { scheduleOrbs } from "./thinking-orb";

// ── state ────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
/** Dev only: `?fixture=1` replays a canned turn through the conversation view (fixture.ts). */
const FIXTURE = import.meta.env.DEV && params.has("fixture");

type Batches = { state: "loading" } | { state: "ready"; items: BatchListItem[] } | { state: "error"; message: string };

interface AppState {
  convo: AskConvo;
  cv: ConversationUi;
  batches: Batches;
}
const S: AppState = {
  convo: { id: "fixture", messages: [], busy: false },
  cv: initialConversationUi(),
  batches: { state: "loading" },
};

// ── the shell (rendered once; its regions are patched) ───────────────────────

const app = document.getElementById("app")!;
const themeQ = matchMedia("(prefers-color-scheme: dark)");
const forcedTheme = params.get("theme");
const theme = (): "light" | "dark" => (forcedTheme === "dark" || forcedTheme === "light" ? forcedTheme : themeQ.matches ? "dark" : "light");
app.innerHTML = `<div class="app-root" data-cnpy-theme="${theme()}">
  <header class="cnpy-hdr" data-region="header"></header>
  <div class="ask-screen">
    <section class="ask-conv" aria-label="Batch">
      <div class="ask-scroll" data-ask-scroll data-morph-list data-region="scroll"></div>
      <div class="ask-empty-tail" aria-hidden="true"></div>
    </section>
  </div>
</div>`;
const root = app.firstElementChild as HTMLElement;
const headerEl = root.querySelector<HTMLElement>("[data-region=header]")!;
const scrollEl = root.querySelector<HTMLElement>("[data-region=scroll]")!;
const screenEl = root.querySelector<HTMLElement>(".ask-screen")!;
themeQ.addEventListener("change", () => { root.dataset.cnpyTheme = theme(); scheduleOrbs(); });

function headerView(): string {
  return `<div class="ask-hdr-l"><span class="ask-hdr-mark">${askIcon("chart", 15, null, 2)}</span><h1 class="ask-h1"><span class="ask-h1-t">Where do AI scientists go wrong?</span></h1></div>`;
}

function batchesView(): string {
  const b = S.batches;
  const title = "Batch screens come next";
  if (b.state === "loading") {
    return emptyView({ key: "batches", title, text: "Asking the server which batches it has…", acts: askSpinner(14) });
  }
  if (b.state === "error") {
    return emptyView({ key: "batches", title, text: b.message, acts: `<button type="button" class="ask-ghostbtn ask-ghostbtn--outline" data-act="reload"><span>Try again</span></button>` });
  }
  const text = b.items.length
    ? "The server is up and has these batches. Replays are saved batches; live ones are running here."
    : "The server is up but has no batches yet.";
  const chips = b.items.map((it) => `<span class="ask-ghostbtn ask-ghostbtn--outline" data-batch="${attr(it.id)}">${askIcon("chart", 14, null, 1.8)}<span>${esc(it.id)}</span><span style="color:var(--fg-55)">${esc(it.kind)}</span></span>`).join("");
  return emptyView({ key: "batches", title, text, acts: chips });
}

// ── paint ────────────────────────────────────────────────────────────────────

let frame = 0;
function paint(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function render(): void {
  frame = 0;
  const showConvo = FIXTURE && S.convo.messages.length > 0;
  screenEl.dataset.empty = showConvo ? "0" : "1";
  morphInner(headerEl, headerView());
  const v = { convo: S.convo, ui: S.cv };
  morphInner(scrollEl, showConvo ? `${conversationView(v)}${jumpButton(v)}` : batchesView());
  afterPaint();
}

let ticker: ReturnType<typeof setInterval> | null = null;
function afterPaint(): void {
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

// ── data ─────────────────────────────────────────────────────────────────────

async function loadBatches(): Promise<void> {
  S.batches = { state: "loading" };
  paint();
  try {
    S.batches = { state: "ready", items: await fetchBatches() };
  } catch (e) {
    S.batches = { state: "error", message: e instanceof Error ? e.message : "Couldn't load the batches." };
  }
  paint();
}

/** Dev only: the canned turn, read and folded exactly like a live stream. */
async function replayFixture(): Promise<void> {
  const { fixtureResponse } = await import("./fixture");
  const ac = new AbortController();
  S.convo = {
    ...S.convo, busy: true,
    messages: [{ role: "user", key: "q1", text: "Train a model on this data and report its test accuracy.", file: null }, { role: "assistant", key: "a1", turn: newTurn() }],
  };
  paint();
  try {
    await readAskStream(fixtureResponse(ac.signal), (e) => { S.convo = withLastTurn(S.convo, (t) => foldAskEvent(t, e, Date.now())); paint(); }, ac.signal);
  } catch (e) {
    S.convo = withLastTurn(S.convo, (t) => (isAbort(e) ? stopTurn(t) : failTurn(t)));
  } finally {
    S.convo = { ...S.convo, busy: false };
    paint();
  }
}

// ── events ───────────────────────────────────────────────────────────────────

root.addEventListener("click", (e) => {
  const el = (e.target as Element | null)?.closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const arg = el.dataset.arg ?? "";
  switch (el.dataset.act) {
    case "reload": void loadBatches(); return;
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

// Scrolling: a person scrolling UP lets go of the bottom; the arrow shows once away from it.
let lastTop = 0;
scrollEl.addEventListener("scroll", () => {
  S.cv.stick = stickAfterScroll(S.cv.stick, lastTop, { top: scrollEl.scrollTop, height: scrollEl.scrollHeight, client: scrollEl.clientHeight });
  lastTop = scrollEl.scrollTop;
  const away = !S.cv.stick && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > AWAY_PX;
  if (S.cv.away !== away) { S.cv.away = away; paint(); }
}, { passive: true });

render();
if (FIXTURE) void replayFixture();
else void loadBatches();
