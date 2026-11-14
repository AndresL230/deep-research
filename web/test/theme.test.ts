// White mode and black mode (src/theme.ts): which one applies, and the switch's markup.
import { describe, expect, it } from "vitest";
import { landingView } from "../src/landing/landing";
import { PAGE_BACKGROUND, resolveTheme, themeChoice, themeSwitch } from "../src/theme";

describe("which theme applies", () => {
  it("is black mode unless something says otherwise", () => {
    expect(themeChoice(null, null)).toBe("dark");
    expect(resolveTheme(themeChoice(null, null), false)).toBe("dark");
  });

  it("keeps the choice made with the switch", () => {
    expect(themeChoice(null, "light")).toBe("light");
    expect(themeChoice(null, "dark")).toBe("dark");
  });

  it("lets the address win over the kept choice", () => {
    expect(themeChoice("light", "dark")).toBe("light");
    expect(themeChoice("dark", "light")).toBe("dark");
    expect(themeChoice("system", "dark")).toBe("system");
  });

  it("ignores anything it does not know", () => {
    expect(themeChoice("purple", "sepia")).toBe("dark");
    expect(themeChoice("", "light")).toBe("light");
  });

  it("follows the OS only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("puts the page's own ground behind it, the landing page's black in black mode", () => {
    expect(PAGE_BACKGROUND.dark).toBe("#15171b");
    expect(PAGE_BACKGROUND.light).not.toBe(PAGE_BACKGROUND.dark);
  });
});

describe("the switch", () => {
  it("has a button for each mode, named, with the current one pressed", () => {
    for (const current of ["light", "dark"] as const) {
      const html = themeSwitch(current);
      expect(html).toContain('role="group" aria-label="Theme"');
      expect(html).toContain(`data-theme="${current}"`);
      expect(html).toMatch(/data-theme-pick="light" aria-pressed="(true|false)" aria-label="White mode"/);
      expect(html).toMatch(/data-theme-pick="dark" aria-pressed="(true|false)" aria-label="Black mode"/);
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(html).toContain(`data-theme-pick="${current}" aria-pressed="true"`);
    }
  });

  it("is in the landing page's nav, before its button, showing the page's own mode", () => {
    for (const tone of ["light", "dark"] as const) {
      const html = landingView(tone);
      const nav = html.slice(html.indexOf('<header class="lp-nav"'), html.indexOf("</header>"));
      expect(nav).toContain(`data-theme="${tone}"`);
      expect(nav.indexOf("th-switch")).toBeLessThan(nav.indexOf("lp-cta"));
      expect(html).toContain(`data-lp-tone="${tone}"`);
    }
  });
});
