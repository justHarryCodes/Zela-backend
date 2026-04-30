/**
 * src/routes/privatePay.js
 *
 * POST /v1/pay/private  — Validate + sponsor a private payment, trigger Umbra routing
 * GET  /v1/pay/pending  — Pending payments waiting to be claimed by auth user
 * POST /v1/pay/claim    — Claim all pending Umbra UTXOs for auth user
 * GET  /v1/pay/history  — Paginated private payment history
 *
 * All routes require Firebase auth (requireFirebaseAuth, applied upstream in server.js).
 *
 * ─── Token support ────────────────────────────────────────────────────────────
 *
 *   SPL tokens (USDC, USDT, USDG):
 *     - Transfer via SPL Token program (instruction opcodes 3 or 12)
 *     - Destination is an Associated Token Account (ATA)
 *
 *   Native SOL:
 *     - Transfer via System Program (instruction type 2)
 *     - Destination is a plain wallet address, NOT an ATA
 *     - Amount is in lamports (9 decimals)
 *
 * ─── Mint addresses ───────────────────────────────────────────────────────────
 *
 *   All mint addresses sourced from src/config/tokenMints.js (network-aware).
 *   No local TOKEN_MINTS object in this file.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Transaction, PublicKey, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { getAuth as adminAuth } from "firebase-admin/auth";

import { feePayer, feePayerPublicKey } from "../feePayer.js";
import { relayPublicKey } from "../relayWallet.js";
import {
  deriveIdentityHash,
  phoneMatchesHash,
} from "../services/identityService.js";
import {
  createUTXOForRecipient,
  claimUTXOsForIdentity,
} from "../services/umbraService.js";
import {
  notifyRegisteredRecipient,
  notifyUnregisteredRecipient,
} from "../services/smsService.js";
import {
  insertPrivatePayment,
  markPaymentRouting,
  markPaymentRouted,
  markPaymentFailed,
  markPaymentClaimed,
  markSMSSent,
  getPendingPaymentsForIdentity,
  getPaymentHistory,
  getIdentityByHash,
  getIdentityByUID,
} from "../db/privatePayment.js";

import {
  getMintAddress,
  isNativeToken,
  ACCEPTED_PAYMENT_TOKENS,
} from "../config/tokenMints.js";

const router = Router();

// ─── Config ───────────────────────────────────────────────────────────────────

const PRIVATE_PAY_FEE_BPS = 100; // 1%
const FEE_TOLERANCE_RAW = 10n;
const MAX_INSTRUCTIONS = 14;

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

const FEE_WALLET_PK = (() => {
  const raw = process.env.FEE_WALLET_PUBLIC_KEY;
  if (!raw) throw new Error("[privatePay] FEE_WALLET_PUBLIC_KEY is not set");
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(
      "[privatePay] FEE_WALLET_PUBLIC_KEY is not a valid Base58 key",
    );
  }
})();

const ALLOWED_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token
  SYSTEM_PROGRAM_ID, // System (native SOL)
]);

const rpcUrl = process.env.ALCHEMY_RPC_URL;
if (!rpcUrl) throw new Error("[privatePay] ALCHEMY_RPC_URL is not set");

const connection = new Connection(rpcUrl, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 60_000,
});

// ─── Transfer destination resolver ───────────────────────────────────────────
//
// For SPL tokens: destination is an ATA derived from mint + wallet.
// For native SOL: destination is the wallet address itself (no ATA).

async function getExpectedDestination(walletPubkey, tokenSymbol) {
  if (isNativeToken(tokenSymbol)) {
    // Native SOL transfers go directly to the wallet address
    return walletPubkey.toBase58();
  }
  // SPL token: derive the Associated Token Account
  const mintStr = getMintAddress(tokenSymbol);
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mintStr),
    walletPubkey,
  );
  return ata.toBase58();
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

const payLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Wait a minute." },
});

const claimLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many claim attempts. Wait a minute." },
});

const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => req.firebaseUid ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

// ─── Instruction decoder ──────────────────────────────────────────────────────
//
// Handles both native SOL (System Program) and SPL Token transfers.
//
// System Program transfer (native SOL):
//   programId : 11111111111111111111111111111111
//   data      : [uint32 LE instruction=2, uint64 LE lamports]
//   keys      : [from, to]
//
// SPL Token Transfer (opcode 3):
//   data      : [u8=3, uint64 LE amount]
//   keys      : [source_ata, dest_ata, authority]
//
// SPL Token TransferChecked (opcode 12):
//   data      : [u8=12, uint64 LE amount, u8 decimals]
//   keys      : [source_ata, mint, dest_ata, authority]

function extractTransferInfo(ix) {
  const programId = ix.programId.toBase58();
  const data = Buffer.from(ix.data);

  // ── Native SOL — System Program transfer ─────────────────────────────────
  if (programId === SYSTEM_PROGRAM_ID) {
    // System Program instruction layout:
    //   bytes 0-3: uint32 LE instruction index (2 = Transfer)
    //   bytes 4-11: uint64 LE lamports
    if (data.length >= 12 && data.readUInt32LE(0) === 2) {
      return {
        amount: data.readBigUInt64LE(4),
        destination: ix.keys[1].pubkey, // to
        isNative: true,
      };
    }
    return null;
  }

  // ── SPL Token transfers ───────────────────────────────────────────────────
  if (data.length < 9) return null;
  switch (data[0]) {
    case 3: // Transfer
      return {
        amount: data.readBigUInt64LE(1),
        destination: ix.keys[1].pubkey,
        isNative: false,
      };
    case 12: // TransferChecked
      return {
        amount: data.readBigUInt64LE(1),
        destination: ix.keys[2].pubkey,
        isNative: false,
      };
    default:
      return null;
  }
}

// ─── Confirmation polling ─────────────────────────────────────────────────────

const POLL_MS = 2_000;
const POLL_TIMEOUT = 60_000;

async function pollForConfirmation(signature, lastValidBlockHeight) {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    const currentHeight = await connection.getBlockHeight("confirmed");
    if (currentHeight > lastValidBlockHeight) {
      throw new Error(
        `Blockhash expired at ${lastValidBlockHeight} (current: ${currentHeight}). Rebuild and resubmit.`,
      );
    }
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value?.[0];
    if (status) {
      if (status.err)
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
        );
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      )
        return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Confirmation timeout for signature: ${signature}`);
}

// ─── Async Umbra routing ──────────────────────────────────────────────────────

export async function routePaymentAsync({
  paymentId,
  recipientIdentityHash,
  isRegistered,
  registeredWallet,
  relayAmountRaw,
  tokenSymbol,
  recipientPhone,
  amountUSD,
}) {
  try {
    const { signature: umbraSignature, utxoId } = await createUTXOForRecipient({
      identityHash: recipientIdentityHash,
      amountRaw: relayAmountRaw, // bigint
      tokenSymbol,
    });

    await markPaymentRouting(paymentId, utxoId, umbraSignature);
    await markPaymentRouted(paymentId);

    if (isRegistered && registeredWallet) {
      setImmediate(async () => {
        try {
          const claimResults = await claimUTXOsForIdentity({
            identityHash: recipientIdentityHash,
            registeredWalletAddress: registeredWallet,
            tokenSymbol,
          });
          if (claimResults.length > 0) {
            console.log(
              `[privatePay] ✓ Auto-claimed ${claimResults.length} UTXO(s) → ${registeredWallet.slice(0, 8)}…`,
            );
          }
        } catch (err) {
          console.warn(
            `[privatePay] Auto-claim failed for ${paymentId}: ${err.message}`,
          );
        }
      });
    }

    if (recipientPhone) {
      const smsSent = isRegistered
        ? await notifyRegisteredRecipient({
            phoneNumber: recipientPhone,
            amountUSD,
            paymentId,
            identityHash: recipientIdentityHash,
          })
        : await notifyUnregisteredRecipient({
            phoneNumber: recipientPhone,
            amountUSD,
            paymentId,
            identityHash: recipientIdentityHash,
          });
      if (smsSent) await markSMSSent(paymentId);
    }

    console.log(
      `[privatePay] ✓ Payment ${paymentId} routed via Umbra (sig: ${umbraSignature})`,
    );
  } catch (err) {
    console.error(
      `[privatePay] Umbra routing failed for ${paymentId}:`,
      err.message,
    );
    await markPaymentFailed(paymentId, err.message).catch(() => {});
  }
}

// ─── POST /v1/pay/private ─────────────────────────────────────────────────────

router.post("/private", payLimiter, async (req, res, next) => {
  try {
    const {
      transaction: txBase64,
      senderPublicKey: senderPubKeyStr,
      recipientIdentityHash,
      recipientPhone: rawRecipientPhone,
      amountUSD,
      tokenSymbol,
      note,
    } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────

    if (!txBase64 || typeof txBase64 !== "string")
      return res
        .status(400)
        .json({ error: "transaction (base64) is required." });

    if (!senderPubKeyStr || typeof senderPubKeyStr !== "string")
      return res.status(400).json({ error: "senderPublicKey is required." });

    if (!recipientIdentityHash || !/^[0-9a-f]{32}$/.test(recipientIdentityHash))
      return res.status(400).json({
        error: "recipientIdentityHash must be 32 lowercase hex chars.",
      });

    if (!rawRecipientPhone || typeof rawRecipientPhone !== "string")
      return res
        .status(400)
        .json({ error: "recipientPhone (E.164) is required." });

    if (!amountUSD || typeof amountUSD !== "number" || amountUSD < 0.01)
      return res.status(400).json({ error: "amountUSD must be ≥ 0.01." });

    if (!ACCEPTED_PAYMENT_TOKENS.has(tokenSymbol))
      return res.status(400).json({
        error: `tokenSymbol must be one of: ${[...ACCEPTED_PAYMENT_TOKENS].join(", ")}.`,
      });

    // ── Phone / identity hash cross-validation ────────────────────────────────

    if (!phoneMatchesHash(rawRecipientPhone.trim(), recipientIdentityHash))
      return res.status(400).json({
        error:
          "recipientPhone does not match recipientIdentityHash. Resolve via /v1/identity/resolve first.",
      });
    const recipientPhone = rawRecipientPhone.trim();

    // ── Sender key ────────────────────────────────────────────────────────────

    let senderPublicKey;
    try {
      senderPublicKey = new PublicKey(senderPubKeyStr);
    } catch {
      return res
        .status(400)
        .json({ error: "senderPublicKey is not a valid Solana public key." });
    }

    // ── Session integrity ─────────────────────────────────────────────────────

    const senderRecord = await getIdentityByUID(req.firebaseUid);
    if (senderRecord && senderRecord.wallet_address !== senderPubKeyStr)
      return res.status(403).json({
        error: "senderPublicKey does not match your registered wallet.",
      });

    // ── Self-payment guard ────────────────────────────────────────────────────

    const senderUser = await adminAuth().getUser(req.firebaseUid);
    if (senderUser.phoneNumber) {
      const senderHash = deriveIdentityHash(senderUser.phoneNumber);
      if (senderHash === recipientIdentityHash)
        return res
          .status(400)
          .json({ error: "You cannot send funds to yourself." });
    }

    // ── Deserialize transaction ───────────────────────────────────────────────

    let tx;
    try {
      tx = Transaction.from(Buffer.from(txBase64, "base64"));
    } catch {
      return res
        .status(400)
        .json({ error: "transaction could not be deserialized." });
    }

    if (!tx.recentBlockhash)
      return res
        .status(400)
        .json({ error: "transaction is missing recentBlockhash." });

    if (!tx.feePayer || tx.feePayer.toBase58() !== feePayerPublicKey)
      return res.status(400).json({
        error: `transaction.feePayer must be the Zela fee payer (${feePayerPublicKey}).`,
      });

    if (tx.instructions.length === 0)
      return res
        .status(400)
        .json({ error: "transaction contains no instructions." });

    if (tx.instructions.length > MAX_INSTRUCTIONS)
      return res
        .status(400)
        .json({ error: `Too many instructions (max ${MAX_INSTRUCTIONS}).` });

    for (const ix of tx.instructions) {
      if (!ALLOWED_PROGRAMS.has(ix.programId.toBase58()))
        return res
          .status(400)
          .json({ error: `Disallowed program: ${ix.programId.toBase58()}.` });
    }

    // ── Extract + validate transfers ──────────────────────────────────────────

    const transfers = tx.instructions.map(extractTransferInfo).filter(Boolean);
    if (transfers.length === 0)
      return res.status(400).json({
        error: `transaction must contain ${isNativeToken(tokenSymbol) ? "SOL" : "SPL token"} Transfer instructions.`,
      });

    // Resolve expected destinations — ATA for SPL, plain address for SOL
    const relayPubkey = new PublicKey(relayPublicKey);
    const expectedRelayDest = await getExpectedDestination(
      relayPubkey,
      tokenSymbol,
    );
    const expectedFeeDest = await getExpectedDestination(
      FEE_WALLET_PK,
      tokenSymbol,
    );

    const relayTransfer = transfers.find(
      (t) => t.destination.toBase58() === expectedRelayDest,
    );
    const feeTransfer = transfers.find(
      (t) => t.destination.toBase58() === expectedFeeDest,
    );

    if (!relayTransfer)
      return res.status(400).json({
        error: `Transaction must include a ${tokenSymbol} transfer to relay ${isNativeToken(tokenSymbol) ? "wallet" : "ATA"} (${expectedRelayDest}).`,
      });

    if (!feeTransfer)
      return res.status(400).json({
        error: `Transaction must include a 1% ${tokenSymbol} fee transfer to fee ${isNativeToken(tokenSymbol) ? "wallet" : "ATA"} (${expectedFeeDest}).`,
      });

    // ── Validate 1% fee ───────────────────────────────────────────────────────

    const relayRaw = relayTransfer.amount;
    const feeRaw = feeTransfer.amount;
    const totalRaw = relayRaw + feeRaw;
    const expectedFee = (totalRaw * 100n) / 10_100n;
    const feeDelta =
      feeRaw > expectedFee ? feeRaw - expectedFee : expectedFee - feeRaw;

    if (feeDelta > FEE_TOLERANCE_RAW)
      return res.status(400).json({
        error: `Fee incorrect. Expected ~${expectedFee} raw units (1% of ${totalRaw}), got ${feeRaw}.`,
      });

    // ── Sender signature ──────────────────────────────────────────────────────

    const senderSig = tx.signatures.find(
      (s) => s.publicKey.toBase58() === senderPubKeyStr,
    );
    if (!senderSig?.signature)
      return res.status(400).json({ error: "Sender signature is missing." });

    if (!tx.verifySignatures(false))
      return res
        .status(400)
        .json({ error: "Sender signature verification failed." });

    // ── Co-sign + broadcast ───────────────────────────────────────────────────

    const { lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.partialSign(feePayer);

    let signature;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    } catch (broadcastErr) {
      return res
        .status(502)
        .json({ error: `Broadcast failed: ${broadcastErr.message}` });
    }

    // ── Confirm ───────────────────────────────────────────────────────────────

    try {
      await pollForConfirmation(signature, lastValidBlockHeight);
    } catch (confirmErr) {
      console.warn(
        `[privatePay] Confirmation issue for ${signature}:`,
        confirmErr.message,
      );
      return res.status(504).json({ error: confirmErr.message, signature });
    }

    console.log(
      `[privatePay] ✓ Deposit confirmed. uid=${req.firebaseUid} token=${tokenSymbol} relay=${relayRaw} fee=${feeRaw} sig=${signature}`,
    );

    // ── Resolve recipient ─────────────────────────────────────────────────────

    const recipientRecord = await getIdentityByHash(recipientIdentityHash);
    const isRegistered = !!recipientRecord;
    const senderIdentityHash = senderUser.phoneNumber
      ? deriveIdentityHash(senderUser.phoneNumber)
      : `uid:${req.firebaseUid}`;
    const feeUSD = parseFloat(
      ((amountUSD * PRIVATE_PAY_FEE_BPS) / 10_000).toFixed(6),
    );

    // ── Persist payment record ────────────────────────────────────────────────

    const paymentId = await insertPrivatePayment({
      senderUID: req.firebaseUid,
      senderIdentityHash,
      senderPublicKey: senderPubKeyStr,
      recipientIdentityHash,
      recipientPhoneE164: recipientPhone,
      amountUSD,
      feeUSD,
      tokenSymbol,
      relayAmountRaw: relayRaw,
      depositSignature: signature,
      note: note ?? null,
    });

    // ── Trigger async Umbra routing ───────────────────────────────────────────

    setImmediate(() =>
      routePaymentAsync({
        paymentId,
        recipientIdentityHash,
        isRegistered,
        registeredWallet: recipientRecord?.wallet_address ?? null,
        relayAmountRaw: relayRaw, // bigint — never convert to string/Number
        tokenSymbol,
        recipientPhone,
        amountUSD,
      }).catch((err) =>
        console.error(
          `[privatePay] routePaymentAsync error ${paymentId}:`,
          err.message,
        ),
      ),
    );

    return res.status(200).json({
      signature,
      paymentId,
      amountUSD,
      feeUSD,
      recipientRegistered: isRegistered,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/pay/pending ──────────────────────────────────────────────────────

router.get("/pending", readLimiter, async (req, res, next) => {
  try {
    const user = await adminAuth().getUser(req.firebaseUid);
    if (!user.phoneNumber) return res.json({ payments: [] });

    const identityHash = deriveIdentityHash(user.phoneNumber);
    const rows = await getPendingPaymentsForIdentity(identityHash);

    return res.json({
      payments: rows.map(
        ({ id, amount_usd, token_symbol, status, created_at }) => ({
          id,
          amountUSD: parseFloat(amount_usd),
          tokenSymbol: token_symbol,
          status,
          createdAt: created_at,
        }),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/pay/claim ───────────────────────────────────────────────────────

router.post("/claim", claimLimiter, async (req, res, next) => {
  try {
    const user = await adminAuth().getUser(req.firebaseUid);

    if (!user.phoneNumber)
      return res.status(422).json({
        error: "Account must have a verified phone number to claim payments.",
      });

    const identityHash = deriveIdentityHash(user.phoneNumber);

    const identityRecord = await getIdentityByUID(req.firebaseUid);
    if (!identityRecord?.wallet_address)
      return res.status(422).json({
        error:
          "Complete wallet setup first. Call POST /v1/identity/register with your wallet address.",
      });

    const registeredWallet = identityRecord.wallet_address;
    const pending = await getPendingPaymentsForIdentity(identityHash);

    if (pending.length === 0)
      return res.json({ claimed: [], message: "No pending payments found." });

    const byToken = {};
    for (const p of pending) (byToken[p.token_symbol] ??= []).push(p);

    const claimed = [];
    const errors = [];

    for (const [tokenSymbol, payments] of Object.entries(byToken)) {
      try {
        const claimResults = await claimUTXOsForIdentity({
          identityHash,
          registeredWalletAddress: registeredWallet,
          tokenSymbol,
        });

        for (let i = 0; i < payments.length; i++) {
          const payment = payments[i];
          const result = claimResults[i] ?? null;
          const claimSig =
            result?.withdrawSignature ?? result?.signature ?? "sweep-claimed";
          await markPaymentClaimed(payment.id, claimSig);
          claimed.push({
            paymentId: payment.id,
            signature: claimSig,
            amountUSD: parseFloat(payment.amount_usd),
            tokenSymbol,
          });
        }
      } catch (err) {
        console.error(
          `[privatePay/claim] ${tokenSymbol} claim failed:`,
          err.message,
        );
        errors.push({ tokenSymbol, error: err.message });
      }
    }

    const response = { claimed };
    if (errors.length > 0) response.partialErrors = errors;
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/pay/history ──────────────────────────────────────────────────────

router.get("/history", readLimiter, async (req, res, next) => {
  try {
    const user = await adminAuth().getUser(req.firebaseUid);
    if (!user.phoneNumber) return res.json({ payments: [] });

    const identityHash = deriveIdentityHash(user.phoneNumber);
    const direction = ["sent", "received", "all"].includes(req.query.direction)
      ? req.query.direction
      : "all";
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const rows = await getPaymentHistory({
      identityHash,
      direction,
      limit,
      offset,
    });

    return res.json({
      payments: rows.map((r) => ({
        id: r.id,
        direction:
          r.sender_identity_hash === identityHash ? "sent" : "received",
        amountUSD: parseFloat(r.amount_usd),
        feeUSD: parseFloat(r.fee_usd),
        tokenSymbol: r.token_symbol,
        depositSignature: r.deposit_signature,
        claimSignature: r.claim_signature ?? null,
        status: r.status,
        createdAt: r.created_at,
        claimedAt: r.claimed_at ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export { router as privatePayRouter };
