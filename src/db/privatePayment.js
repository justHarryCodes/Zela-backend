/**
 * src/db/privatePayments.js
 *
 * Database access layer for:
 *   • umbra_identity_records — user identity hash + wallet registration
 *   • private_payments       — full payment lifecycle
 *   • (sms_audit writes are in smsService.js)
 *
 * ─── Phone number handling ────────────────────────────────────────────────────
 *
 *   Phone numbers are stored AES-256-GCM encrypted in recipient_phone_enc.
 *   The plaintext is only decrypted for SMS operations and is never returned
 *   in API responses.
 *
 *   Encryption key: PHONE_ENCRYPTION_KEY (32-byte hex, 64 chars)
 *   Each ciphertext uses a fresh random 12-byte IV and includes an auth tag,
 *   so ciphertexts are not deterministic — the same phone produces different
 *   ciphertexts on every call.
 *
 * Required env vars:
 *   PHONE_ENCRYPTION_KEY — 64 hex chars (32 bytes)
 *   DATABASE_URL         — PostgreSQL connection string
 */

import crypto from "crypto";
import { query } from "./postgres.js";

// ─── Structured logger ────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "privatePayments",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "privatePayments",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "privatePayments",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Constants ────────────────────────────────────────────────────────────────

const E164_REGEX = /^\+[1-9]\d{6,14}$/;
const HEX64_REGEX = /^[0-9a-f]{64}$/i;
const HEX32_REGEX = /^[0-9a-f]{32}$/i; // identity hash
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const MAX_NOTE_LEN = 280;

// ─── Phone encryption ─────────────────────────────────────────────────────────

const PHONE_KEY_HEX = process.env.PHONE_ENCRYPTION_KEY;

if (!PHONE_KEY_HEX) {
  throw new Error(
    "[privatePayments] PHONE_ENCRYPTION_KEY is not set.\n" +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

if (PHONE_KEY_HEX.length !== 64 || !HEX64_REGEX.test(PHONE_KEY_HEX)) {
  throw new Error(
    "[privatePayments] PHONE_ENCRYPTION_KEY must be exactly 64 lowercase hex chars (32 bytes). " +
      `Got length ${PHONE_KEY_HEX.length}.`,
  );
}

const PHONE_ENCRYPTION_KEY = Buffer.from(PHONE_KEY_HEX, "hex");

/**
 * Validates that a string is a well-formed E.164 phone number.
 * Throws before we ever attempt encryption on garbage input.
 *
 * @param {string} phone
 */
function assertE164(phone) {
  if (typeof phone !== "string" || !E164_REGEX.test(phone)) {
    throw new Error(
      `[privatePayments] Invalid phone number — must be E.164 format (e.g. +12125551234). Got: ${typeof phone}`,
    );
  }
}

/**
 * Encrypts a phone number using AES-256-GCM.
 * Returns a JSON string that can be stored directly in the DB column.
 *
 * @param {string} phoneNumber  E.164 format — validated before encrypting
 * @returns {string}            JSON: { iv, data, tag } — all hex encoded
 */
function encryptPhone(phoneNumber) {
  assertE164(phoneNumber);

  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", PHONE_ENCRYPTION_KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(phoneNumber, "utf8"),
    cipher.final(),
  ]);

  return JSON.stringify({
    iv: iv.toString("hex"),
    data: encrypted.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  });
}

/**
 * Decrypts a phone number from the stored JSON blob.
 * Error messages are normalized — internal parse/crypto details are not exposed
 * to callers (or logs) to avoid leaking ciphertext structure.
 *
 * @param {string} encryptedJson  JSON string from encryptPhone()
 * @returns {string}              E.164 phone number
 * @throws {Error}                Generic message if decryption fails
 */
export function decryptPhone(encryptedJson) {
  let parsed;
  try {
    parsed = JSON.parse(encryptedJson);
  } catch {
    throw new Error(
      "[privatePayments] decryptPhone: invalid ciphertext format",
    );
  }

  const { iv, data, tag } = parsed;
  if (!iv || !data || !tag) {
    throw new Error(
      "[privatePayments] decryptPhone: missing ciphertext fields",
    );
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      PHONE_ENCRYPTION_KEY,
      Buffer.from(iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));

    return (
      decipher.update(Buffer.from(data, "hex"), undefined, "utf8") +
      decipher.final("utf8")
    );
  } catch {
    // Do NOT re-throw the original error — it may contain internal GCM detail.
    // Callers only need to know decryption failed.
    throw new Error(
      "[privatePayments] decryptPhone: authentication failed — ciphertext may be tampered",
    );
  }
}

