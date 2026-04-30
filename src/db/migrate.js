/**
 * src/db/migrate.js
 *
 * Migration runner — reads SQL files from src/db/migrations/ in filename order,
 * skips already-applied ones, and runs the rest in a single transaction each.
 *
 * Usage:
 *   node src/db/migrate.js           — apply all pending migrations
 *   node src/db/migrate.js --status  — list applied + pending migrations
 *   node src/db/migrate.js --redo    — roll back last migration and re-apply it
 *
 * Design decisions:
 *   - Each migration runs in its own transaction. If it throws, the transaction
 *     rolls back and the runner stops — no partial state.
 *   - Filenames are the source of truth for ordering. Convention: NNN_description.sql
 *   - The 000_migration_tracking.sql bootstrap file is excluded from tracking
 *     (it creates the tracking table itself — can't track itself).
 *   - Idempotent: safe to run on every deploy. Already-applied files are skipped.
 *
 * SSL behaviour:
 *   POSTGRES_SSL=false  → SSL disabled (always)
 *   POSTGRES_SSL=true   → SSL enabled (always)
 *   unset + production  → SSL enabled
 *   unset + localhost   → SSL disabled (auto-detected from DATABASE_URL)
 *   unset + other       → SSL enabled (assume managed cloud host)
 */

import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = join(__dirname, "migrations");
const BOOTSTRAP_FILE = "000_migration_tracking.sql";

// ─── SSL config ────────────────────────────────────────────────────────────────

function getSslConfig() {
  // Explicit env override always wins
  if (process.env.POSTGRES_SSL === "false") return false;
  if (process.env.POSTGRES_SSL === "true") return { rejectUnauthorized: false };

  // Production — always require SSL
  if (process.env.NODE_ENV === "production")
    return { rejectUnauthorized: false };

  // Dev — detect local hostnames in the connection string
  const url = process.env.DATABASE_URL ?? "";
  const isLocal =
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("host.docker.internal");

  return isLocal ? false : { rejectUnauthorized: false };
}

// ─── DB connection ─────────────────────────────────────────────────────────────
// Uses a direct client (not the pool) so we can control transactions manually.

function createClient() {
  return new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getSslConfig(),
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getMigrationFiles() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith(".sql") && f !== BOOTSTRAP_FILE).sort(); // lexicographic order — NNN_ prefix enforces sequence
}

async function getAppliedMigrations(client) {
  const result = await client.query(
    "SELECT filename FROM _migrations ORDER BY id ASC",
  );
  return new Set(result.rows.map((r) => r.filename));
}

async function applyMigration(client, filename) {
  const filePath = join(MIGRATIONS_DIR, filename);
  const sql = await readFile(filePath, "utf8");
  const start = Date.now();

  await client.query("BEGIN");
  try {
    await client.query(sql);
    const durationMs = Date.now() - start;
    await client.query(
      "INSERT INTO _migrations (filename, duration_ms) VALUES ($1, $2)",
      [filename, durationMs],
    );
    await client.query("COMMIT");
    return durationMs;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function undoLastMigration(client) {
  const result = await client.query(
    "SELECT filename FROM _migrations ORDER BY id DESC LIMIT 1",
  );
  if (result.rows.length === 0) {
    console.log("No migrations to undo.");
    return null;
  }

  const filename = result.rows[0].filename;

  // Check for a matching rollback file e.g. 003_giftcards.down.sql
  const downFile = filename.replace(".sql", ".down.sql");
  const downPath = join(MIGRATIONS_DIR, downFile);

  try {
    const sql = await readFile(downPath, "utf8");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM _migrations WHERE filename = $1", [
      filename,
    ]);
    await client.query("COMMIT");
    console.log(`  ↩  Rolled back: ${filename}`);
    return filename;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `  ✗  No rollback file found for ${filename}.\n` +
          `     Create ${downFile} to enable --redo.`,
      );
    } else {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    return null;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runStatus(client) {
  const files = await getMigrationFiles();
  const applied = await getAppliedMigrations(client);

  console.log("\n  Migration status:\n");
  console.log(`  ${"File".padEnd(45)} Status`);
  console.log(`  ${"─".repeat(45)} ──────────`);

  for (const f of files) {
    const status = applied.has(f) ? "✅ applied" : "⏳ pending";
    console.log(`  ${f.padEnd(45)} ${status}`);
  }

  const pending = files.filter((f) => !applied.has(f));
  console.log(`\n  ${applied.size} applied, ${pending.length} pending.\n`);
}

async function runMigrate(client) {
  const files = await getMigrationFiles();
  const applied = await getAppliedMigrations(client);
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("  ✅  All migrations already applied. Nothing to do.");
    return;
  }

  console.log(`\n  Applying ${pending.length} pending migration(s):\n`);

  for (const filename of pending) {
    process.stdout.write(`  ↳  ${filename} ... `);
    try {
      const ms = await applyMigration(client, filename);
      console.log(`done (${ms}ms)`);
    } catch (err) {
      console.log("FAILED");
      console.error(`\n  Error in ${filename}:\n  ${err.message}\n`);
      console.error("  Migration stopped. Fix the error and re-run.\n");
      process.exit(1);
    }
  }

  console.log(`\n  ✅  ${pending.length} migration(s) applied successfully.\n`);
}

async function runRedo(client) {
  const last = await undoLastMigration(client);
  if (!last) return;

  console.log(`  ↳  Re-applying ${last} ...`);
  try {
    const ms = await applyMigration(client, last);
    console.log(`  ✅  Re-applied in ${ms}ms\n`);
  } catch (err) {
    console.error(`  ✗  Re-apply failed: ${err.message}\n`);
    process.exit(1);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Ensure _migrations table exists before we do anything else.

async function bootstrap(client) {
  const sql = await readFile(join(MIGRATIONS_DIR, BOOTSTRAP_FILE), "utf8");
  await client.query(sql);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "--migrate";

  if (!["--migrate", "--status", "--redo"].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: node src/db/migrate.js [--migrate|--status|--redo]");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Cannot run migrations.");
    process.exit(1);
  }

  // Log which SSL mode was resolved so misconfiguration is obvious
  const ssl = getSslConfig();
  console.log(
    `  SSL: ${ssl === false ? "disabled" : "enabled"} ` +
      `(POSTGRES_SSL=${process.env.POSTGRES_SSL ?? "unset"}, ` +
      `NODE_ENV=${process.env.NODE_ENV ?? "unset"})`,
  );

  const client = createClient();

  try {
    await client.connect();
    console.log("  Connected to Postgres");

    await bootstrap(client);

    if (command === "--status") await runStatus(client);
    if (command === "--migrate") await runMigrate(client);
    if (command === "--redo") await runRedo(client);
  } catch (err) {
    console.error("\n  Fatal error:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
