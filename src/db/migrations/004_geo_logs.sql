-- ─── Optional: persist geo block events for audit / abuse analysis ────────────
-- This is a write-only append log — never updated, only inserted and queried.

CREATE TABLE IF NOT EXISTS geo_block_log (
  id           BIGSERIAL   PRIMARY KEY,
  firebase_uid TEXT,                       -- null for unauthenticated requests
  ip_masked    TEXT        NOT NULL,       -- e.g. "192.168.x.x"
  country_code TEXT,                       -- null if unknown
  service      TEXT,                       -- "airtime" | "utilities" | etc.
  path         TEXT        NOT NULL,       -- req.path
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS geo_block_log_country_idx ON geo_block_log (country_code);
CREATE INDEX IF NOT EXISTS geo_block_log_created_at_idx ON geo_block_log (created_at DESC);
CREATE INDEX IF NOT EXISTS geo_block_log_uid_idx ON geo_block_log (firebase_uid)
  WHERE firebase_uid IS NOT NULL;