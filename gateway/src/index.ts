/**
 * Orro's gateway on Cloudflare.
 *
 *   browser ──► this Worker ──► Fly.io (Python server: batches, agents, Daytona VMs, Anthropic calls)
 *                 │
 *                 ├─ WorkOS AuthKit: who the user is (sign-in with PKCE, no API key stored here)
 *                 └─ D1: their plan, their credit balance, which batches are theirs, a ledger of every charge
 *
 * Credits: starting a batch reserves its budget from the user's balance before the request reaches Fly, and caps the
 * batch's own `budget_usd` to that reservation, so Orro's budget guard (deep_research/costs.py) stops it there. When
 * the batch is over, the cron (or the user's next /auth/me) settles it: actual spend is charged and the rest returned.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FLY_ORIGIN: string;
  WORKOS_CLIENT_ID: string;
  ADMIN_EMAILS: string;
  GATEWAY_SECRET: string;
}

interface Plan {
  id: string;
  name: string;
  signup_usd: number;
  monthly_usd: number;
  max_batch_usd: number;
  max_runs: number;
  max_open_batches: number;
  allowed_models: string;
  default_model: string;
  default_investigator_model: string;
  can_upload: number;
  unlimited: number;
  is_admin: number;
  can_run: number;
}

interface User {
  id: string;
  email: string;
  name: string | null;
  plan_id: string;
  balance_usd: number;
  last_grant_month: string | null;
}

interface Who {
  user: User;
  plan: Plan;
}

interface BatchRow {
  id: string;
  user_id: string;
  budget_usd: number;
  reserved_usd: number;
  charged_usd: number;
  status: string;
  phase: string | null;
}

const SESSION_COOKIE = "orro_session";
const AUTH_COOKIE = "orro_auth";
const SESSION_DAYS = 30;
const WORKOS = "https://api.workos.com";
// Commentary captions are counted in the batch's spend; keep their own cap small.
const MAX_COMMENTARY_USD = 0.5;
// A batch in one of these phases spends nothing more until it is resumed.
const TERMINAL = (phase: string) =>
  ["done", "stopped", "no_split"].includes(phase) || phase.startsWith("blocked") || phase.startsWith("error");

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // One address for the site: sign-in cookies and WorkOS redirects belong to orrolab.dev.
    if (url.hostname === "www.orrolab.dev" || url.hostname.endsWith(".workers.dev")) {
      url.hostname = "orrolab.dev";
      return Response.redirect(url.toString(), 301);
    }
    try {
      if (url.pathname.startsWith("/auth/")) return await authRoute(req, env, url, ctx);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await adminRoute(req, env, url);
      if (url.pathname.startsWith("/api/")) return await apiRoute(req, env, url, ctx);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error("gateway error", e);
      return json({ detail: "The gateway hit an error. Try again in a moment." }, 500);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([settleOpen(env, null, 25), monthlyRefill(env)]));
  },
} satisfies ExportedHandler<Env>;

// ───────────────────────────── sign-in (WorkOS AuthKit, PKCE) ─────────────────────────────

async function authRoute(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const redirectUri = `${url.origin}/auth/callback`;

  if (url.pathname === "/auth/login") {
    const state = randomToken(16);
    const verifier = randomToken(32);
    const challenge = b64url(await sha256(verifier));
    const back = safeReturn(url.searchParams.get("return"));
    const authorize = new URL(`${WORKOS}/user_management/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: env.WORKOS_CLIENT_ID,
      redirect_uri: redirectUri,
      provider: "authkit",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const value = [state, verifier, b64url(new TextEncoder().encode(back))].join(".");
    return redirect(authorize.toString(), cookie(AUTH_COOKIE, value, { maxAge: 600, path: "/auth" }));
  }

  if (url.pathname === "/auth/callback") {
    const [state, verifier, back64] = (readCookie(req, AUTH_COOKIE) ?? "").split(".");
    const code = url.searchParams.get("code");
    if (!state || !verifier || !code || url.searchParams.get("state") !== state) {
      return new Response("Sign-in expired or was started in another tab. Go back and sign in again.", { status: 400 });
    }
    const res = await fetch(`${WORKOS}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: env.WORKOS_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      console.error("workos authenticate failed", res.status, await res.text());
      return new Response("WorkOS could not finish the sign-in. Try again.", { status: 502 });
    }
    const auth = (await res.json()) as {
      user: WorkosUser;
      access_token?: string;
    };
    await upsertUser(env, auth.user);
    const token = randomToken(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, workos_sid, expires_at) VALUES (?, ?, ?, ?)")
      .bind(hex(await sha256(token)), auth.user.id, jwtClaim(auth.access_token, "sid"), expires)
      .run();
    const back = back64 ? new TextDecoder().decode(fromB64url(back64)) : "/#/start";
    return redirect(safeReturn(back), [
      cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, path: "/" }),
      cookie(AUTH_COOKIE, "", { maxAge: 0, path: "/auth" }),
    ]);
  }

  if (url.pathname === "/auth/logout") {
    const token = readCookie(req, SESSION_COOKIE);
    let sid: string | null = null;
    if (token) {
      const row = await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? RETURNING workos_sid")
        .bind(hex(await sha256(token)))
        .first<{ workos_sid: string | null }>();
      sid = row?.workos_sid ?? null;
    }
    const clear = cookie(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    // End the WorkOS session too, so the next sign-in asks again. WorkOS sends the browser back to the
    // logout redirect configured in its dashboard.
    const to = sid ? `${WORKOS}/user_management/sessions/logout?session_id=${encodeURIComponent(sid)}` : "/";
    return redirect(to, clear);
  }

  if (url.pathname === "/auth/me") {
    const who = await currentUser(req, env);
    if (!who) return json({ signed_in: false });
    // Settle this user's finished batches now, so the balance shown is current.
    await settleOpen(env, who.user.id, 5);
    const fresh = await loadUser(env, who.user.id);
    const w = fresh ?? who;
    const open = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(reserved_usd), 0) AS held FROM batches WHERE user_id = ? AND status != 'settled'",
    )
      .bind(w.user.id)
      .first<{ n: number; held: number }>();
    return json({
      signed_in: true,
      email: w.user.email,
      name: w.user.name,
      plan: w.plan.id,
      plan_name: w.plan.name,
      balance_usd: round(w.user.balance_usd),
      held_usd: round(open?.held ?? 0),
      open_batches: open?.n ?? 0,
      limits: {
        max_batch_usd: w.plan.max_batch_usd,
        max_runs: w.plan.max_runs,
        max_open_batches: w.plan.max_open_batches,
        models: JSON.parse(w.plan.allowed_models) as string[],
        can_upload: !!w.plan.can_upload,
        unlimited: !!w.plan.unlimited,
        can_run: !!w.plan.can_run,
        is_admin: !!w.plan.is_admin,
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

type WorkosUser = { id: string; email: string; email_verified?: boolean; first_name?: string | null; last_name?: string | null };

/**
 * Invite-only: a new account starts on 'pending' (no access). It gets a real plan only when its email is verified by
 * WorkOS and is either in ADMIN_EMAILS or matches the invite list. A pending user who is invited later gets in on
 * their next sign-in, or when an admin approves them on /admin.
 */
