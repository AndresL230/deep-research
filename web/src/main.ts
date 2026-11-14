// The app: one canvas whose state follows the batch (docs/api-contract.md, web/src/batch/model.ts).
//
//   #/                         the landing page: a nav and a hero over a 3D scene of the pipeline (landing/)
//   #/start                    home: saved and live batches, and the config screen to start one
//   #/b/<id>                   a batch, first page: the overview and the wall of runs
//   #/b/<id>/<step>            a batch's later pages, one per stage: changed, investigator, fork, verdict,
//                              diagnosis, fix (model.ts BATCH_STEPS)
//   #/b/<id>/run/<run>         one run in the Ask conversation view
//   #/b/<id>/fork/<f>/<child>  one fork child in the conversation view
//   #/costs                    what every batch cost, in total and one by one
//
// A live batch follows the server over the websocket. A saved batch (a replay) loads its final case file and every
// event log once, then a clock plays it back on the timeline in batch/replay.ts.
//
// This file owns all state, fetching and events. Every view in batch/ is a pure function of a view model; morph.ts
// patches the regions in place on every change (batched to a frame), so iframes and images never reload.

import "./style.css";
import "./system.css";
import "./batch/page.css";
import { attr, esc } from "./ui";
import { symbolTile, wordmark } from "./brand";
import { morphInner } from "./morph";
import { AWAY_PX, conversationView, initialConversationUi, jumpButton, stickAfterScroll, thinkingLabel, type ConversationUi } from "./ask-conversation";
import { scheduleOrbs } from "./thinking-orb";
import { PAGE_BACKGROUND, readStoredTheme, resolveTheme, storeTheme, themeChoice, themeSwitch, type Theme, type ThemeChoice } from "./theme";
import {
  applyMessage, fetchBatches, fetchCase, fetchDatasets, fetchDefaults, fetchForkEvents, fetchHealth, fetchInvestigatorEvents,
  fetchRunEvents, isPendingForks, openBatchSocket, postDecision, postEstimate, resumeBatch, startBatch, uploadController, uploadDataset, uploadScript, startInvestigation, stopBatch,
  type AgentEvent, type HubStatus, type BatchConfig, type BatchSocket, type CaseFile,
} from "./api";
import { ACT, BATCH_STEPS, STEP_LABEL, childKey, parseRoute, routeHash, type BatchStep, type BatchVm, type EventKey, type HomeVm, type LogView, type ReplayState, type Route } from "./batch/model";
import { DEFAULT_DOMAIN, HM_ACT, costBar, domainOf, homeView, initialDraft, pickDomain, recallDomain, rememberDomain, resetDraft, startPayload, toggleModel } from "./batch/home";
import { BT_ACT, DEFAULT_VIEW, sortBy } from "./batch/batch-table";
import { hubBadge } from "./batch/hub-badge";
import { DI_ACT, controllerRow, fileKind, initialDatasetUi, inputsConfig, inputsLabel, inputsView, pickFile, uploadAfterEdit, withUpload, type DatasetUi, type Uploaded, type UploadKind, type UploadTicket } from "./dataset-input";
import { notYetView, overviewView, pageHeadView, pagerView } from "./batch/overview";
import { wallView } from "./batch/wall";
import { feedView, notebookWithCaptions, wallWithFeed } from "./batch/commentary";
import { diagnosisView, fixView, forkView, investigatorView, splitView, verdictView } from "./batch/lanes";
import { trapMark, trapOf } from "./batch/trap";
import { eventsToConvo, runSummaryView, taskText, workStrip } from "./batch/run";
import { ScrollFollow, agentTimes, caseAt, eventsAt, isScrollKey, replayBar, replayDuration, replaySchedule } from "./batch/replay";
import { LABEL_PATTERNS, chartUrl, logOf, notebookCells } from "./batch/notebook";
import { fetchCosts, type CostReport } from "./api";
import type { Loadable } from "./batch/model";
import { costsLink, costsView } from "./batch/costs";
import { landingView } from "./landing/landing";
import { syncLanding } from "./landing/mount";
import { syncMotion } from "./motion";
import { refreshMotion } from "./robot/mount";
import { smoothScroll } from "./scroll";
import { isMotionBatch } from "./robot/markup";

// ── state ────────────────────────────────────────────────────────────────────

