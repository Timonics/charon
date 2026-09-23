import { execSync } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Shared setup for integration specs (run via `npm run test:integration`
 * with DATABASE_URL set — see .env.example; docker compose up -d postgres).
 *
 * Migrations apply once per process (idempotent), and every spec truncates
 * the tables it touches in beforeEach. Never point these at a database you
 * care about.
 */
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/charon';

let pool: Pool | undefined;
let migrationsApplied = false;

export function integrationPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function applyMigrations(): void {
  if (migrationsApplied) return;
  execSync('node-pg-migrate up', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  migrationsApplied = true;
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE payment_intents, escrows, ledger_entries, idempotency_keys, processed_webhooks, webhook_inbox',
  );
}

/** Call from each spec's afterAll so Jest can exit cleanly. */
export async function closeIntegrationPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
