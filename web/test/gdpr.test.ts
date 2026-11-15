import { describe, expect, it } from "vitest";
import { PARTNERS, gdprView, isGdprKey } from "../src/gdpr";

const key = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("the GDPR notice (a joke)", () => {
  it("lists every partner as always on, with the three buttons", () => {
    const html = gdprView();
    for (const p of PARTNERS) expect(html).toContain(p.who);
    expect(html.match(/Always on/g)).toHaveLength(PARTNERS.length);
    for (const act of ["accept", "reject", "prefs"]) expect(html).toContain(`data-gdpr="${act}"`);
  });

  it("opens on Ctrl+E or Cmd+E only, and never while typing in a field", () => {
    expect(isGdprKey(key("e", { ctrlKey: true }))).toBe(true);
    expect(isGdprKey(key("E", { ctrlKey: true }))).toBe(true);
    expect(isGdprKey(key("e", { metaKey: true }))).toBe(true);
    expect(isGdprKey(key("e"))).toBe(false);
    expect(isGdprKey(key("r", { ctrlKey: true }))).toBe(false);
    expect(isGdprKey(key("e", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isGdprKey(key("e", { ctrlKey: true }), { tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(false);
    expect(isGdprKey(key("e", { ctrlKey: true }), { tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(false);
    expect(isGdprKey(key("e", { ctrlKey: true }), { tagName: "BODY", isContentEditable: false } as unknown as EventTarget)).toBe(true);
  });
});
