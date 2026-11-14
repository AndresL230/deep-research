// The app's top bar (src/batch/nav.ts), its count of what needs the person (needs-you.ts `needsCount`), the routes its
// links go to (model.ts), and the New batch dialog (src/batch/new-batch-dialog.ts with home.ts `newBatchView`).

import { describe, expect, it } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import type { BatchConfig, BatchListItem, BatchSummary, CaseFile, DatasetInfo, ScriptInfo } from "../src/api";
import { initialDatasetUi, inputsLabel, inputsView, type DatasetUi } from "../src/dataset-input";
import { homeView, newBatchView, type HomeInputs } from "../src/batch/home";
import { ACT, parseRoute, routeHash, type HomeVm, type Loadable, type Route } from "../src/batch/model";
import { NAV_LINKS, countLabel, navBar, navCurrent, navLinks, navMenu, newBatchButton, refreshDue, refreshEvery } from "../src/batch/nav";
import { needsCount } from "../src/batch/needs-you";
import { newBatchDialog, type DialogEl, type Focusable } from "../src/batch/new-batch-dialog";

/** The markup's visible text: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const linkOf = (html: string, key: string): string => html.match(new RegExp(`<a [^>]*data-nav="${key}"[^>]*>.*?</a>`, "s"))![0];
const currentOf = (html: string): string[] => [...html.matchAll(/<a [^>]*data-nav="(\w+)"[^>]*aria-current="page"/g)].map((m) => m[1]);

const ROUTES: [Route, string | null][] = [
  [{ name: "home" }, "needs"],
  [{ name: "home", at: "batches" }, "batches"],
  [{ name: "costs" }, "costs"],
  [{ name: "batch", id: "b1" }, null],
  [{ name: "batch", id: "b1", step: "verdict" }, null],
  [{ name: "run", id: "b1", run: "r02" }, null],
  [{ name: "child", id: "b1", fork: "f1", child: "control-1" }, null],
];

describe("the nav links", () => {
  it("lists Needs you, Batches and Costs as real links, in that order", () => {
    const html = navBar({ name: "home" }, null);
    expect(html).toMatch(/^<nav class="nv" aria-label="Main"/);
    expect(text(html)).toBe("Needs you Batches Costs");
    expect(NAV_LINKS.map((l) => l.href)).toEqual(["#/start", "#/batches", "#/costs"]);
    for (const l of NAV_LINKS) expect(linkOf(html, l.key)).toContain(`href="${l.href}"`);
  });

  it("marks the page on screen, and only it, with aria-current", () => {
    for (const [r, cur] of ROUTES) {
      expect(navCurrent(r)).toBe(cur);
      for (const html of [navBar(r, 3), navLinks(r, 3, "menu"), navMenu(r, 3, true)]) {
        expect(currentOf(html)).toEqual(cur ? [cur] : []);
        expect(html.match(/aria-current/g)?.length ?? 0).toBe(cur ? 1 : 0);
      }
    }
  });

  it("each link's address opens the page it marks, and the old #/start still works", () => {
    for (const l of NAV_LINKS) expect(navCurrent(parseRoute(l.href))).toBe(l.key);
    expect(parseRoute("#/start")).toEqual({ name: "home" });
    expect(parseRoute("#/batches")).toEqual({ name: "home", at: "batches" });
    expect(routeHash({ name: "home" })).toBe("#/start");
    expect(routeHash({ name: "home", at: "batches" })).toBe("#/batches");
    expect(parseRoute("#/b/batches")).toEqual({ name: "batch", id: "batches" });
    // Both addresses are the same page: the home screen, Needs you then the batches.
    expect(parseRoute("#/batches").name).toBe("home");
  });

  it("shows the count of what needs the person on Needs you, and nothing for none", () => {
    const three = linkOf(navBar({ name: "costs" }, 3), "needs");
    expect(three).toContain('<span class="nv-n" aria-hidden="true">3</span>');
    expect(three).toContain('<span class="nv-sr">, 3 waiting</span>');
    for (const n of [0, null]) {
      const html = navBar({ name: "costs" }, n);
      expect(html).not.toContain("nv-n");
      expect(html).not.toContain("waiting");
    }
    expect(countLabel(120)).toBe("99+");
    expect(countLabel(7)).toBe("7");
    expect(countLabel(0)).toBe("");
    // The other links never carry it.
    expect(linkOf(navBar({ name: "home" }, 3), "batches")).not.toContain("nv-n");
  });
});

describe("the menu on narrow screens", () => {
  it("is a disclosure: a button that says whether it is open, and the panel it controls", () => {
    const shut = navMenu({ name: "home" }, null, false);
    expect(shut).toMatch(new RegExp(`<button type="button" class="nv-menu-b" data-act="${ACT.navMenu}" aria-expanded="false" aria-controls="nv-panel"`));
    expect(shut).toMatch(/<div class="nv-panel" id="nv-panel" hidden>/);
    expect(text(shut)).toContain("Menu");
    const open = navMenu({ name: "home" }, null, true, [["Theme", "<i>SWITCH</i>"], ["Team hub", "<b>HUB</b>"]]);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toMatch(/<div class="nv-panel" id="nv-panel">/);
    expect(text(open)).toBe("Menu Needs you Batches Costs Theme SWITCH Team hub HUB");
    expect(open).toContain('<div class="nv-row"><span>Theme</span><i>SWITCH</i></div>');
    expect(navMenu({ name: "home" }, null, true)).not.toContain("nv-panel-x");
  });

  it("puts a dot on the folded button while something waits, and says it", () => {
    const waiting = navMenu({ name: "batch", id: "b1" }, 2, false);
    expect(waiting).toContain("nv-dot");
    expect(text(waiting)).toContain("Menu, 2 waiting");
    expect(navMenu({ name: "batch", id: "b1" }, 0, false)).not.toContain("nv-dot");
    expect(navMenu({ name: "batch", id: "b1" }, 2, true)).not.toContain("nv-dot");
  });
});

describe("+ New batch", () => {
  it("opens the dialog, and says so while it is open", () => {
    const shut = newBatchButton(false);
    expect(shut).toContain(`data-act="${ACT.newBatch}"`);
    expect(shut).toContain('aria-haspopup="dialog" aria-expanded="false" aria-label="New batch"');
    expect(text(shut)).toBe("New batch");
    // A phone hides " batch" (nav.css), leaving "+ New": the visible words stay inside the button's name.
    expect(shut).toContain('<span class="nv-new-x"> batch</span>');
    expect(newBatchButton(true)).toContain('aria-expanded="true"');
  });
});

// ── the count ────────────────────────────────────────────────────────────────

const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  domain: { name: "tabular", title: "Tabular data science" },
  started_at: "2026-11-14T03:25:54",
  phase: "done",
  simulated: false,
  analyst_models: ["anthropic:claude-haiku-5-5"],
  investigator_model: "anthropic:claude-sonnet-5-5",
  n_runs: 12,
  counts: { honest: 6, inflated: 6, unclear: 0, failed: 0, running: 0, queued: 0, stopped: 0 },
  claim: null,
  step: { label: "deduplicate", name: "removing duplicate rows" },
  verdict: { state: "none" },
  pending: null,
  fork_progress: null,
  spend: { usd: 0.5, usd_partial: false, tokens: 1000 },
  ...over,
});
const APPROVE: BatchListItem = { id: "a", kind: "live", summary: summary({ phase: "awaiting_approval", verdict: { state: "awaiting_approval" } }) };
const READY: BatchListItem = { id: "r", kind: "replay", resumable: true, summary: summary({ phase: "ready" }) };
const OPEN: BatchListItem = { id: "o", kind: "replay", summary: summary({ verdict: { state: "open", pairs: 4, needed_pairs: 8 } }) };
const RUNNING: BatchListItem = { id: "l", kind: "live", summary: summary({ phase: "running", counts: { honest: 1, inflated: 0, unclear: 0, failed: 0, running: 3, queued: 0, stopped: 0 } }) };
const DONE: BatchListItem = { id: "d", kind: "replay", summary: summary({ verdict: { state: "supported", pairs: 9, needed_pairs: 8 } }) };
const ready = (items: BatchListItem[]): Loadable<BatchListItem[]> => ({ state: "ready", value: items });

describe("the count of what needs the person", () => {
  it("counts the batches waiting on an action: approvals, ready to investigate, open verdicts", () => {
    expect(needsCount(ready([APPROVE, READY, OPEN, DONE]))).toBe(3);
    expect(needsCount(ready([DONE]))).toBe(0);
    expect(needsCount(ready([]))).toBe(0);
  });

  it("leaves out running batches (they only offer Open), and what this server cannot act on", () => {
    expect(needsCount(ready([RUNNING]))).toBe(0);
    expect(needsCount(ready([APPROVE, RUNNING]))).toBe(1);
    const remote = { ...OPEN, id: "x", remote: true };
    const fixture = { ...READY, id: "y", fixture: true };
    const simulated = { ...OPEN, id: "z", summary: summary({ simulated: true, verdict: { state: "open", pairs: 4, needed_pairs: 8 } }) };
    expect(needsCount(ready([remote, fixture, simulated]))).toBe(0);
  });

  it("says nothing until the list has loaded", () => {
    expect(needsCount({ state: "loading" })).toBeNull();
    expect(needsCount({ state: "error", message: "down" })).toBeNull();
  });

  it("is what the bar shows", () => {
    const n = needsCount(ready([APPROVE, READY, OPEN, RUNNING, DONE]));
    expect(text(linkOf(navBar({ name: "batch", id: "b1" }, n), "needs"))).toBe("Needs you 3 , 3 waiting");
  });
});

describe("refreshing the list", () => {
  it("is due every 10 s, every 5 s while a batch runs", () => {
    expect(refreshEvery(false)).toBe(10_000);
    expect(refreshEvery(true)).toBe(5_000);
    expect(refreshDue(20_000, 11_000, false)).toBe(false);
    expect(refreshDue(21_000, 11_000, false)).toBe(true);
    expect(refreshDue(15_999, 11_000, true)).toBe(false);
    expect(refreshDue(16_000, 11_000, true)).toBe(true);
    // Never fetched (last = 0): due at once on a real clock.
    expect(refreshDue(Date.now(), 0, false)).toBe(true);
    expect(refreshDue(Date.now(), 0, true)).toBe(true);
  });
});

// ── the dialog ───────────────────────────────────────────────────────────────

/** A stand-in for the <dialog> element: what showModal and close do to `open`, and the events the page sends. */
class FakeDialog extends EventTarget implements DialogEl {
  open = false;
  shown = 0;
  showModal(): void {
    if (this.open) throw new Error("already open");
    this.open = true;
    this.shown++;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
  getBoundingClientRect() { return { left: 100, top: 50, right: 900, bottom: 750 }; }
  /** A press at (x, y) whose target is the dialog itself (the backdrop, or its own border). */
  press(type: "pointerdown" | "click", x?: number, y?: number): void {
    const e = new Event(type) as Event & { clientX?: number; clientY?: number };
    if (x != null) Object.assign(e, { clientX: x, clientY: y });
    this.dispatchEvent(e);
  }
}

class FakeButton implements Focusable {
  focused = 0;
  isConnected = true;
  focus(): void { this.focused++; }
}

const cfg = { ...((JSON.parse(caseRaw) as CaseFile).config as BatchConfig), mode: "live" } as BatchConfig;
const homeVm = (over: Partial<HomeVm> = {}): HomeVm => ({
  batches: { state: "ready", value: [] },
  health: { ok: true, keys: { anthropic: true, daytona: true } },
  defaults: { config: cfg, prices_missing: false },
  draft: cfg,
  estimate: null,
  starting: false,
  error: null,
  ...over,
});

function setup() {
  const el = new FakeDialog();
  const log: string[] = [];
  const fallback = new FakeButton();
  const dlg = newBatchDialog(el, {
    fill: () => log.push("fill"),
    lock: (on) => log.push(on ? "lock" : "unlock"),
    closed: () => log.push("closed"),
    fallback: () => fallback,
  });
  return { el, log, dlg, fallback };
}

describe("the New batch dialog", () => {
  it("fills the form before it shows, as a modal, and locks the page's scrolling", () => {
    const { el, log, dlg } = setup();
    expect(dlg.isOpen).toBe(false);
    dlg.open(new FakeButton());
    expect(el.open).toBe(true);
    expect(dlg.isOpen).toBe(true);
    expect(log).toEqual(["fill", "lock"]);
    // Pressed again while open: nothing more.
    dlg.open(new FakeButton());
    expect(el.shown).toBe(1);
    expect(log).toEqual(["fill", "lock"]);
  });

  it("closes from its X (close), unlocks, and gives focus back to the button that opened it", () => {
    const { el, log, dlg, fallback } = setup();
    const opener = new FakeButton();
    dlg.open(opener);
    dlg.close();
    expect(el.open).toBe(false);
    expect(log).toEqual(["fill", "lock", "unlock", "closed"]);
    expect(opener.focused).toBe(1);
    expect(fallback.focused).toBe(0);
    // Closing what is closed does nothing.
    dlg.close();
    expect(log).toHaveLength(4);
  });

  it("closes on Esc: the browser closes the dialog itself, and the same clean up runs", () => {
    const { el, log, dlg } = setup();
    const opener = new FakeButton();
    dlg.open(opener);
    el.close(); // what Esc does to a modal <dialog>
    expect(dlg.isOpen).toBe(false);
    expect(log.slice(-2)).toEqual(["unlock", "closed"]);
    expect(opener.focused).toBe(1);
  });

  it("closes on a press on the backdrop, not on one inside it or a drag that ends outside", () => {
    const { el, dlg } = setup();
    dlg.open(new FakeButton());
    // Inside the box (its border): stays open.
    el.press("pointerdown", 500, 400);
    el.press("click", 500, 400);
    expect(el.open).toBe(true);
    // A drag from a slider inside (the press lands on a child, not here) that ends on the backdrop: stays open.
    el.press("click", 20, 20);
    expect(el.open).toBe(true);
    // Down and up on the backdrop: closes.
    el.press("pointerdown", 20, 20);
    el.press("click", 20, 20);
    expect(el.open).toBe(false);
  });

  it("gives focus to the header's button when the one that opened it is gone", () => {
    const { dlg, fallback } = setup();
    const gone = new FakeButton();
    dlg.open(gone);
    gone.isConnected = false;
    dlg.close();
    expect(gone.focused).toBe(0);
    expect(fallback.focused).toBe(1);
  });

  it("keeps the draft, the domain and the uploads from one opening to the next", () => {
    // The state main.ts keeps for the session: an edited robot draft, and a dataset and script uploaded earlier.
    const mine: DatasetInfo = { id: "ds-0123abcd", name: "mine.csv", builtin: false, rows: 1200, columns: [{ name: "label", kind: "number", n_unique: 2, missing: 0, target_problem: null }], target: "label" };
    const script: ScriptInfo = { id: "sc-0123abcd", name: "train.py", lines: 120, imports: ["pandas"], missing_packages: [] };
    let home = homeVm({ draft: { ...cfg, n_runs: 6, budget_usd: 4, hint_level: "light" }, advanced: true, error: "Couldn't start the batch: over budget" });
    const ds: DatasetUi = { ...initialDatasetUi(), datasets: [mine], selected: mine.id, script };
    const inputs = (): HomeInputs => ({ html: inputsView(ds), label: inputsLabel(ds) });

    const el = new FakeDialog();
    const shown: string[] = [];
    const dlg = newBatchDialog(el, { fill: () => shown.push(newBatchView(home, inputs())), lock: () => {}, closed: () => {}, fallback: () => null });
    dlg.open();
    dlg.close();
    dlg.open();
    expect(shown).toHaveLength(2);
    expect(shown[1]).toBe(shown[0]);
    const form = shown[1];
    expect(form).toMatch(/value="6" data-cfg="n_runs"/);
    expect(form).toMatch(/value="4" data-cfg="budget_usd"/);
    expect(form).toContain('value="light" checked');
    expect(form).toContain("mine.csv, predicting label");
    expect(form).toContain("train.py");
    expect(form).toContain('aria-expanded="true"');
    // A Start error shows in the dialog, by Start.
    expect(form).toContain("Couldn&#39;t start the batch: over budget</p>");
    expect(form.indexOf("over budget</p>")).toBeGreaterThan(form.indexOf(`data-act="${ACT.start}"`));

    // A change made while it is open is in the next opening too.
    home = { ...home, draft: { ...home.draft!, n_runs: 9 } };
    dlg.close();
    dlg.open();
    expect(shown[2]).toMatch(/value="9" data-cfg="n_runs"/);
    expect(shown[2]).toContain("mine.csv, predicting label");
  });

  it("is not on the home screen any more", () => {
    const html = homeView(homeVm({ advanced: true }));
    expect(html).not.toContain("New batch");
    expect(html).not.toContain("data-cfg=");
    expect(html).not.toContain(`data-act="${ACT.start}"`);
  });
});
