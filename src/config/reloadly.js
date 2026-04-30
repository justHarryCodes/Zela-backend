/**
 * src/config/reloadly.js
 *
 * Single source of truth for all Reloadly service URLs and audiences.
 *
 * Reloadly has SEPARATE OAuth tokens per service — you cannot reuse
 * an airtime token to call the utilities API. Each service also has
 * distinct sandbox vs live base URLs.
 *
 * Required env vars:
 *   RELOADLY_CLIENT_ID       — from Reloadly dashboard → Developers → API Settings
 *   RELOADLY_CLIENT_SECRET   — same place
 *   NODE_ENV                 — "production" uses live endpoints, anything else → sandbox
 */

const IS_PROD = process.env.NODE_ENV === "production";

export const RELOADLY_AUTH_URL = "https://auth.reloadly.com/oauth/token";

/**
 * Each entry maps a service key to:
 *   baseUrl  — the REST API root for that service
 *   audience — the OAuth2 audience string Reloadly requires for that service's token
 */
export const RELOADLY_SERVICES = {
  airtime: {
    baseUrl: IS_PROD
      ? "https://topups.reloadly.com"
      : "https://topups-sandbox.reloadly.com",
    audience: IS_PROD
      ? "https://topups.reloadly.com"
      : "https://topups-sandbox.reloadly.com",
  },
  utilities: {
    baseUrl: IS_PROD
      ? "https://utilities.reloadly.com"
      : "https://utilities-sandbox.reloadly.com",
    audience: IS_PROD
      ? "https://utilities.reloadly.com"
      : "https://utilities-sandbox.reloadly.com",
  },
  giftcards: {
    baseUrl: IS_PROD
      ? "https://giftcards.reloadly.com"
      : "https://giftcards-sandbox.reloadly.com",
    audience: IS_PROD
      ? "https://giftcards.reloadly.com"
      : "https://giftcards-sandbox.reloadly.com",
  },
};

// Accept headers Reloadly requires per service
export const RELOADLY_ACCEPT_HEADERS = {
  airtime: "application/com.reloadly.topups-v1+json",
  utilities: "application/com.reloadly.utilities-v1+json",
  giftcards: "application/com.reloadly.giftcards-v1+json",
};
