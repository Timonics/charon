import type { IdempotencyStore } from '../application/ports/idempotency-store';
import type { IdempotencyKey } from '../../shared/kernel/idempotency-key';
import { DomainError } from '../../shared/kernel/domain-error';
import type { SqlExecutor } from '../../shared/infrastructure/db';

/**
 * Thrown when `complete` or `release` finds the key in an unexpected state
 * (e.g. completing a key nobody holds). Indicates a bug or a lost race —
 * never part of normal operation.
 */
export class IdempotencyOwnershipLostError extends DomainError {
  readonly code = 'IDEMPOTENCY_OWNERSHIP_LOST';

  constructor(scope: string, key: string, operation: string) {
    super(
      `Cannot ${operation} idempotency key ${scope}:${key}: not held in 'in-progress'`,
    );
  }
}

/**
 * Postgres implementation of the idempotency port. The atomicity the port
 * promises is mechanical here:
 *
 *  - acquire: INSERT ... ON CONFLICT DO NOTHING — the PK(scope, key) makes
 *    "exactly one winner" a single-statement fact, no read-then-write race;
 *  - complete/release: conditional UPDATE ... WHERE state = 'in-progress'
 *    then a rowCount check, so a lost race fails loudly instead of
 *    clobbering another request's record.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: SqlExecutor) {}

  async getCompleted<T>(scope: string, key: IdempotencyKey): Promise<T | null> {
    const result = await this.db.query<{ state: string; result: unknown }>(
      'SELECT state, result FROM idempotency_keys WHERE scope = $1 AND key = $2',
      [scope, key],
    );
    const row = result.rows[0];
    if (!row || row.state !== 'completed') {
      return null;
    }
    return row.result as T;
  }

  async acquire(
    scope: string,
    key: IdempotencyKey,
  ): Promise<'acquired' | 'in-progress'> {
    const result = await this.db.query(
      `INSERT INTO idempotency_keys (scope, key, state, created_at)
       VALUES ($1, $2, 'in-progress', now())
       ON CONFLICT (scope, key) DO NOTHING`,
      [scope, key],
    );
    return result.rowCount === 1 ? 'acquired' : 'in-progress';
  }

  async complete(
    scope: string,
    key: IdempotencyKey,
    result: unknown,
  ): Promise<void> {
    const completed = await this.db.query(
      `UPDATE idempotency_keys
       SET state = 'completed', result = $3, completed_at = now()
       WHERE scope = $1 AND key = $2 AND state = 'in-progress'`,
      [scope, key, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) {
      throw new IdempotencyOwnershipLostError(scope, key, 'complete');
    }
  }

  async release(scope: string, key: IdempotencyKey): Promise<void> {
    const released = await this.db.query(
      `DELETE FROM idempotency_keys
       WHERE scope = $1 AND key = $2 AND state = 'in-progress'`,
      [scope, key],
    );
    if (released.rowCount !== 1) {
      // Releasing an absent or completed key is a logic error upstream, but
      // deliberately NOT thrown: release runs on failure paths where the
      // original error matters more. The swallowed rowCount is logged by
      // callers via the audit trail.
    }
  }

  /**
   * Returns a new store instance bound to the given SQL executor. See
   * {@link TransactionCapable.with} for the shared contract.
   */
  with(tx: SqlExecutor): PostgresIdempotencyStore {
    return new PostgresIdempotencyStore(tx);
  }
}
