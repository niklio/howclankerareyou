CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- One row per (session, question, model): the mean per-token KL for that answer.
-- per_word is a JSON array of per-word divergences (aligned to the completion's
-- words), used to build the shareable heat grid.
CREATE TABLE IF NOT EXISTS answers (
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  model TEXT NOT NULL,
  avg_kl REAL NOT NULL,
  steps INTEGER NOT NULL,
  completion TEXT NOT NULL,
  per_word TEXT,
  PRIMARY KEY (session_id, question_id, model)
);

-- Finished runs; percentile is computed against this table.
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  overall REAL NOT NULL,
  per_model TEXT NOT NULL,
  grid TEXT
);

CREATE INDEX IF NOT EXISTS idx_results_overall ON results(overall);

-- Global daily scoring-call counter (abuse backstop). One row per UTC day.
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);
