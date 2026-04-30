import "dotenv/config";

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import compression from "compression";
import os from "os";
import { spawn } from "child_process";

// ─── DB ───────────────────────────────────────────────────────────────────────
import { verifyPostgres } from "./db/postgres.js";
import { connectMongo } from "./db/mongo.js";

// ─── Services ─────────────────────────────────────────────────────────────────
import { warmReloadlyTokens } from "./services/reloadlyAuth.js";
import { feePayerPublicKey } from "./feePayer.js";
import { relayPublicKey } from "./relayWallet.js";
import { registerRelayWallet } from "./services/umbraService.js";

// ─── Middleware ────────────────────────────────────────────────────────────────
import { requireFirebaseAuth } from "./middleware/firebaseAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { attachGeo } from "./middleware/attachGeo.js";
import { geoRestrict } from "./middleware/geoRestriction.js";

// ─── Routes ───────────────────────────────────────────────────────────────────
import { sponsorTransaction } from "./routes/sponsor.js";
import {
  getSwapQuote,
  buildSwapTransaction,
  submitSwapTransaction,
} from "./routes/swap.js";
import { airtimeRouter, dataRouter } from "./routes/airtime.js";
import { utilitiesRouter } from "./routes/utilities.js";
import { giftcardsRouter } from "./routes/giftcards.js";
import { healthRouter } from "./routes/health.js";
import { adminRouter } from "./routes/admin.js";
import { identityRouter } from "./routes/identity.js";
import { privatePayRouter } from "./routes/privatePay.js";

// ─── Token catalog ────────────────────────────────────────────────────────────
import {
  STABLECOINS,
  ECOSYSTEM_TOKENS,
  XSTOCK_TOKENS,
} from "./config/tokens.js";

// ─── Jobs ─────────────────────────────────────────────────────────────────────
import { startJobs, stopJobs } from "./jobs/runner.js";
import { runRoutePrivatePaymentsJob } from "./jobs/routePrivatePayment.js";

// ─── Structured logger ────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "server",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "server",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "server",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Validate environment on startup ──────────────────────────────────────────

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID",
  "ALCHEMY_RPC_URL",
  "RELOADLY_CLIENT_ID",
  "RELOADLY_CLIENT_SECRET",
  "DATABASE_URL",
  "MONGODB_URI",
  "GIFTCARD_ENCRYPTION_KEY",
  "IDENTITY_HMAC_SECRET",
  "UTXO_DERIVATION_SECRET",
  "PHONE_ENCRYPTION_KEY",
  "FEE_WALLET_PUBLIC_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "UMBRA_NETWORK",
  "SOLANA_WS_URL",
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  // Log all missing vars at once rather than failing on the first one
  for (const key of missingEnv) {
    log.error("Missing required environment variable", { key });
  }
  process.exit(1);
}

// In production, CORS_ORIGINS must be explicitly set.
// Defaulting to `origin: true` (reflect all origins) in production is a
// security misconfiguration — it bypasses CORS entirely.
if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
  log.error(
    "CORS_ORIGINS must be set in production (e.g. https://app.zela.io)",
  );
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) return alias.address;
    }
  }
  return "127.0.0.1";
}

/**
 * Redacts the API key from an RPC URL before logging.
 * e.g. https://eth-mainnet.g.alchemy.com/v2/abc123 → https://eth-mainnet.g.alchemy.com/v2/[redacted]
 */
function redactRpcUrl(url = "") {
  try {
    const parsed = new URL(url);
    // API key is typically the last path segment
    const parts = parsed.pathname.split("/");
    parts[parts.length - 1] = "[redacted]";
    parsed.pathname = parts.join("/");
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}

async function runMigrationsOnStartup() {
  return new Promise((resolve, reject) => {
    log.info("Running database migrations...");
    const child = spawn(process.execPath, ["src/db/migrate.js", "--migrate"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => {
      if (code === 0) {
        log.info("Migrations complete");
        resolve();
      } else {
        reject(new Error(`Migration process exited with code ${code}`));
      }
    });
  });
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

app.use(helmet());
app.set("trust proxy", 1);

// Gzip / brotli compression for all JSON responses
app.use(compression());

// ─── CORS ─────────────────────────────────────────────────────────────────────

// Falls back to open in development only — never in production (guarded above).
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : true;

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ─── Health — FIRST, no auth / geo / rate-limit ───────────────────────────────
app.use("/health", healthRouter);

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Zela backend is running." });
});

// ─── Public token catalog ─────────────────────────────────────────────────────
app.get("/v1/tokens", (_req, res) => {
  res.json({
    stablecoins: Object.entries(STABLECOINS).map(([symbol, t]) => ({
      symbol,
      ...t,
    })),
    ecosystemTokens: Object.entries(ECOSYSTEM_TOKENS).map(([symbol, t]) => ({
      symbol,
      ...t,
    })),
    xstockTokens: Object.entries(XSTOCK_TOKENS).map(([symbol, t]) => ({
      symbol,
      ...t,
    })),
  });
});

// ─── Body parser ──────────────────────────────────────────────────────────────
// Placed AFTER the unauthenticated routes above so they never parse a body.
// Placed BEFORE rate limiters so the 10 kb limit rejects oversized payloads
// before they reach rate-limit accounting.
app.use(express.json({ limit: "10kb" }));

// ─── Geo — attach country to every request silently ───────────────────────────
app.use(attachGeo);

// ─── Rate limiters ────────────────────────────────────────────────────────────

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

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quote rate limit exceeded. Try again in a minute." },
});

const swapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Swap rate limit exceeded. Try again in a minute." },
});

// ─── Global geo enforcement — OFAC hard-block before any auth ─────────────────
app.use(geoRestrict());

