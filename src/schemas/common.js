/**
 * src/schemas/common.js
 *
 * Reusable Zod primitives shared across all route schemas.
 * Define once, import everywhere — no duplication.
 */

import { z } from "zod";

// ─── Base types ───────────────────────────────────────────────────────────────

/** Solana base58 transaction signature — 44–88 chars, base58 alphabet */
export const solanaSig = z
  .string()
  .regex(
    /^[1-9A-HJ-NP-Za-km-z]{44,88}$/,
    "Invalid Solana transaction signature",
  );

/** Accepted payment token */
export const cryptoToken = z.enum(["USDC", "USDT"], {
  errorMap: () => ({ message: "cryptoToken must be USDC or USDT" }),
});

/** Positive decimal amount (stored as number, validated > 0) */
export const positiveAmount = z
  .number({ coerce: true })
  .positive("Amount must be greater than 0")
  .finite();

/** USD amount — positive, max 4 decimal places */
export const usdAmount = positiveAmount.multipleOf(
  0.0001,
  "amountUsd may have at most 4 decimal places",
);

/** ISO-2 country code */
export const countryCode = z
  .string()
  .length(2, "countryCode must be a 2-letter ISO code")
  .toUpperCase();

/** E.164-ish phone number — 7 to 15 digits, optional leading + */
export const phoneNumber = z
  .string()
  .regex(/^\+?[0-9]{7,15}$/, "Invalid phone number — must be 7–15 digits");

/** Positive integer ID */
export const positiveInt = z.number({ coerce: true }).int().positive();

/** Optional idempotency key — max 64 chars */
export const customIdentifier = z
  .string()
  .max(64, "customIdentifier must be 64 chars or fewer")
  .optional();

/** Pagination query params */
export const paginationQuery = z.object({
  limit: z.number({ coerce: true }).int().min(1).max(100).default(20),
  offset: z.number({ coerce: true }).int().min(0).default(0),
});

/** Common crypto payment fields — reused in all three services */
export const cryptoPaymentFields = z.object({
  cryptoTxSig: solanaSig,
  cryptoAmount: positiveAmount,
  cryptoToken,
  amountUsd: usdAmount,
});