/**
 * Safe wrapper around decryptPhone for use in list queries.
 * Returns null on any failure rather than throwing, since a single
 * corrupt row should not break the entire result set.
 * Filters out UNKNOWN: sentinel values written when the phone couldn't be verified.
 *
 * @param {string} encryptedJson
 * @returns {string|null}
 */
function safeDecryptPhone(encryptedJson) {
  try {
    const phone = decryptPhone(encryptedJson);
    return phone.startsWith("UNKNOWN:") ? null : phone;
  } catch {
    return null;
  }
}

// ─── Input validators ─────────────────────────────────────────────────────────

/**
 * Asserts a value looks like a 32-hex-char identity hash.
 * Throws with a clear message if not.
 */
function assertIdentityHash(value, label = "identityHash") {
  if (typeof value !== "string" || !HEX32_REGEX.test(value)) {
    throw new Error(`[privatePayments] ${label} must be a 32-char hex string`);
  }
}

/**
 * Clamps pagination params to safe bounds.
 *
 * @param {number} limit
 * @param {number} offset
 * @returns {{ limit: number, offset: number }}
 */
function clampPagination(limit, offset) {
  return {
    limit: Math.min(Math.max(1, Number(limit) || 20), MAX_LIMIT),
    offset: Math.min(Math.max(0, Number(offset) || 0), MAX_OFFSET),
  };
}

// ─── Identity Records ─────────────────────────────────────────────────────────

/**
 * Inserts or updates an identity record for a registered user.
 * Safe to call on re-registration — updates wallet_address and umbra_registered.
 *
 * @param {object}  opts
 * @param {string}   opts.uid
 * @param {string}   opts.identityHash       32 hex chars
 * @param {string}   opts.walletAddress      Solana Base58
 * @param {boolean}  [opts.umbraRegistered]
 */
export async function upsertIdentityRecord({
  uid,
  identityHash,
  walletAddress,
  umbraRegistered = false,
}) {
  assertIdentityHash(identityHash);

  await query(
    `INSERT INTO umbra_identity_records (uid, identity_hash, wallet_address, umbra_registered)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (uid) DO UPDATE SET
       identity_hash    = EXCLUDED.identity_hash,
       wallet_address   = EXCLUDED.wallet_address,
       umbra_registered = EXCLUDED.umbra_registered,
       updated_at       = NOW()`,
    [uid, identityHash, walletAddress, umbraRegistered],
  );

  log.info("Identity record upserted", { uid, umbraRegistered });
}

/**
 * Looks up an identity record by the 32-hex identity hash.
 *
 * @param {string} identityHash  32 hex chars
 * @returns {Promise<object|null>}
 */
export async function getIdentityByHash(identityHash) {
  assertIdentityHash(identityHash);

  const { rows } = await query(
    `SELECT uid, identity_hash, wallet_address, umbra_registered, created_at
     FROM umbra_identity_records
     WHERE identity_hash = $1
     LIMIT 1`,
    [identityHash],
  );
  return rows[0] ?? null;
}

/**
 * Looks up an identity record by Firebase UID.
 *
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function getIdentityByUID(uid) {
  const { rows } = await query(
    `SELECT uid, identity_hash, wallet_address, umbra_registered, created_at
     FROM umbra_identity_records
     WHERE uid = $1
     LIMIT 1`,
    [uid],
  );
  return rows[0] ?? null;
}

/**
 * Marks a user as registered with the Umbra protocol.
 * Called after /v1/identity/register completes Umbra-side onboarding.
 *
 * @param {string} uid
 */
export async function markUmbraRegistered(uid) {
  await query(
    `UPDATE umbra_identity_records
     SET umbra_registered = TRUE, updated_at = NOW()
     WHERE uid = $1`,
    [uid],
  );

  log.info("User marked as Umbra registered", { uid });
}

// ─── Private Payments ─────────────────────────────────────────────────────────

/**
 * Inserts a new private payment record immediately after the deposit tx confirms.
 *
 * @param {object}  opts
 * @param {string}   opts.senderUID
 * @param {string}   opts.senderIdentityHash     32 hex chars
 * @param {string}   opts.senderPublicKey        Solana Base58
 * @param {string}   opts.recipientIdentityHash  32 hex chars
 * @param {string}   opts.recipientPhoneE164     E.164 — validated + encrypted before storage
 * @param {number}   opts.amountUSD
 * @param {number}   opts.feeUSD
 * @param {string}   opts.tokenSymbol            'USDC' | 'USDT' | 'USDG'
 * @param {bigint}   opts.relayAmountRaw         Raw token units in relay wallet
 * @param {string}   opts.depositSignature       On-chain tx signature
 * @param {string|null} [opts.note]
 * @returns {Promise<string>}                    UUID of created row
 */
