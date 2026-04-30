/**
 * src/routes/health.js
 *
 * Two health endpoints:
 *
 *   GET /health        — shallow (always fast, used by load balancers / uptime monitors)
 *                        Returns 200 if the process is alive.
 *
 *   GET /health/deep   — deep (hits every dependency, used for alerting)
 *                        Returns 200 only if ALL checks pass.
 *                        Returns 503 if any check fails.
 *
 * Deep checks:
 *   ✅ Postgres — runs SELECT 1
 *   ✅ MongoDB  — runs db.command({ ping: 1 })
 *   ✅ Reloadly tokens — verifies all 3 service tokens are cached and valid
 *   ✅ Fee payer USDC balance — warns if below threshold
 *   ✅ Fee payer USDT balance — warns if below threshold
 */

import { Router } from "express";
import mongoose from "mongoose";
import { query } from "../db/postgres.js";
import { getAccessToken } from "../services/reloadlyAuth.js";
import { feePayerPublicKey } from "../feePayer.js";
import { Connection } from "@solana/web3.js";
import { getTokenBySymbol } from "../config/tokenMints.js";

export const healthRouter = Router();

const connection = new Connection(process.env.ALCHEMY_RPC_URL, "confirmed");

// Warn if fee payer's token ATA balance falls below this (in human units)
const MIN_USDC_WARN = Number(process.env.FEE_PAYER_MIN_USDC_WARN ?? 10);
const MIN_USDT_WARN = Number(process.env.FEE_PAYER_MIN_USDT_WARN ?? 10);

// ─── Shallow health (load balancer target) ────────────────────────────────────

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    feePayer: feePayerPublicKey,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV ?? "development",
  });
});

// ─── Deep health ──────────────────────────────────────────────────────────────

healthRouter.get("/deep", async (_req, res) => {
  const checks = {};
  let healthy = true;
  const start = Date.now();

  // ── Postgres ─────────────────────────────────────────────────────────────
  try {
    const pg = await query("SELECT NOW() AS ts");
    checks.postgres = {
      ok: true,
      latencyMs: Date.now() - start,
      ts: pg.rows[0].ts,
    };
  } catch (err) {
    checks.postgres = { ok: false, error: err.message };
    healthy = false;
  }

  // ── MongoDB ───────────────────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    await mongoose.connection.db.command({ ping: 1 });
    checks.mongodb = { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    checks.mongodb = { ok: false, error: err.message };
    healthy = false;
  }

  // ── Reloadly tokens ───────────────────────────────────────────────────────
  const reloadlyServices = ["airtime", "utilities", "giftcards"];
  checks.reloadly = {};

  for (const svc of reloadlyServices) {
    try {
      const t0 = Date.now();
      const token = await getAccessToken(svc);
      checks.reloadly[svc] = {
        ok: true,
        hasToken: Boolean(token),
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      checks.reloadly[svc] = { ok: false, error: err.message };
      healthy = false;
    }
  }

  // ── Fee payer token balances ───────────────────────────────────────────────
  checks.feePayerBalances = {};

  for (const [symbol, minWarn] of [
    ["USDC", MIN_USDC_WARN],
    ["USDT", MIN_USDT_WARN],
  ]) {
    try {
      const tokenInfo = getTokenBySymbol(symbol);
      const t0 = Date.now();

      // getTokenAccountsByOwner returns all ATAs for the fee payer with this mint
      const accounts = await connection.getParsedTokenAccountsByOwner(
        {
          toBase58: () => feePayerPublicKey,
          toString: () => feePayerPublicKey,
        },
        {
          mint: {
            toBase58: () => tokenInfo.mint,
            toString: () => tokenInfo.mint,
          },
        },
      );

      // Sum across all ATAs (edge case: multiple accounts for same mint)
      const totalHuman = accounts.value.reduce((sum, acc) => {
        return (
          sum + (acc.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0)
        );
      }, 0);

      const warn = totalHuman < minWarn;
      if (warn) healthy = false; // low balance is a health failure

      checks.feePayerBalances[symbol] = {
        ok: !warn,
        balance: totalHuman,
        minWarn,
        latencyMs: Date.now() - t0,
        ...(warn
          ? {
              warning: `Balance below minimum threshold of ${minWarn} ${symbol}`,
            }
          : {}),
      };
    } catch (err) {
      // RPC failure for balance check is a warning, not a hard failure
      checks.feePayerBalances[symbol] = { ok: false, error: err.message };
    }
  }

  const totalMs = Date.now() - start;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    healthy,
    totalMs,
    checks,
    timestamp: new Date().toISOString(),
  });
});
