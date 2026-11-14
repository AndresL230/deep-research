// The account chip: who is signed in, their plan and credits, and sign-in / sign-out. The gateway on Cloudflare
// (gateway/src/index.ts) answers /auth/me; in local development there is no gateway, so the chip stays hidden.

import "./account.css";

interface Me {
  signed_in: boolean;
  email?: string;
  plan_name?: string;
  balance_usd?: number;
  held_usd?: number;
  limits?: { unlimited: boolean; can_run?: boolean; is_admin?: boolean };
}

const money = (x: number) => `$${x.toFixed(2)}`;

export function signInUrl(): string {
  return `/auth/login?return=${encodeURIComponent(location.hash || "#/start")}`;
}

export async function mountAccount(): Promise<void> {
  let me: Me;
  try {
    const res = await fetch("/auth/me", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return; // no gateway (local dev)
    me = (await res.json()) as Me;
  } catch {
    return;
  }
  const el = document.createElement("div");
  el.className = "account-chip";
  if (!me.signed_in) {
    const a = document.createElement("a");
    a.href = signInUrl();
    a.textContent = "Sign in";
    a.addEventListener("click", () => (a.href = signInUrl()));
    el.append(a);
  } else {
    const who = document.createElement("span");
    who.className = "account-who";
    who.textContent = me.email ?? "";
    const credits = document.createElement("span");
    credits.className = "account-credits";
    credits.textContent = me.limits?.can_run === false
      ? "Waiting for access: an admin has to approve this account"
      : me.limits?.unlimited
      ? `${me.plan_name} · unlimited`
      : `${me.plan_name} · ${money(me.balance_usd ?? 0)} credits${me.held_usd ? ` (${money(me.held_usd)} held)` : ""}`;
    credits.title = "Credits pay for model and VM spend. A running batch holds its budget until it finishes; what it did not spend comes back.";
    const out = document.createElement("a");
    out.href = "/auth/logout";
    out.textContent = "Sign out";
    el.append(who, credits);
    if (me.limits?.is_admin) {
      const admin = document.createElement("a");
      admin.href = "/admin";
      admin.textContent = "Access";
      admin.title = "Invite people and manage plans and credits";
      el.append(admin);
    }
    el.append(out);
  }
  document.body.append(el);
}
