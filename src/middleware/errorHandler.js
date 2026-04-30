/**
 * src/middleware/errorHandler.js
 *
 * Central Express error handler. Must be registered last (after all routes).
 * Catches anything passed to next(err) or thrown inside async route handlers
 * when wrapped with a try/catch that calls next(err).
 *
 * Never leaks stack traces or internal messages to the caller in production.
 */

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "errorHandler",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Export name and signature unchanged — server.js needs no updates.
 *
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} _next  required 4-arg signature
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status ?? err.statusCode ?? 500;

  // In production, never reveal internal error details for 5xx responses.
  const message =
    process.env.NODE_ENV === "production" && status === 500
      ? "Internal server error."
      : (err.message ?? "Internal server error.");

  if (status >= 500) {
    // Include request context so 500s are traceable to a specific user and
    // endpoint without having to correlate across separate log streams.
    log.error("Unhandled server error", {
      uid: req.firebaseUid ?? "unauthenticated",
      method: req.method,
      path: req.path,
      status,
      error: err.message,
      stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    });
  }

  res.status(status).json({ error: message });
}