// ─── Sponsor + Swap ───────────────────────────────────────────────────────────
app.post(
  "/v1/sponsor",
  requireFirebaseAuth,
  sponsorLimiter,
  sponsorTransaction,
);
app.get("/v1/swap/quote", requireFirebaseAuth, quoteLimiter, getSwapQuote);
app.post(
  "/v1/swap/build",
  requireFirebaseAuth,
  swapLimiter,
  buildSwapTransaction,
);
app.post(
  "/v1/swap/submit",
  requireFirebaseAuth,
  swapLimiter,
  submitSwapTransaction,
);

// ─── Identity + Private Pay ───────────────────────────────────────────────────
app.use("/v1/identity", requireFirebaseAuth, identityRouter);
app.use("/v1/pay", requireFirebaseAuth, privatePayRouter);

// ─── Reloadly routes ──────────────────────────────────────────────────────────
app.use(
  "/v1/airtime",
  requireFirebaseAuth,
  geoRestrict({ service: "airtime" }),
  airtimeRouter,
);
app.use(
  "/v1/data",
  requireFirebaseAuth,
  geoRestrict({ service: "data" }),
  dataRouter,
);
app.use(
  "/v1/utilities",
  requireFirebaseAuth,
  geoRestrict({ service: "utilities" }),
  utilitiesRouter,
);
app.use(
  "/v1/giftcards",
  requireFirebaseAuth,
  geoRestrict({ service: "giftcards" }),
  giftcardsRouter,
);

// ─── Admin ────────────────────────────────────────────────────────────────────
app.use("/v1/admin", requireFirebaseAuth, adminRouter);

// ─── Fallbacks ────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

// Track resources that need explicit cleanup on shutdown.
// server and privatePayInterval are assigned after startup completes.
let server;
let privatePayInterval;

async function shutdown(signal) {
  log.info("Shutdown signal received", { signal });

  // 1. Stop accepting new connections; wait for in-flight requests to drain.
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    log.info("HTTP server closed");
  }

  // 2. Stop the background job timer so the job doesn't fire mid-shutdown.
  if (privatePayInterval) {
    clearInterval(privatePayInterval);
  }

  // 3. Stop all other scheduled jobs.
  await stopJobs();

  // DB pools are closed by their own SIGTERM handlers (postgres.js / mongo.js).
  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
const LOCAL_IP = getLocalIP();

async function start() {
  try {
    // ── Initialize everything BEFORE accepting traffic ──────────────────────
    // Calling app.listen() first and initialising inside its callback means
    // the server is live and accepting requests while migrations are still
    // running and DB connections are not yet established.
    await runMigrationsOnStartup();
    await verifyPostgres();
    await connectMongo();
    await warmReloadlyTokens();

    await registerRelayWallet().catch((err) =>
      log.warn("Umbra relay registration warning", { error: err.message }),
    );

    startJobs();

    // Store the interval handle so shutdown() can clear it cleanly.
    const PRIVATE_PAY_JOB_INTERVAL_MS = 2 * 60 * 1000;
    privatePayInterval = setInterval(
      runRoutePrivatePaymentsJob,
      PRIVATE_PAY_JOB_INTERVAL_MS,
    );

    // Run immediately on startup to catch anything missed during downtime.
    runRoutePrivatePaymentsJob().catch((err) =>
      log.warn("Initial private pay job run failed", { error: err.message }),
    );

    // ── Only now open the port ───────────────────────────────────────────────
    server = app.listen(PORT, "0.0.0.0", () => {
      log.info("Server ready", {
        port: PORT,
        env: process.env.NODE_ENV ?? "development",
        feePayerPublicKey,
        relayPublicKey,
        umbraNetwork: process.env.UMBRA_NETWORK,
        rpcUrl: redactRpcUrl(process.env.ALCHEMY_RPC_URL),
      });

      // Human-readable startup summary for local dev
      if (process.env.NODE_ENV !== "production") {
        console.log(`\n  ➜  Local   : http://localhost:${PORT}`);
        console.log(`  ➜  Network : http://${LOCAL_IP}:${PORT}\n`);

        const routes = [
          [
            "Core",
            [
              "GET  /health",
              "GET  /health/deep",
              "GET  /v1/tokens",
              "POST /v1/sponsor",
              "GET  /v1/swap/quote",
              "POST /v1/swap/build",
              "POST /v1/swap/submit",
            ],
          ],
          [
            "Identity + Pay",
            [
              "GET  /v1/identity/me",
              "POST /v1/identity/resolve",
              "POST /v1/identity/register",
              "POST /v1/pay/private",
              "GET  /v1/pay/pending",
              "POST /v1/pay/claim",
              "GET  /v1/pay/history",
            ],
          ],
          [
            "Airtime + Data",
            [
              "GET  /v1/airtime/operators",
              "POST /v1/airtime/topup",
              "POST /v1/data/topup",
            ],
          ],
          [
            "Utilities",
            ["GET  /v1/utilities/billers", "POST /v1/utilities/pay"],
          ],
          [
            "Gift Cards",
            ["GET  /v1/giftcards/products", "POST /v1/giftcards/order"],
          ],
          ["Admin", ["GET  /v1/admin/jobs", "GET  /v1/admin/orders/stats"]],
          [
            "Jobs",
            [
              "pollUtilityOrders → 2 min",
              "retryGiftCardCodes → 5 min",
              "cleanupStaleOrders → 1 hr",
              "refreshCaches → daily 03:00 UTC",
              "routePrivatePayments → 2 min",
            ],
          ],
        ];

        for (const [section, items] of routes) {
          console.log(`  ${section}:`);
          for (const item of items) console.log(`    ${item}`);
          console.log();
        }
      }
    });
  } catch (err) {
    log.error("Fatal startup error", { error: err.message });
    process.exit(1);
  }
}

start();
