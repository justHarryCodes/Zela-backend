/**
 * src/middleware/validate.js
 *
 * Thin Zod validation middleware factory.
 * No extra dependencies — just zod itself.
 *
 * Usage:
 *   import { validate } from "../middleware/validate.js";
 *   import { z } from "zod";
 *
 *   router.post("/topup",
 *     validate({
 *       body:  z.object({ phone: z.string(), ... }),
 *       query: z.object({ countryCode: z.string().length(2) }),
 *     }),
 *     handler
 *   );
 *
 * On failure → 400 with { error: "Validation failed", issues: [...] }
 * On success → req.body / req.query / req.params are the PARSED (coerced) values.
 *
 * Using .strip() on z.object() (the default) means unknown keys are silently
 * dropped — prevents parameter pollution. Use .passthrough() if you need them.
 */

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  debug: (msg, meta = {}) =>
    process.env.NODE_ENV !== "production" &&
    console.debug(
      JSON.stringify({
        level: "debug",
        service: "validate",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Middleware factory ────────────────────────────────────────────────────────

/**
 * Export name and signature unchanged — all existing route files work as-is.
 *
 * @param {{
 *   body?:   import("zod").ZodTypeAny,
 *   query?:  import("zod").ZodTypeAny,
 *   params?: import("zod").ZodTypeAny,
 * }} schemas
 * @returns {import("express").RequestHandler}
 */
export function validate({ body, query, params } = {}) {
  return function zodValidationMiddleware(req, res, next) {
    const allIssues = [];

    if (body) {
      const result = body.safeParse(req.body);
      if (!result.success) {
        allIssues.push(
          ...result.error.issues.map((i) => ({ ...i, _location: "body" })),
        );
      } else {
        req.body = result.data; // replace with parsed (coerced + stripped) values
      }
    }

    if (query) {
      const result = query.safeParse(req.query);
      if (!result.success) {
        allIssues.push(
          ...result.error.issues.map((i) => ({ ...i, _location: "query" })),
        );
      } else {
        req.query = result.data;
      }
    }

    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) {
        allIssues.push(
          ...result.error.issues.map((i) => ({ ...i, _location: "params" })),
        );
      } else {
        req.params = result.data;
      }
    }

    if (allIssues.length > 0) {
      const formatted = allIssues.map((issue) => ({
        location: issue._location,
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }));

      // Debug log in development — helps trace schema mismatches without
      // having to inspect every 400 response manually.
      log.debug("Validation failed", {
        method: req.method,
        path: req.path,
        issues: formatted,
      });

      return res.status(400).json({
        error: "Validation failed",
        issues: formatted,
      });
    }

    next();
  };
}