async function upsertUser(env: Env, u: WorkosUser) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
  const existing = await env.DB.prepare("SELECT id, plan_id FROM users WHERE id = ?").bind(u.id).first<{ plan_id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, last_seen_at = datetime('now') WHERE id = ?")
      .bind(u.email, name, u.id)
      .run();
  } else {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, email, name, plan_id, balance_usd, last_grant_month, last_seen_at) VALUES (?, ?, ?, 'pending', 0, ?, datetime('now'))",
      ).bind(u.id, u.email, name, monthKey()),
      env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_usd, note) VALUES (?, 'signup', 0, 'signed up, waiting for access')").bind(u.id),
    ]);
  }
  if (existing && existing.plan_id !== "pending") return;
  // An email WorkOS has not verified could be anyone's: never let it match an invite.
  if (u.email_verified !== true) return;
  const planId = await invitedPlan(env, u.email);
  if (planId) await setPlan(env, u.id, planId, "invite");
}

async function invitedPlan(env: Env, email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(e)) return "admin";
  const domain = e.slice(e.lastIndexOf("@"));
  const row = await env.DB.prepare("SELECT plan_id FROM invites WHERE pattern IN (?, ?) ORDER BY length(pattern) DESC LIMIT 1")
    .bind(e, domain)
    .first<{ plan_id: string }>();
  return row?.plan_id ?? null;
}

