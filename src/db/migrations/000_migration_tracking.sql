-- ─── Run this ONCE manually before anything else ──────────────────────────────
-- Creates the table that tracks which migrations have been applied.
-- Every other migration file is then managed by the runner.

CREATE TABLE IF NOT EXISTS _migrations (
  id          SERIAL       PRIMARY KEY,
  filename    TEXT         NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  duration_ms INT
);