// Ported from Trov (~/Projects/trov/web/src/ask-icons.ts)
//
// The icon set: the design's paths verbatim, drawn on a 24px stroke grid. One helper, `askIcon`, so every part draws
// them the same way. Trimmed to the icons this app uses (Trov's ref, thread, phone and write-card icons are gone).

import type { AskActivityIcon } from "./ask-core";

export const ASK_ICON_PATHS = {
  search: `<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path>`,
  docs: `<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>`,
  ci: `<circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path>`,
  read: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>`,
  sprint: `<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`,
  chart: `<path d="M3 3v18h18"></path><path d="M7 16v-4M12 16V8M17 16v-7"></path>`,
  csv: `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M9 4v16"></path>`,
  clock: `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>`,
  chevRight: `<path d="M9 6l6 6-6 6"></path>`,
  chevLeft: `<path d="M15 6l-6 6 6 6"></path>`,
  chevDown: `<path d="m6 9 6 6 6-6"></path>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"></path>`,
  plus: `<path d="M12 5v14M5 12h14"></path>`,
  close: `<path d="M5 5l14 14M19 5 5 19"></path>`,
  arrow: `<path d="M5 12h14M13 6l6 6-6 6"></path>`,
  external: `<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>`,
  send: `<path d="M12 19V5"></path><path d="m6 11 6-6 6 6"></path>`,
  attach: `<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"></path>`,
  upload: `<path d="M12 15V3"></path><path d="m7 8 5-5 5 5"></path><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"></path>`,
} as const;
export type AskIconName = keyof typeof ASK_ICON_PATHS;

/** An Ask icon: `currentColor` stroke unless `color` is given. Decorative (aria-hidden) — the control names itself. */
export function askIcon(name: AskIconName, size = 15, color: string | null = null, strokeWidth = 1.8): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block${color ? `;color:${color}` : ""}">${ASK_ICON_PATHS[name]}</svg>`;
}

/** An activity step's icon (`activity.icon`, ask-core.ts `ASK_ACTIVITY_ICONS`). */
export const ACTIVITY_ICON: Record<AskActivityIcon, AskIconName> = {
  search: "search", ci: "ci", sprint: "sprint", docs: "docs", read: "read",
};

/** The running step's spinner (`ask-spin`; still under reduced motion). */
export const askSpinner = (size = 13): string =>
  `<svg class="ask-spin" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:none;display:block;color:var(--fg-55)"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="2.4"></circle><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path></svg>`;
