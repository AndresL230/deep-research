// OWNER: subagent E. Replaying a saved batch on a timeline, and the replay controls.
import type { AgentEvent, CaseFile } from "../api";
import type { EventKey, ReplayState } from "./model";

/** Length of the replay timeline in seconds for a saved batch. */
export function replayDuration(full: CaseFile, events: Record<EventKey, AgentEvent[]>): number {
  void full; void events;
  return 0;
}

/** The case file as it was `t` seconds into the timeline. */
export function caseAt(full: CaseFile, events: Record<EventKey, AgentEvent[]>, t: number): CaseFile {
  void events; void t;
  return full;
}

/** Each event log cut to what had happened by `t`. */
export function eventsAt(full: CaseFile, events: Record<EventKey, AgentEvent[]>, t: number): Record<EventKey, AgentEvent[]> {
  void full; void t;
  return events;
}

/** Play / pause, speed, scrubber, restart, jump to end. */
export function replayBar(r: ReplayState): string {
  void r;
  return "";
}
