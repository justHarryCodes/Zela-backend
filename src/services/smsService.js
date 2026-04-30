/**
 * src/services/smsService.js
 *
 * SMS notification layer using Twilio.
 *
 * ─── Design principles ────────────────────────────────────────────────────────
 *
 *   • Fire-and-forget from the caller's perspective — SMS failures never
 *     block or fail a payment that has already confirmed on-chain.
 *
 *   • Every send attempt (success or failure) is recorded in sms_audit.
 *     Use this table to diagnose delivery failures and for compliance audits.
 *
 *   • Phone numbers are passed in at call time, never cached in this module.
 *     They are only handled in memory for the duration of the send call.
 *
 *   • Twilio client is lazily initialized so missing credentials only fail
 *     when a send is attempted, not at process startup.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID    — From console.twilio.com
 *   TWILIO_AUTH_TOKEN     — From console.twilio.com (keep secret)
 *   TWILIO_PHONE_NUMBER   — E.164 sender number or Messaging Service SID
 *   APP_CLAIM_URL         — Deep link for unregistered users (e.g. https://zela.app/claim)
 *   APP_NAME              — (optional) App name in messages, default "Zela"
 */

import twilio from "twilio";
import { query } from "../db/postgres.js";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  APP_CLAIM_URL = "https://zela.app/claim",
  APP_NAME = "Zela",
} = process.env;

// Lazy Twilio client — instantiated on first use
let _twilioClient = null;

function getTwilioClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error(
      "[smsService] TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set",
    );
  }
  if (!_twilioClient) {
    _twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
}

// ─── Message templates ────────────────────────────────────────────────────────

/**
 * Sent to a user who does NOT have a Zela account yet.
 * Instructs them to download the app and claim their funds.
 */
function buildClaimMessage(amountUSD) {
  const formatted = amountUSD.toFixed(2);
  return (
    `You have $${formatted} waiting for you on ${APP_NAME}! ` +
    `Someone sent you a private payment. ` +
    `Download the app to claim it: ${APP_CLAIM_URL}`
  );
}

/**
 * Sent to a user who already has a Zela account.
 * Tells them to open the app — no amount or claim link needed.
 */
function buildReceivedMessage(amountUSD) {
  const formatted = amountUSD.toFixed(2);
  return (
    `You received a private payment of $${formatted} on ${APP_NAME}. ` +
    `Open the app to view it.`
  );
}

// ─── Core send function ───────────────────────────────────────────────────────

/**
 * Sends an SMS and records the result in sms_audit.
 *
 * @param {object}       opts
 * @param {string}        opts.to              E.164 recipient phone
 * @param {string}        opts.body            Message body
 * @param {string|null}   opts.paymentId       UUID of private_payment row
 * @param {string}        opts.identityHash    32 hex chars — for audit only
 * @returns {Promise<boolean>}                 true if Twilio accepted the message
 */
async function sendSMS({ to, body, paymentId, identityHash }) {
  let messageSid = null;
  let status = "failed";
  let errorCode = null;
  let success = false;

  try {
    const client = getTwilioClient();

    const msg = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body,
    });

    messageSid = msg.sid;
    status = msg.status; // queued | sending | sent | delivered
    success = true;

    return true;
  } catch (err) {
    // Twilio errors have a numeric .code property
    errorCode = err.code?.toString() ?? null;
    console.error(
      `[smsService] Failed to send SMS to ${to.slice(0, 4)}***: ` +
        `${err.message} (code: ${errorCode})`,
    );
    return false;
  } finally {
    // Audit log write — best-effort, never throws
    query(
      `INSERT INTO sms_audit (payment_id, identity_hash, message_sid, status, error_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [paymentId ?? null, identityHash, messageSid, status, errorCode],
    ).catch((dbErr) => {
      console.warn("[smsService] Audit log write failed:", dbErr.message);
    });
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Notifies an unregistered user that they have a pending private payment.
 * Includes the APP_CLAIM_URL deep link so they can download the app.
 *
 * @param {object}  opts
 * @param {string}   opts.phoneNumber   E.164
 * @param {number}   opts.amountUSD
 * @param {string}   opts.paymentId    UUID
 * @param {string}   opts.identityHash  32 hex chars
 * @returns {Promise<boolean>}
 */
export async function notifyUnregisteredRecipient({
  phoneNumber,
  amountUSD,
  paymentId,
  identityHash,
}) {
  return sendSMS({
    to: phoneNumber,
    body: buildClaimMessage(amountUSD),
    paymentId,
    identityHash,
  });
}

/**
 * Notifies a registered user that they received a private payment.
 * Does not include amounts or claim links (they'll see it in-app).
 *
 * @param {object}  opts
 * @param {string}   opts.phoneNumber   E.164
 * @param {number}   opts.amountUSD
 * @param {string}   opts.paymentId    UUID
 * @param {string}   opts.identityHash  32 hex chars
 * @returns {Promise<boolean>}
 */
export async function notifyRegisteredRecipient({
  phoneNumber,
  amountUSD,
  paymentId,
  identityHash,
}) {
  return sendSMS({
    to: phoneNumber,
    body: buildReceivedMessage(amountUSD),
    paymentId,
    identityHash,
  });
}
