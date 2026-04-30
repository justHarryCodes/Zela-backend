/**
 * src/middleware/firebaseAuth.js
 *
 * Express middleware that verifies a Firebase ID token passed in the
 * Authorization header as a Bearer token.
 *
 * On success:  attaches req.firebaseUid (string) and continues.
 * On failure:  returns 401 immediately — the route handler never runs.
 *
 * Initialisation uses the firebase-admin SDK with Application Default
 * Credentials (ADC), which works automatically on:
 *   - Google Cloud Run / GKE  (service account attached to the resource)
 *   - Railway / Fly            (set GOOGLE_APPLICATION_CREDENTIALS to a
 *                               service account JSON file path, or pass
 *                               FIREBASE_PROJECT_ID + a service account key
 *                               as individual env vars)
 *
 * For local dev, run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "firebaseAuth",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "firebaseAuth",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "firebaseAuth",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Initialise once ──────────────────────────────────────────────────────────

function initAdmin() {
  if (getApps().length > 0) return; // already initialised

  // If a full service account JSON is provided as an env var (common on
  // platforms like Railway that don't support file mounts):
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      // A malformed JSON value here means the app cannot authenticate at all —
      // fail fast at boot with a clear message rather than a cryptic runtime error.
      throw new Error(
        "[firebaseAuth] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. " +
          "Check the env var for unescaped quotes or truncation.",
      );
    }
    initializeApp({ credential: cert(serviceAccount) });
    log.info("Firebase Admin initialised with service account JSON");
    return;
  }

  // Fall back to ADC (Cloud Run, GKE, local with GOOGLE_APPLICATION_CREDENTIALS)
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  log.info("Firebase Admin initialised with Application Default Credentials", {
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

initAdmin();

const adminAuth = getAuth();

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Export name and signature unchanged — server.js and all routes work as-is.
 *
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 */
export async function requireFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header." });
  }

  const idToken = authHeader.slice(7); // strip "Bearer "

  try {
    const decoded = await adminAuth.verifyIdToken(idToken, true); // checkRevoked=true
    req.firebaseUid = decoded.uid;
    next();
  } catch (err) {
    // Log the Firebase error code (e.g. auth/id-token-expired) for debugging.
    // The error code is safe to log — it does not contain token material.
    // Never send the code to the caller; it reveals which check failed.
    log.warn("Token verification failed", {
      code: err.code ?? "unknown",
      method: req.method,
      path: req.path,
    });
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
