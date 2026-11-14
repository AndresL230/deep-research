// The app: one canvas whose state follows the batch (docs/api-contract.md, web/src/batch/model.ts).
//
//   #/                         home: saved and live batches, and the config screen to start one
//   #/b/<id>                   a batch: phase panel, the wall of runs, the split lanes, the fork experiment, the verdict
//   #/b/<id>/run/<run>         one run in the Ask conversation view
//   #/b/<id>/fork/<f>/<child>  one fork child in the conversation view
//
// A live batch follows the server over the websocket. A saved batch (a replay) loads its final case file and every
// event log once, then a clock plays it back on the timeline in batch/replay.ts.
//
// This file owns all state, fetching and events. Every view in batch/ is a pure function of a view model; morph.ts
// patches the regions in place on every change (batched to a frame), so iframes and images never reload.

import "./style.css";
import "./batch/page.css";
import { attr, esc } from "./ui";
import { askIcon } from "./ask-icons";
import { morphInner } from "./morph";
import { AWAY_PX, conversationView, initialConversationUi, jumpButton, stickAfterScroll, thinkingLabel, type ConversationUi } from "./ask-conversation";
import { scheduleOrbs } from "./thinking-orb";
import {
  applyMessage, fetchBatches, fetchCase, fetchDefaults, fetchForkEvents, fetchHealth, fetchInvestigatorEvents,
  fetchRunEvents, isPendingForks, openBatchSocket, postDecision, postEstimate, startBatch, startInvestigation, stopBatch,
  type AgentEvent, type BatchConfig, type BatchSocket, type CaseFile,
} from "./api";
import { ACT, childKey, parseRoute, routeHash, type BatchVm, type EventKey, type HomeVm, type ReplayState, type Route } from "./batch/model";
import { costBar, homeView } from "./batch/home";
import { wallView } from "./batch/wall";
import { forkView, investigatorView, splitView, verdictView } from "./batch/lanes";
import { eventsToConvo, runSummaryView, taskText } from "./batch/run";
import { caseAt, eventsAt, replayBar, replayDuration } from "./batch/replay";

// ── state ────────────────────────────────────────────────────────────────────

interface BatchState {
  id: string;
  /** Null until the websocket's snapshot (or the case fetch) arrives. */
  full: CaseFile | null;
  live: boolean;
  events: Record<EventKey, AgentEvent[]>;
  replay: ReplayState | null;
  busy: string | null;
  error: string | null;
  loadError: string | null;
  socket: BatchSocket | null;
}

interface AppState {
  route: Route;
  home: HomeVm;
  homeLoaded: boolean;
  batch: BatchState | null;
  /** The conversation view's UI state (open steps, sticking to the bottom); reset per run. */
  cv: ConversationUi;
  cvKey: string;
}

const S: AppState = {
  route: parseRoute(location.hash),
  home: { batches: { state: "loading" }, health: null, defaults: null, draft: null, estimate: null, starting: false, error: null },
  homeLoaded: false,
  batch: null,
  cv: initialConversationUi(),
  cvKey: "",
};

const DEFAULT_SPEED = 4;
const message = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

// ── the shell ────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const themeQ = matchMedia("(prefers-color-scheme: dark)");
const forcedTheme = params.get("theme");
const theme = (): "light" | "dark" => (forcedTheme === "dark" || forcedTheme === "light" ? forcedTheme : themeQ.matches ? "dark" : "light");
app.innerHTML = `<div class="app-root" data-cnpy-theme="${theme()}">
  <header class="cnpy-hdr pg-hdr" data-region="header"></header>
  <div class="pg-sub" data-region="sub" hidden></div>
  <main class="pg-scroll" data-region="scroll"></main>
</div>`;
const root = app.firstElementChild as HTMLElement;
const headerEl = root.querySelector<HTMLElement>("[data-region=header]")!;
const subEl = root.querySelector<HTMLElement>("[data-region=sub]")!;
const scrollEl = root.querySelector<HTMLElement>("[data-region=scroll]")!;
themeQ.addEventListener("change", () => { root.dataset.cnpyTheme = theme(); scheduleOrbs(); });

