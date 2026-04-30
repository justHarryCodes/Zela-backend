/**
 * src/services/utilities.js
 *
 * Business logic for utility bill payments.
 *
 * Flow differs from airtime:
 *   - Reloadly almost never returns SUCCESSFUL synchronously for bills.
 *     The response comes back PROCESSING with a finalStatusAvailabilityAt hint.
 *   - We store that hint in orders.poll_until so a background job (Step 7)
 *     can poll Reloadly's GET /transactions/:id endpoint for a final answer.
 *   - The client polls GET /v1/utilities/orders/:id on our side to track progress.
 *
 * Endpoints used:
 *   GET  /billers                   list billers with filters
 *   GET  /billers/:id               single biller
 *   POST /pay                       submit bill payment
 *   GET  /transactions/:id          check status of a specific transaction
 */

import { reloadlyGet, reloadlyPost } from "./reloadlyClient.js";
import { BillerCache } from "../models/billerCache.js";
import { OrderLog } from "../models/orderLog.js";
import {
  createOrder,
  confirmCrypto,
  markProcessing,
  markCompleted,
  markFailed,
  findByCustomIdentifier,
  setPollUntil,
} from "../models/orderQueries.js";
import { verifySolanaPayment } from "./solanaVerifier.js";
import { logVerification } from "./verificationLogger.js";

// ─── Valid bill types ──────────────────────────────────────────────────────────

export const BILL_TYPES = [
  "ELECTRICITY_BILL_PAYMENT",
  "WATER_BILL_PAYMENT",
  "TV_BILL_PAYMENT",
  "INTERNET_BILL_PAYMENT",
  "INTERNET_BROADBAND_BILL_PAYMENT",
  "GAS_BILL_PAYMENT",
  "TOLL_BILL_PAYMENT",
];

// ─── Billers ───────────────────────────────────────────────────────────────────

/**
 * List billers filtered by country and optional bill type.
 * Results are cached in MongoDB for 6 hours.
 *
 * @param {object} filters
 * @param {string}  filters.countryCode   - ISO-2 e.g. "NG"
 * @param {string}  [filters.type]        - ELECTRICITY_BILL_PAYMENT etc.
 * @param {string}  [filters.serviceType] - PREPAID | POSTPAID
 * @param {number}  [filters.page]
 * @param {number}  [filters.size]
 */
export async function listBillers({
  countryCode,
  type,
  serviceType,
  page = 1,
  size = 50,
} = {}) {
  // ── Check MongoDB cache ────────────────────────────────────────────────────
  const cacheQuery = { countryCode: countryCode.toUpperCase() };
  if (type) cacheQuery.billerType = type;
  if (serviceType) cacheQuery.serviceType = serviceType;

  const cached = await BillerCache.find(cacheQuery).lean();
  if (cached.length > 0) {
    return cached.map((c) => c.data);
  }

  // ── Fetch from Reloadly ────────────────────────────────────────────────────
  const params = new URLSearchParams({ page, size });
  if (countryCode) params.set("countryISOCode", countryCode.toUpperCase());
  if (type) params.set("type", type);
  if (serviceType) params.set("serviceType", serviceType);

  const response = await reloadlyGet("utilities", `/billers?${params}`);
  const billers = response.content ?? response;

  // ── Populate cache (fire-and-forget) ───────────────────────────────────────
  Promise.all(
    billers.map((b) =>
      BillerCache.findOneAndUpdate(
        { reloadlyId: b.id },
        {
          reloadlyId: b.id,
          countryCode: b.countryCode ?? countryCode.toUpperCase(),
          billerType: b.type,
          serviceType: b.serviceType ?? null,
          data: b,
          cachedAt: new Date(),
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        },
        { upsert: true, new: true },
      ),
    ),
  ).catch((err) =>
    console.error("[utilities] Cache write error:", err.message),
  );

  return billers;
}

/**
 * Fetch a single biller by Reloadly ID, checking MongoDB cache first.
 * @param {number|string} billerId
 */
export async function getBillerById(billerId) {
  const cached = await BillerCache.findOne({
    reloadlyId: Number(billerId),
  }).lean();
  if (cached) return cached.data;
  return reloadlyGet("utilities", `/billers/${billerId}`);
}

/**
 * List all supported bill types with UI metadata from Postgres.
 * Thin wrapper — just returns the static reference table.
 */
export async function listBillTypes() {
  return BILL_TYPES.map((code) => ({ code }));
}

// ─── Amount validation ────────────────────────────────────────────────────────

/**
 * Validate that the payment amount falls within a biller's limits.
 * Throws an HTTP 422 error if out of range.
 *
 * @param {object} biller      - full biller object from Reloadly
 * @param {number} amount      - amount the user wants to pay
 * @param {boolean} useLocal   - true = amount is in biller's local currency
 */
function assertAmountInRange(biller, amount, useLocal) {
  if (useLocal) {
    const min = biller.minLocalTransactionAmount;
    const max = biller.maxLocalTransactionAmount;
    if (min != null && amount < min) {
      const err = new Error(
        `Amount ${amount} is below the minimum ${min} ${biller.localTransactionCurrencyCode}`,
      );
      err.status = 422;
      throw err;
    }
    if (max != null && amount > max) {
      const err = new Error(
        `Amount ${amount} exceeds the maximum ${max} ${biller.localTransactionCurrencyCode}`,
      );
      err.status = 422;
      throw err;
    }
  } else {
    const min = biller.minInternationalTransactionAmount;
    const max = biller.maxInternationalTransactionAmount;
    if (min != null && amount < min) {
      const err = new Error(
        `Amount $${amount} is below the minimum $${min} USD`,
      );
      err.status = 422;
      throw err;
    }
    if (max != null && amount > max) {
      const err = new Error(
        `Amount $${amount} exceeds the maximum $${max} USD`,
      );
      err.status = 422;
      throw err;
    }
  }
}