/** Move a user to a plan and give them that plan's starting credits (up to its monthly amount, at least its signup). */
async function setPlan(env: Env, userId: string, planId: string, why: string): Promise<void> {
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first<Plan>();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
  if (!plan || !user) throw new Error(`unknown plan ${planId} or user ${userId}`);
  const wasPending = user.plan_id === "pending";
  const grant = wasPending ? round(Math.max(plan.signup_usd, plan.monthly_usd - user.balance_usd, 0)) : 0;
  const stmts = [
    env.DB.prepare("UPDATE users SET plan_id = ?, balance_usd = balance_usd + ?, last_grant_month = ? WHERE id = ?").bind(planId, grant, monthKey(), userId),
  ];
  if (grant > 0 || wasPending) {
    stmts.push(
      env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_usd, note) VALUES (?, 'adjust', ?, ?)").bind(userId, grant, `plan set to ${planId} (${why})`),
    );
  }
  await env.DB.batch(stmts);
}

async function currentUser(req: Request, env: Env): Promise<Who | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(hex(await sha256(token)), new Date().toISOString())
    .first<{ user_id: string }>();
  return row ? loadUser(env, row.user_id) : null;
}

async function loadUser(env: Env, id: string): Promise<Who | null> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
  if (!user) return null;
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(user.plan_id).first<Plan>();
  return plan ? { user, plan } : null;
}

// ───────────────────────────── the API: who may do what ─────────────────────────────

// Reads anyone may make, signed in or not: the landing page and the public demo replays use them.
const PUBLIC_GET = new Set(["/api/health", "/api/defaults", "/api/robot/scene", "/api/batches"]);
const UPLOADS = new Set(["/api/datasets", "/api/controllers", "/api/scripts"]);

