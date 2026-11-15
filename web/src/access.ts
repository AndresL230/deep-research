// Who may start and change batches. On the hosted site the Cloudflare gateway (gateway/src/index.ts) decides: reading
// is public (every batch, signed in or not), and starting a batch or acting on one (resume, more pairs, stop,
// investigate, approve or decline a fork, uploads, estimates) is for admins only. The app asks /auth/me once and hides
// those actions from everyone else, so nobody is sent to sign in just to look. Without a gateway (local development)
// /auth/me is not there, and everything is allowed as before.

/** /auth/me, as the gateway answers it. */
export interface Me {
  signed_in: boolean;
  email?: string;
  name?: string | null;
  plan?: string;
  plan_name?: string;
  balance_usd?: number;
  held_usd?: number;
  limits?: { unlimited?: boolean; can_run?: boolean; is_admin?: boolean };
}

export type Access =
  /** /auth/me has not answered yet. */
  | { kind: "unknown" }
  /** No gateway in front (local development): no sign-in, everything allowed. */
  | { kind: "local" }
  | { kind: "gateway"; me: Me };

/**
 * What the views draw for this visitor:
 * - "admin": the actions (an admin behind the gateway, or local development)
 * - "viewer": no actions, and a short line where one would be (anyone else behind the gateway)
 * - "unknown": no actions and no line yet, until /auth/me answers (so an admin does not see the line flash)
 */
export type Role = "admin" | "viewer" | "unknown";

export function roleOf(a: Access): Role {
  if (a.kind === "unknown") return "unknown";
  if (a.kind === "local") return "admin";
  return a.me.signed_in && a.me.limits?.is_admin ? "admin" : "viewer";
}

/** The visitor may start and change batches. */
export const canAct = (a: Access): boolean => roleOf(a) === "admin";

/** The lines a viewer sees where an action would be. */
export const ADMIN_ONLY = {
  start: "Only admins can start batches. Every batch here can be opened and replayed.",
  act: "Only admins can resume, investigate or stop batches.",
  approve: "Only admins can approve or decline a fork.",
} as const;

/** Ask the gateway who this is. An answer that is not JSON (the dev server's index.html, a 404) means there is no
 *  gateway. No answer at all stays unknown: the actions stay hidden, and the gateway would refuse them anyway. */
export async function loadAccess(get: typeof fetch = fetch): Promise<Access> {
  try {
    const res = await get("/auth/me", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return { kind: "local" };
    return { kind: "gateway", me: (await res.json()) as Me };
  } catch {
    return { kind: "unknown" };
  }
}
