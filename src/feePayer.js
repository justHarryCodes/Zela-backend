/**
 * src/feePayer.js
 *
 * Loads the fee payer Keypair exactly once at process start.
 * All other modules import { feePayer, feePayerPublicKey } from here.
 *
 * The secret key is stored as a base58-encoded string in the environment
 * variable FEE_PAYER_SECRET_KEY. Never commit this value to source control.
 *
 * To generate a new fee payer wallet:
 *   node -e "
 *     const { Keypair } = require('@solana/web3.js');
 *     const bs58 = require('bs58');
 *     const kp = Keypair.generate();
 *     console.log('Public key:', kp.publicKey.toBase58());
 *     console.log('Secret key (store in env):', bs58.encode(kp.secretKey));
 *   "
 *
 * Then fund the public key with SOL on mainnet before deploying.
 * Monitor the balance via /health — add alerting when it drops below ~0.1 SOL.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function loadFeePayer() {
  const raw = process.env.FEE_PAYER_SECRET_KEY;
  if (!raw) throw new Error("[feePayer] FEE_PAYER_SECRET_KEY is not set");

  try {
    const secretKey = bs58.decode(raw);
    return Keypair.fromSecretKey(secretKey);
  } catch {
    throw new Error(
      "[feePayer] FEE_PAYER_SECRET_KEY is not valid base58. " +
        "Generate a new keypair and update your environment.",
    );
  }
}

export const feePayer = loadFeePayer();
export const feePayerPublicKey = feePayer.publicKey.toBase58();