async function apiRoute(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";
  const signedIn = await currentUser(req, env);
  // A pending account counts as signed out for everything except the reason it is refused.
  const who = signedIn && signedIn.plan.can_run ? signedIn : null;
  const needSignIn = () => (signedIn ? waitingForAccess() : signInFirst());

  // Start a batch: the one request that commits money.
  if (path === "/api/batches" && method === "POST") {
    if (!who) return needSignIn();
    return startBatch(req, env, url, who);
  }

  // Everything under one batch: its case file, events, files, lab pages, websocket, and its actions.
  const m = path.match(/^\/api\/batches\/([^/]+)(\/.*)?$/);
  if (m) {
    const batchId = decodeURIComponent(m[1]);
    const rest = m[2] ?? "";
    const row = await env.DB.prepare("SELECT * FROM batches WHERE id = ?").bind(batchId).first<BatchRow>();
    const mine = !!who && (row?.user_id === who.user.id || !!who.plan.is_admin);
    if (row && !mine) return who ? json({ detail: "This batch belongs to another user." }, 403) : needSignIn();
    if (!isRead) {
      if (!who) return needSignIn();
      // Acting on a batch nobody owns here (a demo fixture) could spend money no one reserved: admins only.
      if (!row && !who.plan.is_admin) return json({ detail: "Only your own batches can be resumed or investigated." }, 403);
      if (row && rest === "/resume") {
        const held = await reserveForResume(env, who, row);
        if (held) return held;
      }
    }
    return forward(req, env, url, who);
  }

  if (path === "/api/batches" && isRead) {
    // Hide other users' batches from the list. Public replays (no owner here) stay.
    const res = await forward(req, env, url, who);
    if (!res.ok) return res;
    const items = (await res.json()) as { id: string }[];
    const ids = items.map((i) => i.id);
    const owners = await env.DB.prepare("SELECT id, user_id FROM batches WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids))
      .all<{ id: string; user_id: string }>();
    const ownerOf = new Map(owners.results.map((r) => [r.id, r.user_id]));
    const visible = items.filter((i) => {
      const owner = ownerOf.get(i.id);
      return !owner || (who && (owner === who.user.id || who.plan.is_admin));
    });
    return json(visible);
  }

  if (isRead && PUBLIC_GET.has(path)) return forward(req, env, url, who);

  if (!who) return needSignIn();

  if (path === "/api/costs" && !who.plan.is_admin) {
    return json({ detail: "The all-batches cost report is for admins. Your own spend is in your account menu." }, 403);
  }
  if (UPLOADS.has(path) && !isRead && !who.plan.can_upload) {
    return json({ detail: `Uploading files needs a paid plan (you are on ${who.plan.name}).` }, 403);
  }
  // Estimates, datasets, controllers, scripts, the investigator's notebook: signed-in users.
  return forward(req, env, url, who);
}

async function startBatch(req: Request, env: Env, url: URL, who: Who): Promise<Response> {
  const { user, plan } = who;
  let cfg: Record<string, unknown>;
  try {
    cfg = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ detail: "The batch settings were not valid JSON." }, 400);
  }
  const unlimited = !!plan.unlimited;

  // Runs.
  const nRuns = typeof cfg.n_runs === "number" ? cfg.n_runs : 12;
  if (!unlimited && nRuns > plan.max_runs) {
    return json({ detail: `Your ${plan.name} plan allows up to ${plan.max_runs} runs per batch; this batch asks for ${nRuns}.` }, 403);
  }

  // Models: fill in the plan's defaults for any left out, then check every one against the plan.
  cfg.analyst_model ??= plan.default_model;
  cfg.investigator_model ??= plan.default_investigator_model;
  cfg.commentary_model ??= plan.default_model;
  const allowed = new Set(JSON.parse(plan.allowed_models) as string[]);
  const asked = [cfg.analyst_model, cfg.investigator_model, cfg.commentary_model, ...((cfg.analyst_models as unknown[]) ?? [])];
  const blocked = asked.filter((x) => typeof x !== "string" || !allowed.has(x));
  if (!unlimited && blocked.length) {
    return json({ detail: `Your ${plan.name} plan cannot use ${[...new Set(blocked)].join(", ")}. Allowed: ${[...allowed].join(", ")}.` }, 403);
  }

  // Budget: cap it to the plan, and hold it (plus the captions' small cap) from the balance.
  const asks = typeof cfg.budget_usd === "number" && cfg.budget_usd > 0 ? cfg.budget_usd : 10;
  const budget = round(Math.min(asks, plan.max_batch_usd));
  const commentary = round(Math.min(typeof cfg.commentary_budget_usd === "number" ? cfg.commentary_budget_usd : 0.5, MAX_COMMENTARY_USD));
  cfg.budget_usd = budget;
  cfg.commentary_budget_usd = commentary;
  const reserve = round(budget + commentary);

  if (!unlimited) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM batches WHERE user_id = ? AND status != 'settled'")
      .bind(user.id)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= plan.max_open_batches) {
      return json({ detail: `Your ${plan.name} plan allows ${plan.max_open_batches} open batch(es) at once. Finish or stop one first.` }, 429);
    }
  }
  const took = await takeCredits(env, user.id, reserve, unlimited);
  if (!took) {
    return json({ detail: `Not enough credits: this batch holds $${reserve.toFixed(2)}, you have $${round(user.balance_usd).toFixed(2)}. Lower the budget or wait for your monthly refill.` }, 402);
  }

  const res = await forward(req, env, url, who, JSON.stringify(cfg));
  if (!res.ok) {
    await giveCredits(env, user.id, reserve, "release", null, "batch did not start");
    return res;
  }
  const body = (await res.json()) as { id: string };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batches (id, user_id, budget_usd, reserved_usd, phase) VALUES (?, ?, ?, ?, 'running')").bind(
      body.id,
      user.id,
      budget,
      reserve,
    ),
    env.DB.prepare("INSERT INTO ledger (user_id, batch_id, kind, amount_usd, note) VALUES (?, ?, 'reserve', ?, ?)").bind(
      user.id,
      body.id,
      -reserve,
      `held for batch (budget $${budget.toFixed(2)})`,
    ),
  ]);
  return json(body);
}

