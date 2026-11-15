# Orro behind Cloudflare: sign-in, plans and API credits

Orro's agents spend real money (Anthropic tokens and Daytona VMs). The gateway lets anyone read every batch without
signing in, and lets only signed-in admins start or change one, within the admin plan's limits and credits.

```
browser ──► Cloudflare Worker "orro" (gateway/) ──► Fly.io "orro-research" (Python server)
               │  serves web/dist (static assets)          only answers requests carrying
               │  /auth/*  WorkOS AuthKit sign-in           ORRO_GATEWAY_SECRET (deep_research/gateway_guard.py)
               │  /api/*   reads: forwards; changes: admins only, checks credits
               └─ D1 "orro-gateway": plans, users, sessions, batches, ledger
```

- Site: https://orrolab.dev (registered at Cloudflare; www.orrolab.dev and the old orro.josecruz.workers.dev redirect here)
- Cloudflare account: `f56d3cab31332778edabd283b5d28d17`
- D1: `orro-gateway` (`e0d7b332-8491-4a03-9cd9-6ba915716acd`)
- WorkOS: orro's Project, Staging, client `client_01M7E1DADCB6H2JHDQEN6Q9D67`. Redirect URI
  `https://orrolab.dev/auth/callback` (default), sign-out URI `https://orrolab.dev/` (default). The old workers.dev
  entries are still listed and harmless.

## Sign-in

`/auth/login` sends the browser to WorkOS AuthKit with PKCE, so the Worker holds no WorkOS API key.
`/auth/callback` exchanges the code, creates the user in D1 on first sign-in, and sets an HttpOnly session cookie
(30 days; D1 stores only its SHA-256). `/auth/me` returns the user, plan and balance. `/auth/logout` ends both the
Orro session and the WorkOS session.

## Accounts and invites

Signing in only matters for admins: everyone can read every batch without an account (see "Public without sign-in"
below). Anyone can still create a WorkOS account. A new account starts on the `pending` plan. An account gets another
plan when one of these is true:

- its email is in the `ADMIN_EMAILS` Worker secret (`wrangler secret put ADMIN_EMAILS`), giving the `admin` plan
- its email, or its whole domain (`@bu.edu`), is on the invite list, giving the plan the invite names
- an admin sets its plan on the admin page

Invites only match emails WorkOS has verified, so nobody can claim an invited address they do not own. Only the
`admin` plan can start or change batches now, so an invite to `free` or `pro` gives nothing beyond what a visitor
who is signed out already has.

Manage access at **https://orrolab.dev/admin** (admins only; the "Access" link in the account
chip). Inviting an email or domain also approves anyone with a matching email who is already waiting. Setting a user
back to `pending` signs them out; setting an admin to any other plan takes away their admin actions. Make sure each
person who should start batches is on the `admin` plan: `ADMIN_EMAILS` only applies to an account that is new or
still `pending` when it signs in, so move anyone already on `free` or `pro` on the admin page (or with SQL).

## What each plan may do

**Only admins start batches.** The other plans are kept (the tables, credits and charging code are unchanged), but
the gateway answers 403 when they try to start, resume, stop or investigate a batch, upload a file, or ask for an
estimate. So today only the `admin` row below applies; the others say what those plans would get if the gateway let
non-admins act again. Plans are rows in the `plans` table. Change them with SQL, no deploy needed.

| plan  | signup credit | monthly refill to | max per batch | max runs | open batches | models | uploads |
|-------|---------------|-------------------|---------------|----------|--------------|--------|---------|
| pending | none         |                   | no access     |          |              |        | no      |
| free  | $1            | $1                | $1            | 4        | 1            | Haiku  | no      |
| pro   | $0            | $20               | $10           | 24       | 3            | Haiku, Sonnet | yes |
| admin | unlimited     |                   | $100          | 48       | 10           | all    | yes     |

Public without sign-in: every read. Any `GET` or `HEAD` under `/api` works for anyone, signed in or not: the batch
list with every user's batches, each batch's case file, event logs, files, motion, lab pages and websocket, the
"more pairs" quote, the datasets and controllers lists, the investigator's notebooks, `/api/defaults`,
`/api/robot/scene` and `/api/health`. The one read kept back is `/api/costs`, the all-batches cost report, which
counts as part of the admin area (signed out 401, signed in but not admin 403). To make it public too, remove it
from `ADMIN_READS` in `gateway/src/index.ts`.

Admins only: everything that is not a read. That is starting a batch (`POST /api/batches`), every `POST` under
`/api/batches/{id}/` (resume, more pairs, stop, investigate, a fork decision), estimates, uploads (datasets, scripts,
controllers) and any other non-read call. Signed out gets 401 with `sign_in: "/auth/login"`; signed in without the
admin plan gets 403 ("Starting and changing batches is limited to admins."). `/admin` is for admins, as before.

