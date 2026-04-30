/**
 * src/lib/encryption.js
 *
 * AES-256-GCM helpers for encrypting/decrypting gift card redeem codes.
 *
 * AES-256-GCM is preferred over CBC because:
 *   1. Authenticated — decryption fails if the ciphertext was tampered with
 *   2. No padding oracle attacks
 *   3. Fast with hardware acceleration on modern CPUs
 *
 * Each call to encrypt() generates a fresh random 12-byte IV, so encrypting
 * the same code twice produces different ciphertext. This is intentional.
 *
 * Required env var:
 *   GIFTCARD_ENCRYPTION_KEY — 64 hex chars (32 bytes)
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — GCM standard
const TAG_BYTES = 16; // 128-bit auth tag

function getKey() {
  const hex = process.env.GIFTCARD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "[encryption] GIFTCARD_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). " +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {{ iv: string, authTag: string, ciphertext: string }}
 */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

/**
 * Decrypt an encrypted object produced by encrypt().
 * Throws if the auth tag doesn't match (tampering detected).
 * @param {{ iv: string, authTag: string, ciphertext: string }} encrypted
 * @returns {string} plaintext
 */
export function decrypt({ iv, authTag, ciphertext }) {
  const key = getKey();

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));

  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