export async function insertPrivatePayment({
  senderUID,
  senderIdentityHash,
  senderPublicKey,
  recipientIdentityHash,
  recipientPhoneE164,
  amountUSD,
  feeUSD,
  tokenSymbol,
  relayAmountRaw,
  depositSignature,
  note,
}) {
  assertIdentityHash(senderIdentityHash, "senderIdentityHash");
  assertIdentityHash(recipientIdentityHash, "recipientIdentityHash");

  if (typeof amountUSD !== "number" || amountUSD <= 0) {
    throw new Error("[privatePayments] amountUSD must be a positive number");
  }
  if (typeof feeUSD !== "number" || feeUSD < 0) {
    throw new Error("[privatePayments] feeUSD must be a non-negative number");
  }
  if (typeof relayAmountRaw !== "bigint") {
    throw new Error("[privatePayments] relayAmountRaw must be a BigInt");
  }

  // Truncate note to max length — prevents oversized payloads reaching the DB
  const safeNote = note ? String(note).slice(0, MAX_NOTE_LEN) : null;

  // encryptPhone validates E.164 before encrypting
  const recipientPhoneEnc = encryptPhone(recipientPhoneE164);

  const { rows } = await query(
    `INSERT INTO private_payments (
       sender_uid, sender_identity_hash, sender_public_key,
       recipient_identity_hash, recipient_phone_enc,
       amount_usd, fee_usd, token_symbol, relay_amount_raw,
       deposit_signature, status, note
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
     RETURNING id`,
    [
      senderUID,
      senderIdentityHash,
      senderPublicKey,
      recipientIdentityHash,
      recipientPhoneEnc,
      amountUSD,
      feeUSD,
      tokenSymbol,
      relayAmountRaw.toString(), // BIGINT as string — precision safe
      depositSignature,
      safeNote,
    ],
  );

  const paymentId = rows[0].id;

  // Audit log — no PII, no phone, no amounts that aren't already on-chain
  log.info("Payment inserted", {
    paymentId,
    senderUID,
    tokenSymbol,
    status: "pending",
    depositSignature,
  });

  return paymentId;
}

/**
 * Transitions a payment to 'routing' and records the Umbra UTXO reference.
 *
 * @param {string} paymentId        UUID
 * @param {string} utxoId           Umbra UTXO ID / note
 * @param {string} umbraSignature   Umbra deposit tx signature
 */
export async function markPaymentRouting(paymentId, utxoId, umbraSignature) {
  await query(
    `UPDATE private_payments SET
       status                  = 'routing',
       umbra_utxo_id           = $2,
       umbra_deposit_signature = $3,
       updated_at              = NOW()
     WHERE id = $1`,
    [paymentId, utxoId, umbraSignature],
  );
  log.info("Payment status → routing", { paymentId, utxoId });
}

/**
 * Transitions a payment to 'routed' (UTXO is in the mixer, awaiting claim).
 *
 * @param {string} paymentId
 */
export async function markPaymentRouted(paymentId) {
  await query(
    `UPDATE private_payments SET
       status     = 'routed',
       routed_at  = NOW(),
       updated_at = NOW()
     WHERE id = $1`,
    [paymentId],
  );
  log.info("Payment status → routed", { paymentId });
}

/**
 * Transitions a payment to 'claimed' after successful UTXO claim.
 *
 * @param {string} paymentId
 * @param {string} claimSignature  On-chain claim tx signature
 */
export async function markPaymentClaimed(paymentId, claimSignature) {
  await query(
    `UPDATE private_payments SET
       status          = 'claimed',
       claim_signature = $2,
       claimed_at      = NOW(),
       updated_at      = NOW()
     WHERE id = $1`,
    [paymentId, claimSignature],
  );
  log.info("Payment status → claimed", { paymentId, claimSignature });
}

/**
 * Transitions a payment to 'failed' and records the reason.
 * Increments retry_count and sets next_retry_at for the background job.
 *
 * @param {string} paymentId
 * @param {string} reason
 */
export async function markPaymentFailed(paymentId, reason) {
  await query(
    `UPDATE private_payments SET
       status         = 'failed',
       failure_reason = $2,
       retry_count    = retry_count + 1,
       next_retry_at  = NOW() + (LEAST(retry_count + 1, 6) * INTERVAL '5 minutes'),
       updated_at     = NOW()
     WHERE id = $1`,
    [paymentId, reason],
  );
  log.warn("Payment status → failed", { paymentId, reason });
}

/**
 * Marks that an SMS was successfully queued for a payment.
 *
 * @param {string} paymentId
 */
