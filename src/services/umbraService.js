/**
 * src/services/umbraService.js
 *
 * ─── Fix history ──────────────────────────────────────────────────────────────
 *
 *  v1 → v2: ensureClaimKeypairRegistered catch no longer caches on real failures
 *           fundClaimKeypairIfNeeded: pre-funds claim keypair with SOL
 *
 *  v2 → v3: CLAIM_KEYPAIR_SOL_RESERVE raised 0.002 → 0.005 SOL
 *           sendAndConfirmTransaction → manual send + HTTP poll
 *
 *  v3 → v4: rpcSubscriptionsUrl restored (SDK requires it)
 *
 *  v4 → v5: SOLANA_WS_URL env var — separate WS endpoint for Umbra SDK
 *           (Alchemy HTTP does not support slotSubscribe/signatureSubscribe)
 *
 *  v5 → v6: Replaced local MINT_ADDRESSES with getMintAddress() from tokenMints.js
 *           withTimeout() added on all SDK calls to prevent infinite hangs
 *           Step-by-step logging added throughout
 *
 *  v6 → v7: CLAIM_KEYPAIR_SOL_RESERVE raised to 0.015 SOL (15M lamports)
 *           SOL (wSOL mint) supported via getMintAddress("SOL") from tokenMints.js
 *
 *  v7 → v8 (this version):
 *           Raw SDK result logging added after every SDK call so we can see
 *           exact field names returned by the Umbra SDK for signature/utxoId.
 *           Helps fix `signature: undefined` in UTXO created ✓ log.
 */

import {
  Connection,
  SystemProgram,
  Transaction as SolanaTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  getUmbraClient,
  getUmbraRelayer,
  getUserRegistrationFunction,
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  createSignerFromPrivateKeyBytes,
} from "@umbra-privacy/sdk";

import {
  getUserRegistrationProver,
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";

import { relayWallet } from "../relayWallet.js";
import { deriveClaimKeypair } from "./identityService.js";
import { getMintAddress } from "../config/tokenMints.js";

// ─── Internal logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg, meta = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "umbraService",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "umbraService",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta = {}) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "umbraService",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ─── Raw result logger ────────────────────────────────────────────────────────
//
// Logs every key and its type from an SDK result object so we can identify
// the exact field name the SDK uses for signatures/utxoIds.
// Safely handles null, non-objects, and circular-reference-safe stringification.

function logRawResult(label, result) {
  try {
    if (result === null || result === undefined) {
      log.info(`${label} — raw result: null/undefined`);
      return;
    }
    if (typeof result !== "object") {
      log.info(`${label} — raw result (primitive)`, { value: String(result) });
      return;
    }

    // Log all top-level keys with their types and truncated values
    const summary = {};
    for (const key of Object.keys(result)) {
      const val = result[key];
      const type = typeof val;
      if (type === "string")
        summary[key] =
          `string(${val.length}): ${val.slice(0, 32)}${val.length > 32 ? "…" : ""}`;
      else if (type === "bigint") summary[key] = `bigint: ${val.toString()}`;
      else if (type === "number") summary[key] = `number: ${val}`;
      else if (type === "boolean") summary[key] = `boolean: ${val}`;
      else if (val === null) summary[key] = "null";
      else if (Array.isArray(val)) summary[key] = `array(${val.length})`;
      else if (type === "object")
        summary[key] = `object: keys=[${Object.keys(val).join(",")}]`;
      else summary[key] = type;
    }

    log.info(`${label} — raw result keys`, {
      keys: Object.keys(result),
      summary,
    });
  } catch (err) {
    log.warn(`${label} — could not log raw result`, { error: err.message });
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const rpcUrl = process.env.ALCHEMY_RPC_URL;
if (!rpcUrl) throw new Error("[umbraService] ALCHEMY_RPC_URL is not set");

const rpcSubscriptionsUrl = process.env.SOLANA_WS_URL;
if (!rpcSubscriptionsUrl) {
  throw new Error(
    "[umbraService] SOLANA_WS_URL is not set.\n" +
      "Add to .env:\n" +
      "  SOLANA_WS_URL=wss://api.devnet.solana.com        # devnet\n" +
      "  SOLANA_WS_URL=wss://api.mainnet-beta.solana.com  # mainnet\n" +
      "  SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=KEY  # recommended for prod",
  );
}

const UMBRA_NETWORK = process.env.UMBRA_NETWORK ?? "mainnet";
const INDEXER_ENDPOINT = "https://indexer.umbra.finance";
const RELAYER_ENDPOINT = "https://relayer.umbra.finance";

const CLAIM_KEYPAIR_SOL_RESERVE = Math.round(0.015 * LAMPORTS_PER_SOL);

const FUND_POLL_INTERVAL_MS = 2_000;
const FUND_POLL_TIMEOUT_MS = 60_000;
const CLIENT_INIT_TIMEOUT_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 3 * 60_000;
const UTXO_TIMEOUT_MS = 3 * 60_000;
const CLAIM_TIMEOUT_MS = 3 * 60_000;

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`[umbraService] Timeout after ${ms / 1000}s: ${label}`),
          ),
        ms,
      ),
    ),
  ]);
}

