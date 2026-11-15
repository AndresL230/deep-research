// Who may start and change batches (src/access.ts), and what each kind of visitor is shown: on the hosted site reading
// is public and only admins act; in local development (no gateway) everything is allowed.

import { describe, expect, it, vi } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import { ADMIN_ONLY, canAct, loadAccess, roleOf, type Access, type Me } from "../src/access";
import { accountLine } from "../src/account";
import { signInOnRefusal, type BatchListItem, type BatchSummary, type CaseFile } from "../src/api";
import { homeView } from "../src/batch/home";
import { forkView, investigatorView } from "../src/batch/lanes";
import { ACT, type BatchVm, type HomeVm } from "../src/batch/model";
import { navBar, navMenu } from "../src/batch/nav";
import { NY_ACT, needsView } from "../src/batch/needs-you";
import { BROWSE_CTA, START_CTA, landingView } from "../src/landing/landing";

const ME_ADMIN: Me = { signed_in: true, email: "a@x.org", plan_name: "Admin", limits: { unlimited: true, is_admin: true, can_run: true } };
const ME_PRO: Me = { signed_in: true, email: "p@x.org", plan_name: "Pro", balance_usd: 20, limits: { unlimited: false, is_admin: false, can_run: true } };
const ME_PENDING: Me = { signed_in: true, email: "w@x.org", plan_name: "Waiting for access", limits: { is_admin: false, can_run: false } };
const gw = (me: Me): Access => ({ kind: "gateway", me });

describe("roleOf / canAct", () => {
  it("lets admins and local development act, and nobody else", () => {
    expect(roleOf(gw(ME_ADMIN))).toBe("admin");
    expect(roleOf({ kind: "local" })).toBe("admin");
    for (const me of [{ signed_in: false }, ME_PRO, ME_PENDING]) expect(roleOf(gw(me))).toBe("viewer");
    expect(roleOf({ kind: "unknown" })).toBe("unknown");
    expect(canAct(gw(ME_ADMIN))).toBe(true);
    expect(canAct({ kind: "local" })).toBe(true);
    expect(canAct(gw(ME_PRO))).toBe(false);
    expect(canAct({ kind: "unknown" })).toBe(false);
  });
});

describe("loadAccess", () => {
  const answer = (body: string, type: string, status = 200) => vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));
  it("reads /auth/me behind the gateway", async () => {
    expect(await loadAccess(answer(JSON.stringify({ signed_in: false }), "application/json") as unknown as typeof fetch)).toEqual({ kind: "gateway", me: { signed_in: false } });
  });
  it("is local development when /auth/me is the dev server's page or missing", async () => {
    expect(await loadAccess(answer("<!doctype html>", "text/html") as unknown as typeof fetch)).toEqual({ kind: "local" });
    expect(await loadAccess(answer("nope", "text/plain", 404) as unknown as typeof fetch)).toEqual({ kind: "local" });
  });
  it("stays unknown when nothing answers", async () => {
    const down = vi.fn(async () => { throw new TypeError("offline"); });
    expect(await loadAccess(down as unknown as typeof fetch)).toEqual({ kind: "unknown" });
  });
});

describe("the account chip", () => {
  it("shows an admin their plan, and anyone else that the site is read-only for them", () => {
    expect(accountLine(ME_ADMIN)).toBe("Admin · unlimited");
    expect(accountLine({ ...ME_ADMIN, limits: { is_admin: true, unlimited: false }, balance_usd: 3, held_usd: 1 })).toBe("Admin · $3.00 credits ($1.00 held)");
    for (const me of [ME_PRO, ME_PENDING]) expect(accountLine(me)).toBe("Read only: only admins start or change batches");
  });
});

describe("signing in", () => {
  it("is asked for only when an action is refused, never for a read", () => {
    for (const m of [undefined, "GET", "get", "HEAD"]) expect(signInOnRefusal(m)).toBe(false);
    for (const m of ["POST", "post", "PUT", "DELETE"]) expect(signInOnRefusal(m)).toBe(true);
  });
});

describe("the landing page's button", () => {
  it("starts a batch for admins and opens the batch list for everyone else", () => {
    const admin = landingView("light", true);
    const viewer = landingView("light", false);
    expect(admin).toContain(`<a class="lp-cta" href="${START_CTA.href}">${START_CTA.label}</a>`);
    expect(viewer).toContain(`<a class="lp-cta" href="${BROWSE_CTA.href}">${BROWSE_CTA.label}</a>`);
    expect(viewer).not.toContain("Start a batch");
    expect(BROWSE_CTA.href).toBe("#/batches");
  });
});

describe("the header's links", () => {
  it("leave out Costs for those who may not see the all-batches report", () => {
    expect(navBar({ name: "home" }, null)).toContain('data-nav="costs"');
    expect(navBar({ name: "home" }, null, false)).not.toContain('data-nav="costs"');
    expect(navMenu({ name: "home" }, null, true, [], false)).not.toContain('data-nav="costs"');
    expect(navBar({ name: "home" }, null, false)).toContain('data-nav="batches"');
  });
});

