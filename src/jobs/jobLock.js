/**
 * src/jobs/jobLock.js
 *
 * Postgres advisory locks for distributed job deduplication.
 *
 * Problem: if you deploy two instances of this server (Railway, Fly, etc.),
 * both will have node-cron running. Without a lock, every job fires twice,
 * doubling Reloadly API calls, cache writes, and status polls.
 *
 * Solution: Postgres pg_try_advisory_lock() — a non-blocking lock that uses
 * a numeric key. Only one instance acquires the lock; others return false
 * immediately and skip that job run.
 *
 * Advisory locks are connection-scoped and released automatically when the
 * connection is closed — no stale lock risk even if a process crashes.
 *
 * Lock key convention: we hash the job name to a consistent 32-bit integer.
 * This avoids collisions between jobs and is stable across deploys.
 *
 * Usage:
 *   const release = await acquireJobLock("pollUtilityOrders");
 *   if (!release) return; // another instance is already running this job
 *   try {
 *     await doWork();
 *   } finally {
 *     await release();
 *   }
 */

import { getClient } from "../db/postgres.js";
import { createHash } from "crypto";

/**
 * Convert a job name string to a stable 32-bit integer for pg advisory locks.
 * @param {string} jobName
 * @returns {number}
 */
function jobNameToKey(jobName) {
  const hash = createHash("sha256").update(jobName).digest("hex");
  // Take first 8 hex chars → 32-bit unsigned int, fit into signed int32 range
  return parseInt(hash.slice(0, 8), 16) & 0x7fffffff;
}

/**
 * Try to acquire an advisory lock for a job.
 *
 * @param {string} jobName
 * @returns {Promise<(() => Promise<void>) | null>}
 *   Returns a release function if the lock was acquired,
 *   or null if another instance holds it.
 */
export async function acquireJobLock(jobName) {
  const key = jobNameToKey(jobName);
  const client = await getClient();

  const result = await client.query(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [key],
  );

  if (!result.rows[0].acquired) {
    client.release();
    return null; // another instance holds the lock
  }

  // Return a release function that unlocks AND releases the pooled connection
  return async function release() {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    } finally {
      client.release();
    }
  };
}