export async function markSMSSent(paymentId) {
  await query(
    `UPDATE private_payments SET sms_sent = TRUE, updated_at = NOW()
     WHERE id = $1`,
    [paymentId],
  );
  log.info("SMS marked as sent", { paymentId });
}

/**
 * Returns all pending/routed payments for the given recipient identity hash.
 * Used by /v1/pay/pending and /v1/pay/claim.
 *
 * @param {string} recipientIdentityHash
 * @returns {Promise<object[]>}
 */
export async function getPendingPaymentsForIdentity(recipientIdentityHash) {
  assertIdentityHash(recipientIdentityHash, "recipientIdentityHash");

  const { rows } = await query(
    `SELECT
       id, sender_identity_hash,
       amount_usd, fee_usd, token_symbol,
       relay_amount_raw, deposit_signature,
       umbra_utxo_id, status, created_at
     FROM private_payments
     WHERE recipient_identity_hash = $1
       AND status IN ('pending','routing','routed')
     ORDER BY created_at ASC`,
    [recipientIdentityHash],
  );
  return rows;
}

/**
 * Returns paginated payment history for a user (sent, received, or all).
 *
 * Uses UNION ALL instead of OR across two columns so Postgres can use a
 * separate index scan on each column and merge the results — significantly
 * faster at scale than `WHERE col_a = $1 OR col_b = $1`.
 *
 * @param {object}  opts
 * @param {string}   opts.identityHash
 * @param {'sent'|'received'|'all'} opts.direction
 * @param {number}   [opts.limit]   capped at 100
 * @param {number}   [opts.offset]  capped at 10 000
 * @returns {Promise<object[]>}
 */
export async function getPaymentHistory({
  identityHash,
  direction = "all",
  limit = 20,
  offset = 0,
}) {
  assertIdentityHash(identityHash);

  const { limit: safeLimit, offset: safeOffset } = clampPagination(
    limit,
    offset,
  );

  const COLS = `
    id,
    sender_identity_hash,
    recipient_identity_hash,
    amount_usd, fee_usd,
    token_symbol,
    deposit_signature,
    claim_signature,
    status,
    created_at,
    claimed_at`;

  let sql;
  const params = [identityHash, safeLimit, safeOffset];

  if (direction === "sent") {
    sql = `
      SELECT ${COLS}
      FROM private_payments
      WHERE sender_identity_hash = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`;
  } else if (direction === "received") {
    sql = `
      SELECT ${COLS}
      FROM private_payments
      WHERE recipient_identity_hash = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`;
  } else {
    // UNION ALL lets Postgres use individual indexes on each column,
    // then deduplicates via the outer query. Much faster than OR at scale.
    sql = `
      SELECT * FROM (
        SELECT ${COLS} FROM private_payments WHERE sender_identity_hash    = $1
        UNION ALL
        SELECT ${COLS} FROM private_payments WHERE recipient_identity_hash = $1
      ) combined
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`;
  }

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Returns 'pending' payments that have not been routed through Umbra yet.
 * Used by the background retry job.
 *
 * Includes the decrypted phone number for SMS (caller is responsible for
 * not persisting it).
 *
 * @param {number} [ageSeconds=30]  Skip records newer than this (avoids racing
 *                                  with the in-progress async route call)
 * @returns {Promise<object[]>}
 */
export async function getPendingUnroutedPayments(ageSeconds = 30) {
  const { rows } = await query(
    `SELECT
       id,
       recipient_identity_hash,
       recipient_phone_enc,
       amount_usd,
       relay_amount_raw,
       token_symbol
     FROM private_payments
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 * INTERVAL '1 second')
     ORDER BY created_at ASC
     LIMIT 50`,
    [ageSeconds],
  );

  return rows.map((r) => ({
    ...r,
    recipientPhone: safeDecryptPhone(r.recipient_phone_enc),
  }));
}

/**
 * Returns 'failed' payments eligible for retry.
 * Capped at retry_count < 5 to avoid infinite retry loops.
 *
 * @returns {Promise<object[]>}
 */
export async function getRetryableFailedPayments() {
  const { rows } = await query(
    `SELECT
       id,
       recipient_identity_hash,
       recipient_phone_enc,
       amount_usd,
       relay_amount_raw,
       token_symbol,
       retry_count
     FROM private_payments
     WHERE status = 'failed'
       AND retry_count < 5
       AND next_retry_at <= NOW()
     ORDER BY next_retry_at ASC
     LIMIT 20`,
    [],
  );

  return rows.map((r) => ({
    ...r,
    recipientPhone: safeDecryptPhone(r.recipient_phone_enc),
  }));
}