// ── view models ──────────────────────────────────────────────────────────────

function batchVm(b: BatchState, full: CaseFile): BatchVm {
  const r = b.replay;
  return {
    id: b.id,
    live: b.live,
    case: r ? caseAt(full, b.events, r.t) : full,
    events: r ? eventsAt(full, b.events, r.t) : b.events,
    replay: r,
    busy: b.busy,
    error: b.error,
    now: Date.now(),
  };
}

/** The event key the route shows, if it shows one run or child. */
function routeKey(r: Route): EventKey | null {
  if (r.name === "run") return r.run;
  if (r.name === "child") return childKey(r.fork, r.child);
  return null;
}

function finished(c: CaseFile, r: Route): boolean {
  if (r.name === "run") return ["honest", "inflated", "failed"].includes(c.runs[r.run]?.status ?? "");
  if (r.name === "child") {
    const f = c.forks[r.fork];
    const st = f && !isPendingForks(f) ? f.children[r.child]?.status : undefined;
    return st != null && st !== "running";
  }
  return false;
}

// ── render ───────────────────────────────────────────────────────────────────

let frame = 0;
function paint(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function headerView(vm: BatchVm | null): string {
  const r = S.route;
  const crumbs: string[] = [];
  if (r.name !== "home") crumbs.push(`<button type="button" class="pg-crumb${r.name === "batch" ? " is-cur" : ""}" data-act="${ACT.back}">${esc(r.id)}</button>`);
  if (r.name === "run") crumbs.push(`<span class="pg-crumb is-cur">${esc(r.run)}</span>`);
  if (r.name === "child") crumbs.push(`<span class="pg-crumb is-cur">${esc(`${r.fork} ${r.child}`)}</span>`);
  const left = `<div class="ask-hdr-l pg-hdr-l">
    <button type="button" class="pg-home" data-act="${ACT.home}" aria-label="Home"><span class="ask-hdr-mark">${askIcon("chart", 15, null, 2)}</span><span class="ask-h1 ask-h1-t${crumbs.length ? " is-parent" : ""}">Where do AI scientists go wrong?</span></button>
    ${crumbs.map((c) => `<span class="ask-crumb-sep">›</span>${c}`).join("")}
  </div>`;
  const right = vm ? `<div class="pg-hdr-r">${costBar(vm.case.costs ?? {}, { simulated: !!(vm.case.config as BatchConfig).simulated })}</div>` : "";
  return left + right;
}

function batchBody(vm: BatchVm): string {
  // The story in order: the runs, where they split, what the investigator makes of it, the fork, the verdict.
  const sections: [string, string][] = [
    ["wall", wallView(vm)],
    ["split", splitView(vm)],
    ["phase", investigatorView(vm)],
    ["fork", forkView(vm)],
    ["verdict", verdictView(vm)],
  ];
  return `<div class="pg-batch" data-morph-key="batch:${attr(vm.id)}" data-morph-list>${sections
    .filter(([, html]) => html)
    .map(([k, html]) => `<section class="pg-sec pg-sec--${k}" data-morph-key="sec:${k}">${html}</section>`)
    .join("")}</div>`;
}

function runBody(vm: BatchVm, key: EventKey): string {
  const events = vm.events[key];
  const summary = `<div class="pg-runsum" data-morph-key="sum:${attr(key)}">${runSummaryView(vm, key)}</div>`;
  if (!events) return `${summary}<p class="pg-note" data-morph-key="loading">Loading the event log…</p>`;
  const convo = eventsToConvo(key, events, { task: taskText(vm), finished: finished(vm.case, S.route), now: Date.now() });
  const v = { convo, ui: S.cv };
  return `${summary}${conversationView(v)}${jumpButton(v)}`;
}

function messageView(key: string, title: string, text: string, retry = false): string {
  return `<div class="pg-msg" data-morph-key="msg:${attr(key)}"><h2>${esc(title)}</h2><p>${esc(text)}</p>${retry ? `<button type="button" class="ask-btn" data-act="${ACT.home}">Back home</button>` : ""}</div>`;
}

function render(): void {
  frame = 0;
  const r = S.route;
  const b = S.batch;
  const vm = r.name !== "home" && b?.full ? batchVm(b, b.full) : null;

  morphInner(headerEl, headerView(vm));
  const showReplay = !!(vm && vm.replay);
  subEl.hidden = !showReplay;
  if (showReplay && vm?.replay) morphInner(subEl, replayBar(vm.replay));

  let body: string;
  if (r.name === "home") body = homeView(S.home);
  else if (b?.loadError) body = messageView("err", "Couldn't open this batch", b.loadError, true);
  else if (!vm) body = messageView("loading", "Opening the batch", "Loading its case file and event logs…");
  else if (r.name === "batch") body = batchBody(vm);
  else body = runBody(vm, routeKey(r)!);
  scrollEl.dataset.view = r.name;
  morphInner(scrollEl, body);
  afterPaint();
}

/** Sections on screen last paint, so a replay can bring a newly revealed one into view. */
let shownSections = new Set<string>();

let ticker: ReturnType<typeof setInterval> | null = null;
function afterPaint(): void {
  if (S.route.name === "batch") {
    const els = Array.from(scrollEl.querySelectorAll<HTMLElement>(".pg-sec[data-morph-key]"));
    const keys = new Set(els.map((el) => el.dataset.morphKey!));
    const fresh = els.filter((el) => !shownSections.has(el.dataset.morphKey!));
    // Follow the story while a replay plays: the split, the fork and the verdict scroll in as they appear.
    if (S.batch?.replay?.playing && shownSections.size && fresh.length) {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      fresh[fresh.length - 1].scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
    shownSections = keys;
  } else {
    shownSections = new Set();
  }
  const k = routeKey(S.route);
  // The conversation keeps to the bottom while the person has not scrolled up, as in the chat.
  if (k && S.cv.stick && S.batch?.events[k]?.length) scrollEl.scrollTop = scrollEl.scrollHeight;
  if (!ticker && scrollEl.querySelector("[data-ask-think]")) {
    ticker = setInterval(() => {
      const els = Array.from(scrollEl.querySelectorAll<HTMLElement>("[data-ask-think]"));
      if (!els.length) { if (ticker) clearInterval(ticker); ticker = null; return; }
      for (const el of els) el.textContent = thinkingLabel(Number(el.dataset.askThink));
    }, 500);
  }
}

// ── the replay clock ─────────────────────────────────────────────────────────

let clock = 0;
let lastTick = 0;
function tick(now: number): void {
  clock = 0;
  const r = S.batch?.replay;
  if (!r || !r.playing) return;
  const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
  lastTick = now;
  r.t = Math.min(r.duration, r.t + dt * r.speed);
  if (r.t >= r.duration) r.playing = false;
  render();
  if (r.playing) clock = requestAnimationFrame(tick);
}
function runClock(): void {
  lastTick = 0;
  if (!clock) clock = requestAnimationFrame(tick);
}
function stopClock(): void {
  if (clock) cancelAnimationFrame(clock);
  clock = 0;
}

// ── loading a batch ──────────────────────────────────────────────────────────

function closeBatch(): void {
  stopClock();
  S.batch?.socket?.close();
  S.batch = null;
}

function openBatch(id: string): void {
  if (S.batch?.id === id) return;
  closeBatch();
  const b: BatchState = { id, full: null, live: false, events: {}, replay: null, busy: null, error: null, loadError: null, socket: null };
  S.batch = b;
  let snapshotSeen = false;
  b.socket = openBatchSocket(id, {
    message: (m) => {
      if (S.batch !== b) return;
      if (m.kind === "error") { b.loadError = m.message; paint(); return; }
      if (m.kind === "snapshot") {
        snapshotSeen = true;
        b.live = m.live;
        if (m.live) { b.full = m.case; void loadLiveLogs(b); }
        else void loadReplay(b, m.case);
        paint();
        return;
      }
      b.full = applyMessage(b.full, m);
      if (m.kind === "event") append(b, m.run, m.event);
      else if (m.kind === "fork_event") append(b, childKey(m.fork, m.child), m.event);
      else if (m.kind === "investigator") append(b, "investigator", m.event);
      paint();
    },
    close: () => {
      // No websocket (a proxy without ws, say): fall back to the case over HTTP as a replay.
      if (S.batch === b && !snapshotSeen) {
        fetchCase(id).then((c) => { if (S.batch === b) void loadReplay(b, c); })
          .catch((e) => { if (S.batch === b) { b.loadError = message(e, "Couldn't load the batch."); paint(); } });
      }
    },
  });
  paint();
}

function append(b: BatchState, key: EventKey, ev: AgentEvent): void {
  // Only logs already loaded grow; the rest load in full when opened.
  if (b.events[key]) b.events[key] = [...b.events[key], ev];
}

/** Every log a saved batch has: each run, each fork child, and the investigator. */
function logKeys(c: CaseFile): EventKey[] {
  const keys: EventKey[] = Object.keys(c.runs);
  for (const f of Object.values(c.forks)) {
    if (isPendingForks(f)) continue;
    for (const child of Object.keys(f.children ?? {})) keys.push(childKey(f.id, child));
  }
  keys.push("investigator");
  return keys;
}

function fetchLog(id: string, key: EventKey): Promise<AgentEvent[]> {
  if (key === "investigator") return fetchInvestigatorEvents(id);
  const slash = key.indexOf("/");
  return slash < 0 ? fetchRunEvents(id, key) : fetchForkEvents(id, key.slice(0, slash), key.slice(slash + 1));
}

async function loadReplay(b: BatchState, full: CaseFile): Promise<void> {
  try {
    const keys = logKeys(full);
    const logs = await Promise.all(keys.map((k) => fetchLog(b.id, k).catch(() => [] as AgentEvent[])));
    if (S.batch !== b) return;
    b.events = Object.fromEntries(keys.map((k, i) => [k, logs[i]]));
    b.full = full;
    b.live = false;
    const duration = replayDuration(full, b.events);
    // Opened straight onto a run: show it whole. Opened onto the batch: play it from the start.
    const atEnd = S.route.name !== "batch" || params.has("end");
    b.replay = { t: atEnd ? duration : 0, duration, playing: !atEnd && duration > 0, speed: DEFAULT_SPEED };
    if (b.replay.playing) runClock();
  } catch (e) {
    b.loadError = message(e, "Couldn't load the batch.");
  }
  paint();
}

/** A live batch: load the investigator's log, and the log of the run or child on screen. */
async function loadLiveLogs(b: BatchState): Promise<void> {
  const keys = ["investigator", ...(routeKey(S.route) ? [routeKey(S.route)!] : [])].filter((k) => !b.events[k]);
  await Promise.all(keys.map(async (k) => {
    try { const evs = await fetchLog(b.id, k); if (S.batch === b && !b.events[k]) b.events[k] = evs; } catch { /* shown as loading */ }
  }));
  paint();
}

// ── home ─────────────────────────────────────────────────────────────────────

async function loadHome(force = false): Promise<void> {
  if (S.homeLoaded && !force) {
    // The batch list is cheap and changes: refresh it on every visit.
    fetchBatches().then((items) => { S.home = { ...S.home, batches: { state: "ready", value: items } }; paint(); }).catch(() => undefined);
    return;
  }
  S.homeLoaded = true;
  S.home = { ...S.home, batches: { state: "loading" } };
  paint();
  const [batches, health, defaults] = await Promise.allSettled([fetchBatches(), fetchHealth(), fetchDefaults()]);
  S.home = {
    ...S.home,
    batches: batches.status === "fulfilled" ? { state: "ready", value: batches.value } : { state: "error", message: message(batches.reason, "Couldn't load the batches.") },
    health: health.status === "fulfilled" ? health.value : null,
    defaults: defaults.status === "fulfilled" ? defaults.value : S.home.defaults,
    draft: S.home.draft ?? (defaults.status === "fulfilled" ? { ...defaults.value.config } : null),
  };
  paint();
  scheduleEstimate();
}

let estimateTimer: ReturnType<typeof setTimeout> | null = null;
let estimateSeq = 0;
function scheduleEstimate(): void {
  if (estimateTimer) clearTimeout(estimateTimer);
  estimateTimer = setTimeout(async () => {
    const draft = S.home.draft;
    if (!draft) return;
    const seq = ++estimateSeq;
    S.home = { ...S.home, estimate: { state: "loading" } };
    paint();
    try {
      const value = await postEstimate(draft);
      if (seq === estimateSeq) S.home = { ...S.home, estimate: { state: "ready", value } };
    } catch (e) {
      if (seq === estimateSeq) S.home = { ...S.home, estimate: { state: "error", message: message(e, "Couldn't estimate the cost.") } };
    }
    paint();
  }, 250);
}

function setDraft(field: string, raw: string, numeric: boolean): void {
  if (!S.home.draft) return;
  let value: string | number = raw;
  if (numeric) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    value = n;
  }
  S.home = { ...S.home, draft: { ...S.home.draft, [field]: value } as BatchConfig, error: null };
  paint();
  scheduleEstimate();
}

async function start(): Promise<void> {
  const draft = S.home.draft;
  if (!draft || S.home.starting) return;
  S.home = { ...S.home, starting: true, error: null };
  paint();
  try {
    const { id } = await startBatch({ ...draft, mode: "live" });
    S.home = { ...S.home, starting: false };
    go({ name: "batch", id });
  } catch (e) {
    S.home = { ...S.home, starting: false, error: message(e, "Couldn't start the batch.") };
    paint();
  }
}

// ── live actions ─────────────────────────────────────────────────────────────

async function liveAction(name: string, call: (id: string) => Promise<unknown>): Promise<void> {
  const b = S.batch;
  if (!b || !b.live || b.busy) return;
  b.busy = name;
  b.error = null;
  paint();
  try {
    await call(b.id);
  } catch (e) {
    b.error = message(e, "That didn't work.");
  } finally {
    b.busy = null;
    paint();
  }
}

// ── routing ──────────────────────────────────────────────────────────────────

function go(r: Route): void {
  const hash = routeHash(r);
  if (location.hash !== hash) location.hash = hash;
  else onRoute();
}

function onRoute(): void {
  const prev = S.route;
  S.route = parseRoute(location.hash);
  const r = S.route;
  const key = routeKey(r) ?? "";
  if (key !== S.cvKey) { S.cv = initialConversationUi(); S.cvKey = key; }
  if (prev.name !== r.name || routeKey(prev) !== routeKey(r)) scrollEl.scrollTop = 0;
  if (r.name === "home") {
    closeBatch();
    void loadHome();
  } else {
    openBatch(r.id);
    const b = S.batch;
    if (b?.live && b.full) void loadLiveLogs(b);
    // A replay opened on a run that is not there yet: the run page shows it as it plays.
  }
  paint();
}

window.addEventListener("hashchange", onRoute);

// ── events ───────────────────────────────────────────────────────────────────

root.addEventListener("click", (e) => {
  const el = (e.target as Element | null)?.closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
  if (el.tagName === "A") return; // real links (charts, lab pages) open on their own
  const arg = el.dataset.arg ?? "";
  const r = S.route;
  const b = S.batch;
  switch (el.dataset.act) {
    case ACT.home: go({ name: "home" }); if (S.home.batches.state === "error") void loadHome(true); return;
    case ACT.openBatch: go({ name: "batch", id: arg }); return;
    case ACT.start: void start(); return;
    case ACT.resetConfig:
      if (S.home.defaults) { S.home = { ...S.home, draft: { ...S.home.defaults.config }, error: null }; paint(); scheduleEstimate(); }
      return;
    case ACT.openRun: if (r.name !== "home") go({ name: "run", id: r.id, run: arg }); return;
    case ACT.openChild: {
      const [fork, child] = arg.split("/");
      if (r.name !== "home" && fork && child) go({ name: "child", id: r.id, fork, child });
      return;
    }
    case ACT.back: if (r.name !== "home") go({ name: "batch", id: r.id }); return;
    case ACT.investigate: void liveAction("investigate", (id) => startInvestigation(id)); return;
    case ACT.approve: void liveAction("approve", (id) => postDecision(id, true)); return;
    case ACT.decline: void liveAction("decline", (id) => postDecision(id, false)); return;
    case ACT.stop: void liveAction("stop", (id) => stopBatch(id)); return;
    case ACT.replayToggle: {
      const rp = b?.replay;
      if (!rp) return;
      if (rp.t >= rp.duration) rp.t = 0;
      rp.playing = !rp.playing;
      if (rp.playing) runClock(); else stopClock();
      paint();
      return;
    }
    case ACT.replaySpeed: { const rp = b?.replay; const n = Number(arg); if (rp && n > 0) { rp.speed = n; paint(); } return; }
    case ACT.replayRestart: { const rp = b?.replay; if (rp) { rp.t = 0; rp.playing = true; runClock(); paint(); } return; }
    case ACT.replayEnd: { const rp = b?.replay; if (rp) { rp.t = rp.duration; rp.playing = false; stopClock(); paint(); } return; }
    case ACT.toggle: {
      const was = el.getAttribute("aria-expanded") === "true";
      S.cv.open = { ...S.cv.open, [arg]: !was };
      paint();
      return;
    }
    case ACT.jump: {
      S.cv.stick = true;
      S.cv.away = false;
      const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      paint();
      return;
    }
  }
});

// Keyboard: role="button" tiles open on Enter and Space.
root.addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement;
  if ((e.key === "Enter" || e.key === " ") && el.getAttribute("role") === "button" && el.dataset.act) {
    e.preventDefault();
    el.click();
  }
});

