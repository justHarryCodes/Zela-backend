/**
 * src/services/giftcards.js
 *
 * Business logic for gift card purchases.
 *
 * Flow:
 *   1. Idempotency check
 *   2. Fetch product → validate denomination
 *   3. Create PENDING order in Postgres
 *   4. Verify Solana payment on-chain
 *   5. POST /orders to Reloadly → almost always SUCCESSFUL synchronously
 *   6. Fetch redeem code from Reloadly → encrypt → store in MongoDB
 *   7. Mark order COMPLETED in Postgres + set redeem_code_fetched = true
 *   8. Append events to MongoDB audit log
 *
 * Key endpoints:
 *   GET  /products                         — all products (paginated)
 *   GET  /countries/:countryCode/products  — products by country
 *   GET  /products/:productId              — single product
 *   POST /orders                           — place order
 *   GET  /orders/:transactionId/redeem-code — fetch code (sensitive)
 */

import { reloadlyGet, reloadlyPost } from "./reloadlyClient.js";
import { GiftCardProductCache } from "../models/giftCardProductCache.js";
import { GiftCardRedeemCode } from "../models/giftCardRedeemCode.js";
import { OrderLog } from "../models/orderLog.js";
import { encrypt } from "../lib/encryption.js";
import { query } from "../db/postgres.js";
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

// ─── Product catalog ───────────────────────────────────────────────────────────

/**
 * List all gift card products, with optional country filter.
 * Results are cached in MongoDB for 12 hours.
 *
 * @param {object} opts
 * @param {string}  [opts.countryCode]    - ISO-2 filter
 * @param {string}  [opts.productName]    - partial name search
 * @param {boolean} [opts.includeRange]   - include RANGE denomination products
 * @param {boolean} [opts.includeFixed]   - include FIXED denomination products
 * @param {number}  [opts.page]
 * @param {number}  [opts.size]
 */
export async function listProducts({
  countryCode,
  productName,
  includeRange = true,
  includeFixed = true,
  page = 1,
  size = 50,
} = {}) {
  // ── MongoDB cache check ────────────────────────────────────────────────────
  if (countryCode && !productName) {
    const cached = await GiftCardProductCache.find({
      countryCode: countryCode.toUpperCase(),
    })
      .limit(size)
      .lean();

    if (cached.length > 0) return cached.map((c) => c.data);
  }

  // ── Reloadly fetch ─────────────────────────────────────────────────────────
  const path = countryCode
    ? `/countries/${countryCode.toUpperCase()}/products`
    : `/products`;

  const params = new URLSearchParams({
    size,
    page,
    includeRange,
    includeFixed,
    ...(productName ? { productName } : {}),
  });

  const response = await reloadlyGet("giftcards", `${path}?${params}`);
  const products = response.content ?? response;

  // ── Populate cache (fire-and-forget) ──────────────────────────────────────
  Promise.all(
    products.map((p) =>
      GiftCardProductCache.findOneAndUpdate(
        { productId: p.productId },
        {
          productId: p.productId,
          productName: p.productName,
          countryCode: p.country?.isoName ?? countryCode ?? "GLOBAL",
          brandId: p.brand?.brandId,
          brandName: p.brand?.brandName,
          denominationType: p.denominationType,
          global: p.global ?? false,
          data: p,
          cachedAt: new Date(),
          expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
        },
        { upsert: true, new: true },
      ),
    ),
  ).catch((err) =>
    console.error("[giftcards] Cache write error:", err.message),
  );

  return products;
}

/**
 * Get a single product by Reloadly product ID.
 * @param {number|string} productId
 */
export async function getProductById(productId) {
  const cached = await GiftCardProductCache.findOne({
    productId: Number(productId),
  }).lean();

  if (cached) return cached.data;
  return reloadlyGet("giftcards", `/products/${productId}`);
}

// ─── Denomination validation ───────────────────────────────────────────────────

/**
 * Validate that a requested unit price is valid for a given product.
 * Throws a 422 error with a descriptive message on failure.
 *
 * @param {object} product      — full product from Reloadly
 * @param {number} unitPrice    — the amount the user wants to purchase
 */
