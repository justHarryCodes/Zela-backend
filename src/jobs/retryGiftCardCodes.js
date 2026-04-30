/**
 * src/jobs/retryGiftCardCodes.js
 *
 * Retries redeem code fetch + encrypt + store for COMPLETED gift card orders
 * where the code wasn't captured the first time (redeem_code_fetched = FALSE).
 *
 * This can happen if:
 *   - The Reloadly redeem-code endpoint was temporarily unavailable
 *   - The encryption/Mongo write failed after the order was marked COMPLETED
 *   - The process crashed between markCompleted and fetchAndStoreRedeemCodes
 *
 * Runs every 5 minutes. Gives up after MAX_CODE_FETCH_ATTEMPTS.
 */

import { acquireJobLock } from "./jobLock.js";
import { startJobLog } from "./jobLogger.js";
import { query } from "../db/postgres.js";
import { reloadlyGet } from "../services/reloadlyClient.js";
import { GiftCardRedeemCode } from "../models/giftCardRedeemCode.js";
import { encrypt } from "../lib/encryption.js";
import { OrderLog } from "../models/orderLog.js";

const JOB_NAME = "retryGiftCardCodes";
const MAX_CODE_FETCH_ATTEMPTS = Number(
  process.env.GIFTCARD_MAX_CODE_ATTEMPTS ?? 5,
);

export async function retryGiftCardCodes() {
  const release = await acquireJobLock(JOB_NAME);
  if (!release) {
    console.log(`[${JOB_NAME}] Skipping — another instance holds the lock`);
    return;
  }

  const log = await startJobLog(JOB_NAME);
  let processed = 0;
  let failed = 0;

  try {
    // Find COMPLETED gift card orders missing their redeem code
    // poll_attempts doubles as code-fetch attempt counter for this job
    const { rows: orders } = await query(
      `SELECT id, firebase_uid, reloadly_tx_id, recipient, quantity
       FROM   orders
       WHERE  type                = 'GIFTCARD'
         AND  status              = 'COMPLETED'
         AND  redeem_code_fetched = FALSE
         AND  poll_attempts       < $1
       ORDER  BY created_at ASC
       LIMIT  20`,
      [MAX_CODE_FETCH_ATTEMPTS],
    );

    if (orders.length === 0) {
      await log.complete(0);
      return;
    }

    console.log(`[${JOB_NAME}] Retrying codes for ${orders.length} order(s)`);

    for (const order of orders) {
      // Increment attempt counter before trying
      await query(
        `UPDATE orders
         SET poll_attempts = poll_attempts + 1, last_polled_at = NOW()
         WHERE id = $1`,
        [order.id],
      );

      try {
        await fetchAndStoreCode(order);
        processed++;
      } catch (err) {
        failed++;
        console.error(
          `[${JOB_NAME}] Code fetch failed for order ${order.id}:`,
          err.message,
        );
      }
    }

    // Mark permanently failed orders that exhausted all attempts
    await abandonExpiredCodeFetches();

    await log.complete(processed, failed);
  } catch (err) {
    console.error(`[${JOB_NAME}] Job-level error:`, err.message);
    await log.fail(err);
  } finally {
    await release();
  }
}

// ─── Fetch + encrypt + store a single order's code ────────────────────────────

async function fetchAndStoreCode(order) {
  const recipient = order.recipient ?? {};

  const raw = await reloadlyGet(
    "giftcards",
    `/orders/${order.reloadly_tx_id}/redeem-code`,
  );

  const rawCodes = Array.isArray(raw) ? raw : [raw];
  const encrypted = rawCodes.map((entry) =>
    encrypt(
      JSON.stringify({
        cardNumber: entry.cardNumber ?? null,
        pinCode: entry.pinCode ?? null,
      }),
    ),
  );

  await GiftCardRedeemCode.findOneAndUpdate(
    { orderId: order.id },
    {
      orderId: order.id,
      firebaseUid: order.firebase_uid,
      productId: recipient.productId,
      productName: recipient.productName ?? "Gift Card",
      quantity: order.quantity ?? 1,
      codes: encrypted,
      reloadlyTransactionId: Number(order.reloadly_tx_id),
    },
    { upsert: true, new: true },
  );

  // Mark fetched in Postgres
  await query(`UPDATE orders SET redeem_code_fetched = TRUE WHERE id = $1`, [
    order.id,
  ]);

  await OrderLog.findOneAndUpdate(
    { orderId: order.id },
    {
      $push: {
        events: {
          event: "REDEEM_CODE_STORED",
          data: { source: "retry_job" },
          actor: "system",
          ts: new Date(),
        },
      },
    },
  );

  console.log(`[${JOB_NAME}] ✅ Code stored for order ${order.id}`);
}

// ─── Give up on permanently failing code fetches ──────────────────────────────

async function abandonExpiredCodeFetches() {
  const result = await query(
    `UPDATE orders
     SET error_message = 'Redeem code could not be fetched after maximum attempts',
         error_code    = 'CODE_FETCH_EXHAUSTED'
     WHERE type                = 'GIFTCARD'
       AND status              = 'COMPLETED'
       AND redeem_code_fetched = FALSE
       AND poll_attempts       >= $1
     RETURNING id`,
    [MAX_CODE_FETCH_ATTEMPTS],
  );

  if (result.rows.length > 0) {
    console.error(
      `[${JOB_NAME}] ⚠️  Gave up on ${result.rows.length} order(s) — manual intervention required:`,
      result.rows.map((r) => r.id).join(", "),
    );
  }
}
