/**
 * src/routes/admin.js
 *
 * Internal admin endpoints. Protected by requireFirebaseAuth AND
 * an admin UID allowlist (ADMIN_UIDS env var).
 *
 * Routes:
 *   GET /v1/admin/jobs              — recent job run history + stats
 *   GET /v1/admin/jobs/:jobName     — last 20 runs for a specific job
 *   GET /v1/admin/orders/stats      — order counts by status + type
 *   GET /v1/admin/geo/blocks        — recent geo block events
 */

import { Router } from "express";
import { query } from "../db/postgres.js";

export const adminRouter = Router();

// ─── Admin auth guard ─────────────────────────────────────────────────────────

const ADMIN_UIDS = new Set(
  (process.env.ADMIN_UIDS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
);

function requireAdmin(req, res, next) {
  if (ADMIN_UIDS.size === 0) {
    // No admins configured — lock it down completely
    return res.status(403).json({
      error: "Admin access not configured. Set ADMIN_UIDS env var.",
    });
  }

  if (!ADMIN_UIDS.has(req.firebaseUid)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

adminRouter.use(requireAdmin);

// ─── Jobs ─────────────────────────────────────────────────────────────────────

adminRouter.get("/jobs", async (_req, res, next) => {
  try {
    // Summary: last run + stats per job for the past 24h
    const { rows } = await query(
      `SELECT
         job_name,
         COUNT(*)                                               AS total_runs,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')          AS completed,
         COUNT(*) FILTER (WHERE status = 'FAILED')             AS failed,
         COUNT(*) FILTER (WHERE status = 'SKIPPED')            AS skipped,
         SUM(items_processed)                                   AS items_processed,
         ROUND(AVG(duration_ms))                               AS avg_duration_ms,
         MAX(started_at)                                        AS last_run_at,
         (SELECT status FROM job_log j2
          WHERE j2.job_name = j.job_name
          ORDER BY started_at DESC LIMIT 1)                     AS last_status
       FROM job_log j
       WHERE started_at > NOW() - INTERVAL '24 hours'
       GROUP BY job_name
       ORDER BY job_name`,
      [],
    );

    res.json({ jobs: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/jobs/:jobName", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, status, items_processed, items_failed,
              duration_ms, error_message, started_at, finished_at
       FROM   job_log
       WHERE  job_name = $1
       ORDER  BY started_at DESC
       LIMIT  20`,
      [req.params.jobName],
    );
    res.json({ jobName: req.params.jobName, runs: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Order stats ──────────────────────────────────────────────────────────────

adminRouter.get("/orders/stats", async (_req, res, next) => {
  try {
    const { rows: byStatus } = await query(
      `SELECT type, status, COUNT(*) AS count
       FROM   orders
       GROUP  BY type, status
       ORDER  BY type, status`,
      [],
    );

    const { rows: recent } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')   AS last_1h,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')   AS last_7d
       FROM orders`,
      [],
    );

    const { rows: revenue } = await query(
      `SELECT
         type,
         SUM(amount_usd) FILTER (WHERE status = 'COMPLETED') AS completed_usd,
         SUM(amount_usd) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'
                                 AND   status = 'COMPLETED') AS last_24h_usd
       FROM orders
       GROUP BY type
       ORDER BY type`,
      [],
    );

    res.json({
      byStatus,
      volume: recent[0],
      revenue,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Geo block log ────────────────────────────────────────────────────────────

adminRouter.get("/geo/blocks", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);

    const { rows } = await query(
      `SELECT id, ip_masked, country_code, service, path, reason, created_at
       FROM   geo_block_log
       ORDER  BY created_at DESC
       LIMIT  $1 OFFSET $2`,
      [limit, offset],
    );

    res.json({ blocks: rows });
  } catch (err) {
    next(err);
  }
});