interface BatchState {
  id: string;
  /** Null until the websocket's snapshot (or the case fetch) arrives. */
  full: CaseFile | null;
  live: boolean;
  /** A saved batch the server can bring back live (the snapshot said so). */
  resumable: boolean;
  events: Record<EventKey, AgentEvent[]>;
  /** Live only: per log, the last event's time and when it arrived, to run that log's clock between events. */
  ticks: Record<EventKey, { t: number; at: number }>;
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
  /** What a new batch runs on: the dataset, the target column and the training script, or the robot controller (dataset-input.ts). */
  ds: DatasetUi;
  batch: BatchState | null;
  /** The conversation view's UI state (open steps, sticking to the bottom); reset per run. */
  cv: ConversationUi;
  cvKey: string;
  /** A run's page: its notebook, or the same log as conversation steps. */
  runView: "notebook" | "steps";
  /** A robot run's page: the notebook is folded under the player until asked for. Reset per run. */
  workOpen: boolean;
  /** The cost screen's report (GET /api/costs), loaded again on every visit. */
  costs: Loadable<CostReport>;
  /** Where the cost screen was opened from, for its back button. */
  costsBack: Route;
  /** The page of a batch last open, so the way back from one of its runs lands on it. */
  lastStep: { id: string; step: BatchStep } | null;
  /** This server's link to the team hub, for the header badge (refreshed every half minute). */
  hub: HubStatus | null;
  /** The batch page's live feed is unfolded (narrow screens only: on a wide one it is always open). */
  feedOpen: boolean;
}

const S: AppState = {
  route: parseRoute(location.hash),
  home: { batches: { state: "loading" }, health: null, defaults: null, draft: null, estimate: null, starting: false, error: null },
  homeLoaded: false,
  ds: initialDatasetUi(),
  batch: null,
  cv: initialConversationUi(),
  cvKey: "",
  runView: "notebook",
  workOpen: false,
  costs: { state: "loading" },
  costsBack: { name: "home" },
  lastStep: null,
  hub: null,
  feedOpen: false,
};

const DEFAULT_SPEED = 4;
const message = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

// ── the shell ────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const themeQ = matchMedia("(prefers-color-scheme: dark)");
// Black mode unless asked: the switch in the header (kept in this browser), or `?theme=light|dark|system`
// (theme.ts). The landing page follows the same setting once one is made; until then it opens in white mode, the
// look of the site it is modelled on.
let themePick: ThemeChoice = themeChoice(params.get("theme"), readStoredTheme());
let themeChosen = themePick !== themeChoice(null, null) || params.get("theme") !== null || readStoredTheme() !== null;
const theme = (): Theme => (!themeChosen && S.route.name === "landing" ? "light" : resolveTheme(themePick, themeQ.matches));
const syncPageTheme = (): void => { document.documentElement.style.colorScheme = theme(); document.body.style.background = PAGE_BACKGROUND[theme()]; };
syncPageTheme();
app.innerHTML = `<div class="app-root" data-cnpy-theme="${theme()}">
  <header class="cnpy-hdr pg-hdr" data-region="header"></header>
  <div class="pg-sub" data-region="sub" hidden></div>
  <main class="pg-scroll" data-region="scroll"></main>
</div>`;
const root = app.firstElementChild as HTMLElement;
const headerEl = root.querySelector<HTMLElement>("[data-region=header]")!;
const subEl = root.querySelector<HTMLElement>("[data-region=sub]")!;
const scrollEl = root.querySelector<HTMLElement>("[data-region=scroll]")!;
// The page scrolls smoothly (scroll.ts, Lenis); the jumps the app makes itself go through it too.
const smooth = smoothScroll(scrollEl);
const applyTheme = (): void => { root.dataset.cnpyTheme = theme(); syncPageTheme(); scheduleOrbs(); paint(); };
themeQ.addEventListener("change", () => { if (themePick === "system") applyTheme(); });
/** The switch: white or black, kept in this browser. */
function pickTheme(t: Theme): void {
  if (t === theme() && themePick !== "system") return;
  themePick = t;
  themeChosen = true;
  storeTheme(t);
  applyTheme();
}

// ── view models ──────────────────────────────────────────────────────────────

const timesCache = new WeakMap<AgentEvent[], number[]>();
function ownTimes(events: AgentEvent[]): number[] {
  let t = timesCache.get(events);
  if (!t) { t = agentTimes(events); timesCache.set(events, t); }
  return t;
}

const SCORED = ["honest", "inflated", "unclear", "failed"];

/** Each log with its own clock, for the notebooks: a replay's from the timeline, a live batch's from the wall clock. */
function logViews(b: BatchState, full: CaseFile, c: CaseFile): Record<EventKey, LogView> {
  const out: Record<EventKey, LogView> = {};
  const r = b.replay;
  if (r) {
    const sched = replaySchedule(full, b.events);
    const starts: Record<EventKey, number> = {};
    for (const f of sched.forks) for (const [cid, slot] of Object.entries(f.children)) starts[childKey(f.id, cid)] = slot.start;
    for (const [key, events] of Object.entries(b.events)) {
      if (key === "investigator") continue;
      // Runs start with the timeline; a fork child starts when its VM does.
      const clock = r.t >= r.duration ? Infinity : r.t - (starts[key] ?? 0);
      out[key] = { events, times: ownTimes(events), clock, lookahead: true };
    }
    return out;
  }
  const now = Date.now();
  for (const [key, events] of Object.entries(b.events)) {
    if (key === "investigator") continue;
    const slash = key.indexOf("/");
    const f = slash < 0 ? null : c.forks[key.slice(0, slash)];
    const status = slash < 0 ? c.runs[key]?.status : f && !isPendingForks(f) ? f.children?.[key.slice(slash + 1)]?.status : undefined;
    const tick = b.ticks[key];
    const over = !b.live || status == null || SCORED.includes(status) || !tick;
    out[key] = { events, times: ownTimes(events), clock: over ? Infinity : tick.t + (now - tick.at) / 1000, lookahead: false };
  }
  return out;
}

