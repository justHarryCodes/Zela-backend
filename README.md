# Zela Backend

The API server for **Zela**, a Solana payments app. It has four jobs:

- **Sponsor network fees**, so users can transact without holding SOL.
- **Sell real-world services** through Reloadly: airtime, mobile data, utility bills and gift cards, paid in stablecoins.
- **Send private payments** to a phone number, using Umbra's zero-knowledge privacy layer.
- **Map phone numbers to wallets** without ever exposing the numbers.

## API

Every `/v1` route except `/v1/sponsor` requires a Firebase ID token (`Authorization: Bearer <token>`).

| Route | Description |
|---|---|
| `GET /health` | Liveness check, plus fee-payer status |
| `POST /v1/sponsor` | Validates a user's Solana transaction and co-signs it as fee payer |
| `/v1/airtime`, `/v1/data` | Operators, plans and top-up orders |
| `/v1/utilities` | Billers and bill payments (with order status polling) |
| `/v1/giftcards` | Catalogue, purchase and redeem-code retrieval (codes are encrypted at rest) |
| `GET /v1/identity/me` | The caller's identity hash |
| `POST /v1/identity/resolve` | Resolve a phone number to a relay address (the number is never returned) |
| `POST /v1/identity/register` | Link a wallet to an identity and auto-claim pending payments |
| `POST /v1/pay/private` | Send a private payment |
| `GET /v1/pay/pending`, `POST /v1/pay/claim`, `GET /v1/pay/history` | Receive and claim private payments |
| `/v1/admin/*` | Operations for allow-listed admins |

## Background jobs

Cron jobs, protected by a distributed lock, handle:

- polling pending utility orders
- retrying gift-card code retrieval
- routing private payments
- refreshing operator and biller caches
- cleaning up stale orders

## Security

- `helmet`, compression, a 10 KB JSON body limit, and global plus per-route rate limits
- Country allow-listing with GeoIP (`GEO_MODE`, `GEO_ALLOWED_COUNTRIES`)
- Sponsored transactions are checked before signing, so the fee payer can't be drained
- Zod validation on every request body
- Gift-card codes encrypted with `GIFTCARD_ENCRYPTION_KEY`

## Tech stack

Node.js, Express, `@solana/web3.js` and SPL Token, Jupiter, the Umbra SDK (snarkjs zero-knowledge prover), PostgreSQL, MongoDB (Mongoose), Firebase Admin, Reloadly, Twilio, node-cron and Zod.

## Getting started

```bash
git clone https://github.com/justHarryCodes/Zela-backend.git
cd Zela-backend
npm install
cp .env.example .env        # fill in the values
npm run migrate             # PostgreSQL migrations
npm run dev                 # node --watch
```

| Script | Purpose |
|---|---|
| `npm start` / `npm run dev` | Run the server / run it with auto-reload |
| `npm run migrate`, `migrate:status`, `migrate:redo` | Database migrations |
| `npm run updatedb` | Refresh the GeoIP database (needs `MAXMIND_LICENSE_KEY`) |

## Environment variables

See [`.env.example`](.env.example).

| Group | Variables |
|---|---|
| Server | `NODE_ENV`, `PORT` |
| Firebase | `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` |
| Databases | `DATABASE_URL` (PostgreSQL), `MONGODB_URI` |
| Solana | `FEE_PAYER_SECRET_KEY`, `ALCHEMY_RPC_URL`, `SOLANA_COMMITMENT`, `FEE_PAYER_MIN_USDC_WARN`, `FEE_PAYER_MIN_USDT_WARN` |
| Reloadly | `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET`, `GIFTCARD_ENCRYPTION_KEY` |
| Access | `ADMIN_UIDS`, `GEO_MODE`, `GEO_ALLOWED_COUNTRIES` |

## Project structure

```
src/
├── index.js         # Express app, middleware and route mounting
├── routes/          # sponsor, airtime, utilities, giftcards, identity, privatePay, admin, health
├── services/        # Reloadly client, Umbra, SMS, identity, Solana verification
├── jobs/            # Cron runner and jobs
├── middleware/      # Firebase auth, geo restriction, validation, errors
├── models/  schemas/  db/   # Mongo models, Zod schemas, Postgres migrations
├── feePayer.js      # Fee-payer keypair
└── relayWallet.js
```
