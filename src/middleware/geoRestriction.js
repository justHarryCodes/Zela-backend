/**
 * src/middleware/geoRestriction.js
 *
 * Express middleware factory for geographic access control.
 *
 * Usage:
 *   import { geoRestrict } from "../middleware/geoRestriction.js";
 *
 *   // Global — applies to every route
 *   app.use(geoRestrict());
 *
 *   // Per-service — stricter rules for a specific router
 *   app.use("/v1/giftcards", geoRestrict({ service: "giftcards" }), giftcardsRouter);
 *
 * How IP resolution works with Express + Railway/Fly/Render:
 *   app.set("trust proxy", 1) (already set in index.js) makes Express
 *   set req.ip to the leftmost untrusted IP from X-Forwarded-For.
 *   This is correct for platforms that add exactly one proxy hop.
 *
 * Side effects on req:
 *   req.geoCountry  — ISO-2 country code or null
 *   req.geoIp       — the IP that was looked up
 *
 * Bypass:
 *   GEO_BYPASS=true skips the entire check. Only respected outside production.
 *   An error is thrown at startup if bypass is active in production.
 */

import geoip from "geoip-lite";
import { logGeoBlock } from "../services/geoBlockLogger.js"; // static — no per-request dynamic import overhead
import {
  isCountryBlocked,
  GEO_BYPASS,
  HARD_BLOCKED_COUNTRIES,
  GEO_MODE,
  SOFT_BLOCKED_COUNTRIES,
  ALLOWED_COUNTRIES,
  SERVICE_COUNTRY_RULES,
} from "../config/geo.js";

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "geo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "geo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "geo",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Log config summary at module load ────────────────────────────────────────

if (GEO_BYPASS) {
  if (process.env.NODE_ENV === "production") {
    log.error("GEO_BYPASS=true is NOT allowed in production — exiting");
    process.exit(1);
  }
  log.warn("GEO_BYPASS=true — all geo checks disabled (development only)");
} else {
  log.info("Geo restriction active", {
    mode: GEO_MODE,
    hardBlocked: [...HARD_BLOCKED_COUNTRIES],
    softBlocked: GEO_MODE === "denylist" ? [...SOFT_BLOCKED_COUNTRIES] : [],
    allowed: GEO_MODE === "allowlist" ? [...ALLOWED_COUNTRIES] : [],
    serviceRules: Object.entries(SERVICE_COUNTRY_RULES)
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
  });
}

// ─── IP helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the real client IP. Strips IPv4-mapped IPv6 prefix (::ffff:1.2.3.4).
 * With app.set("trust proxy", 1), req.ip is already the correct client IP.
 *
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function extractIp(req) {
  return (req.ip ?? "").replace(/^::ffff:/, "") || null;
}

/**
 * Mask an IP for logging — enough to identify abuse patterns without storing
 * a full address. e.g. "192.168.1.99" → "192.168.x.x"
 *
 * @param {string|null} ip
 * @returns {string}
 */
function maskIp(ip) {
  if (!ip) return "unknown";
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  return `${ip.slice(0, 16)}…`; // IPv6 — show first 16 chars
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Export name and signature unchanged — server.js needs no updates.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.service]  "airtime" | "data" | "utilities" | "giftcards"
 * @param {boolean} [opts.strict]   Treat unresolvable IP as blocked (high-risk routes)
 * @returns {import("express").RequestHandler}
 */
export function geoRestrict({ service, strict = false } = {}) {
  return function geoRestrictionMiddleware(req, res, next) {
    // ── Dev bypass ────────────────────────────────────────────────────────
    if (GEO_BYPASS) {
      req.geoCountry = "BYPASS";
      req.geoIp = req.ip;
      return next();
    }

    // ── IP lookup ─────────────────────────────────────────────────────────
    const ip = extractIp(req);
    const geo = ip ? geoip.lookup(ip) : null;
    const countryCode = geo?.country ?? null;

    req.geoCountry = countryCode;
    req.geoIp = ip;

    // ── Strict mode — block if country cannot be determined ───────────────
    if (strict && !countryCode) {
      return res.status(403).json({
        error: "Unable to determine your location. Please try again.",
      });
    }

    // ── Block check ───────────────────────────────────────────────────────
    const { blocked, reason } = isCountryBlocked(countryCode, service);

    if (blocked) {
      const masked = maskIp(ip);

      log.warn("Request blocked", {
        countryCode: countryCode ?? "unknown",
        ipMasked: masked,
        service: service ?? "global",
        uid: req.firebaseUid ?? "unauthenticated",
        path: req.path,
      });

      // Fire-and-forget DB audit log — imported statically so there is no
      // per-request dynamic import() overhead or silent import failure risk.
      logGeoBlock({
        firebaseUid: req.firebaseUid ?? null,
        ipMasked: masked,
        countryCode,
        service: service ?? null,
        path: req.path,
        reason,
      }).catch(() => {}); // never throw from a log call

      return res.status(451).json({
        error: reason ?? "Service not available in your region",
        code: "GEO_BLOCKED",
      });
    }

    next();
  };
}
