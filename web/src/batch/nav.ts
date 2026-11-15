// The app's top bar (main.ts `headerView`), on every page but the landing page: the logo, the links to the app's
// pages (How it works, Needs you with its count, Batches, Costs; Needs you and Costs for admins only), and on the right the hub badge, the theme switch and "+ New batch",
// which opens the New batch dialog (new-batch-dialog.ts). On a narrow screen the links fold into a menu button. Pure,
// like every view here: main.ts renders it and handles its actions.
//
// Needs you and Batches are the two sections of one page, the home screen. Each has its own address, so each link can
// be the current one and a link to either section can be shared: `#/start` opens the home at its top (Needs you),
// `#/batches` at the batch table (model.ts `parseRoute`).
import "./nav.css";
import { askIcon } from "../ask-icons";
import { attr, esc } from "../ui";
import { ACT, type Route } from "./model";

export type NavKey = "how" | "needs" | "batches" | "costs";

export const NAV_LINKS: readonly { key: NavKey; label: string; href: string }[] = [
  { key: "how", label: "How it works", href: "#/how" },
  { key: "needs", label: "Needs you", href: "#/start" },
  { key: "batches", label: "Batches", href: "#/batches" },
  { key: "costs", label: "Costs", href: "#/costs" },
];

/** The link of the page on screen, or null (a batch's pages: the breadcrumb says where they are). */
export function navCurrent(r: Route): NavKey | null {
  if (r.name === "home") return r.at === "batches" ? "batches" : "needs";
  if (r.name === "costs") return "costs";
  if (r.name === "how") return "how";
  return null;
}

/** The count as the badge shows it: nothing for none (or before the list loads), "99+" past 99. */
export const countLabel = (n: number | null): string => (!n || n < 0 ? "" : n > 99 ? "99+" : String(n));

/** The links only an admin has on the hosted site: Needs you (only an admin can act on what waits there) and Costs
 *  (the all-batches cost report). Local development, with no gateway, counts as an admin (access.ts). */
export const ADMIN_LINKS: ReadonlySet<NavKey> = new Set(["needs", "costs"]);

/** The links, for the bar or for the menu. `count` is how many batches wait on the person (needs-you.ts
 *  `needsCount`). `admin`: the person may act, so the admin-only links (`ADMIN_LINKS`) are there too. */
export function navLinks(r: Route, count: number | null, where: "bar" | "menu" = "bar", admin = true): string {
  const cur = navCurrent(r);
  const n = countLabel(count);
  const items = NAV_LINKS.filter((l) => admin || !ADMIN_LINKS.has(l.key)).map((l) => {
    const badge = l.key === "needs" && n
      ? `<span class="nv-n" aria-hidden="true">${n}</span><span class="nv-sr">, ${n} waiting</span>`
      : "";
    return `<li data-morph-key="${l.key}"><a class="nv-a" href="${l.href}" data-nav="${l.key}"${l.key === cur ? ` aria-current="page"` : ""}>`
      + `<span class="nv-l">${esc(l.label)}</span>${badge}</a></li>`;
  }).join("");
  return `<ul class="nv-list nv-list--${where}" data-morph-list>${items}</ul>`;
}

/** The links in the bar, on a wide screen. */
export function navBar(r: Route, count: number | null, admin = true): string {
  return `<nav class="nv" aria-label="Main" data-morph-key="nav">${navLinks(r, count, "bar", admin)}</nav>`;
}

const MENU_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" style="flex:none;display:block"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>`;

/**
 * The menu button and the links it unfolds, on a narrow screen (nav.css shows one or the other). A dot on the button
 * says something waits on the person while the count is folded away. `extra` goes under the links, as labelled rows
 * (`[label, html]`): what a phone's bar has no room for, the theme switch and the hub badge (nav.css shows them there
 * only).
 */
export function navMenu(r: Route, count: number | null, open: boolean, extra: readonly [string, string][] = [], admin = true): string {
  // The waiting count is an admin's: for anyone else nothing waits on them.
  const waiting = admin ? countLabel(count) : "";
  return `<div class="nv-menu" data-morph-key="nav-menu">
    <button type="button" class="nv-menu-b" data-act="${ACT.navMenu}" aria-expanded="${open}" aria-controls="nv-panel"${waiting ? ` title="${attr(`${waiting} waiting`)}"` : ""}>`
    + `${open ? askIcon("close", 16) : MENU_ICON}<span class="nv-sr">Menu${waiting ? `, ${waiting} waiting` : ""}</span>${waiting && !open ? `<span class="nv-dot" aria-hidden="true"></span>` : ""}</button>
    <div class="nv-panel" id="nv-panel"${open ? "" : " hidden"}>
      <nav aria-label="Main">${navLinks(r, count, "menu", admin)}</nav>
      ${extra.length ? `<div class="nv-panel-x">${extra.map(([label, html]) => `<div class="nv-row"><span>${esc(label)}</span>${html}</div>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

/** "+ New batch", the one filled button in the bar: it opens the New batch dialog. A phone shows "+ New". */
export function newBatchButton(open: boolean): string {
  return `<button type="button" class="nv-new" data-morph-key="new-batch" data-act="${ACT.newBatch}" aria-haspopup="dialog" aria-expanded="${open}" aria-label="New batch">`
    + `${askIcon("plus", 15, null, 2.2)}<span>New<span class="nv-new-x"> batch</span></span></button>`;
}

// ── keeping the count right ──────────────────────────────────────────────────

/** How often the batch list is fetched again on an app page: every 5 s while a batch runs, else every 10 s. */
export const refreshEvery = (live: boolean): number => (live ? 5_000 : 10_000);

/** Whether the list is due again, `last` being when the last fetch started (0: never). */
export const refreshDue = (now: number, last: number, live: boolean): boolean => now - last >= refreshEvery(live);
