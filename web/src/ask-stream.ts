// Ported from Trov (~/Projects/trov/web/src/ask-stream.ts)
//
// The conversation state model. Pure: no DOM, no fetch.
//
// One assistant answer is an `AskTurn`, folded event by event from the SSE stream (`foldAskEvent`). Every part of
// the answer renders from it:
//   • activity  — the steps, in order, `run` → `done` (results + resultLine)
//   • thinking  — `run` (the CLIENT counts the seconds from `startedAt`) → `done` { seconds, summary }
//   • parts     — what the answer SHOWS, in the order it arrived: markdown text (deltas merged) and blocks (images)
//   • tokens, stopped, error
// Dropped from Trov: write cards (`action` / `action_result`), saved artifacts, follow-ups, cites, modes, threads,
// stored-message rebuilding (`turnFromMessage`) — this app keeps no history across reloads.

import type { AskActivityIcon, AskBlock, AskEvent, AskTokens } from "./ask-core";

export interface AskStep {
  step: number;
  tool: string;
  icon: AskActivityIcon;
  label: string;
  state: "run" | "done";
  results: string[];
  resultLine: string | null;
}

export type AskThinking =
  | { state: "run"; startedAt: number }
  | { state: "done"; seconds: number; summary: string };

export type AskPartVm =
  | { kind: "text"; md: string }
  | { kind: "block"; block: AskBlock };

export interface AskTurn {
  /** The server's message id, once `done` names it (null while streaming). */
  messageId: number | null;
  activity: AskStep[];
  thinking: AskThinking | null;
  parts: AskPartVm[];
  tokens: AskTokens | null;
  /** `done` arrived (stopped or not). */
  done: boolean;
  stopped: boolean;
  error: { code: string; message: string } | null;
}

export function newTurn(): AskTurn {
  return { messageId: null, activity: [], thinking: null, parts: [], tokens: null, done: false, stopped: false, error: null };
}

/** Where the answer stands, for the screen: nothing yet, reading (steps running), thinking, writing, or over. */
export type AskTurnPhase = "waiting" | "working" | "thinking" | "writing" | "done" | "stopped" | "error";
export function turnPhase(t: AskTurn): AskTurnPhase {
  if (t.error) return "error";
  if (t.stopped) return "stopped";
  if (t.done) return "done";
  if (t.parts.length) return "writing";
  if (t.thinking?.state === "run") return "thinking";
  if (t.activity.some((s) => s.state === "run")) return "working";
  return t.activity.length || t.thinking ? "working" : "waiting";
}
/** The answer is still coming (Send is Stop, the cursor blinks). */
export const turnLive = (t: AskTurn): boolean => !t.done && !t.stopped && !t.error;

/** Fold ONE event into the turn. Pure: returns a new turn (the input is not changed); `now` is Date.now(). */
export function foldAskEvent(t: AskTurn, e: AskEvent, now: number): AskTurn {
  switch (e.event) {
    case "thinking": {
      const d = e.data;
      return { ...t, thinking: d.state === "run" ? { state: "run", startedAt: now } : { state: "done", seconds: d.seconds, summary: d.summary } };
    }
    case "activity": {
      const d = e.data;
      if (d.state === "run") {
        const step: AskStep = { step: d.step, tool: d.tool, icon: d.icon, label: d.label, state: "run", results: [], resultLine: null };
        return { ...t, activity: [...t.activity.filter((s) => s.step !== d.step), step] };
      }
      return { ...t, activity: t.activity.map((s) => s.step === d.step ? { ...s, state: "done", results: d.results ?? [], resultLine: d.resultLine ?? null } : s) };
    }
    case "text": {
      const last = t.parts[t.parts.length - 1];
      const parts = last?.kind === "text"
        ? [...t.parts.slice(0, -1), { kind: "text" as const, md: last.md + e.data.delta }]
        : [...t.parts, { kind: "text" as const, md: e.data.delta }];
      return { ...t, parts };
    }
    case "block": return { ...t, parts: [...t.parts, { kind: "block", block: e.data }] };
    case "done": {
      const d = e.data;
      return { ...t, messageId: d.messageId, tokens: d.tokens, done: true, stopped: d.stopped === true,
        activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) };
    }
    case "error": return { ...t, error: { code: e.data.code, message: e.data.message }, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) };
  }
}

/** The client stopped the stream (Stop, or the request went away): what ran stays done, the rest is partial. */
export function stopTurn(t: AskTurn): AskTurn {
  if (!turnLive(t)) return t;
  return { ...t, stopped: true, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s),
    thinking: t.thinking?.state === "run" ? null : t.thinking };
}

/** The stream closed with no `done` and no `error` (the connection dropped). */
export function failTurn(t: AskTurn, message = "The answer stopped before it finished."): AskTurn {
  return turnLive(t) ? { ...t, error: { code: "failed", message }, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) } : t;
}

/** The answer's text alone: every text part, joined. */
export const turnText = (t: AskTurn): string => t.parts.filter((p): p is { kind: "text"; md: string } => p.kind === "text").map((p) => p.md).join("");

// ── the conversation ─────────────────────────────────────────────────────────

/** A CSV that went with a question: its name and size (the File itself, kept for Try again). */
export interface AskSentFile { name: string; size: number; file: File | null }

export interface AskQuestion {
  role: "user";
  /** Stable client key (`q1`, …). */
  key: string;
  text: string;
  file: AskSentFile | null;
}
export interface AskAnswer { role: "assistant"; key: string; turn: AskTurn }
export type AskMsg = AskQuestion | AskAnswer;

export interface AskConvo {
  /** The conversation's id: a UUID the CLIENT makes and resends every turn (docs/api-contract.md). */
  id: string;
  messages: AskMsg[];
  /** A stream is in flight (Send is Stop). */
  busy: boolean;
}

/** The last answer of the conversation (the one a stream folds into). */
export function lastAnswer(c: AskConvo): AskAnswer | null {
  for (let i = c.messages.length - 1; i >= 0; i--) { const m = c.messages[i]; if (m.role === "assistant") return m; }
  return null;
}
/** Replace the last answer's turn. */
export function withLastTurn(c: AskConvo, f: (t: AskTurn) => AskTurn): AskConvo {
  const i = c.messages.map((m) => m.role).lastIndexOf("assistant");
  if (i < 0) return c;
  const m = c.messages[i] as AskAnswer;
  return { ...c, messages: [...c.messages.slice(0, i), { ...m, turn: f(m.turn) }, ...c.messages.slice(i + 1)] };
}

// ── write_todos ──────────────────────────────────────────────────────────────

/** A plan item from a `write_todos` step's results: `"[x] text"` done, `"[~] text"` in progress, `"[ ] text"`. */
export interface AskTodo { state: "done" | "doing" | "todo"; text: string }
export function parseTodo(line: string): AskTodo {
  const m = line.match(/^\s*\[([ xX~])\]\s*(.*)$/);
  if (!m) return { state: "todo", text: line.trim() };
  return { state: m[1] === "~" ? "doing" : m[1] === " " ? "todo" : "done", text: m[2] };
}
export const isTodoStep = (s: Pick<AskStep, "tool">): boolean => s.tool === "write_todos";
