/**
 * src/schemas/airtime.js
 * Zod schemas for all airtime and data routes.
 */

import { z } from "zod";
import {
  cryptoPaymentFields,
  countryCode,
  phoneNumber,
  positiveInt,
  positiveAmount,
  customIdentifier,
  paginationQuery,
} from "./common.js";

// ─── Query schemas ─────────────────────────────────────────────────────────────

export const listOperatorsQuery = z.object({
  countryCode,
  page: z.number({ coerce: true }).int().min(1).default(1),
  size: z.number({ coerce: true }).int().min(1).max(200).default(50),
});

export const detectOperatorQuery = z.object({
  phone: phoneNumber,
  countryCode,
  airtimeOnly: z.enum(["true", "false"]).optional().default("false"),
});

export const operatorIdParams = z.object({
  id: positiveInt,
});

export const bundlesParams = z.object({
  operatorId: positiveInt,
});

export const orderIdParams = z.object({
  orderId: z.string().uuid("orderId must be a valid UUID"),
});

export const orderHistoryQuery = paginationQuery.extend({
  type: z.enum(["AIRTIME", "DATA"]).optional(),
});

// ─── Body schemas ──────────────────────────────────────────────────────────────

export const airtimeTopupBody = cryptoPaymentFields.extend({
  operatorId: positiveInt,
  phone: phoneNumber,
  countryCode,
  amount: positiveAmount,
  useLocalAmount: z.boolean({ coerce: true }).default(false),
  customIdentifier,
});

export const dataTopupBody = airtimeTopupBody.extend({
  dataBundle: z.string().min(1, "dataBundle is required for DATA orders"),
});
