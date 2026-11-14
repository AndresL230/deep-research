-- One row per batch: its whole case file, plus the fields the list and the cost screen need without parsing it.
CREATE TABLE batches (
  id          TEXT PRIMARY KEY,
  machine     TEXT NOT NULL,             -- which local server ran it
  revision    INTEGER NOT NULL DEFAULT 0, -- grows with every push; an older push never overwrites a newer one
  phase       TEXT NOT NULL,
  simulated   INTEGER NOT NULL DEFAULT 0,
  spent_usd   REAL,                       -- null when some price was unknown
  summary     TEXT NOT NULL,              -- JSON: run counts, dataset, trap, models
  case_json   TEXT NOT NULL,
  started_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX batches_by_update ON batches (updated_at DESC);

-- One row per agent event, per log: a run ("r01"), a fork child ("f1/control-1") or "investigator".
-- (batch_id, log, seq) is the key, so a push that is retried never adds an event twice.
CREATE TABLE events (
  batch_id  TEXT NOT NULL,
  log       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  event     TEXT NOT NULL,
  PRIMARY KEY (batch_id, log, seq)
) WITHOUT ROWID;
