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

-- Finished runs; percentile is computed against this table. A row is either a
-- self-test (subject_type NULL/'self') or an X-account diagnosis
-- (subject_type='account', with subject_handle/name and sources = JSON of the
-- sampled posts). Older rows predate these columns, so they're all nullable.
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  overall REAL NOT NULL,
  per_model TEXT NOT NULL,
  grid TEXT,
  subject_type TEXT,
  subject_handle TEXT,
  subject_name TEXT,
  sources TEXT
);

CREATE INDEX IF NOT EXISTS idx_results_overall ON results(overall);

-- Global daily scoring-call counter (abuse backstop). One row per UTC day.
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);

-- Opt-out list for the "diagnose an X account" feature. A handle here can't be
-- diagnosed and its stored results are deleted. Handles are stored lowercased.
CREATE TABLE IF NOT EXISTS blocklist (
  handle TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Admin OAuth sessions for analytics.howclankerareyou.com.
CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Product analytics events (traffic, virality, funnel). Fire-and-forget writes.
-- type: pageview | result_view | share | start | ratelimited
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,          -- ms epoch
  day TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  type TEXT NOT NULL,
  ref TEXT,                     -- referrer host (pageview)
  visitor TEXT,                 -- salted-hash of IP, for unique counts
  session_id TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_type_day ON events(type, day);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
