/**
 * src/jobs/runner.js
 *
 * Central job scheduler. Import and call startJobs() once at server startup.
 *
 * Schedule overview:
 *   ┌───────────────────────────┬──────────────────┬─────────────────────────┐
 *   │ Job                       │ Interval         │ Purpose                 │
 *   ├───────────────────────────┼──────────────────┼─────────────────────────┤
 *   │ pollUtilityOrders         │ every 2 min      │ finalise bill payments  │
 *   │ retryGiftCardCodes        │ every 5 min      │ recover missing codes   │
 *   │ cleanupStaleOrders        │ every hour       │ expire abandoned orders │
 *   │ refreshCaches             │ daily at 3am UTC │ warm operator/biller DB │
 *   └───────────────────────────┴──────────────────┴─────────────────────────┘
 *
 * All intervals are overridable via environment variables.
 * Advisory locks prevent duplicate runs in multi-instance deployments.
 *
 * Graceful shutdown:
 *   SIGTERM / SIGINT → stopJobs() → let running jobs finish → process.exit(0)
 *   The Express server calls stopJobs() during its own shutdown sequence.
 */

import cron from "node-cron";
import { pollUtilityOrders }  from "./pollUtilityOrders.js";
import { retryGiftCardCodes } from "./retryGiftCardCodes.js";
import { cleanupStaleOrders } from "./cleanupStaleOrders.js";
import { refreshCaches }      from "./refreshCaches.js";

// ─── Schedule config (overridable via env) ────────────────────────────────────

const SCHEDULES = {
  pollUtilityOrders:  process.env.JOB_UTILITY_POLL_CRON  ?? "*/2 * * * *",
  retryGiftCardCodes: process.env.JOB_GIFTCARD_RETRY_CRON ?? "*/5 * * * *",
  cleanupStaleOrders: process.env.JOB_CLEANUP_CRON        ?? "0 * * * *",
  refreshCaches:      process.env.JOB_CACHE_REFRESH_CRON  ?? "0 3 * * *",
};

// ─── Job registry ─────────────────────────────────────────────────────────────

const JOBS = [
  { name: "pollUtilityOrders",  fn: pollUtilityOrders,  cron: SCHEDULES.pollUtilityOrders  },
  { name: "retryGiftCardCodes", fn: retryGiftCardCodes, cron: SCHEDULES.retryGiftCardCodes },
  { name: "cleanupStaleOrders", fn: cleanupStaleOrders, cron: SCHEDULES.cleanupStaleOrders },
  { name: "refreshCaches",      fn: refreshCaches,      cron: SCHEDULES.refreshCaches      },
];

/** @type {cron.ScheduledTask[]} */
const tasks = [];

// ─── Guard against overlapping runs within the same instance ──────────────────
// The advisory lock handles CROSS-instance deduplication.
// This Set handles WITHIN-instance deduplication (if a job run takes longer
// than its interval, the next tick is skipped).
const running = new Set();

function wrapJob(name, fn) {
  return async () => {
    if (running.has(name)) {
      console.log(`[runner] Skipping ${name} — previous run still in progress`);
      return;
    }

    running.add(name);
    try {
      await fn();
    } catch (err) {
      // Individual jobs already log their own errors.
      // This outer catch is a safety net for unexpected throws.
      console.error(`[runner] Unhandled error in job "${name}":`, err.message);
    } finally {
      running.delete(name);
    }
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startJobs() {
  if (tasks.length > 0) {
    console.warn("[runner] Jobs already started — skipping");
    return;
  }

  for (const job of JOBS) {
    if (!cron.validate(job.cron)) {
      console.error(
        `[runner] Invalid cron expression for "${job.name}": "${job.cron}" — job not scheduled`
      );
      continue;
    }

    const task = cron.schedule(job.cron, wrapJob(job.name, job.fn), {
      timezone: "UTC",
    });

    tasks.push(task);
    console.log(`[runner] Scheduled "${job.name}" → ${job.cron}`);
  }

  console.log(`[runner] ${tasks.length}/${JOBS.length} jobs active`);
}

export async function stopJobs() {
  console.log("[runner] Stopping all scheduled jobs…");

  for (const task of tasks) {
    task.stop();
  }

  tasks.length = 0;

  // Wait for any running jobs to finish (up to 30s)
  const deadline = Date.now() + 30_000;
  while (running.size > 0 && Date.now() < deadline) {
    console.log(`[runner] Waiting for ${running.size} job(s) to finish: ${[...running].join(", ")}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }

  if (running.size > 0) {
    console.warn(`[runner] Timed out waiting for: ${[...running].join(", ")}`);
  } else {
    console.log("[runner] All jobs stopped cleanly");
  }
}