// ─── Solana connection ────────────────────────────────────────────────────────

const connection = new Connection(rpcUrl, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

// ─── HTTP polling ─────────────────────────────────────────────────────────────

async function confirmViaPolling(signature) {
  const deadline = Date.now() + FUND_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value?.[0];
    if (status) {
      if (status.err)
        throw new Error(`SOL funding tx failed: ${JSON.stringify(status.err)}`);
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      )
        return;
    }
    await new Promise((r) => setTimeout(r, FUND_POLL_INTERVAL_MS));
  }
  throw new Error(
    `SOL funding tx ${signature} not confirmed within ${FUND_POLL_TIMEOUT_MS / 1000}s`,
  );
}

// ─── Signer factory ───────────────────────────────────────────────────────────

async function signerFromKeypair(keypair) {
  return createSignerFromPrivateKeyBytes(keypair.secretKey);
}

// ─── ZK Provers ───────────────────────────────────────────────────────────────

const registrationProver = getUserRegistrationProver();
const utxoProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver();
const claimProver = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver();

// ─── Relayer ──────────────────────────────────────────────────────────────────

const relayer = getUmbraRelayer({ apiEndpoint: RELAYER_ENDPOINT });

// ─── Umbra client factory ─────────────────────────────────────────────────────

let _relayClient = null;

async function getRelayClient() {
  if (!_relayClient) {
    log.info("Initialising relay Umbra client…");
    const signer = await signerFromKeypair(relayWallet);
    _relayClient = await withTimeout(
      getUmbraClient({
        signer,
        network: UMBRA_NETWORK,
        rpcUrl,
        rpcSubscriptionsUrl,
        indexerApiEndpoint: INDEXER_ENDPOINT,
      }),
      CLIENT_INIT_TIMEOUT_MS,
      "getUmbraClient (relay)",
    );
    log.info("Relay client initialised", {
      network: UMBRA_NETWORK,
      relayWallet: relayWallet.publicKey.toBase58().slice(0, 8),
    });
  }
  return _relayClient;
}

async function makeClaimClient(claimKeypair) {
  log.info("Initialising claim Umbra client…", {
    claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
  });
  const signer = await signerFromKeypair(claimKeypair);
  const client = await withTimeout(
    getUmbraClient({
      signer,
      network: UMBRA_NETWORK,
      rpcUrl,
      rpcSubscriptionsUrl,
      indexerApiEndpoint: INDEXER_ENDPOINT,
    }),
    CLIENT_INIT_TIMEOUT_MS,
    `getUmbraClient (claim ${claimKeypair.publicKey.toBase58().slice(0, 8)})`,
  );
  log.info("Claim client initialised", {
    claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
  });
  return client;
}

// ─── Registration cache ───────────────────────────────────────────────────────

const _registeredClaimKeys = new Set();

// ─── Public: registerRelayWallet ─────────────────────────────────────────────

export async function registerRelayWallet() {
  const client = await getRelayClient();
  const register = getUserRegistrationFunction(
    { client },
    { zkProver: registrationProver },
  );
  try {
    log.info("Registering relay wallet with Umbra…");
    const result = await withTimeout(
      register({ confidential: true, anonymous: true }),
      REGISTRATION_TIMEOUT_MS,
      "registerRelayWallet",
    );
    logRawResult("registerRelayWallet", result);
    log.info("Relay wallet registered with Umbra");
  } catch (err) {
    log.warn("Relay register() warning", { error: err.message });
  }
}

// ─── Public: getClaimPublicKey ────────────────────────────────────────────────

export function getClaimPublicKey(identityHash) {
  return deriveClaimKeypair(identityHash).publicKey.toBase58();
}

// ─── Internal: fundClaimKeypairIfNeeded ──────────────────────────────────────