/** A settled batch that is resumed can spend again, up to its budget: hold that headroom first. */
async function reserveForResume(env: Env, who: Who, row: BatchRow): Promise<Response | null> {
  if (row.status !== "settled") return null; // still holding its reservation
  const headroom = round(Math.max(0, row.budget_usd - row.charged_usd) + MAX_COMMENTARY_USD);
  const took = await takeCredits(env, who.user.id, headroom, !!who.plan.unlimited);
  if (!took) return json({ detail: `Resuming this batch holds $${headroom.toFixed(2)} of credits; you do not have enough.` }, 402);
  await env.DB.batch([
    env.DB.prepare("UPDATE batches SET status = 'open', reserved_usd = ?, settled_at = NULL WHERE id = ?").bind(headroom, row.id),
    env.DB.prepare("INSERT INTO ledger (user_id, batch_id, kind, amount_usd, note) VALUES (?, ?, 'reserve', ?, 'held to resume batch')").bind(
      who.user.id,
      row.id,
      -headroom,
    ),
  ]);
  return null;
}

/** Take credits if the balance covers them. Unlimited plans may go negative (it is still recorded). */
async function takeCredits(env: Env, userId: string, amount: number, unlimited: boolean): Promise<boolean> {
  const sql = unlimited
    ? "UPDATE users SET balance_usd = balance_usd - ?1 WHERE id = ?2 RETURNING balance_usd"
    : "UPDATE users SET balance_usd = balance_usd - ?1 WHERE id = ?2 AND balance_usd >= ?1 RETURNING balance_usd";
  const row = await env.DB.prepare(sql).bind(amount, userId).first();
  return !!row;
}

async function giveCredits(env: Env, userId: string, amount: number, kind: string, batchId: string | null, note: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance_usd = balance_usd + ? WHERE id = ?").bind(amount, userId),
    env.DB.prepare("INSERT INTO ledger (user_id, batch_id, kind, amount_usd, note) VALUES (?, ?, ?, ?, ?)").bind(userId, batchId, kind, amount, note),
  ]);
}

// ───────────────────────────── settling spend ─────────────────────────────

/** Charge finished batches their actual spend and return the rest of what they held. */
async function settleOpen(env: Env, userId: string | null, limit: number): Promise<void> {
  const q = userId
    ? env.DB.prepare("SELECT * FROM batches WHERE status = 'open' AND user_id = ? ORDER BY created_at LIMIT ?").bind(userId, limit)
    : env.DB.prepare("SELECT * FROM batches WHERE status = 'open' ORDER BY created_at LIMIT ?").bind(limit);
  const { results } = await q.all<BatchRow>();
  await Promise.all(results.map((b) => settleOne(env, b).catch((e) => console.error("settle failed", b.id, e))));
}

async function settleOne(env: Env, b: BatchRow): Promise<void> {
  const res = await fetch(`${env.FLY_ORIGIN}/api/batches/${encodeURIComponent(b.id)}/case`, {
    headers: { "x-orro-gateway": env.GATEWAY_SECRET },
  });
  if (!res.ok) return; // Fly asleep or batch gone: try again next time
  const c = (await res.json()) as { phase?: string; costs?: { spent_usd?: number | null } };
  const phase = c.phase ?? "";
  if (!TERMINAL(phase)) {
    await env.DB.prepare("UPDATE batches SET phase = ? WHERE id = ?").bind(phase, b.id).run();
    return;
  }
  // Claim it, so the cron and a /auth/me never settle the same batch twice.
  const claimed = await env.DB.prepare("UPDATE batches SET status = 'settling' WHERE id = ? AND status = 'open' RETURNING id").bind(b.id).first();
  if (!claimed) return;
  // Unknown prices: charge everything held, the safe side.
  const spent = typeof c.costs?.spent_usd === "number" ? c.costs.spent_usd : b.charged_usd + b.reserved_usd;
  const charge = round(Math.max(0, spent - b.charged_usd));
  const back = round(b.reserved_usd - charge); // negative when spend ran past the hold
  try {
    await settleWrite(env, b, phase, charge, back);
  } catch (e) {
    await env.DB.prepare("UPDATE batches SET status = 'open' WHERE id = ? AND status = 'settling'").bind(b.id).run();
    throw e;
  }
}

