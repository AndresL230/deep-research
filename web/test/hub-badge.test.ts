// The hub badge: every state reads right, and the token never appears.

import { describe, expect, it } from "vitest";
import { ago, hubBadge, hubSummary } from "../src/batch/hub-badge";

const NOW = 1_800_000_000_000;

describe("hubSummary", () => {
  it("says when the hub is not set up, and how to set it up", () => {
    const s = hubSummary({ state: "off" }, NOW);
    expect(s.tone).toBe("off");
    expect(s.detail).toContain("HUB_URL and HUB_TOKEN");
  });

  it("shows a healthy connection with what the hub holds and the last push", () => {
    const s = hubSummary({
      state: "connected", url: "https://research-hub.andresl.dev", machine: "andres", batches: 6, machines: 2,
      queued: 0, last_push_at: NOW / 1000 - 125, push_error: null,
    }, NOW);
    expect(s).toMatchObject({ tone: "ok", label: "Hub" });
    expect(s.detail).toContain("Connected to research-hub.andresl.dev as andres");
    expect(s.detail).toContain("6 batches from 2 machines");
    expect(s.detail).toContain("last sent 2 min ago");
  });

  it("warns when updates are piling up behind an error", () => {
    const s = hubSummary({ state: "connected", queued: 12, push_error: "the hub could not be reached" }, NOW);
    expect(s).toMatchObject({ tone: "warn", label: "Hub: 12 waiting" });
    expect(s.detail).toContain("Retrying");
  });

  it("flags a wrong token and an unreachable hub", () => {
    expect(hubSummary({ state: "wrong_token", url: "https://h.test" }, NOW)).toMatchObject({ tone: "bad", label: "Hub: wrong token" });
    const down = hubSummary({ state: "unreachable", error: "the hub did not answer in time" }, NOW);
    expect(down).toMatchObject({ tone: "bad", label: "Hub unreachable" });
    expect(down.detail).toContain("did not answer in time");
  });

  it("is neutral while the first check is in flight", () => {
    expect(hubSummary(null, NOW).tone).toBe("off");
  });
});

describe("hubBadge", () => {
  it("escapes what the server sends", () => {
    const html = hubBadge({ state: "unreachable", error: "<img src=x>" }, NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("hb--bad");
  });

  it("formats ages", () => {
    expect([ago(3), ago(45), ago(600), ago(7200)]).toEqual(["just now", "45s ago", "10 min ago", "2 h ago"]);
  });
});
