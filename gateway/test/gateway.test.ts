// Who may do what through the gateway (src/index.ts `apiRoute`, `adminRoute`). Runs on Node's own test runner:
// D1 is a real SQLite database (node:sqlite) with the migrations applied, and Fly is a stub of `fetch`.
//
//   npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";

const FLY = "https://fly.test";
const SITE = "https://orrolab.dev";

// ── a D1 on SQLite ───────────────────────────────────────────────────────────

class Stmt {
  db: DatabaseSync;
  sql: string;
  args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, args);
  }
  private prep() {
    return this.db.prepare(this.sql);
  }
  async first<T>(): Promise<T | null> {
    return ((this.prep().get as (...a: unknown[]) => unknown)(...this.args) as T) ?? null;
  }
  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: (this.prep().all as (...a: unknown[]) => unknown[])(...this.args) as T[], success: true };
  }
  async run() {
    this.runSync();
    return { success: true };
  }
  runSync() {
    (this.prep().run as (...a: unknown[]) => unknown)(...this.args);
  }
}

class FakeD1 {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      for (const s of stmts) s.runSync();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return stmts.map(() => ({ success: true }));
  }
}

// ── the world: three people, two batches, and Fly ────────────────────────────

let db: DatabaseSync;
let env: Record<string, unknown>;
/** What reached Fly: method, path and the gateway's headers. */
let flyCalls: { method: string; path: string; user: string | null; secret: string | null }[];

const TOKENS = { admin: "tok-admin", pro: "tok-pro", pending: "tok-pending" } as const;
type Who = keyof typeof TOKENS | "anon";

function seed() {
  db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const users: [string, string, string, number][] = [
    ["u-admin", "admin@example.com", "admin", 0],
    ["u-pro", "pro@example.com", "pro", 20],
    ["u-pending", "pending@example.com", "pending", 0],
  ];
  const later = new Date(Date.now() + 86400_000).toISOString();
  for (const [id, email, plan, balance] of users) {
    db.prepare("INSERT INTO users (id, email, plan_id, balance_usd) VALUES (?, ?, ?, ?)").run(id, email, plan, balance);
  }
  for (const [k, tok] of Object.entries(TOKENS)) {
    const hash = createHash("sha256").update(tok).digest("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash, `u-${k}`, later);
  }
  // b-pro belongs to the pro user; b-admin to the admin, settled so a resume holds credits again.
  db.prepare("INSERT INTO batches (id, user_id, budget_usd, reserved_usd, status, phase) VALUES ('b-pro', 'u-pro', 5, 5.5, 'open', 'running')").run();
  db.prepare("INSERT INTO batches (id, user_id, budget_usd, reserved_usd, charged_usd, status, phase) VALUES ('b-admin', 'u-admin', 10, 0, 2, 'settled', 'done')").run();
  env = {
    DB: new FakeD1(db),
    ASSETS: { fetch: async () => new Response("<!doctype html>asset", { headers: { "content-type": "text/html" } }) },
    FLY_ORIGIN: FLY,
    WORKOS_CLIENT_ID: "client_test",
    ADMIN_EMAILS: "admin@example.com",
    GATEWAY_SECRET: "fly-secret",
  };
  flyCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(u.origin, FLY, "only Fly is called");
    const h = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    flyCalls.push({ method, path: u.pathname, user: h.get("x-orro-user"), secret: h.get("x-orro-gateway") });
    if (u.pathname === "/api/batches" && method === "GET") return Response.json([{ id: "b-pro" }, { id: "b-admin" }, { id: "demo" }]);
    if (u.pathname === "/api/batches" && method === "POST") return Response.json({ id: "b-new" });
    return Response.json({ ok: true, path: u.pathname });
  }) as typeof fetch;
}

beforeEach(seed);

async function call(who: Who, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (who !== "anon") h.set("cookie", `orro_session=${TOKENS[who]}`);
  if (body !== undefined) h.set("content-type", "application/json");
  const req = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(req as never, env as never, ctx as never);
}

const detail = async (res: Response) => ((await res.json()) as { detail?: string; sign_in?: string });

// ── reads are public ─────────────────────────────────────────────────────────

