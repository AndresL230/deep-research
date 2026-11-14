// Ported from Trov (~/Projects/trov/test/render.ask-stream.test.ts) — the client's contract tests: the SSE reader
// (src/ask-sse.ts) and the turn fold (src/ask-stream.ts), run against a hand-written transcript in the shapes of
// docs/api-contract.md. If the server's events change shape, these fail.

import { describe, it, expect } from "vitest";
import { SseParser, askEventOf, readAskStream } from "../src/ask-sse";
import { foldAskEvent, newTurn, parseTodo, stopTurn, failTurn, turnLive, turnPhase, turnText, type AskTurn } from "../src/ask-stream";
import type { AskEvent } from "../src/ask-core";

/** A turn as the server streams it: thinking, a plan (write_todos), a script run, text, a chart, more text, done. */
const TRANSCRIPT = [
  `event: thinking\ndata: {"state":"run"}\n\n`,
  `event: thinking\ndata: {"state":"done","seconds":3,"summary":""}\n\n`,
  `event: activity\ndata: {"step":1,"state":"run","tool":"write_todos","icon":"sprint","label":"Planning"}\n\n`,
  `event: activity\ndata: {"step":1,"state":"done","results":["[x] Load the CSV","[~] Chart revenue by month","[ ] Write up the findings"],"resultLine":"1 of 3 done"}\n\n`,
  `event: activity\ndata: {"step":2,"state":"run","tool":"execute","icon":"ci","label":"Running analyze.py"}\n\n`,
  `event: activity\ndata: {"step":2,"state":"done","resultLine":"exit 0"}\n\n`,
  `event: text\ndata: {"delta":"## Revenue\\n\\nRevenue grew "}\n\n`,
  `event: text\ndata: {"delta":"**12%**."}\n\n`,
  `event: block\ndata: {"kind":"image","url":"/api/files/c1/revenue.png","alt":"Revenue by month"}\n\n`,
  `event: text\ndata: {"delta":"\\n\\nSee the chart."}\n\n`,
  `event: done\ndata: {"messageId":7,"cites":[],"tokens":{"in":100,"out":20,"cached":0}}\n\n`,
].join("");

function eventsOf(raw: string, chunk = 0): AskEvent[] {
  const p = new SseParser();
  const msgs = chunk > 0
    ? [...Array.from({ length: Math.ceil(raw.length / chunk) }, (_, i) => p.push(raw.slice(i * chunk, (i + 1) * chunk))).flat(), ...p.flush()]
    : [...p.push(raw), ...p.flush()];
  return msgs.map((m) => {
    const e = askEventOf(m);
    expect(e, `not an Ask event: ${m.event} ${m.data.slice(0, 80)}`).not.toBeNull();
    return e!;
  });
}

const fold = (events: AskEvent[], now = 1000): AskTurn => events.reduce((t, e) => foldAskEvent(t, e, now), newTurn());

describe("SseParser", () => {
  it("reads a message split across chunks at any point", () => {
    const whole = eventsOf(TRANSCRIPT);
    expect(whole).toHaveLength(11);
    for (const size of [1, 2, 3, 7, 16, 61]) expect(eventsOf(TRANSCRIPT, size)).toEqual(whole);
  });

  it("joins multi-line data, skips comments, and handles CRLF and a final message with no blank line", () => {
    const p = new SseParser();
    const out = [
      ...p.push(": keep-alive\r\n\r\nevent: text\r\ndata: {\"delta\":\r\n"),
      ...p.push("data: \"hi\"}\r\n\r\nevent: done\ndata: {\"messageId\":1,\"cites\":[],\"tokens\":{}}"),
      ...p.flush(),
    ];
    expect(out).toEqual([
      { event: "text", data: `{"delta":\n"hi"}` },
      { event: "done", data: `{"messageId":1,"cites":[],"tokens":{}}` },
    ]);
  });

  it("rejects what is not an Ask event of this contract", () => {
    expect(askEventOf({ event: "thread", data: `{"id":1}` })).toBeNull();          // Trov's, dropped here
    expect(askEventOf({ event: "text", data: `{not json` })).toBeNull();
    expect(askEventOf({ event: "block", data: `{"kind":"chart","chart":{}}` })).toBeNull();
    expect(askEventOf({ event: "block", data: `{"kind":"image","url":"/api/files/c/a.png","alt":""}` })).not.toBeNull();
  });
});

