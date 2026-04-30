/**
 * src/services/geoBlockLogger.js
 *
 * Asynchronously persists geo block events to Postgres for audit / abuse dashboards.
 * Fire-and-forget — a logging failure never blocks the response.
 */

import { query } from "../db/postgres.js";

/**
 * @param {object} params
 * @param {string|null} params.firebaseUid
 * @param {string|null} params.ipMasked
 * @param {string|null} params.countryCode
 * @param {string|null} params.service
 * @param {string}      params.path
 * @param {string|null} params.reason
 */
export function logGeoBlock({
  firebaseUid,
  ipMasked,
  countryCode,
  service,
  path,
  reason,
}) {
  query(
    `INSERT INTO geo_block_log
       (firebase_uid, ip_masked, country_code, service, path, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      firebaseUid ?? null,
      ipMasked ?? null,
      countryCode ?? null,
      service ?? null,
      path,
      reason ?? null,
    ],
  ).catch((err) =>
    console.error("[geoBlockLogger] Failed to write block log:", err.message),
  );
}