function assertValidDenomination(product, unitPrice) {
  if (product.denominationType === "FIXED") {
    const valid = product.fixedRecipientDenominations ?? [];

    if (!valid.includes(Number(unitPrice))) {
      const err = new Error(
        `Invalid denomination $${unitPrice} for "${product.productName}". ` +
          `Valid values: ${valid.map((v) => `$${v}`).join(", ")}`,
      );
      err.status = 422;
      throw err;
    }
  } else if (product.denominationType === "RANGE") {
    const min = product.minRecipientDenomination;
    const max = product.maxRecipientDenomination;

    if (min != null && unitPrice < min) {
      const err = new Error(
        `Amount $${unitPrice} is below the minimum $${min} for "${product.productName}"`,
      );
      err.status = 422;
      throw err;
    }
    if (max != null && unitPrice > max) {
      const err = new Error(
        `Amount $${unitPrice} exceeds the maximum $${max} for "${product.productName}"`,
      );
      err.status = 422;
      throw err;
    }
  }
}

// ─── Redeem code helpers ───────────────────────────────────────────────────────

/**
 * Fetch the redeem code(s) from Reloadly, encrypt each one, and store in Mongo.
 * Called right after a SUCCESSFUL order response.
 *
 * Reloadly returns:
 *   { cardNumber: "...", pinCode: "...", ... }
 *   OR an array for quantity > 1
 *
 * @param {object} params
 * @param {string}  params.orderId
 * @param {string}  params.firebaseUid
 * @param {number}  params.reloadlyTransactionId
 * @param {number}  params.productId
 * @param {string}  params.productName
 * @param {number}  params.quantity
 */
async function fetchAndStoreRedeemCodes({
  orderId,
  firebaseUid,
  reloadlyTransactionId,
  productId,
  productName,
  quantity,
}) {
  const raw = await reloadlyGet(
    "giftcards",
    `/orders/${reloadlyTransactionId}/redeem-code`,
  );

  // Reloadly returns a single object for qty=1, array for qty>1
  const rawCodes = Array.isArray(raw) ? raw : [raw];

  const encryptedCodes = rawCodes.map((entry) => {
    // The code itself is in cardNumber; PIN (if applicable) in pinCode
    const plaintext = JSON.stringify({
      cardNumber: entry.cardNumber ?? null,
      pinCode: entry.pinCode ?? null,
    });
    return encrypt(plaintext);
  });

  await GiftCardRedeemCode.findOneAndUpdate(
    { orderId },
    {
      orderId,
      firebaseUid,
      productId,
      productName,
      quantity,
      codes: encryptedCodes,
      reloadlyTransactionId,
    },
    { upsert: true, new: true },
  );

  // Mark Postgres row as having the code fetched
  await query(`UPDATE orders SET redeem_code_fetched = TRUE WHERE id = $1`, [
    orderId,
  ]);
}

// ─── Place order ───────────────────────────────────────────────────────────────

/**
 * End-to-end gift card purchase:
 *
 * @param {object} params
 * @param {string}  params.firebaseUid
 * @param {string}  params.cryptoTxSig
 * @param {number}  params.cryptoAmount
 * @param {string}  params.cryptoToken
 * @param {number}  params.amountUsd
 * @param {number}  params.productId
 * @param {string}  params.countryCode
 * @param {number}  params.quantity          default 1
 * @param {number}  params.unitPrice         must match product denomination
 * @param {string}  params.senderName
 * @param {string}  params.recipientEmail
 * @param {object}  [params.recipientPhone]  { countryCode, phoneNumber }
 * @param {string}  [params.customIdentifier]
 */