function onField(e: Event): void {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (el.hasAttribute?.("data-replay-seek")) {
    const rp = S.batch?.replay;
    if (rp) { rp.t = Math.max(0, Math.min(rp.duration, Number(el.value))); paint(); }
    return;
  }
  const field = el.dataset?.cfg;
  if (!field) return;
  const numeric = el instanceof HTMLInputElement && (el.type === "number" || el.type === "range");
  setDraft(field, el.value, numeric);
}
root.addEventListener("input", onField);
root.addEventListener("change", onField);

// Scrolling in a run: scrolling up lets go of the bottom; the jump arrow shows once away from it.
let lastTop = 0;
scrollEl.addEventListener("scroll", () => {
  if (!routeKey(S.route)) return;
  S.cv.stick = stickAfterScroll(S.cv.stick, lastTop, { top: scrollEl.scrollTop, height: scrollEl.scrollHeight, client: scrollEl.clientHeight });
  lastTop = scrollEl.scrollTop;
  const away = !S.cv.stick && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > AWAY_PX;
  if (S.cv.away !== away) { S.cv.away = away; paint(); }
}, { passive: true });

// A live batch's "running for 42s" labels move without server messages.
setInterval(() => { if (S.batch?.live && S.route.name !== "home") paint(); }, 1000);

onRoute();