async function settleWrite(env: Env, b: BatchRow, phase: string, charge: number, back: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE batches SET status = 'settled', phase = ?, charged_usd = charged_usd + ?, reserved_usd = 0, settled_at = datetime('now') WHERE id = ?",
    ).bind(phase, charge, b.id),
    env.DB.prepare("UPDATE users SET balance_usd = balance_usd + ? WHERE id = ?").bind(back, b.user_id),
    env.DB.prepare("INSERT INTO ledger (user_id, batch_id, kind, amount_usd, note) VALUES (?, ?, 'release', ?, ?)").bind(
      b.user_id,
      b.id,
      back,
      `batch ${phase}: spent $${charge.toFixed(2)}, returned $${back.toFixed(2)}`,
    ),
  ]);
}

/** On a new month, refill each user's balance up to their plan's monthly amount (never above it). */
async function monthlyRefill(env: Env): Promise<void> {
  const month = monthKey();
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.balance_usd, p.monthly_usd FROM users u JOIN plans p ON p.id = u.plan_id
     WHERE (u.last_grant_month IS NULL OR u.last_grant_month != ?) LIMIT 200`,
  )
    .bind(month)
    .all<{ id: string; balance_usd: number; monthly_usd: number }>();
  for (const u of results) {
    const add = round(Math.max(0, u.monthly_usd - u.balance_usd));
    const stmts = [env.DB.prepare("UPDATE users SET balance_usd = balance_usd + ?, last_grant_month = ? WHERE id = ?").bind(add, month, u.id)];
    if (add > 0) {
      stmts.push(env.DB.prepare("INSERT INTO ledger (user_id, kind, amount_usd, note) VALUES (?, 'monthly', ?, ?)").bind(u.id, add, `refill for ${month}`));
    }
    await env.DB.batch(stmts);
  }
}

// ───────────────────────────── forwarding to Fly ─────────────────────────────

async function forward(req: Request, env: Env, url: URL, who: Who | null, body?: string): Promise<Response> {
  const target = new URL(url.pathname + url.search, env.FLY_ORIGIN);
  const headers = new Headers(req.headers);
  headers.delete("cookie"); // the session cookie stays on Cloudflare
  headers.delete("host");
  headers.set("x-orro-gateway", env.GATEWAY_SECRET);
  if (who) {
    headers.set("x-orro-user", who.user.id);
    headers.set("x-orro-plan", who.plan.id);
  }
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    init.body = body;
  } else if (!["GET", "HEAD"].includes(req.method.toUpperCase())) {
    init.body = req.body;
  }
  // WebSocket upgrades pass straight through: fetch returns the 101 with the socket attached.
  return fetch(target.toString(), init);
}

// ───────────────────────────── small helpers ─────────────────────────────

function signInFirst(): Response {
  return json({ detail: "Sign in to use Orro.", sign_in: "/auth/login" }, 401);
}

function waitingForAccess(): Response {
  return json({ detail: "Your account is waiting for access. Ask an Orro admin to approve it." }, 403);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function redirect(to: string, cookies: string | string[]): Response {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  for (const c of Array.isArray(cookies) ? cookies : [cookies]) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function cookie(name: string, value: string, o: { maxAge: number; path: string }): string {
  return `${name}=${value}; Path=${o.path}; Max-Age=${o.maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Only same-site paths: never an open redirect. */
function safeReturn(r: string | null): string {
  if (!r) return "/#/start";
  if (r.startsWith("#")) return `/${r}`;
  if (r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\")) return r;
  return "/#/start";
}

function jwtClaim(token: string | undefined, claim: string): string | null {
  // Only to read the WorkOS session id for sign-out; nothing is trusted from it.
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(token!.split(".")[1])));
    return typeof payload[claim] === "string" ? payload[claim] : null;
  } catch {
    return null;
  }
}

