// The account chip: who is signed in, and sign-in / sign-out. The gateway on Cloudflare (gateway/src/index.ts)
// answers /auth/me (access.ts); in local development there is no gateway, so the chip stays hidden.
//
// Reading Orro needs no sign-in, so a visitor who is signed out sees no chip at all. Admins sign in at /auth/login (or
// /admin, which sends them there), and any admin action taken while signed out goes to sign-in too (api.ts). Once
// signed in, an admin sees their plan and credits and the "Access" link to /admin; anyone else signed in is told the
// site is read-only for them.

import "./account.css";
import type { Access, Me } from "./access";

const money = (x: number) => `$${x.toFixed(2)}`;

/** The chip's middle line for someone signed in. */
export function accountLine(me: Me): string {
  if (!me.limits?.is_admin) return "Read only: only admins start or change batches";
  return me.limits.unlimited
    ? `${me.plan_name} · unlimited`
    : `${me.plan_name} · ${money(me.balance_usd ?? 0)} credits${me.held_usd ? ` (${money(me.held_usd)} held)` : ""}`;
}

export function mountAccount(access: Access): void {
  if (access.kind !== "gateway") return; // no gateway (local development), or it did not answer
  const me = access.me;
  if (!me.signed_in) return; // reading needs no account: no chip, no sign-in button
  const el = document.createElement("div");
  el.className = "account-chip";
  const who = document.createElement("span");
  who.className = "account-who";
  who.textContent = me.email ?? "";
  const line = document.createElement("span");
  line.className = "account-credits";
  line.textContent = accountLine(me);
  line.title = me.limits?.is_admin
    ? "Credits pay for model and VM spend. A running batch holds its budget until it finishes; what it did not spend comes back."
    : "Every batch can be opened and replayed. Starting, resuming, investigating and stopping batches is for admins.";
  const out = document.createElement("a");
  out.href = "/auth/logout";
  out.textContent = "Sign out";
  el.append(who, line);
  if (me.limits?.is_admin) {
    const admin = document.createElement("a");
    admin.href = "/admin";
    admin.textContent = "Access";
    admin.title = "Invite people and manage plans and credits";
    el.append(admin);
  }
  el.append(out);
  document.body.append(el);
}