describe("foldAskEvent — the transcript folds into the expected turn", () => {
  it("thinking, two steps (one a plan), text deltas merged around an image block, done", () => {
    const t = fold(eventsOf(TRANSCRIPT));
    expect(t).toEqual({
      messageId: 7,
      thinking: { state: "done", seconds: 3, summary: "" },
      activity: [
        { step: 1, tool: "write_todos", icon: "sprint", label: "Planning", state: "done",
          results: ["[x] Load the CSV", "[~] Chart revenue by month", "[ ] Write up the findings"], resultLine: "1 of 3 done" },
        { step: 2, tool: "execute", icon: "ci", label: "Running analyze.py", state: "done", results: [], resultLine: "exit 0" },
      ],
      parts: [
        { kind: "text", md: "## Revenue\n\nRevenue grew **12%**." },
        { kind: "block", block: { kind: "image", url: "/api/files/c1/revenue.png", alt: "Revenue by month" } },
        { kind: "text", md: "\n\nSee the chart." },
      ],
      tokens: { in: 100, out: 20, cached: 0 },
      done: true,
      stopped: false,
      error: null,
    } satisfies AskTurn);
    expect(turnLive(t)).toBe(false);
    expect(turnPhase(t)).toBe("done");
    expect(turnText(t)).toBe("## Revenue\n\nRevenue grew **12%**.\n\nSee the chart.");
    expect(t.activity[0].results.map(parseTodo)).toEqual([
      { state: "done", text: "Load the CSV" }, { state: "doing", text: "Chart revenue by month" }, { state: "todo", text: "Write up the findings" },
    ]);
  });

  it("mid-stream: thinking runs from `now`, a step runs until its done", () => {
    const ev = eventsOf(TRANSCRIPT);
    expect(fold(ev.slice(0, 1), 42).thinking).toEqual({ state: "run", startedAt: 42 });
    expect(turnPhase(fold(ev.slice(0, 1)))).toBe("thinking");
    const mid = fold(ev.slice(0, 5));
    expect(mid.activity.map((s) => s.state)).toEqual(["done", "run"]);
    expect(turnPhase(mid)).toBe("working");
    expect(turnLive(mid)).toBe(true);
  });

  it("Stop keeps what ran and ends the rest; a dropped stream is an error; an error event ends running steps", () => {
    const ev = eventsOf(TRANSCRIPT);
    const mid = fold(ev.slice(0, 7));
    const stopped = stopTurn(mid);
    expect(stopped.stopped).toBe(true);
    expect(stopped.activity.every((s) => s.state === "done")).toBe(true);
    expect(stopped.parts).toEqual(mid.parts);
    expect(failTurn(mid).error).toEqual({ code: "failed", message: "The answer stopped before it finished." });
    expect(failTurn(fold(ev))).toEqual(fold(ev)); // a finished turn is left alone
    const err = foldAskEvent(fold(ev.slice(0, 5)), { event: "error", data: { code: "timeout", message: "Took too long." } }, 0);
    expect(err.error).toEqual({ code: "timeout", message: "Took too long." });
    expect(err.activity.every((s) => s.state === "done")).toBe(true);
    expect(turnPhase(err)).toBe("error");
  });
});

describe("early errors and opaque URLs (the server's notes)", () => {
  it("an error as the ONLY event of a turn (no thinking before it) is an error turn", () => {
    const ev = eventsOf(`event: error\ndata: {"code":"too_large","message":"The file is over 50 MB."}\n\n`);
    const t = fold(ev);
    expect(t.error).toEqual({ code: "too_large", message: "The file is over 50 MB." });
    expect(t.thinking).toBeNull();
    expect(t.parts).toEqual([]);
    expect(turnLive(t)).toBe(false);
    expect(turnPhase(t)).toBe("error");
  });

  it("an image URL with a cache-buster query is kept as is", () => {
    const ev = eventsOf(`event: block\ndata: {"kind":"image","url":"/api/files/c1/chart.png?v=2","alt":"Chart"}\n\n`);
    expect(fold(ev).parts).toEqual([{ kind: "block", block: { kind: "image", url: "/api/files/c1/chart.png?v=2", alt: "Chart" } }]);
  });
});

describe("readAskStream — a real Response, chunked; Stop aborts", () => {
  const respond = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(ctl) { const enc = new TextEncoder(); for (const c of chunks) ctl.enqueue(enc.encode(c)); ctl.close(); },
  }));

  it("hands every event over, whatever the chunking", async () => {
    const got: AskEvent[] = [];
    await readAskStream(respond(TRANSCRIPT.match(/[\s\S]{1,33}/g) ?? []), (e) => got.push(e));
    expect(got).toEqual(eventsOf(TRANSCRIPT));
  });

  it("rejects with an AbortError when the signal fires (Stop)", async () => {
    const ctl = new AbortController();
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`event: text\ndata: {"delta":"a"}\n\n`)); },
    }));
    const p = readAskStream(res, () => ctl.abort(), ctl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
