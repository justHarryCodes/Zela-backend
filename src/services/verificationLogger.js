/**
 * src/services/verificationLogger.js
 *
 * Async, fire-and-forget logger for payment verification attempts.
 * Writes to Postgres. Never throws — a log failure must never block a payment.
 *
 * Called from every processTopup / processBillPayment / purchaseGiftCard
 * service function immediately after verifySolanaPayment() returns.
 */

import { query } from "../db/postgres.js";

/**
 * @param {object} params
 * @param {string}      params.firebaseUid
 * @param {string}      params.txSignature
 * @param {string}      params.tokenSymbol
 * @param {number}      params.expectedAmount
 * @param {object}      params.verifyResult   — the result of verifySolanaPayment()
 */
export function logVerification({
  firebaseUid,
  txSignature,
  tokenSymbol,
  expectedAmount,
  verifyResult,
}) {
  query(
    `INSERT INTO payment_verification_log
       (firebase_uid, tx_signature, token_symbol, expected_amount,
        result, fail_reason, slot, block_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      firebaseUid,
      txSignature,
      tokenSymbol,
      expectedAmount,
      verifyResult.ok ? "PASS" : "FAIL",
      verifyResult.reason ?? null,
      verifyResult.slot ?? null,
      verifyResult.blockTime ?? null,
    ],
  ).catch((err) =>
    console.error("[verificationLogger] Failed to write log:", err.message),
  );
}
