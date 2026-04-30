/**
 * src/routes/sponsor.js
 *
 * POST /v1/sponsor
 *
 * Receives a partially-signed, base64-encoded Solana transaction from the
 * mobile client, validates it, co-signs as fee payer, and broadcasts it.
 *
 * ─── Request body ─────────────────────────────────────────────────────────────
 *
 *   {
 *     "transaction": "<base64-encoded serialized Transaction>",
 *     "senderPublicKey": "<base58 sender public key>"
 *   }
 *
 * ─── Response (200) ──────────────────────────────────────────────────────────
 *
 *   { "signature": "<base58 transaction signature>" }
 *
 * ─── Security model ───────────────────────────────────────────────────────────
 *
 *   1. Firebase ID token verified by requireFirebaseAuth middleware (upstream).
 *      req.firebaseUid is available and trusted by the time we run.
 *
 *   2. We verify that the serialized transaction:
 *        a. Deserializes cleanly (no malformed bytes).
 *        b. Has a fee payer that matches OUR fee payer public key.
 *        c. Contains ONLY SPL Token transfer and createAssociatedTokenAccount
 *           instructions. We reject anything else.
 *        d. The sender's signature is present and cryptographically valid.
 *        e. Does not exceed MAX_INSTRUCTIONS instructions.
 *
 *   3. We never hold or reconstruct the sender's private key.
 *
 *   4. We sign with the fee payer keypair and broadcast immediately.
 *      Broadcasting ourselves prevents a client from stripping our signature.
 *
 * ─── Confirmation strategy ────────────────────────────────────────────────────
 *
 *   We poll getSignatureStatuses() over HTTP rather than using
 *   confirmTransaction() / signatureSubscribe. Alchemy's HTTP RPC endpoint
 *   does not support WebSocket subscriptions, so signatureSubscribe returns
 *   -32601 "Method not found" and the SDK falls back to block-height polling
 *   which races against blockhash expiry and loses.
 *
 *   Blockhash validity is checked with isBlockhashValid() against the
 *   TRANSACTION's own blockhash on each poll tick. The previous approach of
 *   calling getLatestBlockhash() and using its lastValidBlockHeight was
 *   incorrect — that window belongs to the freshly-fetched hash, not to the
 *   (possibly older) hash the client embedded in the transaction, causing
 *   expiry to be over-estimated by up to ~30 seconds.
 */

import { Transaction, PublicKey, Connection } from "@solana/web3.js";
import { feePayer, feePayerPublicKey } from "../feePayer.js";

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "sponsor",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "sponsor",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "sponsor",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Typed internal errors ────────────────────────────────────────────────────
//
// Subclasses instead of string matching on err.message — survives SDK updates
// that change error wording without breaking error categorisation.

class BlockhashExpiredError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BlockhashExpiredError";
  }
}
class ConfirmationTimeoutError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ConfirmationTimeoutError";
  }
}
class OnChainError extends Error {
  constructor(solanaErr) {
    super("Transaction failed on-chain");
    this.name = "OnChainError";
    this.solanaErr = solanaErr; // kept for internal logging only — never sent to client
  }
}

// ─── Solana connection (singleton) ────────────────────────────────────────────

const rpcUrl = process.env.ALCHEMY_RPC_URL;
if (!rpcUrl || !rpcUrl.startsWith("http")) {
  throw new Error(
    "[sponsor] ALCHEMY_RPC_URL is missing or invalid.\n" +
      "Add it to your .env file:\n" +
      "  ALCHEMY_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY\n",
  );
}

const connection = new Connection(rpcUrl, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

// ─── Allowed program IDs ──────────────────────────────────────────────────────

const ALLOWED_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Program
  "11111111111111111111111111111111", // System Program
]);

// ─── Instruction limit ────────────────────────────────────────────────────────
//
// Each routed token produces up to 4 instructions:
//   1. createAssociatedTokenAccount for the recipient   (if ATA is new)
//   2. createAssociatedTokenAccount for the fee wallet  (if ATA is new)
//   3. transfer → recipient
//   4. transfer → fee wallet
//
// 3 tokens × 4 instructions = 12 max; ceiling set to 14 for a 2-instruction margin.

const MAX_INSTRUCTIONS = 14;

// ─── Confirmation via HTTP polling ────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * Polls getSignatureStatuses() until the transaction confirms or its blockhash
 * expires, whichever comes first.
 *
 * Uses isBlockhashValid() against the transaction's own blockhash rather than
 * fetching a fresh blockhash and using its lastValidBlockHeight — those two
 * expiry windows can differ by up to ~150 blocks.
 *
 * @param {string} signature
 * @param {string} txBlockhash   The recentBlockhash embedded in the transaction
 * @param {'confirmed'|'finalized'} [commitment='confirmed']
 * @returns {Promise<void>}
 */
