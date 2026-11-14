-- Orro gateway: who may use what, and how many API credits they have left.
-- Users sign in with WorkOS; this database is the source of truth for their plan and balance.
-- Amounts are US dollars of model and VM spend, as Orro's own cost tracker counts them (deep_research/costs.py).

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Credits given once, when the user first signs in.
  signup_usd REAL NOT NULL DEFAULT 0,
  -- On the first day of each month the balance is refilled up to this amount (never added on top).
  monthly_usd REAL NOT NULL DEFAULT 0,
  -- The most one batch may spend. A batch asking for more is capped to this.
  max_batch_usd REAL NOT NULL,
  -- The most runs (agent VMs) in one batch.
  max_runs INTEGER NOT NULL,
  -- Batches that may hold credits at once (running, or waiting for the investigator).
  max_open_batches INTEGER NOT NULL,
  -- JSON list of the model ids this plan may use, e.g. ["anthropic:claude-haiku-5-5"].
  allowed_models TEXT NOT NULL,
  -- Filled in for any model field the request leaves out.
  default_model TEXT NOT NULL,
  default_investigator_model TEXT NOT NULL,
  -- 1: may upload datasets, scripts and controllers.
  can_upload INTEGER NOT NULL DEFAULT 1,
  -- 1: no balance checks and no limits (still recorded in the ledger). For the owners.
  unlimited INTEGER NOT NULL DEFAULT 0,
  -- 1: may see every user's batches and the all-batches cost report.
  is_admin INTEGER NOT NULL DEFAULT 0
);

INSERT INTO plans VALUES
  ('free',  'Free',  1.00,  1.00,  1.00,  4, 1, '["anthropic:claude-haiku-5-5"]',
   'anthropic:claude-haiku-5-5', 'anthropic:claude-haiku-5-5', 0, 0, 0),
  ('pro',   'Pro',   0,    20.00, 10.00, 24, 3, '["anthropic:claude-haiku-5-5","anthropic:claude-sonnet-5-5"]',
   'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5', 1, 0, 0),
  ('admin', 'Admin', 0,     0,   100.00, 48, 10, '["anthropic:claude-haiku-5-5","anthropic:claude-sonnet-5-5"]',
   'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5', 1, 1, 1);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- the WorkOS user id (user_...)
  email TEXT NOT NULL,
  name TEXT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  balance_usd REAL NOT NULL DEFAULT 0,
  last_grant_month TEXT,              -- 'YYYY-MM' of the last monthly refill
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE INDEX users_email ON users(email);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 of the cookie value; the value itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  workos_sid TEXT,                    -- the WorkOS session, for sign-out
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One row per batch started through the gateway. Batches with no row (the demo fixtures) are public replays.
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  budget_usd REAL NOT NULL,           -- the cap Orro's own budget guard enforces (BatchConfig.budget_usd)
  reserved_usd REAL NOT NULL,         -- taken from the balance and held until the batch settles
  charged_usd REAL NOT NULL DEFAULT 0,-- actual spend charged so far
  status TEXT NOT NULL DEFAULT 'open',-- open | settling | settled
  phase TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE INDEX batches_user ON batches(user_id, status);

-- Every change to a balance, for audit.
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  batch_id TEXT,
  kind TEXT NOT NULL,                 -- signup | monthly | reserve | release | adjust
  amount_usd REAL NOT NULL,           -- positive adds to the balance, negative takes from it
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ledger_user ON ledger(user_id, created_at);