const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  domain: { name: "tabular", title: "Tabular data science" },
  started_at: "2026-11-14T03:25:54",
  phase: "done",
  simulated: false,
  analyst_models: ["anthropic:claude-haiku-5-5"],
  investigator_model: "anthropic:claude-sonnet-5-5",
  n_runs: 12,
  counts: { honest: 6, inflated: 6, unclear: 0, failed: 0, running: 0, queued: 0, stopped: 0 },
  claim: { of: "inflated", n: 6, claimed: 0.9917, measured: 0.5944, n_hidden: 20 },
  step: { label: "deduplicate", name: "removing duplicate rows" },
  verdict: { state: "none" },
  pending: null,
  fork_progress: null,
  spend: { usd: 0.5455, usd_partial: false, tokens: 477_697 },
  ...over,
});
const ITEMS: BatchListItem[] = [
  { id: "b-appr", kind: "live", summary: summary({ phase: "awaiting_approval", verdict: { state: "awaiting_approval" }, pending: { kind: "method", n_per_arm: 4, vm_count: 17, estimate_usd: 2.1 } }) },
  { id: "b-ready", kind: "replay", resumable: true, summary: summary({ phase: "ready" }) },
  { id: "b-open", kind: "replay", summary: summary({ verdict: { state: "open", pairs: 4, needed_pairs: 8 } }) },
];
const ACTION_ATTRS = [NY_ACT.approve, NY_ACT.decline, NY_ACT.investigate, NY_ACT.more].map((a) => `data-act="${a}"`);

describe("Needs you and the home screen", () => {
  const ready = { state: "ready" as const, value: ITEMS };
  it("gives admins the row actions", () => {
    const html = needsView(ready, {}, "admin");
    for (const a of ACTION_ATTRS) expect(html).toContain(a);
  });
  it("gives everyone else rows that only open the batch", () => {
    for (const role of ["viewer", "unknown"] as const) {
      const html = needsView(ready, {}, role);
      for (const a of ACTION_ATTRS) expect(html).not.toContain(a);
      for (const b of ITEMS) expect(html).toContain(`data-act="${ACT.openBatch}" data-arg="${b.id}">Open</button>`);
    }
  });
  it("tells a viewer, once, that only admins start batches", () => {
    const vm: HomeVm = { batches: ready, health: null, defaults: null, draft: null, estimate: null, starting: false, error: null };
    expect(homeView(vm, "viewer")).toContain(ADMIN_ONLY.start);
    expect(homeView(vm, "admin")).not.toContain(ADMIN_ONLY.start);
    expect(homeView(vm, "unknown")).not.toContain(ADMIN_ONLY.start);
  });
});

describe("a batch's own actions", () => {
  const demo = JSON.parse(caseRaw) as CaseFile;
  const vmOf = (over: Partial<CaseFile>, v: Partial<BatchVm> = {}): BatchVm =>
    ({ id: "demo-batch", live: true, case: { ...demo, ...over }, events: {}, replay: null, busy: null, error: null, now: 0, ...v }) as BatchVm;
  const act = (a: string) => `data-act="${a}"`;

  it("Investigate and Stop are for admins; a viewer gets a line instead", () => {
    const ready = vmOf({ phase: "ready" });
    expect(investigatorView(ready)).toContain(act(ACT.investigate));
    expect(investigatorView({ ...ready, role: "admin" })).toContain(act(ACT.investigate));
    const viewer = investigatorView({ ...ready, role: "viewer" });
    expect(viewer).not.toContain(act(ACT.investigate));
    expect(viewer).toContain(ADMIN_ONLY.act);
    const running = vmOf({ phase: "investigating" });
    expect(investigatorView(running)).toContain(act(ACT.stop));
    expect(investigatorView({ ...running, role: "viewer" })).not.toContain(act(ACT.stop));
    expect(investigatorView({ ...running, role: "unknown" })).not.toContain(ADMIN_ONLY.act);
  });

  it("approving a fork is for admins; a viewer gets a line instead", () => {
    const pending = vmOf({
      phase: "awaiting_approval",
      forks: { pending: { id: "pending", status: "awaiting_approval", n_per_arm: 4, vm_count: 9, estimate_usd: 1.2 } } as CaseFile["forks"],
    });
    const admin = forkView(pending);
    expect(admin).toContain(act(ACT.approve));
    expect(admin).toContain(act(ACT.decline));
    const viewer = forkView({ ...pending, role: "viewer" });
    expect(viewer).not.toContain(act(ACT.approve));
    expect(viewer).not.toContain(act(ACT.decline));
    expect(viewer).toContain(ADMIN_ONLY.approve);
  });
});
