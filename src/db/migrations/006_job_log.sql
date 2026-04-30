-- ─── Job execution log ────────────────────────────────────────────────────────
-- Append-only record of every job run. Never updated — only inserted.
-- Lets you see job history, durations, and failure rates at a glance.

CREATE TABLE IF NOT EXISTS job_log (
  id            BIGSERIAL    PRIMARY KEY,
  job_name      TEXT         NOT NULL,
  status        TEXT         NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED')),
  items_processed INT        DEFAULT 0,
  items_failed    INT        DEFAULT 0,
  error_message TEXT,
  duration_ms   INT,
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS job_log_job_name_idx  ON job_log (job_name);
CREATE INDEX IF NOT EXISTS job_log_started_at_idx ON job_log (started_at DESC);
CREATE INDEX IF NOT EXISTS job_log_status_idx    ON job_log (status)
  WHERE status = 'FAILED';

-- ─── Dead order cleanup target ────────────────────────────────────────────────
-- Orders stuck in PROCESSING beyond their poll_until window with no resolution.
-- The cleanup job marks these FAILED so they don't linger indefinitely.

-- Add max_poll_attempts to orders so we don't retry infinitely
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS poll_attempts  SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS orders_last_polled_idx
  ON orders (last_polled_at)
  WHERE status = 'PROCESSING' AND poll_until IS NOT NULL;