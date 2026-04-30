-- ─── Payment verification audit log ──────────────────────────────────────────
-- Append-only record of every verification attempt — pass or fail.
-- Invaluable for debugging disputed transactions and identifying abuse patterns.

CREATE TABLE IF NOT EXISTS payment_verification_log (
  id              BIGSERIAL   PRIMARY KEY,
  firebase_uid    TEXT        NOT NULL,
  tx_signature    TEXT        NOT NULL,
  token_symbol    TEXT        NOT NULL,
  expected_amount NUMERIC(20, 8) NOT NULL,
  result          TEXT        NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  fail_reason     TEXT,
  slot            BIGINT,
  block_time      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pvl_tx_sig_idx     ON payment_verification_log (tx_signature);
CREATE INDEX IF NOT EXISTS pvl_uid_idx        ON payment_verification_log (firebase_uid);
CREATE INDEX IF NOT EXISTS pvl_created_at_idx ON payment_verification_log (created_at DESC);
CREATE INDEX IF NOT EXISTS pvl_result_idx     ON payment_verification_log (result)
  WHERE result = 'FAIL';