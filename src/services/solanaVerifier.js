/**
 * src/services/solanaVerifier.js
 *
 * Production Solana payment verifier — USDC and USDT only (SPL tokens).
 *
 * Verification steps:
 *   1. Input validation — token must be USDC or USDT
 *   2. Double-spend guard — Postgres check before any RPC call
 *   3. Fetch transaction via getParsedTransaction (jsonParsed encoding)
 *   4. Transaction succeeded on-chain (meta.err === null)
 *   5. Recency — blockTime within MAX_TX_AGE_SECONDS
 *   6. Correct mint — token that landed matches the declared symbol's mint
 *   7. Fee payer received funds — scan postTokenBalances for fee payer + mint
 *   8. Amount sufficient — delta ≥ expected × (1 - AMOUNT_TOLERANCE_BPS)
 */

import { Connection } from "@solana/web3.js";
import { feePayerPublicKey } from "../feePayer.js";
import {
  getTokenBySymbol,
  toRawAmount,
  ACCEPTED_PAYMENT_TOKENS,
} from "../config/tokenMints.js";
import { query } from "../db/postgres.js";

// ─── Connection ────────────────────────────────────────────────────────────────

const COMMITMENT = process.env.SOLANA_COMMITMENT ?? "confirmed";
const connection = new Connection(process.env.ALCHEMY_RPC_URL, COMMITMENT);

// ─── Config ────────────────────────────────────────────────────────────────────

const MAX_TX_AGE_SECONDS = Number(process.env.MAX_TX_AGE_SECONDS ?? 600);
const AMOUNT_TOLERANCE_BPS = Number(process.env.AMOUNT_TOLERANCE_BPS ?? 50);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const pass = (extra = {}) => ({ ok: true, ...extra });
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// ─── Double-spend guard ────────────────────────────────────────────────────────

async function checkDoubleSpend(txSignature) {
  const result = await query(
    `SELECT id, status FROM orders WHERE crypto_tx_sig = $1 LIMIT 1`,
    [txSignature],
  );
  if (result.rows.length === 0) return { used: false };
  return {
    used: true,
    orderId: result.rows[0].id,
    status: result.rows[0].status,
  };
}

// ─── SPL token balance verifier ────────────────────────────────────────────────

/**
 * Confirm the fee payer received ≥ expectedRaw of the given mint.
 *
 * Both USDC and USDT are standard SPL tokens with 6 decimals.
 * We use BigInt throughout — no floating point anywhere in the money path.
 *
 * Per the official Solana exchange guide:
 *   - A token account absent from preTokenBalances was created in this tx → pre = 0
 *   - Sum across all ATAs the fee payer holds for this mint (edge case: multiple accounts)
 *
 * @param {object} meta        — tx.meta from getParsedTransaction
 * @param {string} mintAddress — expected mint public key string
 * @param {bigint} expectedRaw — expected amount in raw units (6 decimals)
 * @param {string} symbol      — "USDC" | "USDT" (for error messages only)
 * @returns {{ ok: boolean, deltaRaw?: bigint, reason?: string }}
 */
