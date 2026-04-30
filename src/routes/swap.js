/**
 * src/routes/swap.js
 *
 * Jupiter V6 swap routes — quote fetching, transaction building, and broadcast.
 *
 * ─── Endpoints ────────────────────────────────────────────────────────────────
 *
 *   GET  /v1/swap/quote   — Fetch the best route from Jupiter for a token pair.
 *   POST /v1/swap/build   — Build a VersionedTransaction from a quote response.
 *   POST /v1/swap/submit  — Verify and broadcast a Jupiter VersionedTransaction
 *                           signed by the user. User pays their own fees.
 *
 * ─── Swap pair rules ──────────────────────────────────────────────────────────
 *
 *   Every swap must be between EXACTLY ONE stablecoin and ONE ecosystem/xStock:
 *
 *     USDC  ←→  SOL | JUP | JTO | RAY | BONK | WIF | PYTH | ORCA | RENDER | W
 *     USDT  ←→  TSLAx | NVDAx | AAPLx | SPYx | METAx | GOOGLx | MSTRx | ...
 *
 *   Stable ↔ stable and non-stable ↔ non-stable swaps are both rejected.
 *   All allowed tokens and their mint addresses live in src/config/tokens.js.
 *
 * ─── Fee model ────────────────────────────────────────────────────────────────
 *
 *   The USER is the fee payer. Jupiter builds the transaction with the user's
 *   public key as fee payer. The backend does NOT co-sign — it only verifies
 *   and broadcasts the user-signed transaction.
 *
 * ─── Security model ───────────────────────────────────────────────────────────
 *
 *   1. Firebase ID token required on all routes (requireFirebaseAuth).
 *   2. /v1/swap/quote and /v1/swap/build validate that inputMint and outputMint
 *      satisfy the stable ↔ non-stable pair rule before hitting Jupiter.
 *   3. /v1/swap/submit verifies:
 *        a. Transaction deserialises as a VersionedTransaction.
 *        b. Fee payer (staticAccountKeys[0]) matches the declared senderPublicKey.
 *        c. Sender signature slot is non-empty (user has signed).
 *   4. We broadcast ourselves — the client cannot tamper after signing.
 */

import { VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";

import { STABLE_MINTS, ALLOWED_MINTS, TOKEN_INFO } from "../config/tokens.js";

// ─── Singletons ────────────────────────────────────────────────────────────────

const jupiter = createJupiterApiClient();

const connection = new Connection(process.env.ALCHEMY_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
const MAX_SLIPPAGE_BPS = 500; // 5% ceiling

const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

// ─── Token pair validation ─────────────────────────────────────────────────────

/**
 * Validates that a swap pair satisfies the stable ↔ non-stable rule.
 * Returns null on success, or an error message string on failure.
 *
 * @param {string} inputMint
 * @param {string} outputMint
 * @returns {string|null}
 */
function validateSwapPair(inputMint, outputMint) {
  const inputIsStable = STABLE_MINTS.has(inputMint);
  const outputIsStable = STABLE_MINTS.has(outputMint);
  const inputIsAllowed = ALLOWED_MINTS.has(inputMint);
  const outputIsAllowed = ALLOWED_MINTS.has(outputMint);

  if (!inputIsStable && !inputIsAllowed) {
    return "inputMint is not a supported token.";
  }
  if (!outputIsStable && !outputIsAllowed) {
    return "outputMint is not a supported token.";
  }
  if (inputIsStable && outputIsStable) {
    return (
      "Stable ↔ stable swaps are not supported (e.g. USDC → USDT). " +
      "One side must be a Solana ecosystem token or xStock."
    );
  }
  if (!inputIsStable && !outputIsStable) {
    return (
      "Non-stable ↔ non-stable swaps are not supported. " +
      "One side must be USDC or USDT."
    );
  }

  return null; // valid pair
}

// ─── Confirmation (HTTP polling) ───────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

async function pollForConfirmation(
  signature,
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

// ─── GET /v1/swap/quote ────────────────────────────────────────────────────────

/**
 * Returns the best Jupiter route for a valid stable ↔ non-stable pair.
 *
 * Query params:
 *   inputMint    {string}  — base58 mint of the token to sell
 *   outputMint   {string}  — base58 mint of the token to buy
 *   amount       {number}  — amount in token's smallest unit
 *   slippageBps  {number}  — optional, default 50 (0.5%), max 500 (5%)
 */
export async function getSwapQuote(req, res, next) {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.query;

    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({
        error: "inputMint, outputMint, and amount query params are required.",
      });
    }

    try {
      new PublicKey(inputMint);
      new PublicKey(outputMint);
    } catch {
      return res.status(400).json({
        error: "inputMint and outputMint must be valid Solana public keys.",
      });
    }

    if (inputMint === outputMint) {
      return res
        .status(400)
        .json({ error: "inputMint and outputMint must be different." });
    }

    const pairError = validateSwapPair(inputMint, outputMint);
    if (pairError) return res.status(400).json({ error: pairError });

    const parsedAmount = parseInt(amount, 10);
    if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        error:
          "amount must be a positive integer in the token's smallest unit.",
      });
    }

    const parsedSlippage = slippageBps
      ? parseInt(slippageBps, 10)
      : DEFAULT_SLIPPAGE_BPS;

    if (
      !Number.isInteger(parsedSlippage) ||
      parsedSlippage < 0 ||
      parsedSlippage > MAX_SLIPPAGE_BPS
    ) {
      return res.status(400).json({
        error: `slippageBps must be between 0 and ${MAX_SLIPPAGE_BPS}.`,
      });
    }

    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount: parsedAmount,
      slippageBps: parsedSlippage,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    });

    if (!quote) {
      return res.status(502).json({
        error: "No route found for this pair. Try a different amount.",
      });
    }

    // Attach human-readable token metadata for the frontend.
    // NOTE: _meta is stripped before forwarding to Jupiter in /v1/swap/build.
    return res.json({
      ...quote,
      _meta: {
        inputToken: TOKEN_INFO[inputMint] ?? null,
        outputToken: TOKEN_INFO[outputMint] ?? null,
      },
    });
  } catch (err) {
    if (err?.response?.status === 400) {
      return res.status(400).json({ error: "Invalid token pair or amount." });
    }
    next(err);
  }
}

// ─── POST /v1/swap/build ───────────────────────────────────────────────────────

/**
 * Builds a Jupiter VersionedTransaction from a quote and returns it base64-
 * encoded for the client to sign.
 *
 * The user is the fee payer — userPublicKey is passed directly to Jupiter
 * with no backend wallet involvement at this stage.
 *
 * Request body:
 *   quoteResponse    {object}   — full quote from GET /v1/swap/quote
 *   userPublicKey    {string}   — base58 signer public key (also fee payer)
 *   wrapAndUnwrapSol {boolean}  — auto wrap/unwrap SOL↔wSOL (default true)
 *
 * Response:
 *   { swapTransaction: "<base64>", lastValidBlockHeight: <number> }
 */
