/**
 * src/models/GiftCardRedeemCode.js
 *
 * Stores encrypted gift card redeem codes in MongoDB.
 *
 * WHY ENCRYPTED?
 *   A redeem code is cash-equivalent. If this collection were breached,
 *   plaintext codes would be immediately spendable by an attacker.
 *   AES-256-GCM gives authenticated encryption — tampering is detectable.
 *
 * ENCRYPTION KEY:
 *   Set GIFTCARD_ENCRYPTION_KEY in your env as a 64-char hex string
 *   (32 bytes). Generate with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * WHY MONGODB (not Postgres)?
 *   - Variable-length encrypted blobs don't play well with Postgres TEXT/BYTEA
 *     and we'd need to add a whole column just for gift cards
 *   - Mongo's TTL index lets us auto-expire codes after the product's
 *     validity window without a cron job
 *   - Join between orderId (UUID string) and orders table is trivial
 *
 * ACCESS CONTROL:
 *   Only expose a code after verifying req.firebaseUid === code.firebaseUid.
 *   Never log the plaintext code anywhere.
 */

import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

const redeemCodeSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true }, // Postgres UUID
    firebaseUid: { type: String, required: true, index: true },
    productId: { type: Number, required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, default: 1 },

    // AES-256-GCM encrypted fields
    // Each code entry: { iv, authTag, ciphertext } — all hex strings
    codes: [
      {
        iv: { type: String, required: true },
        authTag: { type: String, required: true },
        ciphertext: { type: String, required: true },
        _id: false,
      },
    ],

    // Raw Reloadly transactionId for support lookups (not the code itself)
    reloadlyTransactionId: { type: Number },

    // Auto-expire after product validity (default 1 year)
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  },
  {
    collection: "giftcard_redeem_codes",
    timestamps: true,
  },
);

// TTL index — Mongo removes expired codes automatically
redeemCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GiftCardRedeemCode =
  models.GiftCardRedeemCode ?? model("GiftCardRedeemCode", redeemCodeSchema);
