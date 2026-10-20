/**
 * Setup helpers for the e2e suite (HTTP-level specs).
 *
 * Reuses the Postgres test database the integration specs use
 * — the same DATABASE_URL points to a docker-compose postgres
 * on :5433. The e2e specs don't need a separate DB; they just
 * need a clean slate between tests.
 *
 * The boot app uses the same connection string, so a clean
 * table at the start of each test means the e2e spec is
 * reading the same rows the controller writes.
 */
import { execSync } from 'node:child_process';
import { Pool } from 'pg';

let pool: Pool | undefined;
let migrationsApplied = false;

function connectionString(): string {
  return (
    process.env.DATABASE_URL ?? 'postgres://postgres:***@localhost:5433/charon'
  );
}

export function e2ePool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString() });
  }
  return pool;
}

export function applyE2eMigrations(): void {
  if (migrationsApplied) return;
  execSync('node-pg-migrate up', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: connectionString() },
  });
  migrationsApplied = true;
}

export async function truncateE2eTables(): Promise<void> {
  await e2ePool().query(
    'TRUNCATE payment_intents, escrows, ledger_entries, idempotency_keys, processed_webhooks, webhook_inbox',
  );
}

export async function closeE2ePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
