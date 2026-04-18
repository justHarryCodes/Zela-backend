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

// ─── Initialise once ──────────────────────────────────────────────────────────

function initAdmin() {
  if (getApps().length > 0) return; // already initialised

  // If a full service account JSON is provided as an env var (common on
  // platforms like Railway that don't support file mounts):
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    );
    initializeApp({ credential: cert(serviceAccount) });
    return;
  }

  // Otherwise fall back to ADC (Cloud Run, GKE, local with GOOGLE_APPLICATION_CREDENTIALS)
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

initAdmin();

const adminAuth = getAuth();

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
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
    // Firebase errors have a code property; log it for debugging without
    // leaking details to the caller.
    console.warn(
      "[firebaseAuth] Token verification failed:",
      err.code ?? err.message,
    );
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