export async function purchaseGiftCard({
  firebaseUid,
  cryptoTxSig,
  cryptoAmount,
  cryptoToken,
  amountUsd,
  productId,
  countryCode,
  quantity = 1,
  unitPrice,
  senderName,
  recipientEmail,
  recipientPhone,
  customIdentifier,
}) {
  // ── 1. Idempotency ──────────────────────────────────────────────────────────
  if (customIdentifier) {
    const existing = await findByCustomIdentifier(customIdentifier);
    if (existing) {
      console.log(`[giftcards] Duplicate — returning order ${existing.id}`);
      return { order: existing, duplicate: true };
    }
  }

  // ── 2. Validate product + denomination ──────────────────────────────────────
  const product = await getProductById(productId);
  if (!product) {
    const err = new Error(`Product ${productId} not found`);
    err.status = 404;
    throw err;
  }
  assertValidDenomination(product, unitPrice);

  // ── 3. Create PENDING order ─────────────────────────────────────────────────
  const order = await createOrder({
    firebaseUid,
    type: "GIFTCARD",
    cryptoTxSig,
    cryptoAmount,
    cryptoToken,
    amountUsd,
    recipient: {
      productId,
      productName: product.productName,
      brandName: product.brand?.brandName,
      countryCode: countryCode.toUpperCase(),
      recipientEmail,
      recipientPhone: recipientPhone ?? null,
      senderName,
      unitPrice,
      quantity,
    },
    customIdentifier,
  });

  // Also set the quantity column
  await query(`UPDATE orders SET quantity = $2 WHERE id = $1`, [
    order.id,
    quantity,
  ]);

  const log = await OrderLog.create({
    orderId: order.id,
    firebaseUid,
    type: "GIFTCARD",
    events: [
      {
        event: "ORDER_CREATED",
        data: { productId, unitPrice, quantity },
        actor: "user",
      },
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

    // ── 5. POST to Reloadly /orders ───────────────────────────────────────────
    const orderPayload = {
      productId: Number(productId),
      countryCode: countryCode.toUpperCase(),
      quantity: Number(quantity),
      unitPrice: Number(unitPrice),
      customIdentifier: order.id, // our PG UUID as Reloadly idempotency key
      senderName,
      recipientEmail,
      ...(recipientPhone ? { recipientPhoneDetails: recipientPhone } : {}),
    };

    const reloadlyResponse = await reloadlyPost(
      "giftcards",
      "/orders",
      orderPayload,
    );
    const reloadlyTxId = reloadlyResponse.transactionId;

    log.events.push({
      event: "RELOADLY_DISPATCHED",
      data: reloadlyResponse,
      actor: "system",
    });
    await log.save();

    // ── 6. Mark as PROCESSING while we fetch the code ─────────────────────────
    await markProcessing(order.id, String(reloadlyTxId));

    // ── 7. Fetch + encrypt + store the redeem code ────────────────────────────
    // We do this immediately since gift card orders are synchronously SUCCESSFUL.
    // If this step fails we still have the order record to retry from (Step 7 job).
    await fetchAndStoreRedeemCodes({
      orderId: order.id,
      firebaseUid,
      reloadlyTransactionId: reloadlyTxId,
      productId: Number(productId),
      productName: product.productName,
      quantity: Number(quantity),
    });

    // ── 8. Mark COMPLETED ─────────────────────────────────────────────────────
    const completed = await markCompleted(order.id, {
      reloadlyTxId: String(reloadlyTxId),
      operatorTxId: reloadlyResponse.customIdentifier ?? null,
      // Strip the code from what goes into Postgres — it's already in Mongo encrypted
      reloadlyPayload: {
        ...reloadlyResponse,
        // Remove any code fields if Reloadly ever includes them in the order response
        cardNumber: "[REDACTED]",
        pinCode: "[REDACTED]",
      },
    });

    log.events.push({
      event: "ORDER_COMPLETED",
      data: { status: "SUCCESSFUL" },
      actor: "system",
    });
    await log.save();

    return { order: completed, duplicate: false };
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

// ─── Retrieve stored redeem code (authenticated) ───────────────────────────────

/**
 * Decrypt and return the redeem code(s) for an order.
 * Only callable by the original purchaser (firebaseUid check).
 *
 * @param {string} orderId
 * @param {string} firebaseUid
 * @returns {Promise<Array<{ cardNumber: string|null, pinCode: string|null }>>}
 */
export async function getRedeemCodes(orderId, firebaseUid) {
  const record = await GiftCardRedeemCode.findOne({
    orderId,
    firebaseUid,
  }).lean();

  if (!record) {
    const err = new Error("Redeem code not found or access denied");
    err.status = 404;
    throw err;
  }

  const { decrypt } = await import("../lib/encryption.js");

  return record.codes.map((enc) => JSON.parse(decrypt(enc)));
}
