/**
 * src/models/GiftCardProductCache.js
 *
 * MongoDB cache for Reloadly gift card products.
 *
 * Products change slowly (daily at most) so we use a 12-hour TTL.
 * The most important fields for the purchase flow are:
 *   denominationType           — "FIXED" | "RANGE"
 *   fixedRecipientDenominations — array of valid amounts (FIXED only)
 *   minRecipientDenomination   — lower bound (RANGE only)
 *   maxRecipientDenomination   — upper bound (RANGE only)
 *   discountPercentage         — applied to senderFee at checkout
 *
 * We cache the full raw Reloadly object in `data` so we never need to
 * hit their API again for display purposes.
 */

import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

const giftCardProductSchema = new Schema(
  {
    productId: { type: Number, required: true },
    productName: { type: String, required: true },
    countryCode: { type: String, required: true, uppercase: true },
    brandId: { type: Number },
    brandName: { type: String },
    denominationType: { type: String, enum: ["FIXED", "RANGE"] },
    global: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, required: true },
    cachedAt: { type: Date, default: Date.now },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  },
  { collection: "giftcard_product_cache" },
);

giftCardProductSchema.index({ productId: 1 }, { unique: true });
giftCardProductSchema.index({ countryCode: 1 });
giftCardProductSchema.index({ brandName: "text", productName: "text" });
giftCardProductSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GiftCardProductCache =
  models.GiftCardProductCache ??
  model("GiftCardProductCache", giftCardProductSchema);