The web app asks `/auth/me` and shows the actions (+ New batch, Costs, Investigate, Approve, Stop, Run more,
uploads) only to admins. Everyone else can open and replay any batch, and is sent to sign in only if they try an
action. The landing page's button says "See the batches" for them and "Start a batch" for admins.

## How credits are charged

1. **Reserve.** `POST /api/batches` (admins only) caps the batch's `budget_usd` to the plan's maximum. It takes that
   amount plus the captions' cap (at most $0.50) from the balance in one conditional `UPDATE`. A balance that is
   too low gets HTTP 402.
2. **Enforce.** The capped `budget_usd` goes to Fly, and Orro's own budget guard (`deep_research/costs.py`) stops the
   batch when it reaches it.
3. **Settle.** Every 10 minutes (cron), and whenever the user's page loads `/auth/me`, the gateway reads each open
   batch's case file. When a batch is `done`, `stopped`, `no_split`, `blocked` or `error`, its actual
   `costs.spent_usd` is charged and the rest of the hold is returned. When prices are unknown, the full hold is
   charged.
4. **Resume.** Resuming a settled batch holds its remaining headroom again.

Every change is a row in `ledger`.

## Common tasks

```sh
cd gateway
# Invite someone (or a whole domain) without the admin page
wrangler d1 execute orro-gateway --remote --command "INSERT INTO invites (pattern, plan_id, note) VALUES ('@bu.edu', 'free', 'BU students')"
# Move a user to pro
wrangler d1 execute orro-gateway --remote --command "UPDATE users SET plan_id='pro' WHERE email='someone@example.com'"
# Give credits (and record it)
wrangler d1 execute orro-gateway --remote --command "UPDATE users SET balance_usd=balance_usd+5 WHERE email='someone@example.com'; INSERT INTO ledger (user_id, kind, amount_usd, note) SELECT id, 'adjust', 5, 'manual top-up' FROM users WHERE email='someone@example.com'"
# Who spent what
wrangler d1 execute orro-gateway --remote --command "SELECT u.email, l.kind, l.amount_usd, l.note, l.created_at FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 50"
# Test and typecheck the gateway (local only: D1 is node:sqlite, Fly is stubbed)
npm ci && npm test && npm run typecheck
# Deploy the gateway (builds the web app first)
npm run deploy
```

Deploy the Python server with `fly deploy --remote-only` from the repo root. The shared secret is
`GATEWAY_SECRET` on the Worker and `ORRO_GATEWAY_SECRET` on Fly. Rotate both together:

```sh
S=$(openssl rand -hex 32); printf %s "$S" | wrangler secret put GATEWAY_SECRET; fly secrets set ORRO_GATEWAY_SECRET="$S"; unset S
```

## Known gaps

- Uploaded datasets, scripts and controllers are stored on Fly in one shared folder. Only admins can upload, and the
  lists of them are public reads like everything else.
- Batches started before reads went public belong to their old owners in D1. Only admins can act on them now. An
  admin resuming another user's settled batch holds the headroom from the admin's balance, and the settlement returns
  what is left to the batch's owner.
- No payments yet. Plans change by SQL. Stripe Checkout plus a webhook setting `plan_id` would go in the gateway.
- WorkOS is on its Staging environment. For real users, switch to Production, add the same redirect URIs there,
  and update `WORKOS_CLIENT_ID`.
- Batches that sit in `ready` or `awaiting_approval` keep their hold until they finish or are stopped.

## Deploying from GitHub

Pushes to `main` deploy through GitHub Actions. Each workflow needs one repository secret, which only a repository
admin can add. Until a secret is set, its job skips with a notice.

- **Cloudflare (web app + gateway):** `.github/workflows/cloudflare-deploy.yml`, when `web/` or `gateway/` change.
  Secret `CLOUDFLARE_API_TOKEN`: in the dashboard, Workers & Pages → orro → Settings → Builds → API token for
  external CI/CD → Create token. D1 migrations are not applied by the workflow: run `npm run migrate` in `gateway/`.
  (Workers Builds, Cloudflare's own Git integration, cannot be used while the repository is under a personal GitHub
  account other than the Cloudflare account owner's.)
- **Fly.io (Python server):** `.github/workflows/fly-deploy.yml`, when files the server runs change.
  Secret `FLY_API_TOKEN`: `fly tokens create deploy -a orro-research | gh secret set FLY_API_TOKEN -R AndresL230/deep-research`.
