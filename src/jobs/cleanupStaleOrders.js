/**
 * src/jobs/cleanupStaleOrders.js
 *
 * Marks truly abandoned orders as FAILED:
 *   - PENDING orders older than MAX_PENDING_AGE_HOURS with no crypto confirmation
 *     (user started checkout but never submitted a transaction)
 *   - CRYPTO_CONFIRMED orders older than MAX_CONFIRMED_AGE_HOURS that were never
 *     dispatched to Reloadly (service crash between confirmation and dispatch)
 *
 * These are not refundable (no Reloadly call was made), but we need to close
 * them so the user can retry and so monitoring dashboards stay accurate.
 *
 * Runs hourly.
 */

import { acquireJobLock } from "./jobLock.js";
import { startJobLog } from "./jobLogger.js";
import { query } from "../db/postgres.js";
import { OrderLog } from "../models/orderLog.js";

const JOB_NAME = "cleanupStaleOrders";

const MAX_PENDING_AGE_HOURS = Number(process.env.MAX_PENDING_AGE_HOURS ?? 1);
const MAX_CONFIRMED_AGE_HOURS = Number(
  process.env.MAX_CONFIRMED_AGE_HOURS ?? 1,
);

export async function cleanupStaleOrders() {
  const release = await acquireJobLock(JOB_NAME);
  if (!release) return;

  const log = await startJobLog(JOB_NAME);

  try {
    // ── Stale PENDING (no crypto tx ever arrived) ──────────────────────────
    const stalePending = await query(
      `UPDATE orders
       SET status        = 'FAILED',
           error_message = 'Order expired — no payment received within the time limit',
           error_code    = 'PAYMENT_TIMEOUT'
       WHERE status     = 'PENDING'
         AND created_at < NOW() - ($1 || ' hours')::INTERVAL
       RETURNING id`,
      [MAX_PENDING_AGE_HOURS],
    );

    // ── Stale CRYPTO_CONFIRMED (crash between confirm and Reloadly dispatch) ─
    const staleConfirmed = await query(
      `UPDATE orders
       SET status        = 'FAILED',
           error_message = 'Order expired — confirmed but never dispatched. Please contact support.',
           error_code    = 'DISPATCH_TIMEOUT'
       WHERE status     = 'CRYPTO_CONFIRMED'
         AND created_at < NOW() - ($1 || ' hours')::INTERVAL
       RETURNING id`,
      [MAX_CONFIRMED_AGE_HOURS],
    );

    const allExpired = [...stalePending.rows, ...staleConfirmed.rows];

    if (allExpired.length > 0) {
      console.log(
        `[${JOB_NAME}] Cleaned up ${allExpired.length} stale order(s): ` +
          `${stalePending.rows.length} pending, ${staleConfirmed.rows.length} confirmed`,
      );

      // Bulk audit log
      await Promise.allSettled(
        allExpired.map((r) =>
          OrderLog.findOneAndUpdate(
            { orderId: r.id },
            {
              $push: {
                events: {
                  event: "ORDER_EXPIRED",
                  data: { source: "cleanup_job" },
                  actor: "system",
                  ts: new Date(),
                },
              },
            },
          ),
        ),
      );
    }

    await log.complete(allExpired.length);
  } catch (err) {
    console.error(`[${JOB_NAME}] Job-level error:`, err.message);
    await log.fail(err);
  } finally {
    await release();
  }
}
