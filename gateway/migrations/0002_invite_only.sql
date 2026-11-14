-- Invite-only access. Anyone can create a WorkOS account, but only people on the invite list (or approved by an
-- admin) can use Orro. Everyone else lands on the 'pending' plan, which can do nothing that spends money.

-- 0: this plan may not use the app at all (only see the public demo replays).
ALTER TABLE plans ADD COLUMN can_run INTEGER NOT NULL DEFAULT 1;

INSERT INTO plans (id, name, signup_usd, monthly_usd, max_batch_usd, max_runs, max_open_batches, allowed_models,
                   default_model, default_investigator_model, can_upload, unlimited, is_admin, can_run)
VALUES ('pending', 'Waiting for access', 0, 0, 0, 0, 0, '[]',
        'anthropic:claude-haiku-5-5', 'anthropic:claude-haiku-5-5', 0, 0, 0, 0);

-- Who may get in, and on which plan. `pattern` is an exact email ('ana@bu.edu') or a whole domain ('@bu.edu').
-- Matched at sign-in, and only for emails WorkOS has verified.
CREATE TABLE invites (
  pattern TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
