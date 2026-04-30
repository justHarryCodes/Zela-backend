/**
 * src/jobs/jobLogger.js
 *
 * Thin helper that writes job execution records to the job_log table.
 * Every job uses this to record start / completion / failure for monitoring.
 */

import { query } from "../db/postgres.js";

/**
 * Record a job run start and return functions to mark it complete or failed.
 *
 * @param {string} jobName
 * @returns {Promise<{
 *   complete: (itemsProcessed: number, itemsFailed: number) => Promise<void>,
 *   fail:     (error: Error) => Promise<void>,
 *   skip:     () => Promise<void>,
 * }>}
 */
export async function startJobLog(jobName) {
  const startedAt = Date.now();

  const { rows } = await query(
    `INSERT INTO job_log (job_name, status, started_at)
     VALUES ($1, 'STARTED', NOW())
     RETURNING id`,
    [jobName],
  );

  const logId = rows[0].id;

  const finish = async (
    status,
    itemsProcessed = 0,
    itemsFailed = 0,
    errorMessage = null,
  ) => {
    const durationMs = Date.now() - startedAt;
    await query(
      `UPDATE job_log
       SET status = $2, items_processed = $3, items_failed = $4,
           error_message = $5, duration_ms = $6, finished_at = NOW()
       WHERE id = $1`,
      [logId, status, itemsProcessed, itemsFailed, errorMessage, durationMs],
    ).catch((err) =>
      console.error(
        `[jobLogger] Failed to update job log ${logId}:`,
        err.message,
      ),
    );
  };

  return {
    complete: (itemsProcessed, itemsFailed = 0) =>
      finish("COMPLETED", itemsProcessed, itemsFailed),
    fail: (err) => finish("FAILED", 0, 0, err.message ?? String(err)),
    skip: () => finish("SKIPPED"),
  };
}
