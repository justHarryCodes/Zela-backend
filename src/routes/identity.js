/**
 * src/routes/identity.js
 *
 * GET  /v1/identity/me       — authenticated user's own identity hash
 * POST /v1/identity/resolve  — resolve phone → identity record + relay address
 * POST /v1/identity/register — register wallet + identity, auto-claim pending UTXOs
 *
 * All routes require Firebase auth (requireFirebaseAuth middleware, applied upstream).
 *
 * ─── Security invariants ──────────────────────────────────────────────────────
 *
 *   • Phone numbers are NEVER returned in any response body.
 *   • Identity hashes ARE returned (they are the stable payment identifier).
 *   • All phone-to-hash derivation happens server-side using IDENTITY_HMAC_SECRET.
 *   • walletAddress in /resolve always returns the relay wallet so private
 *     payments always flow through server-managed Umbra routing.
 *
 * ─── Auto-claim on registration ───────────────────────────────────────────────
 *
 *   POST /register triggers an async UTXO claim sweep immediately after the
 *   identity record is persisted. This is the critical step that moves funds
 *   from the stealth claim address to the user's real wallet when they sign up.
 *
 *   Flow:
 *     1. User calls POST /register with their walletAddress
 *     2. Identity record upserted to DB
 *     3. HTTP 201 returned immediately (user doesn't wait)
 *     4. [async] claimUTXOsForIdentity() scans Umbra for UTXOs at the stealth
 *        address, claims them, and withdraws to walletAddress
 *     5. [async] markUmbraRegistered() called on success
 *
 *   The user can also manually trigger a re-sweep via POST /v1/pay/claim
 *   if they believe payments are missing (e.g. network failure during step 4).
 *
 * ─── Self-send protection ─────────────────────────────────────────────────────
 *
 *   /resolve checks both:
 *     1. Phone number equality (fast path, no DB)
 *     2. UID equality (catches multiple-number edge cases, requires DB)
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getAuth as adminAuth } from "firebase-admin/auth";

import { deriveIdentityHash } from "../services/identityService.js";

import {
  upsertIdentityRecord,
  getIdentityByUID,
  getIdentityByHash,
  markUmbraRegistered,
  getPendingPaymentsForIdentity,
} from "../db/privatePayment.js";

// claimUTXOsForIdentity — scans Umbra for UTXOs at the stealth claim address,
// claims them into the claim keypair's encrypted balance, then withdraws to
// the user's registered wallet. Called async after registration.
import { claimUTXOsForIdentity } from "../services/umbraService.js";

import { relayPublicKey } from "../relayWallet.js";

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const meLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

const resolveLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many resolve requests. Slow down." },
});

const registerLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts." },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Basic Solana Base58 format check (32–44 chars, Base58 alphabet) */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** E.164 phone number format */
const E164_RE = /^\+[1-9]\d{6,14}$/;

// ─── Async UTXO claim sweep ───────────────────────────────────────────────────

/**
 * Sweeps all pending Umbra UTXOs for a newly registered user and withdraws
 * them to their registered wallet. Runs async after POST /register returns.
 *
 * Groups by token to minimise Umbra client round trips.
 * Marks umbra_registered = true on first successful sweep (even if only partial).
 *
 * @param {object} opts
 * @param {string}  opts.identityHash
 * @param {string}  opts.walletAddress   Solana Base58 — final destination
 * @param {string}  opts.uid             Firebase UID — for DB updates
 */
async function sweepPendingUtxosAsync({ identityHash, walletAddress, uid }) {
  try {
    const pending = await getPendingPaymentsForIdentity(identityHash);

    if (pending.length === 0) {
      console.log(
        `[identity/register] No pending UTXOs for ${identityHash.slice(0, 8)}…`,
      );
      return;
    }

    console.log(
      `[identity/register] Sweeping ${pending.length} pending payment(s) ` +
        `for ${identityHash.slice(0, 8)}… → ${walletAddress.slice(0, 8)}…`,
    );

    // Group by token to minimise Umbra SDK client creation
    const tokenSymbols = [...new Set(pending.map((p) => p.token_symbol))];

    let anySuccess = false;

    for (const tokenSymbol of tokenSymbols) {
      try {
        const results = await claimUTXOsForIdentity({
          identityHash,
          registeredWalletAddress: walletAddress,
          tokenSymbol,
        });

        if (results.length > 0) {
          anySuccess = true;
          console.log(
            `[identity/register] Swept ${results.length} ${tokenSymbol} UTXO(s) ` +
              `for ${identityHash.slice(0, 8)}…`,
          );
        }
      } catch (err) {
        // Log per-token failure but continue with other tokens
        console.error(
          `[identity/register] ${tokenSymbol} sweep failed for ` +
            `${identityHash.slice(0, 8)}…: ${err.message}`,
        );
      }
    }

    // Mark umbra_registered once any token sweep succeeds
    // (indicates the user's Umbra state is active and UTXOs can be found)
    if (anySuccess) {
      await markUmbraRegistered(uid).catch((err) =>
        console.warn(
          `[identity/register] markUmbraRegistered failed: ${err.message}`,
        ),
      );
    }
  } catch (err) {
    // Never let a sweep failure propagate — the HTTP response already returned
    console.error(
      `[identity/register] sweepPendingUtxosAsync failed for ` +
        `${identityHash.slice(0, 8)}…: ${err.message}`,
    );
  }
}

// ─── GET /me ──────────────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's identity hash and registration state.
 *
 * Response:
 *   {
 *     identityHash:    string,         // 32 hex chars
 *     umbraRegistered: boolean,        // true once first claim sweep succeeded
 *     walletAddress:   string | null,
 *     hasPending:      boolean,        // true if unclaimed payments are waiting
 *   }
 */