function batchVm(b: BatchState, full: CaseFile): BatchVm {
  const r = b.replay;
  const c = r ? caseAt(full, b.events, r.t) : full;
  return {
    id: b.id,
    live: b.live,
    resumable: b.resumable,
    case: c,
    events: r ? eventsAt(full, b.events, r.t) : b.events,
    logs: logViews(b, full, c),
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
  if (r.name === "run") return SCORED.includes(c.runs[r.run]?.status ?? "");
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
  const onFirst = r.name === "batch" && !r.step;
  if ("id" in r) crumbs.push(`<button type="button" class="pg-crumb${onFirst ? " is-cur" : ""}" data-act="${ACT.back}">${esc(r.id)}</button>`);
  if (r.name === "batch" && r.step) crumbs.push(`<span class="pg-crumb is-cur">${esc(STEP_LABEL[r.step])}</span>`);
  if (r.name === "costs") crumbs.push(`<span class="pg-crumb is-cur">Costs</span>`);
  if (r.name === "run") crumbs.push(`<span class="pg-crumb is-cur">${esc(r.run)}</span>`);
  if (r.name === "child") crumbs.push(`<span class="pg-crumb is-cur">${esc(`${r.fork} ${r.child}`)}</span>`);
  const left = `<div class="ask-hdr-l pg-hdr-l">
    <button type="button" class="pg-home" data-act="${ACT.home}" aria-label="Orro, home">${symbolTile(22)}<span class="ask-h1 ask-h1-t${crumbs.length ? " is-parent" : ""}">${wordmark(16)}</span></button>
    ${crumbs.map((c) => `<span class="ask-crumb-sep">›</span>${c}`).join("")}
  </div>`;
  const bar = vm ? costBar(vm.case.costs ?? {}, { simulated: !!(vm.case.config as BatchConfig).simulated }) : "";
  const right = `<div class="pg-hdr-r">${bar}${hubBadge(S.hub)}${costsLink(r.name === "costs")}${themeSwitch(theme())}</div>`;
  return left + right;
}

/** Each later page's one section. */
const STEP_VIEW: Record<Exclude<BatchStep, "wall">, (vm: BatchVm) => string> = {
  split: splitView, phase: investigatorView, fork: forkView, verdict: verdictView, diagnosis: diagnosisView, fix: fixView,
};

/**
 * A batch, a page at a time instead of one long scroll. The first page is where the batch stands and its agents, with
 * the live feed of notable moments beside them (commentary.ts); each stage after them (where the runs split, the
 * investigator, the fork, the verdict, and a robot batch's diagnosis and fix) is a page of its own. Every page ends in
 * Back / Next (overview.ts `pagerView`).
 */
function batchBody(vm: BatchVm, step: BatchStep): string {
  const sections: [string, string][] = step === "wall"
    ? [["overview", overviewView(vm)], ["wall", wallWithFeed(wallView(vm), feedView(vm, S.feedOpen))]]
    : [["head", pageHeadView(vm, step)], [step, STEP_VIEW[step](vm) || notYetView(vm, step)]];
  // The bar is a new element on every page, so it arrives with the page.
  sections.push([`pager:${step}`, pagerView(vm, step)]);
  return `<div class="pg-batch" data-morph-key="batch:${attr(vm.id)}" data-morph-list>${sections
    .filter(([, html]) => html)
    .map(([k, html]) => `<section class="pg-sec pg-sec--${k.replace(/:.*/, "")}" data-morph-key="sec:${k}">${html}</section>`)
    .join("")}</div>`;
}

function runBody(vm: BatchVm, key: EventKey): string {
  const events = vm.events[key];
  const tab = (view: AppState["runView"], label: string): string =>
    `<button type="button" class="pg-tab" data-act="${ACT.runView}" data-arg="${view}" aria-pressed="${S.runView === view}">${label}</button>`;
  const summary = `<div class="pg-runsum" data-morph-key="sum:${attr(key)}">${runSummaryView(vm, key)}<div class="pg-tabs" role="group" aria-label="View">${tab("notebook", "Notebook")}${tab("steps", "Steps")}</div></div>`;
  if (!events) return `${summary}<p class="pg-note" data-morph-key="loading">Loading the event log…</p>`;
  if (S.runView === "notebook") {
    const log = logOf(vm, key);
    const cells = log ? notebookCells(log) : [];
    const label = vm.case.split?.label;
    const body = cells.length
      ? notebookWithCaptions(cells, log, { image: (name) => chartUrl(vm, key, name), mark: trapMark(trapOf(vm.case), label) ?? (label ? LABEL_PATTERNS[label] ?? null : null) })
      : `<p class="pg-note">Nothing has run yet.</p>`;
    // A robot run: the player is the thing to look at, so the notebook stays folded under a line of what the agent did.
    if (isMotionBatch(vm.case.config) && cells.length) {
      const strip = workStrip(vm, key, cells.length, S.workOpen, ACT.workToggle);
      return `${summary}${strip}${S.workOpen ? `<div class="pg-nb" data-morph-key="nb:${attr(key)}">${body}</div>` : ""}`;
    }
    return `${summary}<div class="pg-nb" data-morph-key="nb:${attr(key)}">${body}</div>`;
  }
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
  const vm = "id" in r && b?.full ? batchVm(b, b.full) : null;

  // The landing page brings its own nav, and its own palettes in the app's two themes.
  const landing = r.name === "landing";
  const landingTone = theme();
  headerEl.hidden = landing;
  root.dataset.cnpyTheme = theme();
  syncPageTheme();
  morphInner(headerEl, headerView(vm));
  const showReplay = !!(vm && vm.replay);
  subEl.hidden = !showReplay;
  if (showReplay && vm?.replay) morphInner(subEl, replayBar(vm.replay));

  let body: string;
  if (landing) body = landingView(landingTone);
  else if (r.name === "home") {
    body = homeView(S.home, {
      html: inputsView(S.ds, S.home.starting), label: inputsLabel(S.ds),
      controllerHtml: controllerRow(S.ds, S.home.starting), controller: S.ds.controller,
    });
  }
  else if (r.name === "costs") body = costsView({ report: S.costs, back: "id" in S.costsBack ? S.costsBack.id : null });
  else if (b?.loadError) body = messageView("err", "Couldn't open this batch", b.loadError, true);
  else if (!vm) body = messageView("loading", "Opening the batch", "Loading its case file and event logs…");
  else if (r.name === "batch") body = batchBody(vm, r.step ?? "wall");
  else body = runBody(vm, routeKey(r)!);
  scrollEl.dataset.view = r.name;
  root.dataset.view = r.name;
  morphInner(scrollEl, body);
  afterPaint();
}

/** What a playing replay follows on a batch page: its sections, and what arrives inside one as the story goes on (a
 *  page's stage replacing "Nothing here yet", a hypothesis, an experiment). */
const FOLLOWED = ".pg-sec[data-morph-key], .ln-sec[data-morph-key], .ln-card[data-morph-key]";
/** The batch page on screen last paint, and what on it a replay follows, so a newly revealed part can be brought into view. */
let shownPage = "";
let shownSections = new Set<string>();
/** When the person last scrolled the page themselves (the listeners are with the other events below). */
const follow = new ScrollFollow();

/**
 * Follow the story while a replay plays: a part of the page that appears scrolls into view (through Lenis, scroll.ts),
 * unless the person scrolled in the last few seconds (then the page stays where they put it). The replay never turns
 * the page: each stage is a page of its own, and opening one is the person's to do. A page just opened is not news, it
 * starts at its top.
 */
function followStory(): void {
  const r = S.route;
  if (r.name !== "batch") {
    shownPage = "";
    shownSections = new Set();
    return;
  }
  const page = `${r.id}/${r.step ?? "wall"}`;
  const els = Array.from(scrollEl.querySelectorAll<HTMLElement>(FOLLOWED));
  const keys = new Set(els.map((el) => el.dataset.morphKey!));
  if (page === shownPage && S.batch?.replay?.playing && shownSections.size && follow.follows(Date.now())) {
    // The outermost new parts (a new section brings its cards with it), and of those the last: the latest news.
    const fresh = els.filter((el) => !shownSections.has(el.dataset.morphKey!));
    const outer = fresh.filter((el) => !fresh.some((o) => o !== el && o.contains(el)));
    const target = outer[outer.length - 1];
    if (target) smooth.to(target, { offset: -16, immediate: matchMedia("(prefers-reduced-motion: reduce)").matches });
  }
  shownPage = page;
  shownSections = keys;
}

let ticker: ReturnType<typeof setInterval> | null = null;
function afterPaint(): void {
  // First, before the browser styles the page: what morph took off the elements that move (motion.ts).
  syncMotion(scrollEl, scrollEl);
  // The landing page's 3D scenes are canvases, not markup: start them when the page is there, stop them when it is
  // not, and show the open item's device.
  syncLanding(scrollEl);
  followStory();
  const k = routeKey(S.route);
  // The conversation keeps to the bottom while the person has not scrolled up, as in the chat. Not on a finished robot
  // run's page: its 3D replay at the top is what the page is for.
  if (k && S.cv.stick && S.batch?.events[k]?.length && !scrollEl.querySelector("[data-robot-view]")) scrollEl.scrollTop = scrollEl.scrollHeight;
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

function openBatch(id: string, reopen = false): void {
  if (S.batch?.id === id && !reopen) return;
  closeBatch();
  const b: BatchState = { id, full: null, live: false, resumable: false, events: {}, ticks: {}, replay: null, busy: null, error: null, loadError: null, socket: null };
  S.batch = b;
  let snapshotSeen = false;
  b.socket = openBatchSocket(id, {
    message: (m) => {
      if (S.batch !== b) return;
      if (m.kind === "error") { b.loadError = m.message; paint(); return; }
      if (m.kind === "snapshot") {
        snapshotSeen = true;
        b.live = m.live;
        b.resumable = !m.live && m.resumable === true;
        if (m.live) { b.full = m.case; void loadLiveLogs(b); }
        else void loadReplay(b, m.case);
        paint();
        return;
      }
      b.full = applyMessage(b.full, m);
      if (m.kind === "case" && (m.section === "runs" || m.section === "forks")) void loadLiveLogs(b);
      if (m.kind === "event") append(b, m.run, m.event);
      else if (m.kind === "fork_event") append(b, childKey(m.fork, m.child), m.event);
      else if (m.kind === "investigator") append(b, "investigator", m.event);
      // A robot run saved an episode: a file saved again under the same path is drawn again from its new content.
      if ((m.kind === "event" || m.kind === "fork_event") && m.event.type === "motion") refreshMotion(b.id, m.event.path);
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
  b.events[key] = [...(b.events[key] ?? []), ev];
  b.ticks[key] = { t: ev.t, at: Date.now() };
}

/** Where a replay starts playing: just before the first agent acts, skipping the wait for the VMs to start. */
function replayStart(b: BatchState): number {
  if (!b.full) return 0;
  const firsts = Object.values(replaySchedule(b.full, b.events).runs).map((r) => r.first).filter((x) => Number.isFinite(x));
  return firsts.length ? Math.max(0, Math.min(...firsts) - 3) : 0;
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
    // Opened straight onto a run or a later page: show it whole. Opened onto the batch: play it from the start.
    const atEnd = S.route.name !== "batch" || !!S.route.step || params.has("end");
    b.replay = { t: atEnd ? duration : replayStart(b), duration, playing: !atEnd && duration > 0, speed: DEFAULT_SPEED };
    if (b.replay.playing) runClock();
  } catch (e) {
    b.loadError = message(e, "Couldn't load the batch.");
  }
  paint();
}

const eventId = (e: AgentEvent): string => `${e.t}|${e.type}|${"id" in e ? e.id ?? "" : ""}`;
const loadedLogs = new WeakMap<BatchState, Set<EventKey>>();

/** A live batch: load what every log already holds (the tiles are notebooks), then the websocket appends to it. */
async function loadLiveLogs(b: BatchState): Promise<void> {
  if (!b.full) return;
  const done = loadedLogs.get(b) ?? new Set<EventKey>();
  loadedLogs.set(b, done);
  const keys = logKeys(b.full).filter((k) => !done.has(k));
  for (const k of keys) done.add(k);
  await Promise.all(keys.map(async (k) => {
    try {
      const saved = await fetchLog(b.id, k);
      if (S.batch !== b) return;
      // Events that arrived over the websocket while this loaded come after what the server had saved.
      const have = new Set(saved.map(eventId));
      const merged = [...saved, ...(b.events[k] ?? []).filter((e) => !have.has(eventId(e)))];
      b.events[k] = merged;
      const last = merged.at(-1);
      if (last && !b.ticks[k]) b.ticks[k] = { t: last.t, at: Date.now() };
    } catch { done.delete(k); /* tried again on the next case update */ }
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
  void loadInputs();
  const [batches, health, defaults] = await Promise.allSettled([fetchBatches(), fetchHealth(), fetchDefaults()]);
  S.home = {
    ...S.home,
    batches: batches.status === "fulfilled" ? { state: "ready", value: batches.value } : { state: "error", message: message(batches.reason, "Couldn't load the batches.") },
    health: health.status === "fulfilled" ? health.value : null,
    defaults: defaults.status === "fulfilled" ? defaults.value : S.home.defaults,
    draft: S.home.draft ?? (defaults.status === "fulfilled" ? initialDraft(defaults.value, recallDomain()) : null),
  };
  paint();
  scheduleEstimate();
}

/** The datasets a batch can run on (the built-in table and earlier uploads). */
async function loadInputs(): Promise<void> {
  try {
    S.ds = { ...S.ds, datasets: await fetchDatasets(), loadError: null };
  } catch (e) {
    S.ds = { ...S.ds, loadError: message(e, "Couldn't load the datasets.") };
  }
  paint();
}

/** A refusal (HTTP 422) carries the server's reason; say it without the status line. */
const refusal = (e: unknown, lead: string, fallback: string): string =>
  message(e, fallback).replace(/^The server answered HTTP 422: /, `${lead}: `);

let uploadSeq = 0;
const WRONG_FILE: Record<UploadKind, string> = {
  dataset: "Choose a CSV file for the dataset.",
  script: "Choose a Python file (.py) for the training script.",
  controller: "Choose a Python file (.py) for the controller.",
};
/** Upload a CSV (a dataset) or a .py file: the training script in the tabular domain, the robot controller in the
 *  robot one. `expected` is what the picker was opened for. */
async function upload(file: File, expected?: UploadKind): Promise<void> {
  if (S.ds.upload.state === "busy" || S.home.starting) return;
  const k = fileKind(file);
  const kind: UploadKind | null = "problem" in k ? null : k.kind === "script" && domainOf(S.home.draft) !== DEFAULT_DOMAIN ? "controller" : k.kind;
  const problem = expected === "controller" && !/\.py$/i.test(file.name) ? WRONG_FILE.controller
    : "problem" in k ? k.problem
    : expected && kind !== expected ? WRONG_FILE[expected]
    : null;
  if (problem !== null || kind === null) { S.ds = { ...S.ds, upload: { state: "error", message: problem ?? "" } }; paint(); return; }
  const ticket: UploadTicket = { seq: ++uploadSeq, selected: S.ds.selected };
  S.ds = { ...S.ds, upload: { state: "busy", kind } };
  S.home = { ...S.home, error: null };
  paint();
  try {
    // Wait first, then merge into the state as it is by then: the person may have changed it meanwhile.
    const done: Uploaded = kind === "dataset" ? { kind, info: await uploadDataset(file) }
      : kind === "controller" ? { kind, info: await uploadController(file) }
      : { kind, info: await uploadScript(file) };
    S.ds = withUpload(S.ds, ticket, uploadSeq, done);
    // The agents start from the controller just uploaded, unless a newer upload has replaced this one.
    if (done.kind === "controller" && ticket.seq === uploadSeq && S.home.draft) {
      S.home = { ...S.home, draft: { ...S.home.draft, robot_start: "uploaded", robot_controller: done.info.id } };
    }
  } catch (e) {
    if (ticket.seq !== uploadSeq) return;
    S.ds = { ...S.ds, upload: { state: "error", message: refusal(e, "That file can't be used", "The upload failed.") } };
  }
  paint();
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
  if (!draft || S.home.starting || S.ds.upload.state === "busy") return;
  S.home = { ...S.home, starting: true, error: null };
  paint();
  try {
    const { id } = await startBatch(startPayload(draft, inputsConfig(S.ds), S.home.defaults));
    S.home = { ...S.home, starting: false };
    go({ name: "batch", id });
  } catch (e) {
    S.home = { ...S.home, starting: false, error: refusal(e, "Couldn't start the batch", "Couldn't start the batch.") };
    paint();
  }
}

// ── the cost screen ──────────────────────────────────────────────────────────

let costsSeq = 0;
async function loadCosts(): Promise<void> {
  const seq = ++costsSeq;
  // A visit after the first keeps the last report on screen while the new one loads.
  if (S.costs.state !== "ready") { S.costs = { state: "loading" }; paint(); }
  try {
    const value = await fetchCosts();
    if (seq === costsSeq) S.costs = { state: "ready", value };
  } catch (e) {
    if (seq === costsSeq) S.costs = { state: "error", message: message(e, "Couldn't load the costs.") };
  }
  paint();
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

/** A saved batch at its split: ask the server to bring it back live and start the investigator, then follow it over
 *  a fresh websocket (the replay's one closed after its snapshot). */
async function resumeAndInvestigate(b: BatchState): Promise<void> {
  if (b.busy) return;
  b.busy = ACT.investigate;
  b.error = null;
  paint();
  try {
    await resumeBatch(b.id, true);
    if (S.batch !== b) return;
    stopClock();
    openBatch(b.id, true);
  } catch (e) {
    b.error = message(e, "Couldn't resume the batch.");
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
  if (key !== S.cvKey) { S.cv = initialConversationUi(); S.cvKey = key; S.workOpen = false; }
  // A new page starts at its top.
  const stepOf = (x: Route): string => (x.name === "batch" ? x.step ?? "wall" : "");
  if (prev.name !== r.name || routeKey(prev) !== routeKey(r) || stepOf(prev) !== stepOf(r)) smooth.top();
  if (r.name === "batch") S.lastStep = { id: r.id, step: r.step ?? "wall" };
  if (r.name === "landing") {
    closeBatch();
  } else if (r.name === "home") {
    closeBatch();
    void loadHome();
  } else if (r.name === "costs") {
    if (prev.name !== "costs") S.costsBack = prev;
    closeBatch();
    void loadCosts();
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
  // The landing page's section buttons: glide down to the section.
  const section = (e.target as Element | null)?.closest<HTMLElement>("[data-lp-go]")?.dataset.lpGo;
  if (section) {
    const to = scrollEl.querySelector<HTMLElement>(`[data-lp-at="${CSS.escape(section)}"]`);
    if (to) smooth.to(to, { offset: section === "intro" ? 0 : -24 });
    return;
  }
  // The white / black switch, in the header and on the landing page.
  const pick = (e.target as Element | null)?.closest<HTMLElement>("[data-theme-pick]")?.dataset.themePick;
  if (pick === "light" || pick === "dark") { pickTheme(pick); return; }
  const el = (e.target as Element | null)?.closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
  if (el.tagName === "A") return; // real links (charts, lab pages) open on their own
  const arg = el.dataset.arg ?? "";
  const r = S.route;
  const b = S.batch;
  switch (el.dataset.act) {
    case ACT.home: go({ name: "home" }); if (S.home.batches.state === "error") void loadHome(true); return;
    case ACT.openBatch: go({ name: "batch", id: arg }); return;
    case ACT.openCosts: go({ name: "costs" }); return;
    case ACT.start: void start(); return;
    case DI_ACT.dataset: S.ds = { ...S.ds, selected: arg, upload: uploadAfterEdit(S.ds.upload) }; S.home = { ...S.home, error: null }; paint(); return;
    case DI_ACT.upload: {
      const kind: UploadKind = arg === "script" || arg === "controller" ? arg : "dataset";
      void pickFile(kind).then((f) => { if (f) void upload(f, kind); });
      return;
    }
    case DI_ACT.scriptRemove: S.ds = { ...S.ds, script: null, upload: uploadAfterEdit(S.ds.upload) }; paint(); return;
    case DI_ACT.controllerRemove:
      S.ds = { ...S.ds, controller: null, upload: uploadAfterEdit(S.ds.upload) };
      if (S.home.draft) S.home = { ...S.home, draft: { ...S.home.draft, robot_start: "blank", robot_controller: null }, error: null };
      paint();
      return;
    case ACT.toggleAdvanced: S.home = { ...S.home, advanced: !S.home.advanced }; paint(); return;
    case BT_ACT.sort: S.home = { ...S.home, table: sortBy(S.home.table ?? DEFAULT_VIEW, arg) }; paint(); return;
    case BT_ACT.domain: S.home = { ...S.home, table: { ...(S.home.table ?? DEFAULT_VIEW), domain: arg || null } }; paint(); return;
    case HM_ACT.domain: {
      const next = pickDomain(S.home, arg);
      if (next !== S.home) { S.home = next; rememberDomain(arg); paint(); scheduleEstimate(); }
      return;
    }
    case HM_ACT.model:
      if (S.home.draft && !S.home.starting) { S.home = { ...S.home, draft: toggleModel(S.home.draft, arg), error: null }; paint(); scheduleEstimate(); }
      return;
    case ACT.runView: if (arg === "notebook" || arg === "steps") { S.runView = arg; paint(); } return;
    case ACT.workToggle: S.workOpen = !S.workOpen; paint(); return;
    case ACT.toggleFeed: S.feedOpen = !S.feedOpen; paint(); return;
    case ACT.resetConfig:
      if (S.home.defaults) { S.home = { ...S.home, draft: resetDraft(S.home), error: null }; paint(); scheduleEstimate(); }
      return;
    case ACT.openRun: if ("id" in r) go({ name: "run", id: r.id, run: arg }); return;
    case ACT.openChild: {
      const [fork, child] = arg.split("/");
      if ("id" in r && fork && child) go({ name: "child", id: r.id, fork, child });
      return;
    }
    case ACT.back: {
      // The batch's name in the header goes to its first page; a run's Back goes to the page it was opened from.
      if (r.name === "batch") go({ name: "batch", id: r.id });
      else if ("id" in r) {
        const step = S.lastStep?.id === r.id ? S.lastStep.step : "wall";
        go(step === "wall" ? { name: "batch", id: r.id } : { name: "batch", id: r.id, step });
      } else if (r.name === "costs") go(S.costsBack);
      return;
    }
    case ACT.goto: {
      // A step of the batch, or Back / Next: open its page.
      const step = BATCH_STEPS.find((k) => k === arg);
      if ("id" in r && step) go(step === "wall" ? { name: "batch", id: r.id } : { name: "batch", id: r.id, step });
      return;
    }
    case ACT.investigate:
      if (b && !b.live && b.resumable) void resumeAndInvestigate(b);
      else void liveAction("investigate", (id) => startInvestigation(id));
      return;
    case ACT.approve: void liveAction("approve", (id) => postDecision(id, true)); return;
    case ACT.decline: void liveAction("decline", (id) => postDecision(id, false)); return;
    case ACT.stop: void liveAction("stop", (id) => stopBatch(id)); return;
    case ACT.replayToggle: {
      const rp = b?.replay;
      if (!rp) return;
      if (rp.t >= rp.duration && b) rp.t = replayStart(b);
      rp.playing = !rp.playing;
      if (rp.playing) runClock(); else stopClock();
      paint();
      return;
    }
    case ACT.replaySpeed: { const rp = b?.replay; const n = Number(arg); if (rp && n > 0) { rp.speed = n; paint(); } return; }
    case ACT.replayRestart: { const rp = b?.replay; if (rp && b) { rp.t = replayStart(b); rp.playing = true; runClock(); paint(); } return; }
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
      smooth.to(scrollEl.scrollHeight);
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
  if (el.dataset?.change === "target") {
    if (e.type === "change") { S.ds = { ...S.ds, targets: { ...S.ds.targets, [S.ds.selected]: el.value } }; S.home = { ...S.home, error: null }; paint(); }
    return;
  }
  const field = el.dataset?.cfg;
  if (!field) return;
  const numeric = el instanceof HTMLInputElement && (el.type === "number" || el.type === "range");
  setDraft(field, el.value, numeric);
}
root.addEventListener("input", onField);
root.addEventListener("change", onField);

// Dropping a CSV or a .py file on the new batch panel's data rows (or the controller row) uploads it. Elsewhere a dropped file does nothing
// (not a page load).
const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");
const overDrop = (e: DragEvent): boolean => !!(e.target as Element | null)?.closest?.("[data-drop]");
function setDragging(on: boolean): void {
  if (S.ds.dragging !== on) { S.ds = { ...S.ds, dragging: on }; paint(); }
}
root.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  setDragging(overDrop(e));
});
root.addEventListener("dragleave", (e) => { if (!e.relatedTarget) setDragging(false); });
root.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const file = overDrop(e) ? e.dataTransfer?.files[0] : null;
  setDragging(false);
  if (file) void upload(file);
});

// The person scrolling the page themselves: a playing replay then stops following new sections for a few seconds.
// Only input counts (wheel, touch, scroll keys, a press on the scrollbar), not the `scroll` event, which the replay's
// own glide (followStory, through Lenis) fires too.
const userScrolled = (): void => follow.userScrolled(Date.now());
scrollEl.addEventListener("wheel", userScrolled, { passive: true });
scrollEl.addEventListener("touchmove", userScrolled, { passive: true });
scrollEl.addEventListener("pointerdown", (e) => {
  // The scrollbar is the part of the element right of (or below) its content box.
  if (e.target === scrollEl && (e.offsetX >= scrollEl.clientWidth || e.offsetY >= scrollEl.clientHeight)) userScrolled();
});
root.addEventListener("keydown", (e) => { if (isScrollKey(e.key, e.target as HTMLElement | null)) userScrolled(); });

// Scrolling in a run: scrolling up lets go of the bottom; the jump arrow shows once away from it.
let lastTop = 0;
scrollEl.addEventListener("scroll", () => {
  if (!routeKey(S.route)) return;
  S.cv.stick = stickAfterScroll(S.cv.stick, lastTop, { top: scrollEl.scrollTop, height: scrollEl.scrollHeight, client: scrollEl.clientHeight });
  lastTop = scrollEl.scrollTop;
  const away = !S.cv.stick && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > AWAY_PX;
  if (S.cv.away !== away) { S.cv.away = away; paint(); }
}, { passive: true });

// A live batch's notebooks type between server messages.
setInterval(() => { if (S.batch?.live && "id" in S.route) paint(); }, 150);
// The cost screen follows a batch that is still running.
setInterval(() => { if (S.route.name === "costs" && S.costs.state === "ready" && S.costs.value.batches.some((b) => b.kind === "live")) void loadCosts(); }, 5000);

// The hub badge: whether this server reaches the team hub and its batches get there. Checked now and every 30s.
async function refreshHub(): Promise<void> {
  try {
    const h = await fetchHealth();
    S.hub = h.hub ?? { state: "off" };
  } catch {
    S.hub = { state: "unreachable", error: "this server did not answer" };
  }
  paint();
}
void refreshHub();
setInterval(() => { void refreshHub(); }, 30_000);

onRoute();