function verifySplReceived(meta, mintAddress, expectedRaw, symbol) {
  const postBalances = meta.postTokenBalances ?? [];
  const preBalances = meta.preTokenBalances ?? [];

  // All ATA entries belonging to the fee payer with the expected mint
  const feePayerPostEntries = postBalances.filter(
    (b) => b.owner === feePayerPublicKey && b.mint === mintAddress,
  );

  if (feePayerPostEntries.length === 0) {
    return fail(
      `Fee payer did not receive any ${symbol} in this transaction. ` +
        `Ensure the payment was sent to the correct address: ${feePayerPublicKey}`,
    );
  }

  // Net delta across all ATAs (handles edge case of multiple token accounts)
  let totalDelta = 0n;

  for (const post of feePayerPostEntries) {
    const postRaw = BigInt(post.uiTokenAmount.amount);

    const pre = preBalances.find((b) => b.accountIndex === post.accountIndex);
    const preRaw = BigInt(pre?.uiTokenAmount?.amount ?? "0");

    totalDelta += postRaw - preRaw;
  }

  if (totalDelta <= 0n) {
    return fail(
      `Fee payer's ${symbol} balance did not increase in this transaction`,
    );
  }

  // Amount tolerance: delta must be ≥ expected × (1 - tolerance)
  const toleranceFactor = BigInt(10_000 - AMOUNT_TOLERANCE_BPS); // e.g. 9950 for 50 bps
  const minimumAcceptable = (expectedRaw * toleranceFactor) / 10_000n;

  if (totalDelta < minimumAcceptable) {
    // Format with 6 decimals for the error message
    const fmt = (raw) => (Number(raw) / 1_000_000).toFixed(6);
    return fail(
      `Received ${fmt(totalDelta)} ${symbol} but expected ${fmt(expectedRaw)} ${symbol} ` +
        `(tolerance: ${AMOUNT_TOLERANCE_BPS} bps / ${AMOUNT_TOLERANCE_BPS / 100}%)`,
    );
  }

  return pass({ deltaRaw: totalDelta });
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Verify a Solana USDC or USDT payment end-to-end.
 *
 * @param {object} params
 * @param {string} params.txSignature    — base58 Solana transaction signature
 * @param {string} params.expectedToken  — "USDC" | "USDT"
 * @param {number} params.expectedAmount — human-readable (e.g. 10.50 for $10.50)
 *
 * @returns {Promise<{
 *   ok:         boolean,
 *   reason?:    string,
 *   slot?:      number,
 *   blockTime?: number,
 *   deltaRaw?:  bigint,
 *   token?:     object,
 * }>}
 */
export async function verifySolanaPayment({
  txSignature,
  expectedToken,
  expectedAmount,
}) {
  // ── 1. Input validation ────────────────────────────────────────────────────
  if (!txSignature || typeof txSignature !== "string") {
    return fail("Missing or invalid transaction signature");
  }

  const tokenSymbol = expectedToken?.toUpperCase();

  if (!ACCEPTED_PAYMENT_TOKENS.has(tokenSymbol)) {
    return fail(
      `"${expectedToken}" is not an accepted payment token. ` +
        `Only USDC and USDT are accepted.`,
    );
  }

  const parsedAmount = Number(expectedAmount);
  if (!parsedAmount || parsedAmount <= 0) {
    return fail("expectedAmount must be a positive number");
  }

  const tokenInfo = getTokenBySymbol(tokenSymbol);

  // ── 2. Double-spend guard ──────────────────────────────────────────────────
  const doubleSpend = await checkDoubleSpend(txSignature);
  if (doubleSpend.used) {
    console.warn(
      `[solanaVerifier] Double-spend — sig: ${txSignature.slice(0, 16)}… ` +
        `existing orderId: ${doubleSpend.orderId} status: ${doubleSpend.status}`,
    );
    return fail("This transaction has already been used for another order");
  }

  // ── 3. Fetch transaction ───────────────────────────────────────────────────
  let tx;
  try {
    tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: COMMITMENT,
    });
  } catch (err) {
    console.error("[solanaVerifier] RPC error:", err.message);
    return fail("Could not fetch transaction from the network — please retry");
  }

  if (!tx) {
    return fail(
      "Transaction not found. It may still be propagating — please retry in a few seconds",
    );
  }

  // ── 4. On-chain success check ──────────────────────────────────────────────
  if (tx.meta?.err) {
    return fail(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
  }

  // ── 5. Recency check ───────────────────────────────────────────────────────
  if (tx.blockTime != null) {
    const ageSeconds = Math.floor(Date.now() / 1000) - tx.blockTime;
    if (ageSeconds > MAX_TX_AGE_SECONDS) {
      return fail(
        `Transaction is ${ageSeconds}s old — maximum is ${MAX_TX_AGE_SECONDS}s. ` +
          `Please make a new payment.`,
      );
    }
  }

  // ── 6 + 7 + 8. Verify fee payer received correct token + amount ───────────
  const rawExpected = toRawAmount(parsedAmount, tokenInfo.decimals);
  const verifyResult = verifySplReceived(
    tx.meta,
    tokenInfo.mint,
    rawExpected,
    tokenSymbol,
  );

  if (!verifyResult.ok) return verifyResult;

  // ── Success ────────────────────────────────────────────────────────────────
  const humanDelta = (Number(verifyResult.deltaRaw) / 1_000_000).toFixed(6);
  console.log(
    `[solanaVerifier] ✅ ${tokenSymbol} payment verified — ` +
      `sig: ${txSignature.slice(0, 16)}… received: ${humanDelta} ` +
      `expected: ${parsedAmount} slot: ${tx.slot}`,
  );

  return pass({
    slot: tx.slot,
    blockTime: tx.blockTime,
    token: tokenInfo,
    deltaRaw: verifyResult.deltaRaw,
  });
}