router.get("/me", meLimiter, async (req, res, next) => {
  try {
    const user = await adminAuth().getUser(req.firebaseUid);

    if (!user.phoneNumber) {
      return res.status(422).json({
        error: "No verified phone number on this account.",
      });
    }

    const identityHash = deriveIdentityHash(user.phoneNumber);
    const record = await getIdentityByUID(req.firebaseUid);

    // Surface whether there are unclaimed payments — lets the client show a
    // "You have pending payments" prompt and call POST /v1/pay/claim
    const pending = await getPendingPaymentsForIdentity(identityHash);
    const hasPending = pending.length > 0;

    return res.json({
      identityHash,
      umbraRegistered: record?.umbra_registered ?? false,
      walletAddress: record?.wallet_address ?? null,
      hasPending,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /resolve ────────────────────────────────────────────────────────────

/**
 * Resolves a phone number to the identity metadata needed for a private payment.
 *
 * Request body: { phoneNumber: string }  — E.164 format
 *
 * Response:
 *   {
 *     identityHash:          string,         // 32 hex chars — stable payment key
 *     walletAddress:         string,         // RELAY wallet — tx destination
 *     directWalletAddress:   string | null,  // recipient's real wallet (if registered)
 *     fullName:              string | null,
 *     uid:                   string | null,
 *     isRegistered:          boolean,
 *     isUmbraRegistered:     boolean,
 *     isPrivateRelay:        true,           // always true — use /v1/pay/private
 *   }
 *
 * walletAddress is ALWAYS the relay wallet. Private payments always flow
 * through server-managed Umbra routing regardless of recipient status.
 * Phone numbers are NEVER returned.
 */
router.post("/resolve", resolveLimiter, async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber || typeof phoneNumber !== "string") {
      return res.status(400).json({ error: "phoneNumber is required." });
    }

    const normalized = phoneNumber.trim();

    if (!E164_RE.test(normalized)) {
      return res.status(400).json({
        error: "phoneNumber must be in E.164 format (e.g. +2348012345678).",
      });
    }

    // Fast self-send guard (phone equality, no DB needed)
    const self = await adminAuth().getUser(req.firebaseUid);
    if (self.phoneNumber && self.phoneNumber === normalized) {
      return res
        .status(400)
        .json({ error: "You cannot send funds to yourself." });
    }

    const identityHash = deriveIdentityHash(normalized);
    const record = await getIdentityByHash(identityHash);

    if (record) {
      // UID-based self-send guard
      if (record.uid === req.firebaseUid) {
        return res
          .status(400)
          .json({ error: "You cannot send funds to yourself." });
      }

      let fullName = null;
      try {
        const recipientAuth = await adminAuth().getUser(record.uid);
        fullName = recipientAuth.displayName ?? null;
      } catch {
        // Non-fatal — proceed without display name
      }

      return res.json({
        identityHash,
        walletAddress: relayPublicKey, // always relay
        directWalletAddress: record.wallet_address,
        fullName,
        uid: record.uid,
        isRegistered: true,
        isUmbraRegistered: record.umbra_registered,
        isPrivateRelay: true,
      });
    }

    // Unregistered recipient — payment still goes through, sits in Umbra
    // until they sign up and the auto-claim sweep runs
    return res.json({
      identityHash,
      walletAddress: relayPublicKey,
      directWalletAddress: null,
      fullName: null,
      uid: null,
      isRegistered: false,
      isUmbraRegistered: false,
      isPrivateRelay: true,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /register ───────────────────────────────────────────────────────────

/**
 * Registers the authenticated user's wallet + identity for private payments.
 * Called once during onboarding after Firebase phone auth and wallet creation.
 *
 * After persisting the identity record, triggers an async UTXO claim sweep
 * so any payments sent before sign-up land in the user's wallet automatically.
 *
 * Request body: { walletAddress: string }  — Solana Base58 public key
 *
 * Response 201: { identityHash: string, hasPending: boolean }
 *   hasPending: true means a sweep was triggered — funds should arrive shortly.
 *   The client can poll GET /me for umbraRegistered to know when sweep completed.
 */
router.post("/register", registerLimiter, async (req, res, next) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress is required." });
    }

    if (!SOLANA_PUBKEY_RE.test(walletAddress)) {
      return res.status(400).json({
        error:
          "walletAddress must be a valid Solana Base58 public key (32–44 chars).",
      });
    }

    const user = await adminAuth().getUser(req.firebaseUid);

    if (!user.phoneNumber) {
      return res.status(422).json({
        error: "Account must have a verified phone number before registering.",
      });
    }

    const identityHash = deriveIdentityHash(user.phoneNumber);

    // Persist identity record — umbraRegistered starts false,
    // sweepPendingUtxosAsync sets it true after first successful sweep
    await upsertIdentityRecord({
      uid: req.firebaseUid,
      identityHash,
      walletAddress,
      umbraRegistered: false,
    });

    // Check pending count before returning so the client knows what to expect
    const pending = await getPendingPaymentsForIdentity(identityHash);
    const hasPending = pending.length > 0;

    // Trigger async sweep — UTXO claim + withdrawal runs after HTTP response.
    // setImmediate ensures the 201 is sent first.
    if (hasPending) {
      setImmediate(() =>
        sweepPendingUtxosAsync({
          identityHash,
          walletAddress,
          uid: req.firebaseUid,
        }),
      );
    }

    return res.status(201).json({ identityHash, hasPending });
  } catch (err) {
    next(err);
  }
});

export { router as identityRouter };