test("anyone reads the whole batch list, unfiltered", async () => {
  for (const who of ["anon", "pending", "pro", "admin"] as const) {
    const res = await call(who, "GET", "/api/batches");
    assert.equal(res.status, 200, who);
    assert.deepEqual(((await res.json()) as { id: string }[]).map((b) => b.id), ["b-pro", "b-admin", "demo"], who);
  }
});

test("anonymous reads another user's batch: case, events, files, lab pages, motion, websocket", async () => {
  const paths = [
    "/api/batches/b-pro/case",
    "/api/batches/b-pro/runs/r01/events",
    "/api/batches/b-pro/forks/f1/control-1/events",
    "/api/batches/b-pro/investigator/events",
    "/api/batches/b-pro/files/runs/r01/charts/a.png",
    "/api/batches/b-pro/runs/r01/lab/index.html",
    "/api/batches/b-pro/motion",
    "/api/batches/b-pro/more-pairs",
    "/api/defaults",
    "/api/robot/scene",
    "/api/health",
    "/api/datasets",
    "/api/memory/tabular",
  ];
  for (const p of paths) {
    const res = await call("anon", "GET", p);
    assert.equal(res.status, 200, p);
  }
  const ws = await call("anon", "GET", "/api/batches/b-pro/ws", undefined, { upgrade: "websocket", connection: "Upgrade" });
  assert.equal(ws.status, 200);
  const last = flyCalls.at(-1)!;
  assert.equal(last.path, "/api/batches/b-pro/ws");
  assert.equal(last.secret, "fly-secret", "Fly gets the gateway secret without a user");
  assert.equal(last.user, null);
});

test("a signed-in non-admin reads another user's batch", async () => {
  assert.equal((await call("pending", "GET", "/api/batches/b-admin/case")).status, 200);
  assert.equal((await call("pro", "GET", "/api/batches/b-admin/runs/r01/events")).status, 200);
  assert.equal((await call("anon", "HEAD", "/api/batches/b-admin/case")).status, 200);
});

// ── the cost report stays in the admin area ──────────────────────────────────

test("/api/costs: anonymous 401, non-admin 403, admin 200", async () => {
  const anon = await call("anon", "GET", "/api/costs");
  assert.equal(anon.status, 401);
  assert.equal((await detail(anon)).sign_in, "/auth/login");
  assert.equal((await call("pro", "GET", "/api/costs")).status, 403);
  assert.equal((await call("pending", "GET", "/api/costs")).status, 403);
  assert.equal((await call("admin", "GET", "/api/costs")).status, 200);
  assert.deepEqual(flyCalls.map((c) => c.path), ["/api/costs"], "only the admin's request reached Fly");
});

// ── changes are admin-only ───────────────────────────────────────────────────

const ACTIONS: [string, string][] = [
  ["POST", "/api/batches"],
  ["POST", "/api/batches/b-pro/resume"],
  ["POST", "/api/batches/b-pro/more-pairs"],
  ["POST", "/api/batches/b-pro/stop"],
  ["POST", "/api/batches/b-pro/investigate"],
  ["POST", "/api/batches/b-pro/decision"],
  ["POST", "/api/batches/demo/resume"],
  ["POST", "/api/estimate"],
  ["POST", "/api/datasets"],
  ["POST", "/api/controllers"],
  ["POST", "/api/scripts"],
  ["DELETE", "/api/batches/b-pro"],
];

test("anonymous changes get 401 with a sign-in link, and never reach Fly", async () => {
  for (const [method, path] of ACTIONS) {
    const res = await call("anon", method, path, {});
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await detail(res)).sign_in, "/auth/login");
  }
  assert.deepEqual(flyCalls, []);
});

test("signed-in non-admins (a pro user, a pending one) get 403 for any change, their own batch included", async () => {
  for (const who of ["pro", "pending"] as const) {
    for (const [method, path] of ACTIONS) {
      const res = await call(who, method, path, {});
      assert.equal(res.status, 403, `${who} ${method} ${path}`);
      assert.equal((await detail(res)).detail, "Starting and changing batches is limited to admins.");
    }
  }
  assert.deepEqual(flyCalls, []);
  // Nothing was held from the pro user's credits.
  assert.equal(db.prepare("SELECT balance_usd FROM users WHERE id = 'u-pro'").get()!.balance_usd, 20);
});