export async function buildSwapTransaction(req, res, next) {
  try {
    const {
      quoteResponse,
      userPublicKey: userPubKeyStr,
      wrapAndUnwrapSol = true,
    } = req.body;

    if (!quoteResponse || typeof quoteResponse !== "object") {
      return res.status(400).json({
        error: "quoteResponse is required (object from GET /v1/swap/quote).",
      });
    }

    // Strip _meta — added by our backend for the UI, rejected by Jupiter.
    const { _meta, ...cleanQuote } = quoteResponse;

    // Re-validate pair so a client can't swap a different pair after quoting.
    const pairError = validateSwapPair(
      cleanQuote.inputMint,
      cleanQuote.outputMint,
    );
    if (pairError) {
      return res.status(400).json({ error: `Invalid quote: ${pairError}` });
    }

    if (typeof userPubKeyStr !== "string" || !userPubKeyStr.trim()) {
      return res.status(400).json({ error: "userPublicKey is required." });
    }

    try {
      new PublicKey(userPubKeyStr);
    } catch {
      return res.status(400).json({
        error: "userPublicKey is not a valid Solana public key.",
      });
    }

    // User is fee payer — no backend wallet injected here.
    const swapPayload = {
      quoteResponse: cleanQuote,
      userPublicKey: userPubKeyStr,
      wrapAndUnwrapSol,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 5000,
    };

    console.log(
      "[swap/build] Sending to Jupiter:",
      JSON.stringify(swapPayload, null, 2),
    );

    const jupiterRes = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapPayload),
    });

    const jupiterBody = await jupiterRes.json();

    if (!jupiterRes.ok) {
      console.error(
        `[swap/build] Jupiter ${jupiterRes.status} error:`,
        JSON.stringify(jupiterBody, null, 2),
      );
      return res.status(400).json({
        error:
          jupiterBody?.error ??
          jupiterBody?.message ??
          "Jupiter rejected the swap build request.",
        detail: jupiterBody,
      });
    }

    return res.json({
      swapTransaction: jupiterBody.swapTransaction,
      lastValidBlockHeight: jupiterBody.lastValidBlockHeight,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /v1/swap/submit ──────────────────────────────────────────────────────

/**
 * Receives a user-signed Jupiter VersionedTransaction and broadcasts it.
 * The user is the fee payer — the backend does NOT co-sign.
 *
 * Security checks:
 *   a. Transaction deserialises as a VersionedTransaction.
 *   b. Fee payer (staticAccountKeys[0]) matches the declared senderPublicKey.
 *   c. Sender signature slot is non-empty (user has signed).
 *
 * Request body:
 *   transaction          {string}  — base64 VersionedTransaction signed by user
 *   senderPublicKey      {string}  — base58 public key of the signer / fee payer
 *   lastValidBlockHeight {number}  — from /v1/swap/build, for expiry tracking
 *
 * Response (200):
 *   { signature: "<base58>" }
 */
export async function submitSwapTransaction(req, res, next) {
  try {
    const {
      transaction: txBase64,
      senderPublicKey: senderPubKeyStr,
      lastValidBlockHeight,
    } = req.body;

    if (typeof txBase64 !== "string" || !txBase64.trim()) {
      return res.status(400).json({
        error: "transaction is required (base64 VersionedTransaction).",
      });
    }

    if (typeof senderPubKeyStr !== "string" || !senderPubKeyStr.trim()) {
      return res.status(400).json({ error: "senderPublicKey is required." });
    }

    if (!Number.isInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
      return res.status(400).json({
        error: "lastValidBlockHeight is required (number from /v1/swap/build).",
      });
    }

    try {
      new PublicKey(senderPubKeyStr);
    } catch {
      return res.status(400).json({
        error: "senderPublicKey is not a valid Solana public key.",
      });
    }

    let tx;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    } catch {
      return res.status(400).json({
        error:
          "transaction could not be deserialised as a VersionedTransaction.",
      });
    }

    // Fee payer must be the declared sender (staticAccountKeys[0]).
    const txFeePayer = tx.message.staticAccountKeys[0]?.toBase58();
    if (txFeePayer !== senderPubKeyStr) {
      return res.status(400).json({
        error:
          `transaction fee payer (${txFeePayer}) does not match senderPublicKey. ` +
          "Use /v1/swap/build to construct the transaction.",
      });
    }

    // Sender must have signed their slot (index 0 for fee payer).
    const senderSig = tx.signatures[0];
    if (!senderSig || senderSig.every((b) => b === 0)) {
      return res.status(400).json({
        error:
          "Sender signature is missing. Sign the transaction on-device before submitting.",
      });
    }

    // Broadcast — no backend co-signing needed.
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    await pollForConfirmation(signature, lastValidBlockHeight, "confirmed");

    console.log(
      `[swap/submit] ✓ uid=${req.firebaseUid} sender=${senderPubKeyStr} sig=${signature}`,
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
      return res.status(400).json({
        error:
          "Insufficient SOL to cover transaction fees. Add SOL to your wallet and try again.",
      });
    }

    next(err);
  }
}
