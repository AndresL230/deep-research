// The app: one canvas whose state follows the batch (docs/api-contract.md, web/src/batch/model.ts).
//
//   #/                         the landing page: a nav and a hero over a 3D scene of the pipeline (landing/)
//   #/start                    home: what needs a person (Needs you), then the saved and live batches
//   #/batches                  the same page, opened at the batch table
//   #/b/<id>                   a batch, first page: the overview and the wall of runs
//   #/b/<id>/<step>            a batch's later pages, one per stage: changed, investigator, fork, verdict,
//                              diagnosis, fix (model.ts BATCH_STEPS)
//   #/b/<id>/run/<run>         one run in the Ask conversation view
//   #/b/<id>/fork/<f>/<child>  one fork child in the conversation view
//   #/costs                    what every batch cost, in total and one by one
//
// Every page but the landing page has the same top bar (batch/nav.ts): the links to Needs you (with how many batches
// wait on the person), Batches and Costs, and "+ New batch", which opens the New batch form in a dialog from any page
// (batch/new-batch-dialog.ts). The batch list behind the count and the home screen is loaded once and kept fresh by
// one poller, on whichever app page is open.
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
  fetchMorePairs, fetchRunEvents, isPendingForks, openBatchSocket, postDecision, postEstimate, resumeBatch, startBatch, startMorePairs, uploadController, uploadDataset, uploadScript, startInvestigation, stopBatch,
  type AgentEvent, type HubStatus, type BatchConfig, type BatchListItem, type BatchSocket, type CaseFile,
} from "./api";
import { ACT, BATCH_STEPS, STEP_LABEL, childKey, parseRoute, routeHash, type BatchStep, type BatchVm, type EventKey, type HomeVm, type LogView, type ReplayState, type Route } from "./batch/model";
import { DEFAULT_DOMAIN, HM_ACT, NEW_BATCH_TITLE, costBar, domainOf, homeView, initialDraft, newBatchView, pickDomain, recallDomain, rememberDomain, resetDraft, startPayload, toggleModel, type HomeInputs } from "./batch/home";
import { BT_ACT, DEFAULT_VIEW, sortBy } from "./batch/batch-table";
import { NY_ACT, moreFailedUi, needKey, needsCount, pruneNeeds, quoteUi, type NeedKind, type NeedUi } from "./batch/needs-you";
import { navBar, navMenu, newBatchButton, refreshDue } from "./batch/nav";
import { newBatchDialog } from "./batch/new-batch-dialog";
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
import { costsView } from "./batch/costs";
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
  /** The batch list, the "Needs you" rows' states and the New batch form's draft (model.ts HomeVm). Kept for the whole
   *  session and loaded on any app page: the header's count, the home screen and the dialog all read it. */
  home: HomeVm;
  /** The first load of `home` (the list, the health and the defaults) has started. */
  appLoaded: boolean;
  /** The header's menu of links is unfolded (narrow screens). */
  navOpen: boolean;
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
  appLoaded: false,
  navOpen: false,
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
  <dialog class="nbd-dlg" aria-labelledby="${NEW_BATCH_TITLE}"><div class="nbd-frame" data-region="new-batch"></div></dialog>
