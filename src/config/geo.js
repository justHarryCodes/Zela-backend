/**
 * src/config/geo.js
 *
 * Single source of truth for all geographic restriction rules.
 *
 * TWO LAYERS of restriction:
 *
 *   1. HARD BLOCK — OFAC sanctioned + high-fraud countries.
 *      These are ALWAYS blocked regardless of env config.
 *      Overriding them would expose you to legal liability.
 *
 *   2. SOFT BLOCK — Configurable via environment variables.
 *      Use GEO_MODE + GEO_BLOCKED_COUNTRIES or GEO_ALLOWED_COUNTRIES.
 *
 * Per-service overrides:
 *   Some services (gift cards, utilities) are only available in a subset
 *   of countries. SERVICE_COUNTRY_RULES lets you restrict individual routes
 *   beyond the global rules.
 *
 * Environment variables:
 *   GEO_MODE              — "denylist" (default) | "allowlist"
 *   GEO_BLOCKED_COUNTRIES — comma-separated ISO-2 codes to block (denylist mode)
 *   GEO_ALLOWED_COUNTRIES — comma-separated ISO-2 codes to allow (allowlist mode)
 *   GEO_BLOCK_UNKNOWN_IP  — "true" | "false" (default: "true")
 *                           Whether to block requests from IPs that can't be geolocated
 *   GEO_BYPASS            — "true" skips ALL geo checks (DEV ONLY, never production)
 */

// ─── Hard-blocked countries (OFAC + FATF high-risk) ───────────────────────────
// Sources: US Treasury OFAC SDN list, FATF high-risk jurisdictions
// These CANNOT be overridden by environment config.

export const HARD_BLOCKED_COUNTRIES = new Set([
  "CU", // Cuba         — OFAC comprehensive sanctions
  "IR", // Iran         — OFAC comprehensive sanctions
  "KP", // North Korea  — OFAC comprehensive sanctions
  "SY", // Syria        — OFAC comprehensive sanctions
  "RU", // Russia       — OFAC/SDN (post-2022 broad restrictions)
  "BY", // Belarus      — OFAC/SDN (post-2022)
  "SD", // Sudan        — OFAC
  "SS", // South Sudan  — FATF high-risk
  "MM", // Myanmar      — FATF high-risk
  "YE", // Yemen        — high conflict risk
]);

// ─── Soft-blocked countries (env-configurable) ────────────────────────────────

function parseCountryList(envKey) {
  const raw = process.env[envKey] ?? "";
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length === 2);
}

export const GEO_MODE = (process.env.GEO_MODE ?? "denylist").toLowerCase();

// Validated on startup — must be "denylist" or "allowlist"
if (!["denylist", "allowlist"].includes(GEO_MODE)) {
  console.error(
    `[geo] GEO_MODE must be "denylist" or "allowlist", got: "${GEO_MODE}"`,
  );
  process.exit(1);
}

export const SOFT_BLOCKED_COUNTRIES = new Set(
  parseCountryList("GEO_BLOCKED_COUNTRIES"),
);
export const ALLOWED_COUNTRIES = new Set(
  parseCountryList("GEO_ALLOWED_COUNTRIES"),
);
export const BLOCK_UNKNOWN_IP =
  (process.env.GEO_BLOCK_UNKNOWN_IP ?? "true") === "true";
export const GEO_BYPASS = process.env.GEO_BYPASS === "true";

// ─── Per-service country restrictions ─────────────────────────────────────────
// Each service key maps to either:
//   { mode: "allowlist", countries: Set }  — only these countries allowed
//   { mode: "denylist",  countries: Set }  — these countries blocked (on top of global rules)
//   null                                   — no extra service-level restriction
//
// Populated from env vars at startup (see parseServiceRules below).
// Can also be hardcoded below for services with known coverage limits.

function parseServiceRules(envPrefix) {
  const mode = process.env[`${envPrefix}_MODE`];
  const rawList = process.env[`${envPrefix}_COUNTRIES`];

  if (!mode || !rawList) return null;

  const countries = new Set(
    rawList
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length === 2),
  );

  return { mode: mode.toLowerCase(), countries };
}

export const SERVICE_COUNTRY_RULES = {
  // GEO_AIRTIME_MODE + GEO_AIRTIME_COUNTRIES (optional)
  airtime: parseServiceRules("GEO_AIRTIME"),

  // GEO_DATA_MODE + GEO_DATA_COUNTRIES (optional)
  data: parseServiceRules("GEO_DATA"),

  // GEO_UTILITIES_MODE + GEO_UTILITIES_COUNTRIES (optional)
  utilities: parseServiceRules("GEO_UTILITIES"),

  // GEO_GIFTCARDS_MODE + GEO_GIFTCARDS_COUNTRIES (optional)
  giftcards: parseServiceRules("GEO_GIFTCARDS"),
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine if a country code should be blocked given all active rules.
 *
 * @param {string|null} countryCode   — ISO-2 or null (unknown)
 * @param {string}      [serviceKey]  — "airtime" | "data" | "utilities" | "giftcards"
 * @returns {{ blocked: boolean, reason: string }}
 */
export function isCountryBlocked(countryCode, serviceKey) {
  // ── Unknown IP ────────────────────────────────────────────────────────────
  if (!countryCode) {
    if (BLOCK_UNKNOWN_IP)
      return { blocked: true, reason: "Unable to determine location" };
    return { blocked: false, reason: null };
  }

  const cc = countryCode.toUpperCase();

  // ── Hard block (OFAC / FATF) ───────────────────────────────────────────────
  if (HARD_BLOCKED_COUNTRIES.has(cc)) {
    return { blocked: true, reason: "Service not available in your region" };
  }

  // ── Global soft rules ──────────────────────────────────────────────────────
  if (GEO_MODE === "allowlist") {
    if (ALLOWED_COUNTRIES.size > 0 && !ALLOWED_COUNTRIES.has(cc)) {
      return { blocked: true, reason: "Service not available in your region" };
    }
  } else {
    // denylist mode
    if (SOFT_BLOCKED_COUNTRIES.has(cc)) {
      return { blocked: true, reason: "Service not available in your region" };
    }
  }

  // ── Per-service rules ──────────────────────────────────────────────────────
  if (serviceKey) {
    const rule = SERVICE_COUNTRY_RULES[serviceKey];
    if (rule) {
      if (rule.mode === "allowlist" && !rule.countries.has(cc)) {
        return {
          blocked: true,
          reason: `${serviceKey} is not available in your region`,
        };
      }
      if (rule.mode === "denylist" && rule.countries.has(cc)) {
        return {
          blocked: true,
          reason: `${serviceKey} is not available in your region`,
        };
      }
    }
  }

  return { blocked: false, reason: null };
}
