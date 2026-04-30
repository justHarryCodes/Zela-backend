/**
 * src/db/mongo.js
 *
 * Production-ready Mongoose connection helper.
 *
 * Required env vars:
 *   MONGODB_URI      — full MongoDB connection string
 *                      e.g. mongodb+srv://user:pass@cluster.mongodb.net/zela
 *
 * Optional env vars:
 *   MONGODB_DB_NAME  — database name (default: "zela")
 *   MONGODB_POOL_MAX — max connection pool size (default: 10)
 *   MONGODB_POOL_MIN — min connection pool size (default: 2)
 *
 * Exports:
 *   connectMongo()   — idempotent connect with retry
 *   disconnectMongo() — graceful disconnect
 *   isHealthy()      — true if connection is live
 *   default          — mongoose instance
 */

import mongoose from "mongoose";

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2_000;

const POOL_MAX = Number(process.env.MONGODB_POOL_MAX) || 10;
const POOL_MIN = Number(process.env.MONGODB_POOL_MIN) || 2;

const CONNECT_OPTIONS = {
  dbName: process.env.MONGODB_DB_NAME ?? "zela",
  maxPoolSize: POOL_MAX, // max concurrent connections
  minPoolSize: POOL_MIN, // keep-alive connections in pool
  connectTimeoutMS: 10_000, // time to establish a connection
  socketTimeoutMS: 45_000, // time to wait for a socket response
  serverSelectionTimeoutMS: 10_000, // time to find a suitable server
  heartbeatFrequencyMS: 10_000, // how often to ping the server
  maxIdleTimeMS: 30_000, // close idle connections after 30s
  retryWrites: true,
  retryReads: true,
};

// ─── Structured logger ───────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "mongo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "mongo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "mongo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── State ───────────────────────────────────────────────────────────────────

let connecting = false; // guard against concurrent connect() calls

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when Mongoose reports a live connection.
 * readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
 */
export function isHealthy() {
  return mongoose.connection.readyState === 1;
}

/** Exponential backoff delay */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Connect ─────────────────────────────────────────────────────────────────

/**
 * Idempotent connect with exponential-backoff retry.
 * Safe to call from multiple entry points — concurrent calls resolve together.
 */
export async function connectMongo() {
  // Already connected — fast path
  if (isHealthy()) return;

  // Prevent parallel connection storms
  if (connecting) {
    await waitForConnection();
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("[mongo] MONGODB_URI is not set");

  connecting = true;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri, CONNECT_OPTIONS);

      log.info("Connected to MongoDB", {
        db: CONNECT_OPTIONS.dbName,
        poolMax: POOL_MAX,
        poolMin: POOL_MIN,
      });

      _registerEventHandlers();
      _registerShutdownHandlers();

      connecting = false;
      return;
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1); // 2s → 4s → 8s

      log.error("Connection attempt failed", {
        attempt,
        maxRetries: MAX_RETRIES,
        error: err.message,
        ...(isLastAttempt ? {} : { retryInMs: delay }),
      });

      if (isLastAttempt) {
        connecting = false;
        throw err;
      }

      await sleep(delay);
    }
  }
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/** Gracefully close all connections. Call before process exit. */
export async function disconnectMongo() {
  if (!isHealthy()) return;
  await mongoose.connection.close();
  log.info("Disconnected from MongoDB");
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Poll until Mongoose is connected (used when a parallel connect is in flight). */
function waitForConnection(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (isHealthy()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        reject(new Error("[mongo] Timed out waiting for connection"));
      }
    }, 200);
  });
}

let handlersRegistered = false;

function _registerEventHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  mongoose.connection.on("error", (err) => {
    log.error("Connection error", { error: err.message });
  });

  mongoose.connection.on("disconnected", () => {
    log.warn("Disconnected — Mongoose will attempt automatic reconnect");
  });

  mongoose.connection.on("reconnected", () => {
    log.info("Reconnected to MongoDB");
  });
}

let shutdownRegistered = false;

function _registerShutdownHandlers() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal) => {
    log.info("Received shutdown signal — closing MongoDB connection", {
      signal,
    });
    await disconnectMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export default mongoose;
