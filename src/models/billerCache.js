/**
 * src/models/BillerCache.js
 *
 * MongoDB cache for Reloadly utility billers.
 *
 * Why a separate model from OperatorCache?
 *   - Billers have a completely different schema (no phone detection, no bundles)
 *   - Billers change less frequently than operators — 6h TTL is appropriate
 *   - We query by countryCode + type often, so separate indexes make sense
 *
 * Refresh strategy: a biller lookup always checks here first.
 * Cache is populated on first miss and auto-expired by Mongo TTL index.
 */

import mongoose from "mongoose";

const { Schema, model, models } = mongoose;

const billerCacheSchema = new Schema(
  {
    reloadlyId: { type: Number, required: true },
    countryCode: { type: String, required: true, uppercase: true },
    billerType: { type: String, required: true }, // ELECTRICITY_BILL_PAYMENT etc.
    serviceType: { type: String }, // PREPAID | POSTPAID
    data: { type: Schema.Types.Mixed, required: true },
    cachedAt: { type: Date, default: Date.now },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 6 * 60 * 60 * 1000),
    },
  },
  { collection: "biller_cache" },
);

billerCacheSchema.index({ reloadlyId: 1 }, { unique: true });
billerCacheSchema.index({ countryCode: 1, billerType: 1 });
billerCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BillerCache =
  models.BillerCache ?? model("BillerCache", billerCacheSchema);
