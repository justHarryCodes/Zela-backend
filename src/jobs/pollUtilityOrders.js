/**
 * src/jobs/pollUtilityOrders.js
 *
 * Polls Reloadly for final status on PROCESSING utility bill payment orders.
 *
 * Runs every 2 minutes (configurable via JOB_UTILITY_POLL_INTERVAL).
 *
 * Logic:
 *   1. Acquire Postgres advisory lock (skip if another instance is running)
 *   2. Fetch all PROCESSING utility orders where:
 *        poll_until > NOW()                (still within Reloadly's estimate)
 *        poll_attempts < MAX_POLL_ATTEMPTS (haven't exhausted retries)
 *   3. For each order — call Reloadly GET /transactions/:id
 *   4. If SUCCESSFUL → markCompleted, update audit log
 *      If FAILED     → markFailed, update audit log
 *      If still pending → increment poll_attempts, update last_polled_at
 *   5. Any order beyond poll_until AND MAX_POLL_ATTEMPTS → mark FAILED
 *      ("Reloadly did not confirm within the expected window")
 */

import { acquireJobLock } from "./jobLock.js";
import { startJobLog } from "./jobLogger.js";
import { query } from "../db/postgres.js";
import { getPendingPollOrders} from "../models/orderQueries.js";
import { markCompleted, markFailed } from "../models/orderQueries.js";
import { getReloadlyTransactionStatus } from "../services/utilities.js";
import { OrderLog } from "../models/orderLog.js";

const JOB_NAME = "pollUtilityOrders";
const MAX_POLL_ATTEMPTS = Number(process.env.UTILITY_MAX_POLL_ATTEMPTS ?? 20);

export async function pollUtilityOrders() {
  // ── Advisory lock ────────────────────────────────────────────────────────
  const release = await acquireJobLock(JOB_NAME);
  if (!release) {
    console.log(`[${JOB_NAME}] Skipping — another instance holds the lock`);
    return;
  }

  const log = await startJobLog(JOB_NAME);
  let processed = 0;
  let failed = 0;

  try {
    const orders = await getPendingPollOrders(); // type = UTILITY, status = PROCESSING

    if (orders.length === 0) {
      await log.complete(0);
      return;
    }

    console.log(
      `[${JOB_NAME}] Polling ${orders.length} pending utility order(s)`,
    );

    for (const order of orders) {
      try {
        await processOneOrder(order);
        processed++;
      } catch (err) {
        failed++;
        console.error(
          `[${JOB_NAME}] Error processing order ${order.id}:`,
          err.message,
        );
      }
    }

    // ── Expire overdue orders ──────────────────────────────────────────────
    // Orders past poll_until with no resolution → mark FAILED
    await expireOverdueOrders();

    await log.complete(processed, failed);
    console.log(
      `[${JOB_NAME}] Done — processed: ${processed} failed: ${failed}`,
    );
  } catch (err) {
    console.error(`[${JOB_NAME}] Job-level error:`, err.message);
    await log.fail(err);
  } finally {
    await release();
  }
}

// ─── Process a single order ───────────────────────────────────────────────────

async function processOneOrder(order) {
  // Increment attempt counter first so a crash doesn't cause infinite retries
  await query(
    `UPDATE orders
     SET poll_attempts = poll_attempts + 1, last_polled_at = NOW()
     WHERE id = $1`,
    [order.id],
  );

  let reloadlyTx;
  try {
    reloadlyTx = await getReloadlyTransactionStatus(order.reloadly_tx_id);
  } catch (err) {
    // Reloadly 404 or 5xx — don't fail the order yet, just skip this attempt
    console.warn(
      `[${JOB_NAME}] Reloadly status fetch failed for order ${order.id}:`,
      err.message,
    );
    return;
  }

  if (reloadlyTx.status === "SUCCESSFUL") {
    await markCompleted(order.id, {
      reloadlyTxId: String(reloadlyTx.id),
      operatorTxId: reloadlyTx.referenceId ?? null,
      reloadlyPayload: reloadlyTx,
    });

    await OrderLog.findOneAndUpdate(
      { orderId: order.id },
      {
        $push: {
          events: {
            event: "ORDER_COMPLETED",
            data: { source: "poller", status: "SUCCESSFUL" },
            actor: "system",
            ts: new Date(),
          },
        },
      },
    );

    console.log(`[${JOB_NAME}] ✅ Order ${order.id} completed`);
  } else if (reloadlyTx.status === "FAILED") {
    await markFailed(order.id, {
      errorMessage: reloadlyTx.message ?? "Reloadly reported failure",
      errorCode: reloadlyTx.errorCode ?? null,
      reloadlyPayload: reloadlyTx,
    });

    await OrderLog.findOneAndUpdate(
      { orderId: order.id },
      {
        $push: {
          events: {
            event: "ORDER_FAILED",
            data: { source: "poller", reloadlyTx },
            actor: "system",
            ts: new Date(),
          },
        },
      },
    );

    console.log(`[${JOB_NAME}] ❌ Order ${order.id} failed`);
  }
  // else still PROCESSING — do nothing, will retry on next run
}

// ─── Expire overdue orders ────────────────────────────────────────────────────

async function expireOverdueOrders() {
  const result = await query(
    `UPDATE orders
     SET status        = 'FAILED',
         error_message = 'Reloadly did not confirm within the expected window',
         error_code    = 'POLL_TIMEOUT'
     WHERE type        = 'UTILITY'
       AND status      = 'PROCESSING'
       AND (
             poll_until < NOW()
             OR poll_attempts >= $1
           )
     RETURNING id`,
    [MAX_POLL_ATTEMPTS],
  );

  if (result.rows.length > 0) {
    console.warn(
      `[${JOB_NAME}] Expired ${result.rows.length} overdue order(s):`,
      result.rows.map((r) => r.id).join(", "),
    );

    // Bulk-append EXPIRED event to audit logs
    await Promise.allSettled(
      result.rows.map((r) =>
        OrderLog.findOneAndUpdate(
          { orderId: r.id },
          {
            $push: {
              events: {
                event: "ORDER_EXPIRED",
                data: { reason: "poll_timeout" },
                actor: "system",
                ts: new Date(),
              },
            },
          },
        ),
      ),
    );
  }
}