test("an admin starts a batch as before: capped, held, recorded", async () => {
  const res = await call("admin", "POST", "/api/batches", { budget_usd: 500, n_runs: 12 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "b-new" });
  const row = db.prepare("SELECT user_id, budget_usd, reserved_usd FROM batches WHERE id = 'b-new'").get()!;
  assert.equal(row.user_id, "u-admin");
  assert.equal(row.budget_usd, 100, "capped to the admin plan's max per batch");
  assert.equal(row.reserved_usd, 100.5);
  const ledger = db.prepare("SELECT kind, amount_usd FROM ledger WHERE batch_id = 'b-new'").get()!;
  assert.equal(ledger.kind, "reserve");
  assert.equal(ledger.amount_usd, -100.5);
  assert.equal(flyCalls.at(-1)!.user, "u-admin");
});

test("an admin resumes a settled batch (its headroom is held again), stops, investigates and uploads", async () => {
  assert.equal((await call("admin", "POST", "/api/batches/b-admin/resume")).status, 200);
  const row = db.prepare("SELECT status, reserved_usd FROM batches WHERE id = 'b-admin'").get()!;
  assert.equal(row.status, "open");
  assert.equal(row.reserved_usd, 8.5);
  for (const p of ["/api/batches/b-pro/stop", "/api/batches/b-pro/investigate", "/api/batches/demo/resume", "/api/datasets", "/api/estimate"]) {
    assert.equal((await call("admin", "POST", p, {})).status, 200, p);
  }
  assert.equal(flyCalls.length, 6);
});

// ── /admin and /auth/me are unchanged ────────────────────────────────────────

test("/admin: signed out goes to sign-in, a non-admin gets 403, an admin gets the page", async () => {
  const anon = await call("anon", "GET", "/admin");
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), `/auth/login?return=${encodeURIComponent("/admin")}`);
  assert.equal((await call("pro", "GET", "/admin")).status, 403);
  assert.equal((await call("pending", "POST", "/admin/plan", undefined, { origin: SITE })).status, 403);
  const admin = await call("admin", "GET", "/admin");
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /Orro access/);
});

test("/auth/me says who is an admin", async () => {
  const me = async (who: Who) => (await (await call(who, "GET", "/auth/me")).json()) as { signed_in: boolean; limits?: { is_admin: boolean } };
  assert.deepEqual(await me("anon"), { signed_in: false });
  assert.equal((await me("pro")).limits!.is_admin, false);
  assert.equal((await me("admin")).limits!.is_admin, true);
});

test("pages that are not the API or sign-in are the static site", async () => {
  const res = await call("anon", "GET", "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /asset/);
});

test("a media file is sent in parts when a part is asked for (Safari will not play a video otherwise)", async () => {
  const bytes = new Uint8Array(100).map((_, i) => i);
  env.ASSETS = { fetch: async () => new Response(bytes, { headers: { "content-type": "video/mp4" } }) };
  const ask = (range?: string, path = "/media/clip.mp4") =>
    worker.fetch(new Request(`${SITE}${path}`, range ? { headers: { Range: range } } : {}), env as never, { waitUntil() {} } as never);
  const part = await ask("bytes=10-19");
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(part.headers.get("content-length"), "10");
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  // Safari's first probe, an open end, and the last bytes.
  assert.equal((await ask("bytes=0-1")).headers.get("content-range"), "bytes 0-1/100");
  assert.equal((await ask("bytes=90-")).headers.get("content-range"), "bytes 90-99/100");
  assert.equal((await ask("bytes=-5")).headers.get("content-range"), "bytes 95-99/100");
  assert.equal((await ask("bytes=50-500")).headers.get("content-range"), "bytes 50-99/100");
  // Past the end: 416. A range this does not understand, no range, or a file outside /media/: the whole file.
  assert.equal((await ask("bytes=200-300")).status, 416);
  assert.equal((await ask("bytes=0-1,5-6")).status, 200);
  assert.equal((await ask()).status, 200);
  assert.equal((await ask("bytes=0-1", "/assets/app.js")).status, 200);
});
