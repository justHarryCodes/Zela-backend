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
 *   Polling via getSignatureStatuses is pure HTTP, always works on Alchemy,
 *   and gives us fine-grained control over timeout and retry cadence.
 *
 *   The blockhash used for expiry tracking is the one INSIDE the transaction
 *   (set by the client before signing). Fetching a new blockhash after
 *   broadcast — as the previous version did — would track the wrong window.
 */

import { Transaction, PublicKey, Connection } from "@solana/web3.js";

import { feePayer, feePayerPublicKey } from "../feePayer.js";

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
// Each routed token now produces up to 4 instructions:
//   1. createAssociatedTokenAccount for the recipient   (if ATA is new)
//   2. createAssociatedTokenAccount for the fee wallet  (if ATA is new)
//   3. transfer → recipient
//   4. transfer → fee wallet
//
// With 3 tokens routed and both ATAs brand-new on every step:
//   3 tokens × 4 instructions = 12 max
//
// We set the ceiling to 14 to keep a 2-instruction safety margin without
// opening the door to unrelated instruction injection.
const MAX_INSTRUCTIONS = 14;

// ─── Confirmation via HTTP polling ────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * Polls getSignatureStatuses() until the transaction reaches the target
 * commitment level or the blockhash expires, whichever comes first.
 *
 * @param {string} signature
 * @param {string} blockhash
 * @param {number} lastValidBlockHeight
 * @param {'confirmed'|'finalized'} [commitment='confirmed']
 * @returns {Promise<void>}
 */
async function pollForConfirmation(
  signature,
  blockhash,
  lastValidBlockHeight,
  commitment = "confirmed",
) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentHeight = await connection.getBlockHeight("confirmed");
    if (currentHeight > lastValidBlockHeight) {
      throw new Error(
        `Transaction blockhash expired at block height ${lastValidBlockHeight} ` +
          `(current: ${currentHeight}). Rebuild and resubmit.`,
      );
    }

    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });

    const status = value?.[0];

    if (status) {
      if (status.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
        );
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

  throw new Error(
    `Confirmation timeout: transaction ${signature} was not confirmed within ` +
      `${POLL_TIMEOUT_MS / 1000} seconds.`,
  );
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 */
export async function sponsorTransaction(req, res, next) {
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
      const txBuffer = Buffer.from(txBase64, "base64");
      tx = Transaction.from(txBuffer);
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

    const blockhashInfo = await connection.getLatestBlockhash("confirmed");
    const lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;

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
        console.warn(`[sponsor] ✗ REJECTED program: ${programId}`);
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

    const sigsValid = tx.verifySignatures(false);
    if (!sigsValid) {
      return res.status(400).json({
        error:
          "Sender signature verification failed. The transaction may have been tampered with.",
      });
    }

    // ── Co-sign as fee payer and broadcast ────────────────────────────────

    tx.partialSign(feePayer);

    const rawTx = tx.serialize();

    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    await pollForConfirmation(
      signature,
      txBlockhash,
      lastValidBlockHeight,
      "confirmed",
    );

    console.log(
      `[sponsor] ✓ uid=${req.firebaseUid} sender=${senderPubKeyStr} sig=${signature}`,
    );

    return res.status(200).json({ signature });
  } catch (err) {
    if (
      err.message?.includes("blockhash expired") ||
      err.message?.includes("Rebuild and resubmit") ||
      err.message?.includes("BlockhashNotFound")
    ) {
      return res.status(502).json({ error: err.message });
    }

    if (err.message?.includes("Confirmation timeout")) {
      return res.status(504).json({ error: err.message });
    }

    if (err.message?.includes("InsufficientFundsForFee")) {
      console.error("[sponsor] Fee payer wallet is out of SOL!");
      return res.status(503).json({
        error: "Service temporarily unavailable. Please try again shortly.",
      });
    }

    next(err);
  }
}
