-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Private payment infrastructure (Umbra SDK integration)
--
-- Tables:
--   umbra_identity_records  — maps Firebase UIDs to identity hashes + wallets
--   private_payments        — full lifecycle of every private payment
--   sms_audit               — every SMS attempt (success + failure)
--
-- Phone numbers are NEVER stored in plain text.
-- recipient_phone_enc is AES-256-GCM encrypted in application code.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Enable pgcrypto for gen_random_uuid() if not already enabled ─────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Identity records ─────────────────────────────────────────────────────────
--
--  One row per registered Zela user.
--  identity_hash = HMAC-SHA256(phoneNumber, IDENTITY_HMAC_SECRET)[0:32 hex]
--  Derived by the server — clients receive the hash but never compute it.

CREATE TABLE IF NOT EXISTS umbra_identity_records (
  id               SERIAL       PRIMARY KEY,
  uid              TEXT         NOT NULL UNIQUE,   -- Firebase Auth UID
  identity_hash    TEXT         NOT NULL UNIQUE,   -- 32 hex chars (128-bit HMAC)
  wallet_address   TEXT         NOT NULL,           -- Solana Base58 public key
  umbra_registered BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uir_identity_hash ON umbra_identity_records (identity_hash);
CREATE INDEX IF NOT EXISTS idx_uir_uid           ON umbra_identity_records (uid);

-- ─── Private payments ─────────────────────────────────────────────────────────
--
--  Lifecycle: pending → routing → routed → claimed
--                                        ↘ failed   (with failure_reason)
--
--  pending  = deposit tx confirmed on-chain; Umbra routing not yet done
--  routing  = Umbra UTXO creation in progress
--  routed   = UTXO created; recipient can claim
--  claimed  = UTXO claimed to recipient wallet
--  failed   = Umbra routing failed (see failure_reason; background job retries)

CREATE TABLE IF NOT EXISTS private_payments (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Sender
  sender_uid               TEXT          NOT NULL,
  sender_identity_hash     TEXT          NOT NULL,
  sender_public_key        TEXT          NOT NULL,

  -- Recipient (phone stored encrypted; hash is the payment key)
  recipient_identity_hash  TEXT          NOT NULL,
  recipient_phone_enc      TEXT          NOT NULL,   -- AES-256-GCM JSON blob

  -- Amounts
  amount_usd               NUMERIC(20,6) NOT NULL,   -- amount recipient gets
  fee_usd                  NUMERIC(20,6) NOT NULL,   -- 1% service fee
  token_symbol             TEXT          NOT NULL
                             CHECK (token_symbol IN ('USDC','USDT','USDG')),
  relay_amount_raw         BIGINT        NOT NULL,   -- raw units held by relay wallet

  -- On-chain references
  deposit_signature        TEXT          NOT NULL UNIQUE,  -- sender → relay tx sig
  umbra_utxo_id            TEXT,                           -- set after UTXO creation
  umbra_deposit_signature  TEXT,                           -- Umbra mixer deposit tx sig
  claim_signature          TEXT,                           -- set after claim

  -- State machine
  status                   TEXT          NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','routing','routed','claimed','failed')),
  failure_reason           TEXT,
  retry_count              SMALLINT      NOT NULL DEFAULT 0,
  next_retry_at            TIMESTAMPTZ,

  -- Metadata
  sms_sent                 BOOLEAN       NOT NULL DEFAULT FALSE,
  note                     TEXT,

  -- Timestamps
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  routed_at                TIMESTAMPTZ,
  claimed_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pp_recipient_status
  ON private_payments (recipient_identity_hash, status);

CREATE INDEX IF NOT EXISTS idx_pp_sender
  ON private_payments (sender_identity_hash);

CREATE INDEX IF NOT EXISTS idx_pp_status
  ON private_payments (status);

CREATE INDEX IF NOT EXISTS idx_pp_next_retry
  ON private_payments (next_retry_at)
  WHERE status = 'failed' AND retry_count < 5;

-- ─── SMS audit ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_audit (
  id            SERIAL       PRIMARY KEY,
  payment_id    UUID         REFERENCES private_payments(id) ON DELETE SET NULL,
  identity_hash TEXT         NOT NULL,
  message_sid   TEXT,        -- Twilio message SID
  status        TEXT         NOT NULL,
  error_code    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pp_updated_at  ON private_payments;
DROP TRIGGER IF EXISTS trg_uir_updated_at ON umbra_identity_records;

CREATE TRIGGER trg_pp_updated_at
  BEFORE UPDATE ON private_payments
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TRIGGER trg_uir_updated_at
  BEFORE UPDATE ON umbra_identity_records
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();