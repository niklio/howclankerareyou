-- Diagnose cache: /api/diagnose reuses the latest stored result for a handle
-- within a 1-week TTL, so repeat lookups don't re-burn scraper credits.
CREATE INDEX IF NOT EXISTS idx_results_subject
  ON results(subject_type, subject_handle, created_at);
