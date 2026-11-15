// The hub: one place where every teammate's local server records its batches, runs and costs, and where the
// runner keys live. Local servers push to it (deep_research/hub.py) and read from it, so the batch list and the cost
// screen show everyone's work, not only this machine's.
//
// Every /v1 route needs `Authorization: Bearer <TEAM_TOKEN>`. Anyone holding the token can read all batch data and
// the runner keys, so it is as private as the keys themselves.
//
//   GET    /health                          no auth; whether the hub is set up
//   GET    /v1/ping                         the token works: how many batches and machines the hub holds
//   GET    /v1/runner-env                   the runner keys stored as secrets on this Worker
//   GET    /v1/batches                      every batch, newest first, without the case file
//   GET    /v1/cases                        every batch with its case file (for the cost report)
//   PUT    /v1/batches/:id                  {machine, revision, case, started_at?}: store the case file
//   GET    /v1/batches/:id                  one batch with its case file
//   DELETE /v1/batches/:id                  remove a batch and its events
//   POST   /v1/batches/:id/events           {log, events: [{seq, event}]}: add events; a seq already stored is skipped
//   GET    /v1/batches/:id/logs             the logs a batch has, with their event counts
//   GET    /v1/batches/:id/events?log=r01   one log's events, in order
//   PUT    /v1/batches/:id/files/<path>     a robot run's motion file (body: the JSON, gzipped with content-encoding gzip
//                                           or plain); <path> is batch-relative, as in the case file's motion_files
//   GET    /v1/batches/:id/files/<path>     that file back, with its ETag; If-None-Match answers 304
//
// Motion files live in R2 (the FILES binding), the rest in D1. A hub deployed without FILES answers 503 on /files.

/** Secrets this Worker hands to local servers, so a key is changed in one place. */
export const RUNNER_KEYS = [
  "ANTHROPIC_API_KEY",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_SNAPSHOT",
  "LANGSMITH_API_KEY",
] as const;

type RunnerKey = (typeof RUNNER_KEYS)[number];
export type HubEnv = { DB: D1Database; FILES?: R2Bucket; TEAM_TOKEN?: string } & Partial<Record<RunnerKey, string>>;

const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LOG_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,39})?$/;
// D1 stores at most 2 MB in one value; leave room.
const MAX_VALUE_BYTES = 1_900_000;
const MAX_EVENTS_PER_PUSH = 500;
const MAX_ROWS = 500;
// A motion file as sent: one is a few hundred kB of JSON at most (robot_view.MAX_MOTION_BYTES is 2 MB unpacked).
const MAX_FILE_BYTES = 4_000_000;
const MAX_FILE_PATH = 300;
// One part of a file's path: no leading dot (so never `..` or a dotfile), no slash.
const PATH_PART = /^[A-Za-z0-9_,-][A-Za-z0-9._, -]{0,119}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// ── auth ─────────────────────────────────────────────────────────────────────