function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

// ───────────────────────────── admin: who may use Orro ─────────────────────────────

/**
 * /admin: the invite list and every user, with their plan and credits. Admins only. Forms post back here; the
 * Origin check plus SameSite=Lax cookies keep other sites from posting as an admin.
 */
async function adminRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const who = await currentUser(req, env);
  if (!who) return redirect(`/auth/login?return=${encodeURIComponent("/admin")}`, []);
  if (!who.plan.is_admin) return new Response("Admins only.", { status: 403 });

  if (req.method === "POST") {
    if (req.headers.get("origin") !== url.origin) return new Response("Bad origin.", { status: 403 });
    const f = await req.formData();
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const plans = new Set((await env.DB.prepare("SELECT id FROM plans").all<{ id: string }>()).results.map((p) => p.id));
    let msg = "";
    if (url.pathname === "/admin/invite") {
      const pattern = s("pattern").toLowerCase();
      const plan = s("plan");
      if (!/^([^@\s]+@|@)[^@\s]+\.[^@\s]+$/.test(pattern) || !plans.has(plan) || plan === "pending") {
        msg = "Invite needs an email (ana@bu.edu) or a domain (@bu.edu), and a plan other than pending.";
      } else {
        await env.DB.prepare("INSERT INTO invites (pattern, plan_id, note, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(pattern) DO UPDATE SET plan_id = excluded.plan_id, note = excluded.note")
          .bind(pattern, plan, s("note") || null, who.user.email)
          .run();
        // People already waiting who match get in now.
        const waiting = await env.DB.prepare("SELECT id, email FROM users WHERE plan_id = 'pending'").all<{ id: string; email: string }>();
        let n = 0;
        for (const u of waiting.results) {
          const e = u.email.toLowerCase();
          if (e === pattern || (pattern.startsWith("@") && e.endsWith(pattern))) {
            await setPlan(env, u.id, plan, `invite ${pattern}`);
            n++;
          }
        }
        msg = `Invited ${pattern} on ${plan}.${n ? ` ${n} waiting account(s) approved.` : ""} Waiting accounts are matched by email; new sign-ups need a verified email.`;
      }
    } else if (url.pathname === "/admin/uninvite") {
      await env.DB.prepare("DELETE FROM invites WHERE pattern = ?").bind(s("pattern")).run();
      msg = `Removed invite ${s("pattern")}. People already in keep their plan; set them to pending to remove access.`;
    } else if (url.pathname === "/admin/plan") {
      const plan = s("plan");
      if (!plans.has(plan)) msg = "Unknown plan.";
      else if (s("user") === who.user.id && plan !== "admin") msg = "You cannot remove your own admin access here.";
      else {
        await setPlan(env, s("user"), plan, `set by ${who.user.email}`);
        if (plan === "pending") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(s("user")).run();
        msg = `Plan set to ${plan}.`;
      }
    } else if (url.pathname === "/admin/credits") {
      const amount = Number(s("amount"));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) msg = "Credits: a non-zero amount up to 1000.";
      else {
        await giveCredits(env, s("user"), round(amount), "adjust", null, `by ${who.user.email}${s("note") ? `: ${s("note")}` : ""}`);
        msg = `Credits ${amount > 0 ? "added" : "removed"}: $${Math.abs(amount).toFixed(2)}.`;
      }
    }
    return redirect(`/admin?msg=${encodeURIComponent(msg)}`, []);
  }

  const [plans, users, invites] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM plans ORDER BY can_run, unlimited, monthly_usd").all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.plan_id, u.balance_usd, u.created_at, u.last_seen_at,
              COALESCE((SELECT SUM(reserved_usd) FROM batches b WHERE b.user_id = u.id AND b.status != 'settled'), 0) AS held,
              COALESCE((SELECT SUM(charged_usd) FROM batches b WHERE b.user_id = u.id), 0) AS spent
       FROM users u ORDER BY (u.plan_id = 'pending') DESC, u.created_at DESC LIMIT 500`,
    ).all<{ id: string; email: string; name: string | null; plan_id: string; balance_usd: number; created_at: string; last_seen_at: string | null; held: number; spent: number }>(),
    env.DB.prepare("SELECT * FROM invites ORDER BY created_at DESC").all<{ pattern: string; plan_id: string; note: string | null; created_by: string | null; created_at: string }>(),
  ]);
  const planSelect = (current: string, name = "plan") =>
    `<select name="${name}">${plans.results.map((p) => `<option value="${esc(p.id)}"${p.id === current ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
  const msg = url.searchParams.get("msg");
  const userRows = users.results
    .map(
      (u) => `<tr${u.plan_id === "pending" ? ' class="pending"' : ""}>
  <td><b>${esc(u.email)}</b>${u.name ? `<br><small>${esc(u.name)}</small>` : ""}</td>
  <td><form method="post" action="/admin/plan"><input type="hidden" name="user" value="${esc(u.id)}">${planSelect(u.plan_id)} <button>Set</button></form></td>
  <td>$${u.balance_usd.toFixed(2)}${u.held ? `<br><small>$${u.held.toFixed(2)} held</small>` : ""}</td>
  <td>$${u.spent.toFixed(2)}</td>
  <td><form method="post" action="/admin/credits"><input type="hidden" name="user" value="${esc(u.id)}"><input name="amount" type="number" step="0.01" placeholder="+5 or -2" required> <button>Apply</button></form></td>
  <td><small>joined ${esc(u.created_at.slice(0, 10))}<br>seen ${esc((u.last_seen_at ?? "").slice(0, 10))}</small></td>
</tr>`,
    )
    .join("");
  const inviteRows = invites.results
    .map(
      (i) => `<tr><td><b>${esc(i.pattern)}</b>${i.note ? `<br><small>${esc(i.note)}</small>` : ""}</td><td>${esc(i.plan_id)}</td><td><small>${esc(i.created_by ?? "")}<br>${esc(i.created_at.slice(0, 10))}</small></td>
  <td><form method="post" action="/admin/uninvite"><input type="hidden" name="pattern" value="${esc(i.pattern)}"><button>Remove</button></form></td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orro access</title><style>
:root{--bg:#fbfaff;--fg:#1d1b26;--mut:#6b6880;--line:#e4e1ef;--acc:#5b3fd6;--warn:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#15131c;--fg:#ece9f7;--mut:#9a96ad;--line:#2c2938;--acc:#b4a3ff;--warn:#3a3320}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
p{color:var(--mut);margin:4px 0 12px}.msg{background:var(--warn);color:var(--fg);padding:8px 12px;border-radius:8px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600}tr.pending td{background:var(--warn)}small{color:var(--mut)}
input,select,button{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
input[type=number]{width:90px}button{cursor:pointer;color:var(--acc);font-weight:600}form{display:inline}a{color:var(--acc)}
.add{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.add input[name=pattern]{min-width:220px}
</style></head><body><main>
<h1>Orro access</h1><p>Signed in as ${esc(who.user.email)} · <a href="/">Back to Orro</a> · <a href="/auth/logout">Sign out</a></p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ""}
<h2>Invite list</h2><p>Only these emails (or whole domains) get access when they sign in with a verified email. Everyone else waits as pending.</p>
<form class="add" method="post" action="/admin/invite"><input name="pattern" placeholder="ana@bu.edu or @bu.edu" required>${planSelect("free")}<input name="note" placeholder="note (optional)"><button>Invite</button></form>
<div class="wrap"><table><tr><th>Email or domain</th><th>Plan</th><th>Added by</th><th></th></tr>${inviteRows || '<tr><td colspan="4"><small>No invites yet.</small></td></tr>'}</table></div>
<h2>Users</h2><p>Pending accounts are highlighted. Set a plan to approve them; set Pending to cut someone off (signs them out).</p>
<div class="wrap"><table><tr><th>User</th><th>Plan</th><th>Balance</th><th>Spent</th><th>Credits</th><th></th></tr>${userRows || '<tr><td colspan="6"><small>No users yet.</small></td></tr>'}</table></div>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
