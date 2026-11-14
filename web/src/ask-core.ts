// Ported from Trov (~/Projects/trov/shared/ai-ask-core.ts) — the Ask stream's event types, trimmed.
//
// The server (server/, Python) speaks exactly these shapes: docs/api-contract.md. Kept from Trov: `thinking`,
// `activity`, `text`, `block`, `done`, `error`. Dropped: `thread`, `action`, `action_result`, `artifact_saved`,
// `followups`, the modes, refs, write cards and every Trov-domain block. Added: the `image` block (a chart the
// agent saved in its sandbox, downloaded by the server and served at `/api/files/<conversation>/<name>`).

// ── Blocks ───────────────────────────────────────────────────────────────────

export const ASK_BLOCK_KINDS = ["image"] as const;
export type AskBlockKind = (typeof ASK_BLOCK_KINDS)[number];
export type AskBlock = { kind: "image"; url: string; alt: string };

// ── Activity ─────────────────────────────────────────────────────────────────
// The server maps each tool onto one of these: execute → ci; read_file, ls → read; write_file, edit_file → docs;
// grep, glob → search; write_todos → sprint; anything else → read.

export const ASK_ACTIVITY_ICONS = ["search", "read", "docs", "ci", "sprint"] as const;
export type AskActivityIcon = (typeof ASK_ACTIVITY_ICONS)[number];

// ── The stream: SSE events ───────────────────────────────────────────────────
// `thinking {run}` first; then `thinking {done}`, `activity`, `text` and `block` interleaved as the turn goes; then
// `done`. `error` ends a stream early. Each SSE message is `event: <name>` + `data: <json>`.

export const ASK_EVENTS = ["thinking", "activity", "text", "block", "done", "error"] as const;
export type AskEventName = (typeof ASK_EVENTS)[number];

export const ASK_ERROR_CODES = ["no_key", "timeout", "too_large", "failed"] as const;
export type AskErrorCode = (typeof ASK_ERROR_CODES)[number];

export interface AskTokens { in: number; out: number; cached: number }

export type AskActivityEvent =
  | { step: number; tool: string; icon: AskActivityIcon; label: string; state: "run" }
  | { step: number; state: "done"; results?: string[]; resultLine?: string };

export interface AskEventMap {
  /** `run` while it thinks (the client counts the seconds), then `done` with the summary (may be ""). */
  thinking: { state: "run" } | { state: "done"; seconds: number; summary: string };
  activity: AskActivityEvent;
  text: { delta: string };
  block: AskBlock;
  /** `cites` is always [] here (Trov's sources; kept so the shape matches). */
  done: { messageId: number; cites: unknown[]; tokens: AskTokens; stopped?: boolean };
  error: { code: AskErrorCode; message: string };
}
export type AskEvent = { [K in AskEventName]: { event: K; data: AskEventMap[K] } }[AskEventName];
