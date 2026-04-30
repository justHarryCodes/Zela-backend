/**
 * src/models/OperatorCache.js
 *
 * Caches Reloadly operator & biller data in MongoDB so we don't hammer
 * their API on every lookup. TTL index auto-expires stale entries.
 *
 * Refresh strategy: background job (Step 7) re-fetches and upserts.
 * The route layer calls getOperator() which checks here first.
 */

import mongoose from "mongoose";

const { Schema, model, models } = mongoose;

const operatorCacheSchema = new Schema(
  {
    // "airtime" | "data" | "utilities" | "giftcards"
    service: { type: String, required: true },
    reloadlyId: { type: Number, required: true },
    countryCode: { type: String, required: true, uppercase: true },
    data: { type: Schema.Types.Mixed, required: true }, // raw Reloadly object
    cachedAt: { type: Date, default: Date.now },
    // TTL — Mongo will delete documents 24h after cachedAt
    expiresAt: { type: Date, default: () => new Date(Date.now() + 86_400_000) },
  },
  { collection: "operator_cache" },
);

// Compound unique: one entry per service+id combination
operatorCacheSchema.index({ service: 1, reloadlyId: 1 }, { unique: true });
operatorCacheSchema.index({ service: 1, countryCode: 1 });
// TTL index — Mongo removes expired docs automatically
operatorCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OperatorCache =
  models.OperatorCache ?? model("OperatorCache", operatorCacheSchema);