</div>`;
const root = app.firstElementChild as HTMLElement;
const headerEl = root.querySelector<HTMLElement>("[data-region=header]")!;
const subEl = root.querySelector<HTMLElement>("[data-region=sub]")!;
const scrollEl = root.querySelector<HTMLElement>("[data-region=scroll]")!;
// The New batch dialog: the <dialog> is never patched, only the frame inside it (new-batch-dialog.ts).
const dialogEl = root.querySelector<HTMLDialogElement>("dialog.nbd-dlg")!;
const newBatchEl = root.querySelector<HTMLElement>("[data-region=new-batch]")!;
// The page scrolls smoothly (scroll.ts, Lenis); the jumps the app makes itself go through it too.
const smooth = smoothScroll(scrollEl);
const newBatch = newBatchDialog(dialogEl, {
  fill: () => morphInner(newBatchEl, newBatchView(S.home, formInputs())),
  lock: (on) => {
    if (on) root.dataset.modal = "open";
    else delete root.dataset.modal;
    smooth.lock(on);
  },
  closed: () => { if (S.ds.dragging) S.ds = { ...S.ds, dragging: false }; paint(); },
  fallback: () => headerEl.querySelector<HTMLElement>("[data-act=new-batch]"),
});

/** What the form runs on, drawn by dataset-input.ts. */
function formInputs(): HomeInputs {
  return {
    html: inputsView(S.ds, S.home.starting), label: inputsLabel(S.ds),
    controllerHtml: controllerRow(S.ds, S.home.starting), controller: S.ds.controller,
  };
}

/** "+ New batch": the dialog, from any app page. The data behind the form loads with the app; the first open of a
 *  session that has not loaded it yet starts it. */
function openNewBatch(opener: HTMLElement | null): void {
  if (S.route.name === "landing") return;
  S.navOpen = false;
  void loadApp();
  newBatch.open(opener);
  paint();
}
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
  if (r.name === "run") crumbs.push(`<span class="pg-crumb is-cur">${esc(r.run)}</span>`);
  if (r.name === "child") crumbs.push(`<span class="pg-crumb is-cur">${esc(`${r.fork} ${r.child}`)}</span>`);
  const count = needsCount(S.home.batches);
  // The logo, the links (nav.ts), then on a batch's pages its breadcrumb: the batch and the page in it.
  const left = `<div class="ask-hdr-l pg-hdr-l">
    <button type="button" class="pg-home" data-act="${ACT.home}" aria-label="Orro, home">${symbolTile(22)}<span class="ask-h1 ask-h1-t">${wordmark(16)}</span></button>
    ${navBar(r, count)}
    ${crumbs.length ? `<nav class="pg-crumbs" aria-label="Breadcrumb" data-morph-key="crumbs">${crumbs.join(`<span class="ask-crumb-sep" aria-hidden="true">›</span>`)}</nav>` : ""}
  </div>`;
  const bar = vm ? costBar(vm.case.costs ?? {}, { simulated: !!(vm.case.config as BatchConfig).simulated }) : "";
  const right = `<div class="pg-hdr-r">${bar}${hubBadge(S.hub)}${themeSwitch(theme())}${newBatchButton(newBatch.isOpen)}${navMenu(r, count, S.navOpen, [["Theme", themeSwitch(theme())], ["Team hub", hubBadge(S.hub)]])}</div>`;
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

  // The form in the dialog, while it is open: patched like the page, so a field keeps its focus and its caret.
  if (newBatch.isOpen) morphInner(newBatchEl, newBatchView(S.home, formInputs()));

  let body: string;
  if (landing) body = landingView(landingTone);
  else if (r.name === "home") body = homeView(S.home);
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

/** Where the home screen goes once it is drawn, after a link in the header: its batch table (`#/batches`) or its top
 *  (`#/start`). `glide` when the person was on the home screen already, else a jump. */
let homeScroll: { to: "batches" | "top"; glide: boolean } | null = null;

function scrollHome(): void {
  const h = homeScroll;
  if (!h || S.route.name !== "home") { homeScroll = null; return; }
  const immediate = !h.glide || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (h.to === "top") {
    smooth.to(0, { immediate });
    homeScroll = null;
    return;
  }
  // Wait for the list: Needs you, above the table, only shows once it has loaded, and pushes the table down.
  const table = scrollEl.querySelector<HTMLElement>('.hm [data-morph-key="batches"]');
  if (!table || S.home.batches.state === "loading") return;
  smooth.to(table, { offset: -20, immediate });
  homeScroll = null;
}

