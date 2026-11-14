# Orro behind Cloudflare: sign-in, plans and API credits

Orro's agents spend real money (Anthropic tokens and Daytona VMs). The gateway makes sure only signed-in users
start batches, and only within the plan and credits they have.

```
browser ──► Cloudflare Worker "orro" (gateway/) ──► Fly.io "orro-research" (Python server)
               │  serves web/dist (static assets)          only answers requests carrying
               │  /auth/*  WorkOS AuthKit sign-in           ORRO_GATEWAY_SECRET (deep_research/gateway_guard.py)
               │  /api/*   checks plan + credits, forwards
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

## Invite-only access

Anyone can create a WorkOS account, but no one can use Orro until they are let in. A new account starts on the
`pending` plan, which can do nothing that spends money; it only sees the public demo replays. An account gets a real
plan when one of these is true:

- its email is in the `ADMIN_EMAILS` Worker secret (`wrangler secret put ADMIN_EMAILS`), giving the `admin` plan
- its email, or its whole domain (`@bu.edu`), is on the invite list, giving the plan the invite names
- an admin sets its plan on the admin page

Invites only match emails WorkOS has verified, so nobody can claim an invited address they do not own.

Manage access at **https://orrolab.dev/admin** (admins only; the "Access" link in the account
chip). Inviting an email or domain also approves anyone with a matching email who is already waiting. Setting a user
back to `pending` cuts them off and signs them out.

## What each plan may do

Plans are rows in the `plans` table. Change them with SQL, no deploy needed.

| plan  | signup credit | monthly refill to | max per batch | max runs | open batches | models | uploads |
|-------|---------------|-------------------|---------------|----------|--------------|--------|---------|
| pending | none         |                   | no access     |          |              |        | no      |
| free  | $1            | $1                | $1            | 4        | 1            | Haiku  | no      |
| pro   | $0            | $20               | $10           | 24       | 3            | Haiku, Sonnet | yes |
| admin | unlimited     |                   | $100          | 48       | 10           | all    | yes     |

Public without sign-in: the landing page, `/api/health`, `/api/defaults`, `/api/robot/scene`, the batch list and the
demo replays (batches with no owner in D1). Everything else needs sign-in. A user only sees their own batches.
Admins see all of them, and only admins get `/api/costs`.

## How credits are charged

1. **Reserve.** `POST /api/batches` caps the batch's `budget_usd` to the plan's maximum. It takes that amount plus
   the captions' cap (at most $0.50) from the balance in one conditional `UPDATE`. A balance that is too low
   gets HTTP 402.
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
# Deploy the gateway (builds the web app first)
npm run deploy
```

Deploy the Python server with `fly deploy --remote-only` from the repo root. The shared secret is
`GATEWAY_SECRET` on the Worker and `ORRO_GATEWAY_SECRET` on Fly. Rotate both together:

```sh
S=$(openssl rand -hex 32); printf %s "$S" | wrangler secret put GATEWAY_SECRET; fly secrets set ORRO_GATEWAY_SECRET="$S"; unset S
```

## Known gaps

- Uploaded datasets, scripts and controllers are stored on Fly in one shared folder, so any user who can upload
  can list everyone's uploads. Free users cannot upload. Per-user upload folders are the next step.
- No payments yet. Plans change by SQL. Stripe Checkout plus a webhook setting `plan_id` would go in the gateway.
- WorkOS is on its Staging environment. For real users, switch to Production, add the same redirect URIs there,
  and update `WORKOS_CLIENT_ID`.
- Batches that sit in `ready` or `awaiting_approval` keep their hold until they finish or are stopped.

## Deploying from GitHub

Pushes to `main` deploy on their own once this is set up:

- **Cloudflare (web app + gateway):** Workers Builds, connected to this repository in the dashboard (Workers &
  Pages → orro → Settings → Builds). Settings: branch `main`, root directory `gateway`, build command
  `npm ci && cd ../web && npm ci && npm run build`, deploy command `npx wrangler deploy`. D1 migrations are not run
  by the build: apply new ones with `npm run migrate` in `gateway/`.
- **Fly.io (Python server):** `.github/workflows/fly-deploy.yml`, when files the server runs change. It needs the
  repository secret `FLY_API_TOKEN` (`fly tokens create deploy -a orro-research | gh secret set FLY_API_TOKEN`),
  which only a repository admin can add.