async function fundClaimKeypairIfNeeded(claimKeypair) {
  const balance = await connection.getBalance(claimKeypair.publicKey);

  if (balance >= CLAIM_KEYPAIR_SOL_RESERVE) {
    log.info("Claim keypair already funded", {
      claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
      balance,
    });
    return;
  }

  const lamportsNeeded = CLAIM_KEYPAIR_SOL_RESERVE - balance;
  log.info("Funding claim keypair from relay wallet", {
    claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
    lamports: lamportsNeeded,
    currentBalance: balance,
    targetBalance: CLAIM_KEYPAIR_SOL_RESERVE,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new SolanaTransaction().add(
    SystemProgram.transfer({
      fromPubkey: relayWallet.publicKey,
      toPubkey: claimKeypair.publicKey,
      lamports: lamportsNeeded,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = relayWallet.publicKey;
  tx.sign(relayWallet);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });

  log.info("Funding tx sent, confirming…", {
    claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
    signature: signature.slice(0, 16),
  });
  await confirmViaPolling(signature);
  log.info("Claim keypair funded ✓", {
    claimPublicKey: claimKeypair.publicKey.toBase58().slice(0, 8),
    lamports: lamportsNeeded,
    signature: signature.slice(0, 16),
  });
}

// ─── Internal: ensureClaimKeypairRegistered ───────────────────────────────────

async function ensureClaimKeypairRegistered(identityHash) {
  const claimPublicKey = getClaimPublicKey(identityHash);

  if (_registeredClaimKeys.has(claimPublicKey)) {
    log.info("Claim keypair already registered (cached)", {
      identityHash: identityHash.slice(0, 8),
      claimPublicKey: claimPublicKey.slice(0, 8),
    });
    return;
  }

  const claimKeypair = deriveClaimKeypair(identityHash);

  log.info("Step 1/3 — funding claim keypair", {
    identityHash: identityHash.slice(0, 8),
  });
  await fundClaimKeypairIfNeeded(claimKeypair);

  log.info("Step 2/3 — building claim Umbra client", {
    identityHash: identityHash.slice(0, 8),
  });
  const client = await makeClaimClient(claimKeypair);

  log.info("Step 3/3 — registering claim keypair with Umbra", {
    identityHash: identityHash.slice(0, 8),
  });
  const register = getUserRegistrationFunction(
    { client },
    { zkProver: registrationProver },
  );

  try {
    const regResult = await withTimeout(
      register({ confidential: true, anonymous: true }),
      REGISTRATION_TIMEOUT_MS,
      `register claim keypair ${claimPublicKey.slice(0, 8)}`,
    );
    logRawResult("register (claim keypair)", regResult);
    _registeredClaimKeys.add(claimPublicKey);
    log.info("Claim keypair registered ✓", {
      identityHash: identityHash.slice(0, 8),
      claimPublicKey: claimPublicKey.slice(0, 8),
    });
  } catch (err) {
    const msg = err.message?.toLowerCase() ?? "";
    const alreadyRegistered =
      msg.includes("already registered") || msg.includes("already exists");

    if (alreadyRegistered) {
      _registeredClaimKeys.add(claimPublicKey);
      log.info("Claim keypair already registered — cached", {
        identityHash: identityHash.slice(0, 8),
        claimPublicKey: claimPublicKey.slice(0, 8),
      });
      return;
    }

    log.error("Claim keypair registration failed", {
      identityHash: identityHash.slice(0, 8),
      claimPublicKey: claimPublicKey.slice(0, 8),
      error: err.message,
    });
    throw new Error(
      `[umbraService] Claim keypair registration failed for identity ${identityHash.slice(0, 8)}…: ${err.message}`,
    );
  }
}

// ─── Public: createUTXOForRecipient ──────────────────────────────────────────

export async function createUTXOForRecipient({
  identityHash,
  amountRaw,
  tokenSymbol,
}) {
  log.info("createUTXOForRecipient — start", {
    identityHash: identityHash.slice(0, 8),
    tokenSymbol,
    amountRaw: String(amountRaw),
  });

  await ensureClaimKeypairRegistered(identityHash);

  log.info("Getting relay client for UTXO creation…");
  const client = await getRelayClient();
  const mint = getMintAddress(tokenSymbol);
  const claimPublicKey = getClaimPublicKey(identityHash);

  const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client },
    { zkProver: utxoProver },
  );

  log.info("Calling createUtxo…", {
    identityHash: identityHash.slice(0, 8),
    claimPublicKey: claimPublicKey.slice(0, 8),
    tokenSymbol,
    mint: mint.slice(0, 8),
  });

  const result = await withTimeout(
    createUtxo({ destinationAddress: claimPublicKey, mint, amount: amountRaw }),
    UTXO_TIMEOUT_MS,
    `createUtxo for ${identityHash.slice(0, 8)}`,
  );

  // ── Log the raw result so we know exactly what the SDK returns ────────────
  logRawResult("createUtxo result", result);

  // ── Extract signature and utxoId from whichever field the SDK uses ────────
  // Confirmed field names from logRawResult output:
  //   createUtxoSignature        — the UTXO creation tx signature  ← use this
  //   createProofAccountSignature — proof account creation tx
  //   closeProofAccountSignature  — undefined until proof is closed
  const signature =
    result?.createUtxoSignature ??
    result?.queueSignature ??
    result?.signature ??
    result?.txHash ??
    result?.transactionSignature;

  // No dedicated utxoId field returned — use the signature as the utxo reference
  const utxoId =
    result?.utxoId ??
    result?.noteHash ??
    result?.id ??
    result?.note ??
    signature;

  log.info("UTXO created ✓", {
    identityHash: identityHash.slice(0, 8),
    claimPublicKey: claimPublicKey.slice(0, 8),
    tokenSymbol,
    amountRaw: String(amountRaw),
    signature: String(signature).slice(0, 16),
    utxoId: String(utxoId).slice(0, 16),
  });

  return { signature, utxoId, claimPublicKey };
}

// ─── Public: claimUTXOsForIdentity ───────────────────────────────────────────

export async function claimUTXOsForIdentity({
  identityHash,
  registeredWalletAddress,
  tokenSymbol,
}) {
  const claimKeypair = deriveClaimKeypair(identityHash);

  log.info("Building claim client for UTXO sweep…", {
    identityHash: identityHash.slice(0, 8),
  });
  const client = await makeClaimClient(claimKeypair);
  const mint = getMintAddress(tokenSymbol);

  const scanFn = getClaimableUtxoScannerFunction({ client });

  log.info("Scanning for UTXOs…", {
    identityHash: identityHash.slice(0, 8),
    tokenSymbol,
  });

  let received;
  try {
    const scanResult = await withTimeout(
      scanFn(0n, 0n, undefined),
      CLAIM_TIMEOUT_MS,
      `UTXO scan for ${identityHash.slice(0, 8)}`,
    );
    // ── Log raw scan result ──────────────────────────────────────────────────
    logRawResult("scanFn result", scanResult);
    received =
      scanResult?.received ?? scanResult?.utxos ?? scanResult?.items ?? [];
    log.info("UTXO scan complete", {
      identityHash: identityHash.slice(0, 8),
      receivedCount: received.length,
    });
  } catch (err) {
    throw new Error(`[umbraService] UTXO scan failed: ${err.message}`);
  }

  const utxos = received.filter((u) => !u.mint || u.mint === mint);

  if (utxos.length === 0) {
    log.info("No UTXOs found", {
      identityHash: identityHash.slice(0, 8),
      tokenSymbol,
    });
    return [];
  }

  log.info("Claiming UTXOs", {
    identityHash: identityHash.slice(0, 8),
    count: utxos.length,
    registeredWalletAddress: registeredWalletAddress.slice(0, 8),
  });

  // ── Log first UTXO shape so we know its fields ────────────────────────────
  if (utxos[0]) logRawResult("utxo[0] shape", utxos[0]);

  const claimFn = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client },
    { zkProver: claimProver, relayer },
  );
  const withdrawFn = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
    { client },
  );

  const results = [];

  for (const utxo of utxos) {
    try {
      const utxoId =
        utxo?.id ?? utxo?.note ?? utxo?.utxoId ?? utxo?.noteHash ?? "unknown";
      log.info("Claiming UTXO…", { utxoId: String(utxoId).slice(0, 12) });

      const claimResult = await withTimeout(
        claimFn([utxo]),
        CLAIM_TIMEOUT_MS,
        `claimFn for ${identityHash.slice(0, 8)}`,
      );
      // ── Log raw claim result ───────────────────────────────────────────────
      logRawResult("claimFn result", claimResult);

      const claimSig =
        claimResult?.queueSignature ??
        claimResult?.signature ??
        claimResult?.txHash ??
        claimResult?.transactionSignature;
      const amountRaw = utxo?.amount ?? utxo?.amountRaw ?? 0n;

      log.info("Withdrawing UTXO…", {
        utxoId: String(utxoId).slice(0, 12),
        registeredWalletAddress: registeredWalletAddress.slice(0, 8),
      });

      const withdrawResult = await withTimeout(
        withdrawFn(registeredWalletAddress, mint, amountRaw),
        CLAIM_TIMEOUT_MS,
        `withdrawFn for ${identityHash.slice(0, 8)}`,
      );
      // ── Log raw withdraw result ────────────────────────────────────────────
      logRawResult("withdrawFn result", withdrawResult);

      const withdrawSig =
        withdrawResult?.queueSignature ??
        withdrawResult?.signature ??
        withdrawResult?.txHash ??
        withdrawResult?.transactionSignature;

      log.info("UTXO claimed and withdrawn ✓", {
        utxoId: String(utxoId).slice(0, 12),
        registeredWalletAddress: registeredWalletAddress.slice(0, 8),
        claimSig: String(claimSig).slice(0, 16),
        withdrawSig: String(withdrawSig).slice(0, 16),
      });

      results.push({
        signature: claimSig,
        withdrawSignature: withdrawSig,
        utxoId,
        amountRaw,
      });
    } catch (err) {
      log.error("Failed to claim/withdraw UTXO", {
        identityHash: identityHash.slice(0, 8),
        error: err.message,
      });
    }
  }

  return results;
}
