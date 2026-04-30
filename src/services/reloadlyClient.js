/**
 * src/services/reloadlyClient.js
 *
 * Thin, typed wrapper around fetch() for all Reloadly REST calls.
 *
 * Handles:
 *   - Automatic token injection via reloadlyAuth
 *   - Correct Content-Type / Accept headers per service
 *   - Uniform error normalisation — Reloadly error bodies become JS errors
 *     with a `.status` property so the errorHandler middleware picks them up
 *
 * Usage:
 *   import { reloadlyGet, reloadlyPost } from "../services/reloadlyClient.js";
 *
 *   const operators = await reloadlyGet("airtime", "/operators?countryCode=NG");
 *   const txn = await reloadlyPost("airtime", "/topups", { operatorId, amount, ... });
 */

import { getAccessToken } from "./reloadlyAuth.js";
import {
  RELOADLY_SERVICES,
  RELOADLY_ACCEPT_HEADERS,
} from "../config/reloadly.js";

/**
 * Build headers for a Reloadly request.
 * @param {string} serviceKey
 * @param {string} token
 * @returns {Record<string, string>}
 */
function buildHeaders(serviceKey, token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: RELOADLY_ACCEPT_HEADERS[serviceKey],
  };
}

/**
 * Parse and normalise a non-OK Reloadly response into a thrown error.
 * Reloadly returns { errorCode, message } on failures.
 */
async function throwOnError(res, serviceKey, path) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = { message: await res.text() };
  }

  const message =
    body?.message ?? body?.error ?? `Reloadly ${serviceKey} error`;

  const err = new Error(`[reloadly:${serviceKey}] ${path} → ${message}`);
  err.status = res.status >= 500 ? 502 : res.status; // don't expose 5xx as our own
  err.reloadlyCode = body?.errorCode ?? null;
  err.upstreamStatus = res.status;
  throw err;
}

/**
 * GET a Reloadly endpoint.
 * @param {"airtime"|"utilities"|"giftcards"} serviceKey
 * @param {string} path  - e.g. "/operators?countryCode=NG"
 * @returns {Promise<any>}
 */
export async function reloadlyGet(serviceKey, path) {
  const token = await getAccessToken(serviceKey);
  const url = `${RELOADLY_SERVICES[serviceKey].baseUrl}${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(serviceKey, token),
  });

  if (!res.ok) await throwOnError(res, serviceKey, path);
  return res.json();
}

/**
 * POST to a Reloadly endpoint.
 * @param {"airtime"|"utilities"|"giftcards"} serviceKey
 * @param {string} path  - e.g. "/topups"
 * @param {object} body  - will be JSON-serialised
 * @returns {Promise<any>}
 */
export async function reloadlyPost(serviceKey, path, body) {
  const token = await getAccessToken(serviceKey);
  const url = `${RELOADLY_SERVICES[serviceKey].baseUrl}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(serviceKey, token),
    body: JSON.stringify(body),
  });

  if (!res.ok) await throwOnError(res, serviceKey, path);
  return res.json();
}