let ticker: ReturnType<typeof setInterval> | null = null;
/** An element to focus once the next paint is in (a row's Start once its confirm opens, say), as a selector. */
let focusNext: string | null = null;
function afterPaint(): void {
  if (focusNext) {
    scrollEl.querySelector<HTMLElement>(focusNext)?.focus({ preventScroll: true });
    focusNext = null;
  }
  scrollHome();
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

// ── the app's data: the batch list and the New batch form ───────────────────

/**
 * The first load, on whichever app page opens first: the batch list (the header's count, the home screen), the health
 * and the defaults (the New batch form, which opens from any page). After that only the list is fetched again, by
 * `refreshBatches`: on a visit to the home screen, after an action on a batch, and every 10 s (5 s while one runs).
 * `force` loads it all again (the home screen's Retry).
 */
async function loadApp(force = false): Promise<void> {
  if (S.appLoaded && !force) return;
  S.appLoaded = true;
  batchesAt = Date.now();
  S.home = { ...S.home, batches: { state: "loading" } };
  paint();
  void loadInputs();
  const seq = ++batchesSeq;
  const [batches, health, defaults] = await Promise.allSettled([fetchBatches(), fetchHealth(), fetchDefaults()]);
  // A refresh that started later has the newer list.
  const fresh = seq === batchesSeq;
  S.home = {
    ...S.home,
    batches: !fresh ? S.home.batches
      : batches.status === "fulfilled" ? { state: "ready", value: batches.value } : { state: "error", message: message(batches.reason, "Couldn't load the batches.") },
    needs: fresh && batches.status === "fulfilled" ? pruneNeeds(S.home.needs, batches.value) : S.home.needs,
    health: health.status === "fulfilled" ? health.value : null,
    defaults: defaults.status === "fulfilled" ? defaults.value : S.home.defaults,
    draft: S.home.draft ?? (defaults.status === "fulfilled" ? initialDraft(defaults.value, recallDomain()) : null),
  };
  paint();
  scheduleEstimate();
}

/** When the batch list was last asked for, and which request is the latest: an answer to an older one is dropped. */
let batchesAt = 0;
let batchesSeq = 0;

/** The batch list again (it is cheap and changes), and the "Needs you" rows' states that still apply. The one loader
 *  of the list after the first load: the poller below, the home screen and the rows' actions all call this. A failed
 *  refresh keeps the list there was. */
async function refreshBatches(): Promise<void> {
  if (!S.appLoaded) { void loadApp(); return; }
  batchesAt = Date.now();
  const seq = ++batchesSeq;
  let items: BatchListItem[];
  try {
    items = await fetchBatches();
  } catch (e) {
    if (seq === batchesSeq && S.home.batches.state === "loading") {
      S.home = { ...S.home, batches: { state: "error", message: message(e, "Couldn't load the batches.") } };
      paint();
    }
    return;
  }
  if (seq !== batchesSeq) return;
  S.home = { ...S.home, batches: { state: "ready", value: items }, needs: pruneNeeds(S.home.needs, items) };
  paint();
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
    // The dialog closes and the new batch opens, from whichever page the dialog was opened on.
    newBatch.close();
    go({ name: "batch", id });
    void refreshBatches();
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

// ── "Needs you" (batch/needs-you.ts) ─────────────────────────────────────────

const needUi = (kind: NeedKind, id: string): NeedUi | undefined => S.home.needs?.[needKey(kind, id)];

function setNeed(kind: NeedKind, id: string, ui: NeedUi | null): void {
  const needs = { ...(S.home.needs ?? {}) };
  if (ui) needs[needKey(kind, id)] = ui;
  else delete needs[needKey(kind, id)];
  S.home = { ...S.home, needs };
  paint();
}

/** A row's call is in flight: a second press waits for it. */
const inFlight = (ui: NeedUi | undefined): boolean => ui?.state === "busy" || (ui?.state === "confirm" && !!ui.starting);

/** Open a batch from its row once the call that wakes it is in, if the person is still on the home screen. A batch
 *  that went live opens on a fresh websocket: home closed the one of any batch open before (`closeBatch`). */
function openFromHome(id: string): void {
  if (S.route.name === "home") go({ name: "batch", id });
}

/** Approve or decline the fork waiting on a live batch, as its page does. */
async function needDecide(id: string, approve: boolean): Promise<void> {
  if (inFlight(needUi("approve", id))) return;
  setNeed("approve", id, { state: "busy", action: approve ? "approve" : "decline" });
  try {
    await postDecision(id, approve);
    setNeed("approve", id, { state: "done", message: approve ? "Approved. The fork is starting." : "Declined. The investigator goes on without it." });
    void refreshBatches();
  } catch (e) {
    setNeed("approve", id, { state: "error", message: message(e, "Couldn't send the decision.") });
  }
}

/** Bring a saved batch back live with its investigator started, as its page's Investigate does, then open it. */
async function needInvestigate(id: string): Promise<void> {
  if (inFlight(needUi("investigate", id))) return;
  setNeed("investigate", id, { state: "busy", action: "investigate" });
  try {
    await resumeBatch(id, true);
    setNeed("investigate", id, null);
    openFromHome(id);
  } catch (e) {
    setNeed("investigate", id, { state: "error", message: message(e, "Couldn't resume the batch.") });
  }
}

/** "Run 4 more": what the pairs would run and cost (nothing starts), as the row's confirm. */
async function needQuote(id: string): Promise<void> {
  if (inFlight(needUi("open", id))) return;
  setNeed("open", id, { state: "busy", action: "quote" });
  try {
    const ui = quoteUi(await fetchMorePairs(id));
    focusNext = `.ny-row[data-morph-key="${CSS.escape(id)}"] [data-ny-focus]`;
    setNeed("open", id, ui);
  } catch (e) {
    setNeed("open", id, moreFailedUi(e));
  }
}

/** The confirm's Start: run the quoted pairs, then open the batch to follow them live. */
async function needStartMore(id: string): Promise<void> {
  const ui = needUi("open", id);
  if (ui?.state !== "confirm" || ui.starting) return;
  setNeed("open", id, { ...ui, starting: true });
  try {
    await startMorePairs(id, ui.quote.n_per_arm);
    setNeed("open", id, null);
    openFromHome(id);
  } catch (e) {
    setNeed("open", id, moreFailedUi(e));
  }
}

function needCancel(id: string): void {
  if (inFlight(needUi("open", id))) return;
  focusNext = `.ny-row[data-morph-key="${CSS.escape(id)}"] [data-act="${NY_ACT.more}"]`;
  setNeed("open", id, null);
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
  S.navOpen = false;
  // Every app page has the header's count and the New batch dialog: their data loads on whichever comes first.
  if (r.name !== "landing") void loadApp();
  if (r.name === "landing") {
    closeBatch();
    newBatch.close();
  } else if (r.name === "home") {
    closeBatch();
    // The batch list is cheap and changes: fetched again on every visit (the first visit's load fetched it already).
    if (routed) void refreshBatches();
    // The header's Batches link opens the page at the table; Needs you at its top. From elsewhere it is a jump.
    const was = routed && prev.name === "home";
    if (r.at === "batches") homeScroll = { to: "batches", glide: was };
    else if (was && prev.name === "home" && prev.at === "batches") homeScroll = { to: "top", glide: true };
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
  routed = true;
  paint();
}
/** The first route has been taken (the page's own load is not a move from one page to another). */
let routed = false;

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
  const target = e.target as Element | null;
  // A press anywhere but the header's menu folds it.
  if (S.navOpen && !target?.closest?.(".nv-menu")) { S.navOpen = false; paint(); }
  // The header's links are real links (the hash routes them). One to the page already open goes to its place again
  // (the top, or the batch table) instead of doing nothing.
  const nav = target?.closest<HTMLAnchorElement>("a[data-nav]");
  if (nav) {
    S.navOpen = false;
    if (nav.hash === location.hash && S.route.name === "home") {
      e.preventDefault();
      homeScroll = { to: S.route.at === "batches" ? "batches" : "top", glide: true };
      paint();
    }
    return;
  }
  // The white / black switch, in the header and on the landing page.
  const pick = target?.closest<HTMLElement>("[data-theme-pick]")?.dataset.themePick;
  if (pick === "light" || pick === "dark") { pickTheme(pick); return; }
  const el = target?.closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
  if (el.tagName === "A") return; // real links (charts, lab pages) open on their own
  const arg = el.dataset.arg ?? "";
  const r = S.route;
  const b = S.batch;
  switch (el.dataset.act) {
    case ACT.home: go({ name: "home" }); if (S.home.batches.state === "error") void loadApp(true); return;
    case ACT.openBatch: go({ name: "batch", id: arg }); return;
    case ACT.openCosts: go({ name: "costs" }); return;
    case ACT.newBatch: openNewBatch(el); return;
    case ACT.closeNewBatch: newBatch.close(); return;
    case ACT.navMenu: S.navOpen = !S.navOpen; paint(); return;
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
    case NY_ACT.approve: void needDecide(arg, true); return;
    case NY_ACT.decline: void needDecide(arg, false); return;
    case NY_ACT.investigate: void needInvestigate(arg); return;
    case NY_ACT.more: void needQuote(arg); return;
    case NY_ACT.start: void needStartMore(arg); return;
    case NY_ACT.cancel: needCancel(arg); return;
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

// Keyboard: Esc folds the header's menu (the dialog closes on Esc by itself), back onto its button.
root.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !S.navOpen || newBatch.isOpen) return;
  S.navOpen = false;
  paint();
  headerEl.querySelector<HTMLElement>("[data-act=nav-menu]")?.focus();
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

// Dropping a CSV or a .py file on the New batch form's data rows (or the controller row) uploads it. Elsewhere a dropped file does nothing
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
// The batch list stays fresh on every app page, so the header's count is right and the home screen's rows move on:
// every 10 s, every 5 s while a batch runs (nav.ts `refreshDue`). One poller for every page, never two; not while the
// tab is hidden, nor on the landing page.
setInterval(() => {
  if (S.route.name === "landing" || !S.appLoaded || document.hidden) return;
  const b = S.home.batches;
  if (b.state === "loading") return;
  const live = b.state === "ready" && b.value.some((x) => x.kind === "live");
  if (refreshDue(Date.now(), batchesAt, live)) void refreshBatches();
}, 1000);
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
