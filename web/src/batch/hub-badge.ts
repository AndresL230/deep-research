// The team hub's badge in the header: is this server connected to the hub, and are its batches getting there.
// Read from /api/health (`hub`), which main.ts refreshes every half minute.

import "./hub-badge.css";
import type { HubStatus } from "../api";
import { attr, esc } from "../ui";

export type HubTone = "ok" | "warn" | "bad" | "off";

/** Seconds ago in words: "just now", "40s ago", "3 min ago", "2 h ago". */
export function ago(seconds: number): string {
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** What the badge says and how it is colored, plus the longer explanation for its tooltip. */
export function hubSummary(h: HubStatus | null | undefined, nowMs: number = Date.now()): { tone: HubTone; label: string; detail: string } {
  if (!h) return { tone: "off", label: "Hub", detail: "Checking the hub…" };
  const host = h.url ? h.url.replace(/^https?:\/\//, "") : "the hub";
  switch (h.state) {
    case "off":
      return { tone: "off", label: "Hub off", detail: "Not connected to the team hub. Add HUB_URL and HUB_TOKEN to .env and restart the server to share batches with the team." };
    case "wrong_token":
      return { tone: "bad", label: "Hub: wrong token", detail: `${host} refused this server's token. Check HUB_TOKEN in .env. Batches stay on this machine until it is fixed.` };
    case "unreachable":
      return { tone: "bad", label: "Hub unreachable", detail: `${h.error ?? "Could not reach the hub"}. Batches keep running and are sent once it is back.` };
    case "connected": {
      const parts = [`Connected to ${host} as ${h.machine ?? "this machine"}`];
      if (h.batches != null) parts.push(`${h.batches} batch${h.batches === 1 ? "" : "es"} from ${h.machines ?? 0} machine${h.machines === 1 ? "" : "s"} on the hub`);
      if (h.last_push_at) parts.push(`last sent ${ago(nowMs / 1000 - h.last_push_at)}`);
      const queued = h.queued ?? 0;
      if (h.push_error && queued > 0) {
        return { tone: "warn", label: `Hub: ${queued} waiting`, detail: `${parts.join(". ")}. ${queued} update${queued === 1 ? "" : "s"} not sent yet: ${h.push_error}. Retrying.` };
      }
      if (queued > 0) parts.push(`${queued} update${queued === 1 ? "" : "s"} on the way`);
      return { tone: "ok", label: "Hub", detail: `${parts.join(". ")}.` };
    }
  }
}

/** The badge itself. */
export function hubBadge(h: HubStatus | null | undefined, nowMs: number = Date.now()): string {
  const s = hubSummary(h, nowMs);
  return `<span class="hb hb--${s.tone}" title="${attr(s.detail)}" role="status" aria-label="${attr(`${s.label}. ${s.detail}`)}">`
    + `<span class="hb-dot" aria-hidden="true"></span><span class="hb-t">${esc(s.label)}</span></span>`;
}
