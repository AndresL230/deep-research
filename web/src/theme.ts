// White mode and black mode: which one the app is in, the switch that changes it, and remembering the choice.
//
// The app opens in black mode. A choice made with the switch is kept in this browser and wins from then on. A
// `?theme=` in the address wins over both: `light` (white), `dark` (black), or `system` to follow the OS. The
// landing page and the rest of the app share the one setting.
import "./theme.css";

export type Theme = "light" | "dark";
/** What decides the theme: one of the two, or the OS's setting. */
export type ThemeChoice = Theme | "system";

/** Where the choice is kept in this browser. */
export const THEME_KEY = "orro-theme";

const isChoice = (v: string | null | undefined): v is ThemeChoice => v === "light" || v === "dark" || v === "system";

/** Which choice applies: the address's, else the one kept in this browser, else black. */
export function themeChoice(param: string | null, stored: string | null): ThemeChoice {
  if (isChoice(param)) return param;
  if (isChoice(stored)) return stored;
  return "dark";
}

/** The theme a choice comes to, given whether the OS asks for dark. */
export function resolveTheme(choice: ThemeChoice, osDark: boolean): Theme {
  if (choice === "system") return osDark ? "dark" : "light";
  return choice;
}

/** The choice kept in this browser, or null. Storage can be missing or refuse (a private window, blocked site
 *  data): then nothing is kept and the app still works. */
export function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* nothing kept; the switch still works until the page is left */
  }
}

/** The page's own background in each theme, for what shows past its ends when the scroll bounces. */
export const PAGE_BACKGROUND: Record<Theme, string> = { dark: "#15171b", light: "#fbfbfc" };

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"></path></svg>`;

/** The switch: two buttons, white and black, the current one pressed. Pressing one is handled in main.ts
 *  (`data-theme-pick`). */
export function themeSwitch(current: Theme): string {
  const button = (theme: Theme, label: string, icon: string): string =>
    `<button type="button" class="th-opt" data-theme-pick="${theme}" aria-pressed="${theme === current}" aria-label="${label}" title="${label}">${icon}</button>`;
  return `<div class="th-switch" role="group" aria-label="Theme" data-theme="${current}" data-morph-key="theme-switch">${button("light", "White mode", SUN)}${button("dark", "Black mode", MOON)}</div>`;
}
