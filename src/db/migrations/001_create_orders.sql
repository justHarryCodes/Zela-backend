-- ─── Run once against your Postgres database ──────────────────────────────────
-- Applies cleanly on repeat (IF NOT EXISTS everywhere).

-- Enable UUID generation (Postgres 13+ has gen_random_uuid() built in)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid      TEXT        NOT NULL,

  -- service type
  type              TEXT        NOT NULL
                    CHECK (type IN ('AIRTIME', 'DATA', 'UTILITY', 'GIFTCARD')),

  -- lifecycle status
  status            TEXT        NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN (
                      'PENDING',           -- order created, waiting for crypto confirmation
                      'CRYPTO_CONFIRMED',  -- on-chain tx verified
                      'PROCESSING',        -- sent to Reloadly, awaiting their status
                      'COMPLETED',         -- Reloadly confirmed success
                      'FAILED',            -- Reloadly returned failure
                      'REFUNDED'           -- manual/auto refund issued
                    )),

  -- crypto payment leg
  crypto_tx_sig     TEXT        UNIQUE,        -- Solana transaction signature
  crypto_amount     NUMERIC(20, 8),            -- amount of token sent
  crypto_token      TEXT,                      -- e.g. 'USDC', 'SOL', 'USDT'
  crypto_confirmed_at TIMESTAMPTZ,

  -- fiat equivalent at time of order
  amount_usd        NUMERIC(10, 4) NOT NULL,

  -- Reloadly fulfillment
  reloadly_tx_id    TEXT,
  reloadly_operator_tx_id TEXT,                -- operator's own ref from Reloadly response
  reloadly_payload  JSONB,                     -- full Reloadly response, for debugging

  -- recipient  (phone/email/account number depending on type)
  recipient         JSONB       NOT NULL,
  -- e.g. { "phone": "2348012345678", "countryCode": "NG", "operatorId": 341 }

  -- optional caller-supplied idempotency key
  custom_identifier TEXT        UNIQUE,

  -- failure info
  error_message     TEXT,
  error_code        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS orders_firebase_uid_idx   ON orders (firebase_uid);
CREATE INDEX IF NOT EXISTS orders_status_idx         ON orders (status);
CREATE INDEX IF NOT EXISTS orders_type_idx           ON orders (type);
CREATE INDEX IF NOT EXISTS orders_created_at_idx     ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_crypto_tx_sig_idx  ON orders (crypto_tx_sig)
  WHERE crypto_tx_sig IS NOT NULL;

-- ─── Auto-update updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();