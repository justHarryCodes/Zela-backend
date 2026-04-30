/**
 * src/db/postgres.js
 *
 * Production-ready singleton pg Pool — imported by all modules that need Postgres.
 *
 * Required env vars:
 *   DATABASE_URL        — full postgres connection string
 *                         e.g. postgres://user:pass@host:5432/dbname
 *
 * Optional env vars:
 *   POSTGRES_SSL        — "true" | "false" (overrides auto-detection)
 *   POSTGRES_CA_CERT    — path to CA cert file for full TLS verification
 *   POSTGRES_POOL_MAX   — max pool size (default: 10)
 *   POSTGRES_POOL_MIN   — min pool size (default: 2)
 *   SLOW_QUERY_MS       — warn threshold in ms (default: 500)
 *
 * Exports:
 *   query(text, params)       — parameterised query, with slow-query logging
 *   withTransaction(fn)       — auto commit/rollback transaction wrapper
 *   getClient()               — raw client (use only when you need cursor/COPY)
 *   verifyPostgres()          — smoke-test at startup
 *   isHealthy()               — lightweight liveness check
 *   default                   — pool instance
 */

import pg from "pg";
import fs from "fs";

const { Pool } = pg;

// ─── Config ───────────────────────────────────────────────────────────────────

const POOL_MAX = Number(process.env.POSTGRES_POOL_MAX) || 10;
const POOL_MIN = Number(process.env.POSTGRES_POOL_MIN) || 2;
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 500;

// ─── Structured logger ────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "postgres",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "postgres",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "postgres",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  debug: (msg, meta = {}) =>
    process.env.NODE_ENV !== "production" &&
    console.debug(
      JSON.stringify({
        level: "debug",
        service: "postgres",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── SSL configuration ────────────────────────────────────────────────────────

function getSslConfig() {
  // Explicit override — opt out
  if (process.env.POSTGRES_SSL === "false") return false;

  // Full verification via CA cert (recommended for production)
  if (process.env.POSTGRES_CA_CERT) {
    return {
      rejectUnauthorized: true,
      ca: fs.readFileSync(process.env.POSTGRES_CA_CERT, "utf8"),
    };
  }

  // Explicit override — opt in (managed hosts without custom CA)
  if (process.env.POSTGRES_SSL === "true") return { rejectUnauthorized: false };

  // Auto-detect: local dev → no SSL; production → SSL required
  if (process.env.NODE_ENV === "production") {
    // Log a warning if running without CA cert in production
    log.warn(
      "SSL enabled without CA cert — set POSTGRES_CA_CERT for full TLS verification",
    );
    return { rejectUnauthorized: false };
  }

  const url = process.env.DATABASE_URL ?? "";
  const isLocal =
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("@host.docker.internal");

  return isLocal ? false : { rejectUnauthorized: false };
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(),
  max: POOL_MAX,
  min: POOL_MIN,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Kill runaway queries before they starve the pool
  statement_timeout: 30_000,
  // Abort any query that waits more than 10s for a lock
  lock_timeout: 10_000,
});

// ─── Pool events ──────────────────────────────────────────────────────────────

pool.on("error", (err) => {
  log.error("Unexpected pool error", { error: err.message });
});

pool.on("connect", () => {
  log.debug("New client connected to pool", {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
});

pool.on("remove", () => {
  log.debug("Client removed from pool", {
    total: pool.totalCount,
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shutdownRegistered = false;

function registerShutdownHandlers() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal) => {
    log.info("Received shutdown signal — draining PostgreSQL pool", { signal });
    await pool.end();
    log.info("PostgreSQL pool closed");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

registerShutdownHandlers();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a parameterised query.
 *
 * @param {string} text    SQL with $1, $2 … placeholders
 * @param {any[]}  params  values
 * @returns {Promise<pg.QueryResult>}
 *
 * @example
 *   const { rows } = await query(
 *     "SELECT * FROM users WHERE id = $1",
 *     [userId]
 *   );
 */
export async function query(text, params) {
  const start = Date.now();

  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration >= SLOW_QUERY_MS) {
      // Warn in all environments — slow queries matter in prod too
      log.warn("Slow query detected", {
        duration,
        query: text.slice(0, 120),
      });
    } else {
      log.debug("Query executed", {
        duration,
        query: text.slice(0, 80),
        rows: result.rowCount,
      });
    }

    return result;
  } catch (err) {
    log.error("Query error", {
      error: err.message,
      query: text.slice(0, 120),
    });
    throw err;
  }
}

/**
 * Execute multiple statements inside a single transaction.
 * Automatically commits on success, rolls back on any error.
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn  callback receiving the client
 * @returns {Promise<T>}
 *
 * @example
 *   const order = await withTransaction(async (client) => {
 *     const { rows: [order] } = await client.query(
 *       "INSERT INTO orders (user_id) VALUES ($1) RETURNING *",
 *       [userId]
 *     );
 *     await client.query(
 *       "UPDATE inventory SET stock = stock - 1 WHERE id = $1",
 *       [itemId]
 *     );
 *     return order;
 *   });
 */
export async function withTransaction(fn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    log.error("Transaction rolled back", { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Grab a raw client from the pool.
 * Prefer withTransaction() for transactional work.
 * You MUST call client.release() in a finally block.
 *
 * @returns {Promise<pg.PoolClient>}
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Lightweight liveness check — true if the pool can reach the server.
 * Useful for /healthz endpoints.
 *
 * @returns {Promise<boolean>}
 */
export async function isHealthy() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Smoke-test the connection at startup.
 * Call once during app boot to surface misconfiguration early.
 */
export async function verifyPostgres() {
  try {
    const { rows } = await query("SELECT NOW() AS ts");
    log.info("Connected to PostgreSQL", {
      serverTime: rows[0].ts,
      poolMax: POOL_MAX,
      poolMin: POOL_MIN,
    });
  } catch (err) {
    log.error("Failed to connect to PostgreSQL — check DATABASE_URL", {
      error: err.message,
    });
    throw err;
  }
}

export default pool;