// ─── Transaction status ───────────────────────────────────────────────────────

/**
 * Fetch the current status of a utility transaction directly from Reloadly.
 * Used by the status-poll route and the background job.
 *
 * @param {number|string} reloadlyTxId
 */
export async function getReloadlyTransactionStatus(reloadlyTxId) {
  return reloadlyGet("utilities", `/transactions/${reloadlyTxId}`);
}

// ─── Bill payment ─────────────────────────────────────────────────────────────

/**
 * End-to-end utility bill payment:
 *   1. Idempotency check
 *   2. Validate biller exists + amount in range
 *   3. Create PENDING order in Postgres
 *   4. Verify Solana payment on-chain
 *   5. POST to Reloadly /pay
 *   6. Store poll_until for background poller
 *   7. Append events to MongoDB audit log
 *
 * @param {object} params
 * @param {string}  params.firebaseUid
 * @param {string}  params.cryptoTxSig
 * @param {number}  params.cryptoAmount
 * @param {string}  params.cryptoToken
 * @param {number}  params.amountUsd
 * @param {number}  params.billerId
 * @param {string}  params.subscriberAccountNumber
 * @param {number}  params.amount
 * @param {boolean} [params.useLocalAmount]
 * @param {string}  [params.customIdentifier]
 */
export async function processBillPayment({
  firebaseUid,
  cryptoTxSig,
  cryptoAmount,
  cryptoToken,
  amountUsd,
  billerId,
  subscriberAccountNumber,
  amount,
  useLocalAmount = false,
  customIdentifier,
}) {
  // ── 1. Idempotency ──────────────────────────────────────────────────────────
  if (customIdentifier) {
    const existing = await findByCustomIdentifier(customIdentifier);
    if (existing) {
      console.log(
        `[utilities] Duplicate request — returning order ${existing.id}`,
      );
      return { order: existing, duplicate: true };
    }
  }

  // ── 2. Validate biller + amount ─────────────────────────────────────────────
  const biller = await getBillerById(billerId);
  if (!biller) {
    const err = new Error(`Biller ${billerId} not found`);
    err.status = 404;
    throw err;
  }
  assertAmountInRange(biller, amount, useLocalAmount);

  // ── 3. Create order (PENDING) ───────────────────────────────────────────────
  const order = await createOrder({
    firebaseUid,
    type: "UTILITY",
    cryptoTxSig,
    cryptoAmount,
    cryptoToken,
    amountUsd,
    recipient: {
      billerId,
      billerName: biller.name,
      billerType: biller.type,
      countryCode: biller.countryCode,
      subscriberAccountNumber: String(subscriberAccountNumber),
    },
    customIdentifier,
  });

  const log = await OrderLog.create({
    orderId: order.id,
    firebaseUid,
    type: "UTILITY",
    events: [
      { event: "ORDER_CREATED", data: { order, biller }, actor: "user" },
    ],
  });

  try {
    // ── 4. Verify Solana payment ──────────────────────────────────────────────
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

    // ── 5. POST to Reloadly /pay ──────────────────────────────────────────────
    const payPayload = {
      subscriberAccountNumber: String(subscriberAccountNumber),
      amount,
      billerId: Number(billerId),
      useLocalAmount,
      referenceId: order.id, // our UUID = idempotency key on Reloadly's side
    };

    const reloadlyResponse = await reloadlyPost(
      "utilities",
      "/pay",
      payPayload,
    );

    // ── 6. Store Reloadly tx ID + poll deadline ───────────────────────────────
    // Utility payments are almost always PROCESSING — store the
    // finalStatusAvailabilityAt so the background poller knows when to check.
    const reloadlyTxId = String(reloadlyResponse.id);

    await markProcessing(order.id, reloadlyTxId);

    if (reloadlyResponse.finalStatusAvailabilityAt) {
      // Parse Reloadly's datetime string — they return "YYYY-MM-DD HH:MM:SS"
      const pollUntil = new Date(
        reloadlyResponse.finalStatusAvailabilityAt.replace(" ", "T") + "Z",
      );
      // Add a 30-min buffer past their estimate in case they're slow
      pollUntil.setMinutes(pollUntil.getMinutes() + 30);
      await setPollUntil(order.id, pollUntil);
    }

    log.events.push({
      event: "RELOADLY_DISPATCHED",
      data: reloadlyResponse,
      actor: "system",
    });
    await log.save();

    // ── 7. Handle rare synchronous success ────────────────────────────────────
    if (reloadlyResponse.status === "SUCCESSFUL") {
      const completed = await markCompleted(order.id, {
        reloadlyTxId,
        operatorTxId: null,
        reloadlyPayload: reloadlyResponse,
      });
      log.events.push({
        event: "ORDER_COMPLETED",
        data: reloadlyResponse,
        actor: "system",
      });
      await log.save();
      return { order: completed, duplicate: false };
    }

    // Return the PROCESSING order — the client polls /orders/:id
    const updated = await markProcessing(order.id, reloadlyTxId);
    return { order: updated, duplicate: false };
  } catch (err) {
    await markFailed(order.id, {
      errorMessage: err.message,
      errorCode: err.reloadlyCode ?? null,
      reloadlyPayload: null,
    });
    log.events.push({
      event: "ORDER_FAILED",
      data: { message: err.message, code: err.reloadlyCode },
      actor: "system",
    });
    await log.save();
    throw err;
  }
}