async function digest(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** Compare the bearer token with TEAM_TOKEN in constant time (both hashed first, so lengths match). */
async function authorized(request: Request, env: HubEnv): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.TEAM_TOKEN) return false;
  const [a, b] = await Promise.all([digest(m[1].trim()), digest(env.TEAM_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ── reading request bodies ───────────────────────────────────────────────────

async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function fits(text: string, what: string): string {
  if (new TextEncoder().encode(text).length > MAX_VALUE_BYTES) throw new HttpError(413, `${what} is larger than ${MAX_VALUE_BYTES} bytes`);
  return text;
}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** What the list and the cost screen need from a case file, so they never parse it. */
export function summarize(c: Record<string, unknown>): Record<string, unknown> {
  const config = obj(c.config);
  const runs = Object.values(obj(c.runs)).map(obj);
  const count = (status: string) => runs.filter((r) => r.status === status).length;
  return {
    runs: runs.length,
    honest: count("honest"),
    inflated: count("inflated"),
    failed: count("failed"),
    dataset: str(config.dataset),
    target: str(config.target),
    trap: str(config.trap),
    analyst_model: str(config.analyst_model),
    investigator_model: str(config.investigator_model),
    verdict: str(obj(c.verdict).sentence),
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

async function putBatch(env: HubEnv, id: string, request: Request): Promise<Response> {
  const b = await body(request);
  const machine = str(b.machine)?.trim() ?? "";
  if (!machine || machine.length > 64) throw new HttpError(400, "machine must be a name of 1 to 64 characters");
  const revision = num(b.revision);
  if (revision === null || !Number.isInteger(revision) || revision < 0) throw new HttpError(400, "revision must be a whole number of 0 or more");
  const c = b.case;
  if (!c || typeof c !== "object" || Array.isArray(c) || typeof (c as Record<string, unknown>).phase !== "string") {
    throw new HttpError(400, "case must be a case file (an object with a phase)");
  }
  const kase = c as Record<string, unknown>;
  const caseJson = fits(JSON.stringify(kase), "the case file");
  const startedAt = str(b.started_at);
  const now = new Date().toISOString();
  const config = obj(kase.config);
  const costs = obj(kase.costs);
  const simulated = config.simulated === true || costs.simulated === true ? 1 : 0;
  // An older push (a slow retry) never overwrites a newer one.
  const result = await env.DB.prepare(
    `INSERT INTO batches (id, machine, revision, phase, simulated, spent_usd, summary, case_json, started_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT (id) DO UPDATE SET
       machine = excluded.machine, revision = excluded.revision, phase = excluded.phase, simulated = excluded.simulated,
       spent_usd = excluded.spent_usd, summary = excluded.summary, case_json = excluded.case_json,
       started_at = COALESCE(excluded.started_at, batches.started_at), updated_at = excluded.updated_at
     WHERE excluded.revision >= batches.revision`,
  ).bind(id, machine, revision, kase.phase as string, simulated, num(costs.spent_usd), JSON.stringify(summarize(kase)), caseJson, startedAt, now).run();
  return json({ ok: true, stored: result.meta.changes > 0 });
}

type BatchRow = {
  id: string; machine: string; revision: number; phase: string; simulated: number; spent_usd: number | null;
  summary: string; started_at: string | null; created_at: string; updated_at: string; case_json?: string;
};

function batchOut(row: BatchRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id, machine: row.machine, revision: row.revision, phase: row.phase, simulated: row.simulated === 1,
    spent_usd: row.spent_usd, summary: JSON.parse(row.summary), started_at: row.started_at, created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.case_json !== undefined) out.case = JSON.parse(row.case_json);
  return out;
}

const LIST_COLUMNS = "id, machine, revision, phase, simulated, spent_usd, summary, started_at, created_at, updated_at";

async function listBatches(env: HubEnv, withCase: boolean): Promise<Response> {
  const columns = withCase ? `${LIST_COLUMNS}, case_json` : LIST_COLUMNS;
  const { results } = await env.DB.prepare(`SELECT ${columns} FROM batches ORDER BY updated_at DESC LIMIT ?1`).bind(MAX_ROWS).all<BatchRow>();
  return json(results.map(batchOut));
}

async function getBatch(env: HubEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${LIST_COLUMNS}, case_json FROM batches WHERE id = ?1`).bind(id).first<BatchRow>();
  if (!row) throw new HttpError(404, `no batch ${id}`);
  return json(batchOut(row));
}

async function deleteBatch(env: HubEnv, id: string): Promise<Response> {
  const [b] = await env.DB.batch([
    env.DB.prepare("DELETE FROM batches WHERE id = ?1").bind(id),
    env.DB.prepare("DELETE FROM events WHERE batch_id = ?1").bind(id),
  ]);
  if (env.FILES) await deleteFiles(env.FILES, id);
  return json({ ok: true, deleted: b.meta.changes > 0 });
}

async function deleteFiles(files: R2Bucket, id: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await files.list({ prefix: `${id}/`, cursor });
    if (page.objects.length) await files.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// ── motion files ─────────────────────────────────────────────────────────────

/**
 * A batch-relative motion file path, checked: under a run's or a fork child's outputs (`runs/r01/outputs/live/x.motion.json`)
 * or hidden episodes (`runs/r01/hidden/07-s0.motion.json`, `forks/f1/control-1/hidden/...`), named `*.motion.json` or
 * `motion*.json` (sim's OUTPUT_GLOBS). Anything else is refused, so the hub never holds task files or holdout labels.
 */
export function motionPath(parts: string[]): string {
  const bad = () => new HttpError(400, "a file must be a motion file under runs/<run>/outputs, runs/<run>/hidden or the same of forks/<fork>/<child>");
  const path = parts.join("/");
  if (path.length > MAX_FILE_PATH || !parts.every((p) => PATH_PART.test(p))) throw bad();
  const owner = parts[0] === "runs" ? 2 : parts[0] === "forks" ? 3 : 0;
  if (!owner || parts.length < owner + 2) throw bad();
  const area = parts[owner];
  if (!(area === "outputs" || (area === "hidden" && parts.length === owner + 2))) throw bad();
  const name = parts[parts.length - 1];
  if (!(name.endsWith(".motion.json") || (name.startsWith("motion") && name.endsWith(".json")))) throw bad();
  return path;
}

function fileStore(env: HubEnv): R2Bucket {
  if (!env.FILES) throw new HttpError(503, "this hub has no file storage yet: add the FILES R2 bucket to wrangler.jsonc and deploy");
  return env.FILES;
}

const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

async function putFile(env: HubEnv, id: string, path: string, request: Request): Promise<Response> {
  const files = fileStore(env);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FILE_BYTES) throw new HttpError(413, `a file is at most ${MAX_FILE_BYTES} bytes`);
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "gzip" && encoding !== "identity") throw new HttpError(415, "send a file plain or with content-encoding gzip");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, `a file is at most ${MAX_FILE_BYTES} bytes`);
  if (!bytes.length) throw new HttpError(400, "the file is empty");
  // Stored as it arrived; whether it is gzipped is read from the bytes, in case something on the way unpacked it.
  const gzipped = isGzip(bytes);
  const stored = await files.put(`${id}/${path}`, bytes, {
    httpMetadata: { contentType: "application/json", ...(gzipped ? { contentEncoding: "gzip" } : {}) },
  });
  return json({ ok: true, size: bytes.length, etag: stored.httpEtag });
}

async function getFile(env: HubEnv, id: string, path: string, request: Request): Promise<Response> {
  const files = fileStore(env);
  const obj = await files.get(`${id}/${path}`, { onlyIf: request.headers });
  if (!obj) throw new HttpError(404, `the hub has no ${path} for batch ${id}`);
  const headers = new Headers({ "content-type": "application/json", etag: obj.httpEtag, "cache-control": "private, no-cache" });
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const gzipped = obj.httpMetadata?.contentEncoding === "gzip";
  if (!gzipped) return new Response(obj.body, { headers });
  if (/\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) {
    headers.set("content-encoding", "gzip");
    // Already gzipped: sent as it is, not packed again.
    return new Response(obj.body, { headers, encodeBody: "manual" });
  }
  return new Response(obj.body.pipeThrough(new DecompressionStream("gzip")), { headers });
}

async function postEvents(env: HubEnv, id: string, request: Request): Promise<Response> {
  const b = await body(request);
  const log = str(b.log) ?? "";
  if (!LOG_KEY.test(log)) throw new HttpError(400, "log must be a run id (r01), a fork child (f1/control-1) or investigator");
  if (!Array.isArray(b.events)) throw new HttpError(400, "events must be a list");
  if (b.events.length > MAX_EVENTS_PER_PUSH) throw new HttpError(413, `send at most ${MAX_EVENTS_PER_PUSH} events at a time`);
  const rows = b.events.map((e, i) => {
    const item = obj(e);
    const seq = num(item.seq);
    if (seq === null || !Number.isInteger(seq) || seq < 0) throw new HttpError(400, `events[${i}].seq must be a whole number of 0 or more`);
    if (!item.event || typeof item.event !== "object") throw new HttpError(400, `events[${i}].event must be an object`);
    return { seq, event: fits(JSON.stringify(item.event), `events[${i}]`) };
  });
  if (!rows.length) return json({ ok: true, inserted: 0 });
  const insert = env.DB.prepare("INSERT OR IGNORE INTO events (batch_id, log, seq, event) VALUES (?1, ?2, ?3, ?4)");
  // One batch is one query against the per-invocation limit, however many statements it holds.
  const results = await env.DB.batch(rows.map((r) => insert.bind(id, log, r.seq, r.event)));
  return json({ ok: true, inserted: results.reduce((n, r) => n + r.meta.changes, 0) });
}

async function listLogs(env: HubEnv, id: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT log, COUNT(*) AS count, MAX(seq) AS last_seq FROM events WHERE batch_id = ?1 GROUP BY log ORDER BY log",
  ).bind(id).all<{ log: string; count: number; last_seq: number }>();
  return json(results);
}

async function getEvents(env: HubEnv, id: string, url: URL): Promise<Response> {
  const log = url.searchParams.get("log") ?? "";
  if (!LOG_KEY.test(log)) throw new HttpError(400, "log must be a run id (r01), a fork child (f1/control-1) or investigator");
  const after = Number(url.searchParams.get("after") ?? "-1");
  const { results } = await env.DB.prepare(
    "SELECT event FROM events WHERE batch_id = ?1 AND log = ?2 AND seq > ?3 ORDER BY seq",
  ).bind(id, log, Number.isFinite(after) ? after : -1).all<{ event: string }>();
  return json(results.map((r) => JSON.parse(r.event)));
}

/** For a server's status badge: the token works, and what the hub holds. One small read. */
async function ping(env: HubEnv): Promise<Response> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS batches, COUNT(DISTINCT machine) AS machines, MAX(updated_at) AS last_update FROM batches")
    .first<{ batches: number; machines: number; last_update: string | null }>();
  return json({ ok: true, batches: row?.batches ?? 0, machines: row?.machines ?? 0, last_update: row?.last_update ?? null });
}

function runnerEnv(env: HubEnv): Response {
  const out: Record<string, string> = {};
  for (const k of RUNNER_KEYS) if (env[k]) out[k] = env[k] as string;
  return json(out);
}

// ── the router ───────────────────────────────────────────────────────────────

async function route(request: Request, env: HubEnv): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (url.pathname === "/health" && method === "GET") {
    return json({ ok: true, configured: Boolean(env.TEAM_TOKEN) });
  }
  if (parts[0] !== "v1") throw new HttpError(404, "not found");
  if (!env.TEAM_TOKEN) throw new HttpError(503, "the hub has no TEAM_TOKEN yet: run `wrangler secret put TEAM_TOKEN`");
  if (!(await authorized(request, env))) throw new HttpError(401, "missing or wrong team token");

  if (parts.length === 2 && parts[1] === "ping" && method === "GET") return ping(env);
  if (parts.length === 2 && parts[1] === "runner-env" && method === "GET") return runnerEnv(env);
  if (parts.length === 2 && parts[1] === "cases" && method === "GET") return listBatches(env, true);
  if (parts[1] !== "batches") throw new HttpError(404, "not found");
  if (parts.length === 2 && method === "GET") return listBatches(env, false);

  const id = decodeURIComponent(parts[2] ?? "");
  if (!BATCH_ID.test(id)) throw new HttpError(400, "a batch id is 1 to 64 letters, digits, dots, dashes or underscores");
  if (parts.length === 3) {
    if (method === "PUT") return putBatch(env, id, request);
    if (method === "GET") return getBatch(env, id);
    if (method === "DELETE") return deleteBatch(env, id);
  }
  if (parts.length === 4 && parts[3] === "events") {
    if (method === "POST") return postEvents(env, id, request);
    if (method === "GET") return getEvents(env, id, url);
  }
  if (parts.length === 4 && parts[3] === "logs" && method === "GET") return listLogs(env, id);
  if (parts.length > 4 && parts[3] === "files") {
    let rel: string[];
    try {
      rel = parts.slice(4).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "the file path is not valid URL encoding");
    }
    const path = motionPath(rel);
    if (method === "PUT") return putFile(env, id, path, request);
    if (method === "GET") return getFile(env, id, path, request);
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request: Request, env: HubEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("hub error", e);
      return json({ error: "the hub failed; see `wrangler tail`" }, 500);
    }
  },
} satisfies ExportedHandler<HubEnv>;
