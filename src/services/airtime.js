/**
 * src/services/airtime.js
 *
 * Business logic layer for airtime and data top-ups.
 * Route handlers call these functions — they never call reloadlyClient directly.
 *
 * Separation of concerns:
 *   routes/airtime.js  → HTTP layer  (parse req, call service, send res)
 *   services/airtime.js → domain layer (orchestrate DB + Reloadly calls)
 */

import { reloadlyGet, reloadlyPost } from "./reloadlyClient.js";
import { OperatorCache } from "../models/operatorCache.js";
import { OrderLog } from "../models/orderLog.js";
import {
  createOrder,
  confirmCrypto,
  markProcessing,
  markCompleted,
  markFailed,
  findByCustomIdentifier,
} from "../models/orderQueries.js";
import { verifySolanaPayment } from "./solanaVerifier.js";
import { logVerification } from "./verificationLogger.js";

// ─── Operators ─────────────────────────────────────────────────────────────────

/**
 * List airtime/data operators for a country, using MongoDB cache when available.
 * @param {string} countryCode - ISO-2 e.g. "NG"
 * @param {{ page?: number, size?: number }} opts
 */
export async function listOperators(countryCode, { page = 1, size = 20 } = {}) {
  // 1. Check MongoDB cache first
  const cached = await OperatorCache.find({
    service: "airtime",
    countryCode: countryCode.toUpperCase(),
  }).lean();

  if (cached.length > 0) {
    return cached.map((c) => c.data);
  }

  // 2. Fetch from Reloadly and cache results
  const params = new URLSearchParams({
    countryCode: countryCode.toUpperCase(),
    page,
    size,
    includePin: false,
    includeData: true,
    includeBundles: true,
  });

  const response = await reloadlyGet("airtime", `/operators?${params}`);
  const operators = response.content ?? response;

  // Upsert into MongoDB (fire-and-forget — don't block the response)
  Promise.all(
    operators.map((op) =>
      OperatorCache.findOneAndUpdate(
        { service: "airtime", reloadlyId: op.id },
        {
          service: "airtime",
          reloadlyId: op.id,
          countryCode: op.country?.isoName ?? countryCode,
          data: op,
          cachedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        { upsert: true, new: true },
      ),
    ),
  ).catch((err) => console.error("[airtime] Cache write error:", err.message));

  return operators;
}

/**
 * Auto-detect operator from a phone number.
 * @param {string} phone       - E.164 number e.g. "2348012345678"
 * @param {string} countryCode - ISO-2 e.g. "NG"
 * @param {boolean} suggestAirtimeOnly
 */
export async function detectOperator(
  phone,
  countryCode,
  suggestAirtimeOnly = false,
) {
  const params = new URLSearchParams({
    phone,
    countryCode: countryCode.toUpperCase(),
    suggestedAmountsMap: false,
    suggestAirtimeOnly,
  });

  return reloadlyGet("airtime", `/operators/auto-detect?${params}`);
}

/**
 * Get a single operator by its Reloadly ID.
 */
export async function getOperatorById(operatorId) {
  // Check cache first
  const cached = await OperatorCache.findOne({
    service: "airtime",
    reloadlyId: Number(operatorId),
  }).lean();

  if (cached) return cached.data;

  return reloadlyGet("airtime", `/operators/${operatorId}`);
}

// ─── Data bundles ──────────────────────────────────────────────────────────────

/**
 * List data bundles available for a specific operator.
 * @param {number|string} operatorId
 */
export async function listDataBundles(operatorId) {
  return reloadlyGet("airtime", `/operators/${operatorId}/data-bundles`);
}

// ─── Top-up ────────────────────────────────────────────────────────────────────

/**
 * Process an airtime OR data top-up end-to-end:
 *   1. Idempotency check
 *   2. Create pending order in Postgres
 *   3. Verify Solana payment on-chain
 *   4. Dispatch to Reloadly
 *   5. Update order status
 *   6. Append events to MongoDB audit log
 *
 * @param {object} params
 * @param {string} params.firebaseUid
 * @param {"AIRTIME"|"DATA"} params.type
 * @param {string} params.cryptoTxSig     - Solana transaction signature
 * @param {number} params.cryptoAmount    - token amount sent
 * @param {string} params.cryptoToken     - e.g. "USDC"
 * @param {number} params.amountUsd       - USD value
 * @param {number} params.operatorId
 * @param {string} params.phone           - recipient phone (E.164)
 * @param {string} params.countryCode     - ISO-2
 * @param {number} params.amount          - top-up amount
 * @param {boolean} [params.useLocalAmount]
 * @param {string} [params.dataBundle]    - bundle SKU (DATA type only)
 * @param {string} [params.customIdentifier] - caller-supplied idempotency key
 */
export async function processTopup({
  firebaseUid,
  type,
  cryptoTxSig,
  cryptoAmount,
  cryptoToken,
  amountUsd,
  operatorId,
  phone,
  countryCode,
  amount,
  useLocalAmount = false,
  dataBundle,
  customIdentifier,
}) {
  // ── 1. Idempotency ────────────────────────────────────────────────────────
  if (customIdentifier) {
    const existing = await findByCustomIdentifier(customIdentifier);
    if (existing) {
      console.log(
        `[airtime] Duplicate request — returning existing order ${existing.id}`,
      );
      return { order: existing, duplicate: true };
    }
  }

  // ── 2. Create order (PENDING) ─────────────────────────────────────────────
  const order = await createOrder({
    firebaseUid,
    type,
    cryptoTxSig,
    cryptoAmount,
    cryptoToken,
    amountUsd,
    recipient: { phone, countryCode, operatorId },
    customIdentifier,
  });

  const log = await OrderLog.create({
    orderId: order.id,
    firebaseUid,
    type,
    events: [{ event: "ORDER_CREATED", data: { order }, actor: "user" }],
  });

  try {
    // ── 3. Verify Solana payment ────────────────────────────────────────────
    // ─── Replace the payment verification block (same pattern in all 3 services) ──
    const paymentVerified = await verifySolanaPayment({
      txSignature: cryptoTxSig,
      expectedToken: cryptoToken,
      expectedAmount: cryptoAmount,
    });

    // Log every attempt — pass or fail — for audit
    logVerification({
      firebaseUid,
      txSignature: cryptoTxSig,
      tokenSymbol: cryptoToken,
      expectedAmount: cryptoAmount,
      verifyResult: paymentVerified,
    });

    if (!paymentVerified.ok) {
      throw Object.assign(
        new Error(paymentVerified.reason ?? "Payment verification failed"),
        { status: 402 },
      );
    }

    await confirmCrypto(order.id);
    log.events.push({
      event: "CRYPTO_CONFIRMED",
      data: paymentVerified,
      actor: "system",
    });
    await log.save();

    // ── 4. Dispatch to Reloadly ─────────────────────────────────────────────
    const topupPayload = {
      operatorId: Number(operatorId),
      amount,
      useLocalAmount,
      customIdentifier: order.id, // use our PG UUID as Reloadly's idempotency key
      recipientPhone: {
        countryCode: countryCode.toUpperCase(),
        number: phone,
      },
      ...(type === "DATA" && dataBundle ? { dataBundle } : {}),
    };

    const reloadlyResponse = await reloadlyPost(
      "airtime",
      "/topups",
      topupPayload,
    );

    await markProcessing(order.id, String(reloadlyResponse.transactionId));
    log.events.push({
      event: "RELOADLY_DISPATCHED",
      data: reloadlyResponse,
      actor: "system",
    });
    await log.save();

    // ── 5. Check immediate Reloadly status ─────────────────────────────────
    // Reloadly may return SUCCESSFUL synchronously for many operators.
    if (reloadlyResponse.status === "SUCCESSFUL") {
      const completed = await markCompleted(order.id, {
        reloadlyTxId: String(reloadlyResponse.transactionId),
        operatorTxId: reloadlyResponse.operatorTransactionId,
        reloadlyPayload: reloadlyResponse,
      });

      log.events.push({
        event: "ORDER_COMPLETED",
        data: { status: "SUCCESSFUL" },
        actor: "system",
      });
      await log.save();

      return { order: completed, duplicate: false };
    }

    // Otherwise it's PROCESSING — we'll get a webhook later (Step 7)
    const updated = await markProcessing(
      order.id,
      String(reloadlyResponse.transactionId),
    );
    return { order: updated, duplicate: false };
  } catch (err) {
    // ── Error path: mark order FAILED ─────────────────────────────────────
    await markFailed(order.id, {
      errorMessage: err.message,
      errorCode: err.reloadlyCode ?? null,
      reloadlyPayload: err.reloadlyPayload ?? null,
    });

    log.events.push({
      event: "ORDER_FAILED",
      data: { message: err.message, code: err.reloadlyCode },
      actor: "system",
    });
    await log.save();

    throw err; // bubble up to route → errorHandler
  }
}
