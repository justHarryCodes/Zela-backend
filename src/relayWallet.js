/**
 * src/relayWallet.js
 *
 * Loads the private-pay relay Keypair exactly once at process start.
 * All Umbra SDK operations are signed with this keypair.
 *
 * The relay wallet:
 *   • Receives stablecoins from senders (via sponsored transactions)
 *   • Signs Umbra mixer deposits on behalf of recipients
 *   • Must hold sufficient SOL for Umbra transaction gas (~0.005 SOL per op)
 *   • Must have initialised ATAs for USDC, USDT, and USDG before use
 *
 * IMPORTANT: Fund this wallet with SOL and initialise its ATAs before
 * deploying to mainnet. Monitor the SOL balance in /health/deep.
 *
 * To generate a new relay wallet:
 *   node -e "
 *     const { Keypair } = require('@solana/web3.js');
 *     const bs58 = require('bs58');
 *     const kp = Keypair.generate();
 *     console.log('Public key:', kp.publicKey.toBase58());
 *     console.log('Secret key:', bs58.encode(kp.secretKey));
 *   "
 *
 * Exports (unchanged):
 *   relayWallet      — Keypair (used for signing Umbra transactions)
 *   relayPublicKey   — Base58 string
 *
 * New additive export:
 *   getRelayBalance  — async fn(connection) → SOL balance as number
 */

import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "relayWallet",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "relayWallet",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Loader ───────────────────────────────────────────────────────────────────

function loadRelayWallet() {
  // ── 1. Presence check — fastest possible failure ──────────────────────────
  const raw = process.env.PRIVATE_PAY_RELAY_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "[relayWallet] PRIVATE_PAY_RELAY_SECRET_KEY is not set.\n" +
        "Generate a new keypair and add it to your .env file.",
    );
  }

  // ── 2. Decode — catch non-base58 input before touching crypto ─────────────
  let secretKey;
  try {
    secretKey = bs58.decode(raw);
  } catch {
    throw new Error(
      "[relayWallet] PRIVATE_PAY_RELAY_SECRET_KEY is not valid base58. " +
        "Ensure it is a full base58-encoded Solana secret key.",
    );
  }

  // ── 3. Length check — a short key silently produces the wrong wallet ───────
  // Must be exactly 64 bytes (32-byte seed + 32-byte public key).
  // Checked before Keypair.fromSecretKey so the error is immediately clear.
  if (secretKey.length !== 64) {
    throw new Error(
      `[relayWallet] PRIVATE_PAY_RELAY_SECRET_KEY decoded to ${secretKey.length} bytes — ` +
        "expected 64. Ensure you are using the full secret key, not just the seed.",
    );
  }

  // ── 4. Keypair construction ────────────────────────────────────────────────
  let keypair;
  try {
    keypair = Keypair.fromSecretKey(secretKey);
  } catch (err) {
    throw new Error(`[relayWallet] Failed to create Keypair: ${err.message}`);
  }

  // secretKey bytes and process.env.PRIVATE_PAY_RELAY_SECRET_KEY are intentionally
  // kept alive — this wallet signs Umbra transactions throughout the process lifetime.

  log.info("Relay wallet loaded", { publicKey: keypair.publicKey.toBase58() });

  return keypair;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const relayWallet = loadRelayWallet();
export const relayPublicKey = relayWallet.publicKey.toBase58();

/**
 * Returns the current SOL balance of the relay wallet.
 * Plug into /health/deep.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @returns {Promise<number>} balance in SOL
 */
export async function getRelayBalance(connection) {
  const lamports = await connection.getBalance(relayWallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}
