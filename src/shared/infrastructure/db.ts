import { Pool } from 'pg';

/**
 * Process-wide connection pool. Created lazily so that importing modules
 * (e.g. in unit tests that never touch the database) never opens
 * connections.
 *
 * Secrets contract (non-negotiable #10): the connection string comes ONLY
 * from the DATABASE_URL environment variable, injected by the runtime —
 * never from committed files, never with a fallback default. A missing
 * variable fails loudly at first use rather than connecting to a guessed
 * database.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Export it per .env.example (docker compose up -d postgres).',
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

/**
 * Minimal query surface shared by Pool, PoolClient, and any transaction
 * client. Repositories depend only on this — never on the Pool directly —
 * so the same repository code runs inside or outside a transaction.
 */
export type SqlExecutor = Pick<Pool, 'query'>;
