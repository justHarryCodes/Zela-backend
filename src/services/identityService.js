/**
 * src/services/identityService.js
 *
 * Server-side identity hash derivation and deterministic claim-key generation.
 *
 * ─── Identity Hash ────────────────────────────────────────────────────────────
 *
 *   identityHash = HMAC-SHA256(E.164_phone, IDENTITY_HMAC_SECRET)[0:32 hex]
 *
 *   Properties:
 *     • Deterministic — same phone + same secret always yields the same hash
 *     • One-way — cannot recover phone number without the secret (server-only)
 *     • Collision-resistant — 128-bit output, safe for any realistic dataset
 *     • Spoofing-resistant — attacker cannot forge a hash without the secret
 *
 *   The client receives the hash after authentication but NEVER computes it.
 *   All derivation happens here, on the server.
 *
 * ─── Claim Keypair (unregistered-user UTXOs) ─────────────────────────────────
 *
 *   For unregistered recipients, the server creates Umbra UTXOs addressed to
 *   a Solana keypair derived deterministically from the recipient's identity hash:
 *
 *     claimSeed   = HMAC-SHA256(identityHash, UTXO_DERIVATION_SECRET)  [32 bytes]
 *     claimKeypair = Keypair.fromSeed(claimSeed)
 *
 *   When the recipient later registers and calls /v1/pay/claim:
 *     1. Firebase phone auth proves their identity (phone → identityHash)
 *     2. Server rederives the same claimKeypair from identityHash
 *     3. Server claims all UTXOs to the user's registered wallet
 *     4. The user never touches the claim keypair — server controls everything
 *
 *   SECURITY NOTE:
 *     • Compromise of UTXO_DERIVATION_SECRET allows claiming all pending
 *       unregistered-user UTXOs. Treat it as a HSM-grade secret.
 *     • Rotate via a migration that re-creates all pending UTXOs if compromised.
 *     • IDENTITY_HMAC_SECRET and UTXO_DERIVATION_SECRET must be distinct.
 */

import crypto from "crypto";
import { Keypair } from "@solana/web3.js";

// ─── Secret validation ────────────────────────────────────────────────────────

const IDENTITY_HMAC_SECRET = process.env.IDENTITY_HMAC_SECRET;
const UTXO_DERIVATION_SECRET = process.env.UTXO_DERIVATION_SECRET;

if (!IDENTITY_HMAC_SECRET) {
  throw new Error(
    "[identityService] IDENTITY_HMAC_SECRET is not set.\n" +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

if (!UTXO_DERIVATION_SECRET) {
  throw new Error(
    "[identityService] UTXO_DERIVATION_SECRET is not set.\n" +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

if (IDENTITY_HMAC_SECRET === UTXO_DERIVATION_SECRET) {
  throw new Error(
    "[identityService] IDENTITY_HMAC_SECRET and UTXO_DERIVATION_SECRET must be different values.",
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Derives the stable, server-side identity hash for a phone number.
 *
 * @param {string} phoneNumber  E.164 format, e.g. "+2348012345678"
 * @returns {string}            32 hex chars (128-bit HMAC-SHA256)
 * @throws {Error}              If phoneNumber is not a non-empty string
 */
export function deriveIdentityHash(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== "string") {
    throw new TypeError(
      "[identityService] phoneNumber must be a non-empty string",
    );
  }

  return crypto
    .createHmac("sha256", IDENTITY_HMAC_SECRET)
    .update(phoneNumber.trim())
    .digest("hex")
    .slice(0, 32);
}

/**
 * Derives the 32-byte seed used to generate the claim keypair for an
 * unregistered recipient. The seed is a second-layer HMAC so that
 * compromise of one secret does not compromise the other.
 *
 * @param {string} identityHash  32 hex char identity hash
 * @returns {Buffer}             32-byte HMAC-SHA256 digest
 */
export function deriveClaimSeed(identityHash) {
  if (
    !identityHash ||
    identityHash.length !== 32 ||
    !/^[0-9a-f]{32}$/.test(identityHash)
  ) {
    throw new TypeError(
      "[identityService] identityHash must be exactly 32 lowercase hex chars",
    );
  }

  return crypto
    .createHmac("sha256", UTXO_DERIVATION_SECRET)
    .update(identityHash)
    .digest(); // returns a 32-byte Buffer
}

/**
 * Returns the deterministic Solana Keypair that receives Umbra UTXOs for an
 * unregistered recipient. The server uses this keypair to claim UTXOs on the
 * user's behalf when they eventually register.
 *
 * This keypair's public key is used as the UTXO recipient in the Umbra mixer.
 * Its private key is NEVER persisted — it is always rederived on demand.
 *
 * @param {string} identityHash  32 hex char identity hash
 * @returns {import("@solana/web3.js").Keypair}
 */
export function deriveClaimKeypair(identityHash) {
  const seed = deriveClaimSeed(identityHash);
  return Keypair.fromSeed(seed);
}

/**
 * Validates that a phone number matches the claimed identity hash.
 * Used to prevent phone/hash spoofing in payment requests.
 *
 * @param {string} phoneNumber      E.164
 * @param {string} claimedHash      32 hex chars
 * @returns {boolean}
 */
export function phoneMatchesHash(phoneNumber, claimedHash) {
  try {
    const derived = deriveIdentityHash(phoneNumber);
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(derived, "hex"),
      Buffer.from(claimedHash, "hex"),
    );
  } catch {
    return false;
  }
}
