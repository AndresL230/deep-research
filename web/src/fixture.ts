// DEV ONLY (`?fixture=1`, main.ts): a canned answer replayed as a real `text/event-stream` Response, timed like a
// live one, so the screen can be looked at without the Python server. It goes through the SAME path as a live answer:
// ask-sse.ts reads it, ask-stream.ts folds it, the conversation renders it. Never in the production bundle (main.ts
// imports it behind `import.meta.env.DEV`).

import type { AskEvent } from "./ask-core";

/** A small bar chart as an SVG data URL — the image block's stand-in for `/api/files/<conversation>/<name>`. */
function chartUrl(): string {
  const rows: [string, number][] = [["Jan", 42], ["Feb", 48], ["Mar", 61], ["Apr", 57], ["May", 73], ["Jun", 88]];
  const w = 640, h = 320, pad = 48, bw = 56;
  const max = 100;
  const bars = rows.map(([m, v], i) => {
    const x = pad + 20 + i * ((w - pad * 2) / rows.length);
    const bh = ((h - pad * 2) * v) / max;
    return `<rect x="${x}" y="${h - pad - bh}" width="${bw}" height="${bh}" rx="3" fill="#525cc3"/><text x="${x + bw / 2}" y="${h - pad + 18}" font-size="13" text-anchor="middle" fill="#555">${m}</text><text x="${x + bw / 2}" y="${h - pad - bh - 6}" font-size="12" text-anchor="middle" fill="#333">${v}k</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#fff"/><text x="${pad}" y="28" font-family="sans-serif" font-size="15" font-weight="600" fill="#222">Monthly revenue, H1</text><g font-family="sans-serif">${bars}</g><line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#ccc"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const ANSWER = `## Revenue grew steadily through H1

Revenue rose from **$42k in January to $88k in June** — about *110%* growth, with one dip in April.

| Region | Revenue | Share |
|---|---|---|
| West | $142k | 38% |
| East | $121k | 33% |
| South | $106k | 29% |

Key points:
- The **West** region leads, driven by the \`Pro\` plan.
- April's dip lines up with a pricing change on the 3rd.
- June is the best month on record.
`;

const TAIL = `The chart above is saved as \`revenue_by_month.png\`. Ask a follow-up to break it down by product.`;

function plan(done: number, doing: boolean): string[] {
  const items = ["Load the CSV and inspect its columns", "Clean dates and revenue values", "Aggregate revenue by month and region", "Chart the monthly trend", "Write up the findings"];
  return items.map((t, i) => (i < done ? `[x] ${t}` : i === done && doing ? `[~] ${t}` : `[ ] ${t}`));
}

/** The canned turn, as [delay before it (ms), event]. */
export function fixtureEvents(): [number, AskEvent][] {
  const ev: [number, AskEvent][] = [
    [150, { event: "thinking", data: { state: "run" } }],
    [1600, { event: "thinking", data: { state: "done", seconds: 2, summary: "Planned the analysis: load the data, clean it, aggregate by month and region, then chart the trend." } }],
    [200, { event: "activity", data: { step: 1, state: "run", tool: "write_todos", icon: "sprint", label: "Planning the analysis" } }],
    [400, { event: "activity", data: { step: 1, state: "done", results: plan(0, true), resultLine: "0 of 5 done" } }],
    [300, { event: "activity", data: { step: 2, state: "run", tool: "ls", icon: "read", label: "Listing /home/daytona/data" } }],
    [500, { event: "activity", data: { step: 2, state: "done", resultLine: "1 file" } }],
    [200, { event: "activity", data: { step: 3, state: "run", tool: "write_file", icon: "docs", label: "Writing analyze.py" } }],
    [600, { event: "activity", data: { step: 3, state: "done", resultLine: "wrote 42 lines" } }],
    [200, { event: "activity", data: { step: 4, state: "run", tool: "execute", icon: "ci", label: "Running analyze.py" } }],
    [1800, { event: "activity", data: { step: 4, state: "done", results: ["rows: 1,204", "months: 6", "regions: 3", "saved outputs/revenue_by_month.png"], resultLine: "exit 0" } }],
    [200, { event: "activity", data: { step: 5, state: "run", tool: "write_todos", icon: "sprint", label: "Updating the plan" } }],
    [300, { event: "activity", data: { step: 5, state: "done", results: plan(4, true), resultLine: "4 of 5 done" } }],
  ];
  // The answer, in small deltas.
  const words = ANSWER.match(/\S+\s*|\s+/g) ?? [];
  for (let i = 0; i < words.length; i += 2) ev.push([45, { event: "text", data: { delta: words.slice(i, i + 2).join("") } }]);
  ev.push([300, { event: "block", data: { kind: "image", url: chartUrl(), alt: "Monthly revenue, H1" } }]);
  for (const w of TAIL.match(/\S+\s*/g) ?? []) ev.push([45, { event: "text", data: { delta: w } }]);
  ev.push([200, { event: "done", data: { messageId: 1, cites: [], tokens: { in: 5120, out: 640, cached: 0 } } }]);
  return ev;
}

/** The canned turn as a streamed `text/event-stream` Response (`signal` stops it, like a real fetch's). */
export function fixtureResponse(signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const events = fixtureEvents();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      let i = 0;
      const next = () => {
        if (signal.aborted) return;
        if (i >= events.length) { ctl.close(); return; }
        const [wait, e] = events[i++];
        timer = setTimeout(() => {
          // Split each message in two chunks, as a network would.
          const raw = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
          const cut = Math.floor(raw.length / 2);
          ctl.enqueue(enc.encode(raw.slice(0, cut)));
          ctl.enqueue(enc.encode(raw.slice(cut)));
          next();
        }, wait);
      };
      next();
    },
    cancel() { if (timer) clearTimeout(timer); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
