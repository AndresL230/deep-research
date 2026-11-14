// The batch client against the committed demo batch (fixtures/demo-batch/): if the case file or the event logs change
// shape, these fail. Plus the client's URL building, error messages and websocket folding.

import { afterEach, describe, expect, it, vi } from "vitest";
import caseRaw from "../../fixtures/demo-batch/case/case.json?raw";
import runEventsRaw from "../../fixtures/demo-batch/runs/r02/events.jsonl?raw";
import forcedEventsRaw from "../../fixtures/demo-batch/forks/f1/forced-1/events.jsonl?raw";
import {
  ApiError, CASE_SECTIONS, MAX_CONTROLLER_BYTES, MAX_SCRIPT_BYTES, PHASES, RUN_STATUSES, STEP_LABELS, applyMessage, batchFileUrl,
  batchSocketUrl, fetchBatches, fetchCase, isPendingForks, labPageUrl, postDecision, uploadController, type AgentEvent, type CaseFile,
  type ControllerInfo, type ForkExperiment,
} from "../src/api";

const demo = JSON.parse(caseRaw) as CaseFile;
const jsonl = (raw: string): AgentEvent[] => raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);

describe("the demo case file matches the types", () => {
  it("has every section and a known phase", () => {
    // The demo was saved before the diagnosis existed: `trace` and `fix` are absent and read as empty.
    const saved = CASE_SECTIONS.filter((s) => s !== "trace" && s !== "fix");
    expect(Object.keys(demo).sort()).toEqual([...saved].sort());
    for (const k of Object.keys(demo)) expect(CASE_SECTIONS).toContain(k);
    expect(CASE_SECTIONS).toContain("trace");
    expect(CASE_SECTIONS).toContain("fix");
    expect(PHASES).toContain(demo.phase);
    expect(demo.config).toMatchObject({ dataset: "pima", n_runs: 12, simulated: true });
  });

  it("has scored runs with labels from the known set", () => {
    const runs = Object.values(demo.runs);
    expect(runs).toHaveLength(12);
    for (const r of runs) {
      expect(RUN_STATUSES).toContain(r.status);
      expect(typeof r.reported_accuracy).toBe("number");
      expect(typeof r.true_accuracy).toBe("number");
      for (const step of r.labels ?? []) for (const l of step) expect(STEP_LABELS).toContain(l);
    }
  });

  it("has a split and a finished fork experiment", () => {
    expect(demo.split).toMatchObject({ label: "deduplicate", fork_run_id: "r02" });
    const f = demo.forks.f1;
    expect(isPendingForks(f)).toBe(false);
    const fork = f as ForkExperiment;
    expect(fork.arms?.control?.scored).toBe(4);
    for (const c of Object.values(fork.children)) expect(["control", "forced"]).toContain(c.arm);
    expect(demo.verdict?.step_label).toBe("deduplicate");
  });

  it("has event logs with the four event types", () => {
    const types = new Set(jsonl(runEventsRaw).map((e) => e.type));
    expect(types).toEqual(new Set(["todos", "tool_call", "tool_result", "thought"]));
    for (const e of [...jsonl(runEventsRaw), ...jsonl(forcedEventsRaw)]) {
      expect(typeof e.t).toBe("number");
      if (e.type === "tool_call") expect(typeof e.name).toBe("string");
      if (e.type === "todos") for (const t of e.todos) expect(["pending", "in_progress", "completed"]).toContain(t.status);
    }
  });

  it("never mentions the holdout labels", () => {
    expect(caseRaw).not.toContain("holdout_labels");
  });
});

describe("the websocket", () => {
  it("builds ws and wss URLs", () => {
    expect(batchSocketUrl("demo-batch", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/api/batches/demo-batch/ws");
    expect(batchSocketUrl("a b", { protocol: "https:", host: "x.dev" })).toBe("wss://x.dev/api/batches/a%20b/ws");
  });

  it("folds a snapshot, then section updates, and ignores events", () => {
    let c = applyMessage(null, { kind: "case", section: "phase", value: "running" });
    expect(c).toBeNull();
    c = applyMessage(c, { kind: "snapshot", case: demo, live: true });
    c = applyMessage(c, { kind: "case", section: "phase", value: "forking" });
    expect(c?.phase).toBe("forking");
    expect(c?.runs).toBe(demo.runs);
    const after = applyMessage(c, { kind: "event", run: "r01", event: { t: 1, type: "thought", text: "hi" } });
    expect(after).toBe(c);
  });
});

describe("REST", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (res: Response | Error) => {
    const f = vi.fn(async () => { if (res instanceof Error) throw res; return res; });
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("encodes file paths segment by segment", () => {
    expect(batchFileUrl("demo-batch", "runs/r01/live/02 confusion.png")).toBe("/api/batches/demo-batch/files/runs/r01/live/02%20confusion.png");
  });

  it("reads JSON", async () => {
    const f = stubFetch(new Response(JSON.stringify([{ id: "demo-batch", kind: "replay" }])));
    expect(await fetchBatches()).toEqual([{ id: "demo-batch", kind: "replay" }]);
    expect(f).toHaveBeenCalledWith("/api/batches", {});
  });

  it("posts JSON bodies", async () => {
    const f = stubFetch(new Response(JSON.stringify({ ok: true })));
    await postDecision("b1", true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/batches/b1/decision");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ approve: true });
  });

  it("uploads a controller as the request body", async () => {
    const info: ControllerInfo = { id: "ct-0123abcd", name: "my arm.py", lines: 80, imports: ["numpy"], missing_packages: [] };
    const f = stubFetch(new Response(JSON.stringify(info)));
    const py = Object.assign(new Blob(["class Controller: ...\n"]), { name: "my arm.py" });
    expect(await uploadController(py)).toEqual(info);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/controllers?name=my%20arm.py");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(py);
    expect(MAX_CONTROLLER_BYTES).toBe(MAX_SCRIPT_BYTES);
    // A refused controller carries the server's reason.
    stubFetch(new Response(JSON.stringify({ detail: "no class Controller" }), { status: 422 }));
    await expect(uploadController(py)).rejects.toMatchObject({ status: 422, message: "The server answered HTTP 422: no class Controller" });
  });

  it("turns errors into messages", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "no batch nope" }), { status: 404 }));
    await expect(fetchCase("nope")).rejects.toMatchObject({ status: 404, message: "The server answered HTTP 404: no batch nope" });
    stubFetch(new Response("", { status: 502 }));
    await expect(fetchCase("x")).rejects.toThrow(/Is it running on port 8000/);
    stubFetch(new TypeError("fetch failed"));
    await expect(fetchCase("x")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("labPageUrl", () => {
  it("points runs and fork children at the server's proxy, with the trailing slash", () => {
    expect(labPageUrl("b 1", "r01")).toBe("/api/batches/b%201/runs/r01/lab/");
    expect(labPageUrl("b1", "f1/control-1")).toBe("/api/batches/b1/forks/f1/control-1/lab/");
  });
});
