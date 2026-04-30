/**
 * src/models/orderQueries.js
 *
 * All Postgres order queries in one place.
 * No raw SQL scattered across route handlers.
 */

import { query, getClient } from "../db/postgres.js";

/**
 * Create a new order row.
 * @param {object} params
 * @returns {Promise<object>} the created order row
 */
export async function createOrder({
  firebaseUid,
  type,
  cryptoTxSig,
  cryptoAmount,
  cryptoToken,
  amountUsd,
  recipient, // plain JS object — stored as JSONB
  customIdentifier,
}) {
  const result = await query(
    `INSERT INTO orders
       (firebase_uid, type, crypto_tx_sig, crypto_amount, crypto_token,
        amount_usd, recipient, custom_identifier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      firebaseUid,
      type,
      cryptoTxSig ?? null,
      cryptoAmount ?? null,
      cryptoToken ?? null,
      amountUsd,
      JSON.stringify(recipient),
      customIdentifier ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * Transition an order to CRYPTO_CONFIRMED.
 */
export async function confirmCrypto(orderId) {
  const result = await query(
    `UPDATE orders
     SET status = 'CRYPTO_CONFIRMED', crypto_confirmed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId],
  );
  return result.rows[0];
}

/**
 * Mark as PROCESSING once we've sent the request to Reloadly.
 */
export async function markProcessing(orderId, reloadlyTxId) {
  const result = await query(
    `UPDATE orders
     SET status = 'PROCESSING', reloadly_tx_id = $2
     WHERE id = $1
     RETURNING *`,
    [orderId, reloadlyTxId ?? null],
  );
  return result.rows[0];
}

/**
 * Mark as COMPLETED after Reloadly confirms success.
 */
export async function markCompleted(
  orderId,
  { reloadlyTxId, operatorTxId, reloadlyPayload },
) {
  const result = await query(
    `UPDATE orders
     SET status = 'COMPLETED',
         reloadly_tx_id = $2,
         reloadly_operator_tx_id = $3,
         reloadly_payload = $4
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      reloadlyTxId,
      operatorTxId ?? null,
      JSON.stringify(reloadlyPayload),
    ],
  );
  return result.rows[0];
}

/**
 * Mark as FAILED with a human-readable reason.
 */
export async function markFailed(
  orderId,
  { errorMessage, errorCode, reloadlyPayload },
) {
  const result = await query(
    `UPDATE orders
     SET status = 'FAILED',
         error_message = $2,
         error_code = $3,
         reloadly_payload = $4
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      errorMessage,
      errorCode ?? null,
      JSON.stringify(reloadlyPayload ?? {}),
    ],
  );
  return result.rows[0];
}

/**
 * Fetch a single order by ID, scoped to a Firebase UID for security.
 */
export async function getOrderById(orderId, firebaseUid) {
  const result = await query(
    `SELECT * FROM orders WHERE id = $1 AND firebase_uid = $2`,
    [orderId, firebaseUid],
  );
  return result.rows[0] ?? null;
}

/**
 * Paginated order history for a user.
 */
export async function getOrdersByUser(
  firebaseUid,
  { limit = 20, offset = 0, type } = {},
) {
  const params = [firebaseUid, limit, offset];
  const typeClause = type ? `AND type = $4` : "";
  if (type) params.push(type);

  const result = await query(
    `SELECT * FROM orders
     WHERE firebase_uid = $1
     ${typeClause}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    params,
  );
  return result.rows;
}

/**
 * Idempotency check — return existing order if same customIdentifier used twice.
 */
export async function findByCustomIdentifier(customIdentifier) {
  const result = await query(
    `SELECT * FROM orders WHERE custom_identifier = $1`,
    [customIdentifier],
  );
  return result.rows[0] ?? null;
}


// ─── Append to src/models/orderQueries.js ─────────────────────────────────────

/**
 * Set poll_until on a PROCESSING utility order so the poller knows
 * how long to keep checking Reloadly for a final status.
 * Reloadly's `finalStatusAvailabilityAt` tells us when they'll have an answer.
 *
 * @param {string} orderId
 * @param {Date|string} pollUntil
 */
export async function setPollUntil(orderId, pollUntil) {
  const result = await query(
    `UPDATE orders SET poll_until = $2 WHERE id = $1 RETURNING *`,
    [orderId, pollUntil]
  );
  return result.rows[0];
}

/**
 * Fetch all PROCESSING orders whose poll_until hasn't expired yet.
 * Used by the background status-poll job (Step 7).
 */
export async function getPendingPollOrders() {
  const result = await query(
    `SELECT * FROM orders
     WHERE status = 'PROCESSING'
       AND poll_until IS NOT NULL
       AND poll_until > NOW()
     ORDER BY created_at ASC`,
    []
  );
  return result.rows;
}