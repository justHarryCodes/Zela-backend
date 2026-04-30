/**
 * src/schemas/utilities.js
 * Zod schemas for all utility bill payment routes.
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

export const VALID_BILL_TYPES = [
  "ELECTRICITY_BILL_PAYMENT",
  "WATER_BILL_PAYMENT",
  "TV_BILL_PAYMENT",
  "INTERNET_BILL_PAYMENT",
  "INTERNET_BROADBAND_BILL_PAYMENT",
  "GAS_BILL_PAYMENT",
  "TOLL_BILL_PAYMENT",
];

// ─── Query schemas ─────────────────────────────────────────────────────────────

export const listBillersQuery = z.object({
  countryCode,
  type: z.enum(VALID_BILL_TYPES).optional(),
  serviceType: z.enum(["PREPAID", "POSTPAID"]).optional(),
  page: z.number({ coerce: true }).int().min(1).default(1),
  size: z.number({ coerce: true }).int().min(1).max(200).default(50),
});

export const billerIdParams = z.object({
  id: positiveInt,
});

export const orderIdParams = z.object({
  orderId: z.string().uuid("orderId must be a valid UUID"),
});

export const orderHistoryQuery = paginationQuery;

// ─── Body schemas ──────────────────────────────────────────────────────────────

export const billPayBody = cryptoPaymentFields.extend({
  billerId: positiveInt,
  subscriberAccountNumber: z
    .string()
    .trim()
    .min(1, "subscriberAccountNumber must not be empty")
    .max(50, "subscriberAccountNumber is too long"),
  amount: positiveAmount,
  useLocalAmount: z.boolean({ coerce: true }).default(false),
  customIdentifier,
});
