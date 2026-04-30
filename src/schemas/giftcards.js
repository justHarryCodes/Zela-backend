/**
 * src/schemas/giftcards.js
 * Zod schemas for all gift card routes.
 */

import { z } from "zod";
import {
  cryptoPaymentFields,
  countryCode,
  positiveInt,
  positiveAmount,
  customIdentifier,
  paginationQuery,
} from "./common.js";

// ─── Query schemas ─────────────────────────────────────────────────────────────

export const listProductsQuery = z.object({
  countryCode: countryCode.optional(),
  productName: z.string().max(100).optional(),
  includeRange: z.enum(["true", "false"]).default("true"),
  includeFixed: z.enum(["true", "false"]).default("true"),
  page: z.number({ coerce: true }).int().min(1).default(1),
  size: z.number({ coerce: true }).int().min(1).max(200).default(50),
});

export const productIdParams = z.object({
  productId: positiveInt,
});

export const orderIdParams = z.object({
  orderId: z.string().uuid("orderId must be a valid UUID"),
});

export const orderHistoryQuery = paginationQuery;

// ─── Recipient phone sub-schema ────────────────────────────────────────────────

const recipientPhone = z
  .object({
    countryCode: z.string().length(2).toUpperCase(),
    phoneNumber: z.string().regex(/^\+?[0-9]{7,15}$/),
  })
  .strict();

// ─── Body schemas ──────────────────────────────────────────────────────────────

export const giftCardOrderBody = cryptoPaymentFields.extend({
  productId: positiveInt,
  countryCode,
  quantity: z
    .number({ coerce: true })
    .int()
    .min(1, "quantity must be at least 1")
    .max(10, "quantity cannot exceed 10")
    .default(1),
  unitPrice: positiveAmount,
  senderName: z.string().trim().min(1).max(100),
  recipientEmail: z
    .string()
    .email("recipientEmail must be a valid email address")
    .toLowerCase(),
  recipientPhone: recipientPhone.optional(),
  customIdentifier,
});
