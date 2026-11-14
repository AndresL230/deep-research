// OWNER: subagent D. One run (or fork child) in the Ask conversation view.
import type { AgentEvent } from "../api";
import type { AskConvo } from "../ask-stream";
import type { BatchVm, EventKey } from "./model";

/** An event log as a conversation: the task as the question, the agent's work as one streamed answer. */
export function eventsToConvo(key: EventKey, events: AgentEvent[], opts: { task: string; finished: boolean; now: number }): AskConvo {
  void events; void opts;
  return { id: key, messages: [], busy: false };
}

/** The strip above the conversation: which run, its status and score, charts, back to the batch. */
export function runSummaryView(vm: BatchVm, key: EventKey): string {
  void vm; void key;
  return "";
}
