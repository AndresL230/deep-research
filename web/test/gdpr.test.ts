import { describe, expect, it } from "vitest";
import { GDPR_KEY, PARTNERS, gdprDismissed, gdprView } from "../src/gdpr";

const store = (v: string | null) => ({ getItem: (k: string) => (k === GDPR_KEY ? v : null), setItem() {} });

describe("the GDPR notice (a joke)", () => {
  it("lists every partner as always on, with the three buttons", () => {
    const html = gdprView();
    for (const p of PARTNERS) expect(html).toContain(p.who);
    expect(html.match(/Always on/g)).toHaveLength(PARTNERS.length);
    for (const act of ["accept", "reject", "prefs"]) expect(html).toContain(`data-gdpr="${act}"`);
  });

  it("stays closed once dismissed, and shows when storage is empty or throws", () => {
    expect(gdprDismissed(store("1"))).toBe(true);
    expect(gdprDismissed(store(null))).toBe(false);
    expect(gdprDismissed(null)).toBe(false);
    expect(gdprDismissed({ getItem: () => { throw new Error("blocked"); }, setItem() {} })).toBe(false);
  });
});