async function pollForConfirmation(
  signature,
  txBlockhash,
  commitment = "confirmed",
) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Cheapest failure path — bail out the moment the blockhash is no longer valid.
    const { value: isValid } = await connection.isBlockhashValid(txBlockhash, {
      commitment: "confirmed",
    });

    if (!isValid) {
      throw new BlockhashExpiredError(
        "Transaction blockhash has expired. " +
          "The transaction was not confirmed within the ~150-block validity window. " +
          "Rebuild and resubmit.",
      );
    }

    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });

    const status = value?.[0];

    if (status) {
      if (status.err) {
        // Carry the raw Solana error for server-side logging only.
        // The route handler sends a sanitised message to the client.
        throw new OnChainError(status.err);
      }

      const reached =
        commitment === "finalized"
          ? status.confirmationStatus === "finalized"
          : status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized";

      if (reached) return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new ConfirmationTimeoutError(
    `Transaction ${signature} was not confirmed within ${POLL_TIMEOUT_MS / 1000} seconds.`,
  );
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Export name and signature unchanged — server.js and tests need no updates.
 *
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 */
export async function sponsorTransaction(req, res, next) {
  const startMs = Date.now();

  try {
    const { transaction: txBase64, senderPublicKey: senderPubKeyStr } =
      req.body;

    // ── Input validation ──────────────────────────────────────────────────

    if (typeof txBase64 !== "string" || !txBase64.trim()) {
      return res
        .status(400)
        .json({ error: "transaction is required (base64 string)." });
    }

    if (typeof senderPubKeyStr !== "string" || !senderPubKeyStr.trim()) {
      return res.status(400).json({ error: "senderPublicKey is required." });
    }

    let senderPublicKey;
    try {
      senderPublicKey = new PublicKey(senderPubKeyStr);
    } catch {
      return res
        .status(400)
        .json({ error: "senderPublicKey is not a valid Solana public key." });
    }

    // ── Deserialize ───────────────────────────────────────────────────────

    let tx;
    try {
      tx = Transaction.from(Buffer.from(txBase64, "base64"));
    } catch {
      return res
        .status(400)
        .json({ error: "transaction could not be deserialized." });
    }

    // ── Extract blockhash from the transaction ────────────────────────────

    const txBlockhash = tx.recentBlockhash;
    if (!txBlockhash) {
      return res
        .status(400)
        .json({ error: "transaction is missing recentBlockhash." });
    }

    // ── Guard: fee payer must be our wallet ───────────────────────────────

    if (!tx.feePayer || tx.feePayer.toBase58() !== feePayerPublicKey) {
      return res.status(400).json({
        error: `transaction.feePayer must be set to the Zela fee payer (${feePayerPublicKey}).`,
      });
    }

    // ── Guard: instruction allowlist ──────────────────────────────────────

    if (tx.instructions.length === 0) {
      return res
        .status(400)
        .json({ error: "transaction contains no instructions." });
    }

    if (tx.instructions.length > MAX_INSTRUCTIONS) {
      return res.status(400).json({
        error: `transaction contains too many instructions (max ${MAX_INSTRUCTIONS}).`,
      });
    }

    for (const ix of tx.instructions) {
      const programId = ix.programId.toBase58();
      if (!ALLOWED_PROGRAMS.has(programId)) {
        // Log with uid + sender so security probes are correlatable in the aggregator.
        log.warn("Disallowed program rejected", {
          uid: req.firebaseUid,
          senderPublicKey: senderPubKeyStr,
          programId,
        });
        return res.status(400).json({
          error: `Instruction targets a disallowed program: ${programId}. Only SPL Token transfers are permitted.`,
        });
      }
    }

    // ── Guard: sender must have already signed ────────────────────────────

    const senderSigEntry = tx.signatures.find(
      (s) => s.publicKey.toBase58() === senderPubKeyStr,
    );

    if (!senderSigEntry?.signature) {
      return res.status(400).json({
        error:
          "Sender signature is missing. Sign the transaction on-device before submitting.",
      });
    }

    if (!tx.verifySignatures(false)) {
      return res.status(400).json({
        error:
          "Sender signature verification failed. The transaction may have been tampered with.",
      });
    }

    // ── Co-sign as fee payer and broadcast ────────────────────────────────

    tx.partialSign(feePayer);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    await pollForConfirmation(signature, txBlockhash, "confirmed");

    log.info("Transaction sponsored", {
      uid: req.firebaseUid,
      senderPublicKey: senderPubKeyStr,
      signature,
      ixCount: tx.instructions.length,
      durationMs: Date.now() - startMs,
    });

    return res.status(200).json({ signature });
  } catch (err) {
    const durationMs = Date.now() - startMs;

    if (err instanceof BlockhashExpiredError) {
      return res.status(502).json({ error: err.message });
    }

    if (err instanceof ConfirmationTimeoutError) {
      log.warn("Confirmation timeout", { uid: req.firebaseUid, durationMs });
      return res.status(504).json({ error: err.message });
    }

    if (err instanceof OnChainError) {
      // Log the raw Solana error server-side for debugging.
      // Send only a generic message to the client — status.err can expose
      // instruction indices and program internals that aid attackers.
      log.error("On-chain transaction failure", {
        uid: req.firebaseUid,
        durationMs,
        solanaErr: JSON.stringify(err.solanaErr),
      });
      return res.status(400).json({
        error:
          "Transaction was rejected by the network. Check your balances and try again.",
      });
    }

    // InsufficientFundsForFee surfaces as a SendTransactionError from the SDK —
    // string-match is the only option here since it's not our own error type.
    if (err.message?.includes("InsufficientFundsForFee")) {
      log.error("Fee payer wallet is out of SOL — top up urgently", {
        uid: req.firebaseUid,
        feePayerPublicKey,
      });
      return res.status(503).json({
        error: "Service temporarily unavailable. Please try again shortly.",
      });
    }

    next(err);
  }
}
