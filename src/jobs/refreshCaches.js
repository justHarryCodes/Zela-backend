/**
 * src/jobs/refreshCaches.js
 *
 * Proactively refreshes MongoDB operator and biller caches from Reloadly.
 *
 * Why proactive refresh instead of just relying on TTL expiry?
 *   - TTL expiry causes the FIRST request after expiry to be slow (cache miss)
 *   - A background refresh keeps the cache warm, so user requests always hit cache
 *   - Operators and billers change rarely — daily refresh is sufficient
 *
 * What gets refreshed:
 *   - Top 10 countries by expected volume (configurable via CACHE_REFRESH_COUNTRIES)
 *   - All biller types for each country
 *   - Gift card products for each country
 *
 * Runs daily at 3:00 AM UTC (configurable via JOB_CACHE_REFRESH_CRON).
 */

import { acquireJobLock } from "./jobLock.js";
import { startJobLog } from "./jobLogger.js";
import { listOperators } from "../services/airtime.js";
import { listBillers } from "../services/utilities.js";
import { listProducts } from "../services/giftcards.js";
import { OperatorCache } from "../models/operatorCache.js";
import { BillerCache } from "../models/billerCache.js";
import { GiftCardProductCache } from "../models/giftCardProductCache.js";

const JOB_NAME = "refreshCaches";

// Countries to pre-warm. Override via env var (comma-separated ISO-2 codes).
const REFRESH_COUNTRIES = (
  process.env.CACHE_REFRESH_COUNTRIES ?? "NG,GH,KE,ZA,UG,TZ,US,GB,IN,BR"
)
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const BILLER_TYPES = [
  "ELECTRICITY_BILL_PAYMENT",
  "WATER_BILL_PAYMENT",
  "TV_BILL_PAYMENT",
  "INTERNET_BILL_PAYMENT",
];

export async function refreshCaches() {
  const release = await acquireJobLock(JOB_NAME);
  if (!release) {
    console.log(`[${JOB_NAME}] Skipping — another instance holds the lock`);
    return;
  }

  const log = await startJobLog(JOB_NAME);
  let processed = 0;
  let failed = 0;

  try {
    console.log(
      `[${JOB_NAME}] Refreshing caches for ${REFRESH_COUNTRIES.length} countries`,
    );

    for (const countryCode of REFRESH_COUNTRIES) {
      // ── Airtime operators ────────────────────────────────────────────────
      try {
        // Force-clear stale cache for this country before re-fetching
        await OperatorCache.deleteMany({ service: "airtime", countryCode });
        await listOperators(countryCode, { size: 200 });
        console.log(`[${JOB_NAME}] ✅ Operators refreshed for ${countryCode}`);
        processed++;
      } catch (err) {
        console.error(
          `[${JOB_NAME}] Operator refresh failed for ${countryCode}:`,
          err.message,
        );
        failed++;
      }

      // ── Utility billers ──────────────────────────────────────────────────
      for (const billerType of BILLER_TYPES) {
        try {
          await BillerCache.deleteMany({ countryCode, billerType });
          await listBillers({ countryCode, type: billerType, size: 100 });
          processed++;
        } catch (err) {
          // Not all countries have all biller types — treat as soft failure
          if (err.upstreamStatus !== 404) {
            console.error(
              `[${JOB_NAME}] Biller refresh failed ${countryCode}/${billerType}:`,
              err.message,
            );
            failed++;
          }
        }
      }

      // ── Gift card products ───────────────────────────────────────────────
      try {
        await GiftCardProductCache.deleteMany({ countryCode });
        await listProducts({ countryCode, size: 200 });
        console.log(`[${JOB_NAME}] ✅ Gift cards refreshed for ${countryCode}`);
        processed++;
      } catch (err) {
        console.error(
          `[${JOB_NAME}] Gift card refresh failed for ${countryCode}:`,
          err.message,
        );
        failed++;
      }

      // Brief pause between countries to avoid hammering Reloadly rate limits
      await sleep(500);
    }

    await log.complete(processed, failed);
    console.log(
      `[${JOB_NAME}] Done — refreshed: ${processed} errors: ${failed}`,
    );
  } catch (err) {
    console.error(`[${JOB_NAME}] Job-level error:`, err.message);
    await log.fail(err);
  } finally {
    await release();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
