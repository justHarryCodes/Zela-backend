// src/index.js

import "dotenv/config";

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors"; // ← ADD
import os from "os"; // ← ADD

import { sponsorTransaction } from "./routes/sponsor.js";
import { feePayerPublicKey } from "./feePayer.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requireFirebaseAuth } from "./middleware/firebaseAuth.js";

// ─── Validate environment on startup ──────────────────────────────────────────

const REQUIRED_ENV = [
  "FEE_PAYER_SECRET_KEY",
  "FIREBASE_PROJECT_ID",
  "ALCHEMY_RPC_URL",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── Resolve local IP ─────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) return alias.address;
    }
  }
  return "127.0.0.1";
}

// ─── App ───────────────────────────────────────────────────────────────────────

const app = express();

// Security headers
app.use(helmet());

app.set("trust proxy", 1);

// ─── CORS ──────────────────────────────────────────────────────────────────────
// Allows your local frontend (any port) to call this backend.
// In production, replace the origin with your deployed frontend URL.

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",") // e.g. "https://app.zela.com"
  : true; // allow all origins in dev

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10kb" }));

// ─── Rate limiting ─────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
app.use(globalLimiter);

const sponsorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Sponsor rate limit exceeded. Try again in a minute." },
});

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    feePayer: feePayerPublicKey,
    timestamp: new Date().toISOString(),
  });
});
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Zela sponsor service is running." });
});

app.post(
  "/v1/sponsor",
  requireFirebaseAuth,
  sponsorLimiter,
  sponsorTransaction,
);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
const LOCAL_IP = getLocalIP(); // ← ADD

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Fee payer : ${feePayerPublicKey}`);
  console.log(`[server] RPC       : ${process.env.ALCHEMY_RPC_URL}`);
  console.log(`\n  ➜  Local   : http://localhost:${PORT}`);
  console.log(`  ➜  Network : http://${LOCAL_IP}:${PORT}\n`);
});
