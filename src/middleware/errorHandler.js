/**
 * src/middleware/errorHandler.js
 *
 * Central Express error handler. Must be registered last (after all routes).
 * Catches anything passed to next(err) or thrown inside async route handlers
 * when wrapped with a try/catch that calls next(err).
 *
 * Never leaks stack traces or internal messages to the caller in production.
 */

/**
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} _next  - required 4-arg signature
 */
export function errorHandler(err, req, res, _next) {
  // Operational errors we threw ourselves carry a status code.
  const status = err.status ?? err.statusCode ?? 500;

  // In production, never reveal internal error details.
  const message =
    process.env.NODE_ENV === "production" && status === 500
      ? "Internal server error."
      : (err.message ?? "Internal server error.");

  if (status >= 500) {
    // Log full error server-side for 5xx only.
    console.error("[errorHandler]", err);
  }

  res.status(status).json({ error: message });
}
