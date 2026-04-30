/**
 * src/config/tokens.js
 *
 * Canonical allowlist for all tokens supported in swaps.
 *
 * ─── Swap rules ───────────────────────────────────────────────────────────────
 *
 *   Every swap must have EXACTLY ONE stable side and ONE non-stable side:
 *     USDC  ←→  SOL / JUP / JTO / RAY / ... / TSLAx / AAPLx / ...
 *     USDT  ←→  SOL / JUP / JTO / RAY / ... / TSLAx / AAPLx / ...
 *
 *   Stable ↔ stable and non-stable ↔ non-stable swaps are rejected.
 *
 * ─── Mint address verification ────────────────────────────────────────────────
 *
 *   All addresses marked ✓ VERIFIED have been cross-checked on Solscan.
 *   Addresses marked ⚠ VERIFY before going live — confirm on:
 *     https://solscan.io/token/<MINT_ADDRESS>
 *     https://birdeye.so/token/<MINT_ADDRESS>
 *
 * ─── Adding tokens ────────────────────────────────────────────────────────────
 *
 *   Add entries to ECOSYSTEM_TOKENS or XSTOCK_TOKENS below, then re-deploy.
 *   Never add a token without first confirming its mint address on Solscan.
 */

// ─── Stablecoins ─────────────────────────────────────────────────────────────
// These are always the "stable side" of every swap.

export const STABLECOINS = {
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // ✓ VERIFIED
    name: "USD Coin",
    decimals: 6,
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // ✓ VERIFIED
    name: "Tether USD",
    decimals: 6,
  },
};

// ─── Top 10 Solana Ecosystem Tokens ───────────────────────────────────────────
// These are the "non-stable side" of a swap.

export const ECOSYSTEM_TOKENS = {
  SOL: {
    mint: "So11111111111111111111111111111111111111112", // ✓ VERIFIED — wrapped SOL
    name: "Solana",
    decimals: 9,
  },
  JUP: {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // ✓ VERIFIED — Jupiter
    name: "Jupiter",
    decimals: 6,
  },
  JTO: {
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // ✓ VERIFIED — Jito
    name: "Jito",
    decimals: 9,
  },
  RAY: {
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // ✓ VERIFIED — Raydium
    name: "Raydium",
    decimals: 6,
  },
  BONK: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // ✓ VERIFIED — Bonk
    name: "Bonk",
    decimals: 5,
  },
  WIF: {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // ✓ VERIFIED — dogwifhat
    name: "dogwifhat",
    decimals: 6,
  },
  PYTH: {
    mint: "HZ1JovNiVvGqkvK2mefJ2co9nquviTKkdP3VaiaqkJJv", // ⚠ VERIFY on Solscan
    name: "Pyth Network",
    decimals: 6,
  },
  ORCA: {
    mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", // ⚠ VERIFY on Solscan
    name: "Orca",
    decimals: 6,
  },
  RENDER: {
    mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", // ⚠ VERIFY on Solscan
    name: "Render",
    decimals: 8,
  },
  W: {
    mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", // ⚠ VERIFY on Solscan — Wormhole
    name: "Wormhole",
    decimals: 6,
  },
};

// ─── Top 10 xStocks (Tokenized Equities by Backed Finance) ────────────────────
// These are real-world stocks tokenized 1:1 as SPL tokens on Solana.
// Issued by Backed Assets (JE) Limited. Not available to US persons.
//
// Source: KuCoin listing announcement (NVDAx, SPYx confirmed) + Solscan.
// ⚠ Verify ALL addresses on https://solscan.io before going to production.

export const XSTOCK_TOKENS = {
  TSLAx: {
    mint: "XsoTS2pBbMSQjEmzBAKBCnbXfYHGnXMmPx3dGHkDVMZ", // ⚠ VERIFY on Solscan
    name: "Tesla xStock",
    decimals: 8,
    underlying: "TSLA",
  },
  NVDAx: {
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", // ✓ VERIFIED (KuCoin listing)
    name: "NVIDIA xStock",
    decimals: 8,
    underlying: "NVDA",
  },
  AAPLx: {
    mint: "XsoAPLsAa9sAFnCFJNyHKyXpPFxXBDV1b5iDHwrVLyy", // ⚠ VERIFY on Solscan
    name: "Apple xStock",
    decimals: 8,
    underlying: "AAPL",
  },
  SPYx: {
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", // ✓ VERIFIED (KuCoin listing)
    name: "S&P 500 ETF xStock",
    decimals: 8,
    underlying: "SPY",
  },
  METAx: {
    mint: "XsoMETAxW91kLNBqMkzASs2NqxUETsN4bFY6gfCfGBe", // ⚠ VERIFY on Solscan
    name: "Meta xStock",
    decimals: 8,
    underlying: "META",
  },
  GOOGLx: {
    mint: "XsoGOOGLkS2V9hBzF9SzZk5n2yMaGKXXQnqgRAWnkqT", // ⚠ VERIFY on Solscan
    name: "Alphabet xStock",
    decimals: 8,
    underlying: "GOOGL",
  },
  MSTRx: {
    mint: "XsoMSTRfPsGFa4FhRAjP3NdGUTUh5Bb1kZRTp9JWHTV", // ⚠ VERIFY on Solscan
    name: "MicroStrategy xStock",
    decimals: 8,
    underlying: "MSTR",
  },
  CRCLx: {
    mint: "XsoCRCLPMWgVnm3BWFZ3gFGN7CRjFpxAAnHsVcpBQv", // ⚠ VERIFY on Solscan
    name: "Circle xStock",
    decimals: 8,
    underlying: "CRCL",
  },
  QQQx: {
    mint: "XsoQQQhfzPVqZGwFvHpbKS2bNDyKXt7b5LVCkHY1Wdz", // ⚠ VERIFY on Solscan
    name: "Nasdaq-100 ETF xStock",
    decimals: 8,
    underlying: "QQQ",
  },
  COINx: {
    mint: "XsoCOINTJpCr9Fc2eXRVcBK9e8vE4YzLHMV2Pf4KLMB", // ⚠ VERIFY on Solscan
    name: "Coinbase xStock",
    decimals: 8,
    underlying: "COIN",
  },
};

// ─── Derived lookup sets (used by swap validation) ────────────────────────────

/** Set of all stable mint addresses */
export const STABLE_MINTS = new Set(
  Object.values(STABLECOINS).map((t) => t.mint),
);

/** Set of all allowed non-stable mint addresses */
export const ALLOWED_MINTS = new Set([
  ...Object.values(ECOSYSTEM_TOKENS).map((t) => t.mint),
  ...Object.values(XSTOCK_TOKENS).map((t) => t.mint),
]);

/** Full mint → token info map (all tokens) */
export const TOKEN_INFO = Object.fromEntries([
  ...Object.values(STABLECOINS).map((t) => [t.mint, t]),
  ...Object.values(ECOSYSTEM_TOKENS).map((t) => [t.mint, t]),
  ...Object.values(XSTOCK_TOKENS).map((t) => [t.mint, t]),
]);
