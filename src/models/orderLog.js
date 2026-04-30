/**
 * src/models/OrderLog.js
 *
 * MongoDB model for verbose, append-only order audit logs.
 *
 * Why MongoDB for this?
 *   - Each event has a different shape (Reloadly responses vary by service)
 *   - Append-only log pattern is a natural fit for document storage
 *   - Keeps Postgres lean — no JSONB blobs clogging the relational side
 *   - Easy to query by orderId, uid, or date range for support/debugging
 */

import mongoose from "mongoose";

const { Schema, model, models } = mongoose;

const eventSchema = new Schema(
  {
    event: { type: String, required: true }, // e.g. "ORDER_CREATED", "CRYPTO_CONFIRMED"
    data: { type: Schema.Types.Mixed }, // any shape
    actor: { type: String }, // "system" | "user" | "webhook"
    ts: { type: Date, default: Date.now },
  },
  { _id: false },
);

const orderLogSchema = new Schema(
  {
    orderId: { type: String, required: true, index: true }, // Postgres UUID
    firebaseUid: { type: String, required: true, index: true },
    type: { type: String, required: true },
    events: { type: [eventSchema], default: [] },
  },
  {
    collection: "order_logs",
    timestamps: true,
  },
);

export const OrderLog = models.OrderLog ?? model("OrderLog", orderLogSchema);
