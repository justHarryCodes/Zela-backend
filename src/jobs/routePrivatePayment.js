/**
 * src/jobs/routePrivatePayments.js
 *
 * Background job: retries Umbra routing for private payments that are stuck
 * in 'pending' or have failed ≤ 5 times.
 *
 * ─── Why this job exists ──────────────────────────────────────────────────────
 *
 *   The POST /v1/pay/private route triggers Umbra routing via setImmediate()
 *   after the deposit tx confirms. If the Umbra SDK call fails (network blip,
 *   RPC timeout, relay wallet out of gas), the payment is marked 'failed' and
 *   stays in the DB with retry_count and next_retry_at.
 *
 *   This job runs every 2 minutes, picks up:
 *     • 'pending' payments older than 30s (setImmediate window has passed)
 *     • 'failed' payments with retry_count < 5 and next_retry_at ≤ NOW()
 *
 *   Exponential back-off is computed in markPaymentFailed():
 *     next_retry_at = NOW() + (min(retry_count + 1, 6) × 5 minutes)
 *   → delays: 5m, 10m, 15m, 20m, 25m (capped at 30m)
 *
 *   After 5 failures the payment is left in 'failed' state for manual review.
 *   Alert on: SELECT count(*) FROM private_payments WHERE status='failed' AND retry_count >= 5
 *
 * ─── Adding to the job runner ─────────────────────────────────────────────────
 *
 *   In src/jobs/runner.js, add:
 *
 *     import { runRoutePrivatePaymentsJob } from "./routePrivatePayments.js";
 *
 *     // Inside startJobs():
 *     scheduleJob("routePrivatePayments", "0 *\/2 * * * *", runRoutePrivatePaymentsJob);
 *     //                                  └─ every 2 minutes (cron-style)
 */

import {
  getPendingUnroutedPayments,
  getRetryableFailedPayments,
  getIdentityByHash,
} from "../db/privatePayment.js";

import { routePaymentAsync } from "../routes/privatePay.js";

// ─── Job runner ───────────────────────────────────────────────────────────────

let _running = false; // guard against concurrent execution

/**
 * Processes one batch of pending and failed payments.
 * Safe to call from any scheduler (cron, setInterval, etc.).
 * Concurrent calls are skipped — only one execution at a time.
 *
 * @returns {Promise<{ processed: number, skipped: number }>}
 */
export async function runRoutePrivatePaymentsJob() {
  if (_running) {
    console.log(
      "[routePrivatePayments] Skipped — previous run still in progress.",
    );
    return { processed: 0, skipped: 0 };
  }

  _running = true;
  let processed = 0;
  let skipped = 0;

  try {
    const [pending, retryable] = await Promise.all([
      getPendingUnroutedPayments(30),
      getRetryableFailedPayments(),
    ]);

    // Deduplicate by payment ID (could theoretically appear in both lists)
    const seenIds = new Set();
    const batch = [];

    for (const p of [...pending, ...retryable]) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        batch.push(p);
      }
    }

    if (batch.length === 0) {
      console.log("[routePrivatePayments] No payments to route.");
      return { processed: 0, skipped: 0 };
    }

    console.log(
      `[routePrivatePayments] Processing ${batch.length} payment(s).`,
    );

    for (const payment of batch) {
      try {
        // Look up recipient registration status
        const recipientRecord = await getIdentityByHash(
          payment.recipient_identity_hash,
        );

        await routePaymentAsync({
          paymentId: payment.id,
          recipientIdentityHash: payment.recipient_identity_hash,
          isRegistered: !!recipientRecord,
          registeredWallet: recipientRecord?.wallet_address ?? null,
          relayAmountRaw: BigInt(payment.relay_amount_raw),
          tokenSymbol: payment.token_symbol,
          recipientPhone: payment.recipientPhone ?? null, // decrypted by getPending*
          amountUSD: parseFloat(payment.amount_usd),
        });

        processed++;
      } catch (err) {
        // routePaymentAsync already calls markPaymentFailed internally.
        // Log here for visibility without crashing the batch.
        console.error(
          `[routePrivatePayments] Error routing payment ${payment.id}:`,
          err.message,
        );
        skipped++;
      }
    }
  } catch (err) {
    console.error("[routePrivatePayments] Job error:", err.message);
  } finally {
    _running = false;
  }

  console.log(
    `[routePrivatePayments] Done — processed: ${processed}, skipped: ${skipped}`,
  );

  return { processed, skipped };
}
