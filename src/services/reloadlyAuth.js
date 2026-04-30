/**
 * src/services/reloadlyAuth.js
 *
 * OAuth2 client-credentials token manager for Reloadly.
 *
 * Key design decisions:
 *
 * 1. ONE token per service — Reloadly requires a separate audience per
 *    product (airtime / utilities / giftcards), so three independent tokens.
 *
 * 2. In-memory cache with a 5-minute safety buffer — production tokens last
 *    60 days; sandbox tokens last 24 hours. We refresh proactively before
 *    expiry so a mid-flight request never uses a stale token.
 *
 * 3. Singleton per service key — concurrent callers await the same
 *    in-flight fetch promise instead of hammering the auth endpoint.
 *
 * Usage:
 *   import { getAccessToken } from "../services/reloadlyAuth.js";
 *   const token = await getAccessToken("airtime");   // "airtime" | "utilities" | "giftcards"
 */

import { RELOADLY_AUTH_URL, RELOADLY_SERVICES } from "../config/reloadly.js";

const BUFFER_SECONDS = 300; // refresh 5 min before expiry

/** @type {Map<string, { token: string, expiresAt: number, inflightPromise: Promise|null }>} */
const tokenCache = new Map();

/**
 * Fetches a fresh token from Reloadly's auth server for a given service.
 * @param {string} serviceKey - one of "airtime" | "utilities" | "giftcards"
 * @returns {Promise<{ accessToken: string, expiresAt: number }>}
 */
async function fetchNewToken(serviceKey) {
  const { audience } = RELOADLY_SERVICES[serviceKey];

  const res = await fetch(RELOADLY_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.RELOADLY_CLIENT_ID,
      client_secret: process.env.RELOADLY_CLIENT_SECRET,
      grant_type: "client_credentials",
      audience,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(
      new Error(
        `[reloadlyAuth] Token fetch failed for "${serviceKey}": ${body}`,
      ),
      { status: 502 },
    );
  }

  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in - BUFFER_SECONDS) * 1000;

  console.log(
    `[reloadlyAuth] New token for "${serviceKey}" — expires in ` +
      `${Math.round(data.expires_in / 3600)}h`,
  );

  return { accessToken: data.access_token, expiresAt };
}

/**
 * Returns a valid access token for the given service, refreshing if needed.
 * @param {"airtime"|"utilities"|"giftcards"} serviceKey
 * @returns {Promise<string>}
 */
export async function getAccessToken(serviceKey) {
  if (!RELOADLY_SERVICES[serviceKey]) {
    throw new Error(`[reloadlyAuth] Unknown service key: "${serviceKey}"`);
  }

  const cached = tokenCache.get(serviceKey);

  // Token still valid — return it immediately.
  if (cached && cached.expiresAt > Date.now() && !cached.inflightPromise) {
    return cached.token;
  }

  // Token expired (or first call) — kick off a refresh if not already in-flight.
  if (!cached?.inflightPromise) {
    const promise = fetchNewToken(serviceKey)
      .then(({ accessToken, expiresAt }) => {
        tokenCache.set(serviceKey, {
          token: accessToken,
          expiresAt,
          inflightPromise: null,
        });
        return accessToken;
      })
      .catch((err) => {
        // Clear inflight so the next caller retries
        const entry = tokenCache.get(serviceKey);
        if (entry) entry.inflightPromise = null;
        throw err;
      });

    tokenCache.set(serviceKey, {
      token: cached?.token ?? null,
      expiresAt: cached?.expiresAt ?? 0,
      inflightPromise: promise,
    });
  }

  return tokenCache.get(serviceKey).inflightPromise;
}

/**
 * Pre-warm all three service tokens at startup.
 * Call this in src/index.js after env validation.
 */
export async function warmReloadlyTokens() {
  const services = Object.keys(RELOADLY_SERVICES);
  await Promise.allSettled(services.map((s) => getAccessToken(s)));
  console.log("[reloadlyAuth] Token warm-up complete.");
}
