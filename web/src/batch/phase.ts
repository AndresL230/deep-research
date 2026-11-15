// An `error: x` phase in words: what the batch list, the header tag and the investigator panel say, with the raw
// exception text folded behind a "details" disclosure rather than shown as the batch's state.

import { esc } from "../ui";

export const STOPPED_BY_ERROR = "Stopped by an error";

/** An `error: x` phase's raw text behind a "details" disclosure, or "" for any other phase. */
export const phaseDetails = (phase: string): string => {
  const raw = /^error:\s*(.*)$/s.exec(phase)?.[1].trim();
  return raw ? `<details class="ph-details"><summary>details</summary><code>${esc(raw)}</code></details>` : "";
};
