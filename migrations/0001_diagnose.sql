-- "Diagnose an X account" feature: subject columns on results + opt-out list.
-- SQLite has no IF NOT EXISTS for ADD COLUMN; applied once per database.
ALTER TABLE results ADD COLUMN subject_type TEXT;
ALTER TABLE results ADD COLUMN subject_handle TEXT;
ALTER TABLE results ADD COLUMN subject_name TEXT;
ALTER TABLE results ADD COLUMN sources TEXT;

CREATE TABLE IF NOT EXISTS blocklist (
  handle TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
