// The server's HTTP surface (docs/api-contract.md). Same origin: Vite proxies /api in dev; the server serves web/dist.

/** A fresh conversation id: the CLIENT makes it and resends it every turn. */
export function newConversationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Not a secure context (an IP over plain http): a v4 UUID from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError" || (e as { name?: string } | null)?.name === "AbortError";

/** A request that did not get an event stream back: what to tell the person. */
export class AskHttpError extends Error {}

async function httpMessage(res: Response): Promise<string> {
  // The Vite proxy answers 502/504 (or 500 with no body) when the server is not running.
  if (res.status === 502 || res.status === 503 || res.status === 504) return `Couldn't reach the server (HTTP ${res.status}). Is it running on port 8000?`;
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { detail?: unknown; message?: unknown };
      const d = j.detail ?? j.message;
      detail = typeof d === "string" ? d : d ? JSON.stringify(d) : "";
    } catch { detail = text.slice(0, 200); }
  } catch { /* no body */ }
  if (res.status === 500 && !detail.trim()) return `Couldn't reach the server (HTTP 500). Is it running on port 8000?`;
  return `The server answered HTTP ${res.status}${detail ? `: ${detail}` : "."}`;
}

/** `POST /api/ask` (multipart): the conversation, the message, and the CSV only on the turn it is attached. Resolves
 *  to the `text/event-stream` response; rejects with `AskHttpError` when the server did not answer with one. */
export async function postAsk(o: { conversation: string; message: string; file: File | null; signal: AbortSignal }): Promise<Response> {
  const fd = new FormData();
  fd.append("conversation", o.conversation);
  fd.append("message", o.message);
  if (o.file) fd.append("file", o.file, o.file.name);
  let res: Response;
  try {
    res = await fetch("/api/ask", { method: "POST", body: fd, signal: o.signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new AskHttpError("Couldn't reach the server. Is it running on port 8000?");
  }
  if (!res.ok) throw new AskHttpError(await httpMessage(res));
  if (!/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) throw new AskHttpError("The server did not answer with an event stream.");
  return res;
}

/** `DELETE /api/conversations/{id}`: the server deletes the sandbox and forgets the thread (204, unknown id too).
 *  `keepalive` lets it finish while the page unloads. Never fails loudly. */
export function deleteConversation(id: string, keepalive = false): void {
  void fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE", keepalive }).catch(() => undefined);
}

/** `GET /api/sample`: the bundled sales CSV, as a File named from its Content-Disposition. */
export async function fetchSample(): Promise<File> {
  let res: Response;
  try { res = await fetch("/api/sample"); } catch { throw new AskHttpError("Couldn't reach the server. Is it running on port 8000?"); }
  if (!res.ok) throw new AskHttpError(await httpMessage(res));
  const cd = res.headers.get("content-disposition") ?? "";
  const name = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? cd.match(/filename="?([^";]+)"?/i)?.[1] ?? "sales.csv";
  const blob = await res.blob();
  return new File([blob], decodeURIComponent(name), { type: "text/csv" });
}
