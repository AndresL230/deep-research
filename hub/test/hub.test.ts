// The hub against a local D1 and R2, through Wrangler's test harness: auth, storing and reading batches, the revision
// guard, idempotent events, motion files, limits, and the runner keys.

import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const TOKEN = "test-team-token";
const server = createTestHarness({
  workers: [{
    configPath: "./wrangler.jsonc",
    secrets: { TEAM_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-test", DAYTONA_API_KEY: "dtn-test" },
  }],
});
const worker = server.getWorker();

beforeAll(async () => { await server.listen(); });
beforeEach(async () => {
  await server.reset();
  await worker.applyD1Migrations("DB");
});
afterAll(async () => { await server.close(); });

type Call = { method?: string; body?: string | Uint8Array; headers?: Record<string, string>; json?: unknown; token?: string | null };

const call = (path: string, init: Call = {}) => {
  const { json, token = TOKEN, method, body, headers: extra } = init;
  const headers: Record<string, string> = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers["content-type"] = "application/json";
  return worker.fetch(`http://hub.test${path}`, { method, headers, body: json === undefined ? body : JSON.stringify(json) });
};

const CASE = {
  config: { dataset: "pima", trap: "duplicates", analyst_model: "anthropic:claude-haiku-5-5", investigator_model: "anthropic:claude-sonnet-5-5" },
  phase: "running",
  runs: { r01: { id: "r01", status: "honest" }, r02: { id: "r02", status: "inflated" }, r03: { id: "r03", status: "running" } },
  costs: { budget_usd: 10, spent_usd: 0.42, scopes: {} },
};

describe("auth", () => {
  test("health needs no token", async () => {
    const res = await call("/health", { token: null });
    expect(await res.json()).toEqual({ ok: true, configured: true });
  });

  test("every /v1 route needs the team token", async () => {
    expect((await call("/v1/batches", { token: null })).status).toBe(401);
    expect((await call("/v1/batches", { token: "wrong" })).status).toBe(401);
    expect((await call("/v1/runner-env", { token: null })).status).toBe(401);
    expect((await call("/v1/batches")).status).toBe(200);
  });

  test("ping says the token works and what the hub holds", async () => {
    expect((await call("/v1/ping", { token: "wrong" })).status).toBe(401);
    expect(await (await call("/v1/ping")).json()).toEqual({ ok: true, batches: 0, machines: 0, last_update: null });
    await call("/v1/batches/b1", { method: "PUT", json: { machine: "a", revision: 1, case: CASE } });
    await call("/v1/batches/b2", { method: "PUT", json: { machine: "b", revision: 1, case: CASE } });
    const after = await (await call("/v1/ping")).json() as { batches: number; machines: number; last_update: string };
    expect(after.batches).toBe(2);
    expect(after.machines).toBe(2);
    expect(typeof after.last_update).toBe("string");
  });

  test("hands the runner keys to a token holder", async () => {
    expect(await (await call("/v1/runner-env")).json()).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test", DAYTONA_API_KEY: "dtn-test" });
  });
});

describe("batches", () => {
  test("stores a case file and lists it with a summary", async () => {
    const put = await call("/v1/batches/1114-034546-6c7a", { method: "PUT", json: { machine: "andres-laptop", revision: 1, case: CASE, started_at: "2026-11-14T08:45:46Z" } });
    expect(await put.json()).toEqual({ ok: true, stored: true });
    const list = await (await call("/v1/batches")).json() as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "1114-034546-6c7a", machine: "andres-laptop", phase: "running", simulated: false, spent_usd: 0.42,
      started_at: "2026-11-14T08:45:46Z",
      summary: { runs: 3, honest: 1, inflated: 1, failed: 0, dataset: "pima", trap: "duplicates" },
    });
    expect(list[0]).not.toHaveProperty("case");
    const one = await (await call("/v1/batches/1114-034546-6c7a")).json() as Record<string, unknown>;
    expect(one.case).toEqual(CASE);
    const cases = await (await call("/v1/cases")).json() as Record<string, unknown>[];
    expect(cases[0].case).toEqual(CASE);
  });

  test("an older revision never overwrites a newer one", async () => {
    const path = "/v1/batches/b1";
    await call(path, { method: "PUT", json: { machine: "m", revision: 5, case: { ...CASE, phase: "done" } } });
    const stale = await call(path, { method: "PUT", json: { machine: "m", revision: 4, case: { ...CASE, phase: "running" } } });
    expect(await stale.json()).toEqual({ ok: true, stored: false });
    expect(((await (await call(path)).json()) as { phase: string }).phase).toBe("done");
  });

  test("rejects bad input", async () => {
    expect((await call("/v1/batches/bad%20id", { method: "PUT", json: { machine: "m", revision: 1, case: CASE } })).status).toBe(400);
    expect((await call("/v1/batches/b1", { method: "PUT", json: { machine: "", revision: 1, case: CASE } })).status).toBe(400);
    expect((await call("/v1/batches/b1", { method: "PUT", json: { machine: "m", revision: -1, case: CASE } })).status).toBe(400);
    expect((await call("/v1/batches/b1", { method: "PUT", json: { machine: "m", revision: 1, case: { runs: {} } } })).status).toBe(400);
    expect((await call("/v1/batches/b1", { method: "PUT", body: "not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    const huge = { ...CASE, blob: "x".repeat(2_000_000) };
    expect((await call("/v1/batches/b1", { method: "PUT", json: { machine: "m", revision: 1, case: huge } })).status).toBe(413);
    expect((await call("/v1/batches/nope")).status).toBe(404);
  });

  test("deletes a batch and its events", async () => {
    await call("/v1/batches/b1", { method: "PUT", json: { machine: "m", revision: 1, case: CASE } });
    await call("/v1/batches/b1/events", { method: "POST", json: { log: "r01", events: [{ seq: 0, event: { t: 1, type: "thought", text: "hi" } }] } });
    expect(await (await call("/v1/batches/b1", { method: "DELETE" })).json()).toEqual({ ok: true, deleted: true });
    expect((await call("/v1/batches/b1")).status).toBe(404);
    expect(await (await call("/v1/batches/b1/events?log=r01")).json()).toEqual([]);
  });
});

describe("events", () => {
  const ev = (seq: number) => ({ seq, event: { t: seq, type: "tool_call", id: `c${seq}`, name: "execute", args: { command: `echo ${seq}` } } });

  test("appends in order and skips a seq it already has", async () => {
    const path = "/v1/batches/b1/events";
    expect(await (await call(path, { method: "POST", json: { log: "r01", events: [ev(0), ev(1)] } })).json()).toEqual({ ok: true, inserted: 2 });
    // A retried push that overlaps adds only the new one.
    expect(await (await call(path, { method: "POST", json: { log: "r01", events: [ev(1), ev(2)] } })).json()).toEqual({ ok: true, inserted: 1 });
    await call(path, { method: "POST", json: { log: "f1/control-1", events: [ev(0)] } });
    const r01 = await (await call(`${path}?log=r01`)).json() as { t: number }[];
    expect(r01.map((e) => e.t)).toEqual([0, 1, 2]);
    expect(await (await call(`${path}?log=r01&after=0`)).json()).toHaveLength(2);
    expect(await (await call("/v1/batches/b1/logs")).json()).toEqual([
      { log: "f1/control-1", count: 1, last_seq: 0 },
      { log: "r01", count: 3, last_seq: 2 },
    ]);
  });

  test("rejects bad logs, bad events and too many at once", async () => {
    const path = "/v1/batches/b1/events";
    expect((await call(path, { method: "POST", json: { log: "../x", events: [] } })).status).toBe(400);
    expect((await call(path, { method: "POST", json: { log: "r01", events: [{ seq: -1, event: {} }] } })).status).toBe(400);
    expect((await call(path, { method: "POST", json: { log: "r01", events: [{ seq: 0, event: "text" }] } })).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ev(i));
    expect((await call(path, { method: "POST", json: { log: "r01", events: many } })).status).toBe(413);
    expect((await call(`${path}?log=a/b/c`)).status).toBe(400);
  });

  test("takes a full push of 500 events", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ev(i));
    expect(await (await call("/v1/batches/b1/events", { method: "POST", json: { log: "investigator", events: many } })).json()).toEqual({ ok: true, inserted: 500 });
  });
});

describe("files", () => {
  const MOTION = { header: { can_start: [0.3, 0.25] }, frames: [{ t: 0 }, { t: 0.5 }], result: { success: true } };
  const text = JSON.stringify(MOTION);
  const live = "/v1/batches/b1/files/runs/r01/outputs/live/v5_0.3,0.25_s0.motion.json";
  const put = (path: string, body: string | Uint8Array, headers: Record<string, string> = {}, token?: string | null) =>
    call(path, { method: "PUT", body, headers: { "content-type": "application/json", ...headers }, token });

  test("stores a gzipped motion file and hands it back", async () => {
    const res = await put(live, gzipSync(text), { "content-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const back = await call(live, { headers: { "accept-encoding": "gzip" } });
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("application/json");
    expect(back.headers.get("etag")).toBeTruthy();
    // Either still gzipped (the client unpacks it) or already unpacked on the way: the JSON is the same.
    const bytes = new Uint8Array(await back.arrayBuffer());
    const raw = bytes[0] === 0x1f ? gunzipSync(bytes).toString() : new TextDecoder().decode(bytes);
    expect(JSON.parse(raw)).toEqual(MOTION);
  });

  test("unpacks a gzipped file for a client that does not take gzip", async () => {
    await put(live, gzipSync(text), { "content-encoding": "gzip" });
    const back = await call(live, { headers: { "accept-encoding": "identity" } });
    expect(back.headers.get("content-encoding")).toBeNull();
    expect(await back.json()).toEqual(MOTION);
  });

  test("stores a plain file, replaces it, and answers 304 for an ETag it still has", async () => {
    const hidden = "/v1/batches/b1/files/forks/f1/control-1/hidden/07-s0.motion.json";
    await put(hidden, text);
    const first = await call(hidden);
    expect(await first.json()).toEqual(MOTION);
    const etag = first.headers.get("etag") as string;
    expect((await call(hidden, { headers: { "if-none-match": etag } })).status).toBe(304);
    await put(hidden, JSON.stringify({ ...MOTION, frames: [{ t: 0 }] }));
    const again = await call(hidden, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { frames: unknown[] }).frames).toHaveLength(1);
  });

  test("a file it does not have is 404, and the files go with their batch", async () => {
    expect((await call(live)).status).toBe(404);
    await call("/v1/batches/b1", { method: "PUT", json: { machine: "m", revision: 1, case: CASE } });
    await put(live, text);
    await put("/v1/batches/b2/files/runs/r01/outputs/live/x.motion.json", text);
    await call("/v1/batches/b1", { method: "DELETE" });
    expect((await call(live)).status).toBe(404);
    expect((await call("/v1/batches/b2/files/runs/r01/outputs/live/x.motion.json")).status).toBe(200);
  });

  test("needs the team token", async () => {
    expect((await put(live, text, {}, null)).status).toBe(401);
    expect((await call(live, { token: "wrong" })).status).toBe(401);
  });

  test("takes only motion files under a run's or fork child's outputs or hidden episodes", async () => {
    const bad = [
      "/v1/batches/b1/files/task/hidden_positions.json",
      "/v1/batches/b1/files/runs/r01/outputs/report.json",
      "/v1/batches/b1/files/runs/r01/events.jsonl",
      "/v1/batches/b1/files/runs/r01/hidden/sub/07.motion.json",
      "/v1/batches/b1/files/runs/r01/outputs/.secret.motion.json",
      "/v1/batches/b1/files/runs/r01/outputs/live%2F..%2F..%2Fx.motion.json",
      "/v1/batches/b1/files/runs/r01/outputs/%2e%2e/x.motion.json",
      "/v1/batches/b1/files/forks/f1/outputs/x.motion.json",
      `/v1/batches/b1/files/runs/r01/outputs/${"a".repeat(290)}.motion.json`,
    ];
    for (const path of bad) {
      const status = (await put(path, text)).status;
      expect([400, 404], path).toContain(status);
    }
    expect((await put("/v1/batches/b1/files/runs/r01/outputs/motion_01.json", text)).status).toBe(200);
    expect((await put("/v1/batches/bad%20id/files/runs/r01/outputs/x.motion.json", text)).status).toBe(400);
  });

  test("caps a file's size and refuses an empty or oddly encoded one", async () => {
    expect((await put(live, new Uint8Array(4_000_001).fill(0x20))).status).toBe(413);
    expect((await put(live, "")).status).toBe(400);
    expect((await put(live, text, { "content-encoding": "br" })).status).toBe(415);
  });
});

test("unknown routes are 404", async () => {
  expect((await call("/v1/nope")).status).toBe(404);
  expect((await call("/nope", { token: null })).status).toBe(404);
  expect((await call("/v1/batches/b1/other")).status).toBe(404);
});
