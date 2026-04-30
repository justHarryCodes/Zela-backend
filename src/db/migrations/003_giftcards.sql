-- ─── Gift card order extras ────────────────────────────────────────────────────
-- The redeem code itself lives in MongoDB (encrypted).
-- We store a reference here so the two DBs stay in sync.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS redeem_code_fetched  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quantity             SMALLINT NOT NULL DEFAULT 1;

-- Index for "fetch all orders that need redeem codes pulled"
CREATE INDEX IF NOT EXISTS orders_redeem_pending_idx
  ON orders (status, redeem_code_fetched)
  WHERE type = 'GIFTCARD'
    AND status = 'COMPLETED'
    AND redeem_code_fetched = FALSE;