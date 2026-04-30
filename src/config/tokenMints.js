/**
 * src/config/tokenMints.js
 *
 * Payment token registry — USDC, USDT, USDG, and SOL.
 *
 * ─── Network selection ────────────────────────────────────────────────────────
 *
 *   Controlled by UMBRA_NETWORK env var — NOT by NODE_ENV.
 *   .env:
 *     UMBRA_NETWORK=devnet      ← test / staging
 *     UMBRA_NETWORK=mainnet     ← production
 *
 * ─── Mint addresses ───────────────────────────────────────────────────────────
 *
 *   USDC mainnet : EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (Circle)
 *   USDC devnet  : 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU  (Circle faucet)
 *
 *   USDT mainnet : Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB  (Tether)
 *   USDT devnet  : BQcdHdAQW1hczDbBi9hiegXAR7A98Q9jx3X3iBBBDiq4
 *                  ⚠️  Must match frontend stablecoinUtils.js USDT devnet mint
 *
 *   USDG mainnet : 2u1tszSeqiFdYPKqBGBjBb6HpJiNGjGGnFnLWa6U5vB9  (Paxos)
 *   USDG devnet  : null  (not available on devnet)
 *
 *   SOL  both    : So11111111111111111111111111111111111111112  (wSOL — same on all networks)
 *                  Native SOL transfers use the System Program, not SPL Token.
 *                  privatePay.js handles SOL separately via SystemProgram.transfer detection.
 *                  9 decimals (1 SOL = 1_000_000_000 lamports).
 *
 * ─── Adding a new token ───────────────────────────────────────────────────────
 *
 *   1. Add an entry to TOKEN_REGISTRY with both mainnet + devnet mints
 *   The transaction verifier picks it up automatically.
 */

const UMBRA_NETWORK = process.env.UMBRA_NETWORK ?? "devnet";
const IS_MAINNET = UMBRA_NETWORK === "mainnet";

// wSOL mint is identical on every Solana network
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const TOKEN_REGISTRY = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    type: "SPL",
    isNative: false,
    mint: IS_MAINNET
      ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      : "4oG4sjmopf5MzvTHLE8rpVJ2uyczxfsw2K84SUTpNDx7",
  },
  USDT: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    type: "SPL",
    isNative: false,
    mint: IS_MAINNET
      ? "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
      : "DXQwBNGgyQ2BzGWxEriJPVmXYFQBsQbXvfvfSNTaJkL6",
  },
  USDG: {
    symbol: "USDG",
    name: "USDG",
    decimals: 6,
    type: "SPL",
    isNative: false,
    mint: IS_MAINNET ? "2u1tszSeqiFdYPKqBGBjBb6HpJiNGjGGnFnLWa6U5vB9" : null, // not available on devnet
  },
  SOL: {
    symbol: "SOL",
    name: "Solana",
    decimals: 9, // 1 SOL = 1_000_000_000 lamports
    type: "NATIVE", // transfers use SystemProgram, not SPL Token
    isNative: true,
    mint: WSOL_MINT, // wSOL mint — same on mainnet and devnet
  },
};

/**
 * Tokens accepted as payment input on the current network.
 * USDG is automatically excluded on devnet (null mint).
 */
export const ACCEPTED_PAYMENT_TOKENS = new Set(
  Object.values(TOKEN_REGISTRY)
    .filter((t) => t.mint !== null)
    .map((t) => t.symbol),
);

/**
 * Look up a full token entry by symbol.
 * Returns null if unknown or not available on the current network.
 *
 * @param {string} symbol
 * @returns {object|null}
 */
export function getTokenBySymbol(symbol) {
  const token = TOKEN_REGISTRY[symbol?.toUpperCase()] ?? null;
  if (!token || !token.mint) return null;
  return token;
}

/**
 * Returns the mint address for a symbol on the current network.
 * For SOL this returns the wSOL mint (same on all networks).
 * Throws if the symbol is unknown or unavailable on this network.
 *
 * @param {string} symbol
 * @returns {string}
 */
export function getMintAddress(symbol) {
  const token = TOKEN_REGISTRY[symbol?.toUpperCase()];
  if (!token) {
    throw new Error(`[tokenMints] Unknown token symbol: "${symbol}"`);
  }
  if (!token.mint) {
    throw new Error(
      `[tokenMints] ${symbol} is not available on ${UMBRA_NETWORK}. ` +
        `Add a devnet mint to TOKEN_REGISTRY if needed.`,
    );
  }
  return token.mint;
}

/**
 * Returns true if the token uses native SOL transfers (System Program)
 * rather than SPL Token transfers.
 *
 * Used by privatePay.js to decide which instruction decoder to apply.
 *
 * @param {string} symbol
 * @returns {boolean}
 */
export function isNativeToken(symbol) {
  return TOKEN_REGISTRY[symbol?.toUpperCase()]?.isNative ?? false;
}

/**
 * Scale a human-readable amount to raw on-chain units using BigInt.
 *
 * @param {number} humanAmount
 * @param {number} decimals
 * @returns {bigint}
 *
 * @example
 * toRawAmount(1.5, 9)  // → 1_500_000_000n  (SOL)
 * toRawAmount(10.5, 6) // → 10_500_000n      (USDC/USDT)
 */
export function toRawAmount(humanAmount, decimals) {
  return BigInt(Math.round(humanAmount * 10 ** decimals));
}

// ─── Startup log ──────────────────────────────────────────────────────────────

const activeTokens = Object.values(TOKEN_REGISTRY)
  .filter((t) => t.mint)
  .map((t) => `${t.symbol}(${t.mint.slice(0, 8)}…)`)
  .join(", ");

console.log(
  JSON.stringify({
    level: "info",
    service: "tokenMints",
    msg: "Token registry loaded",
    network: UMBRA_NETWORK,
    isMainnet: IS_MAINNET,
    tokens: activeTokens,
    ts: new Date().toISOString(),
  }),
);
