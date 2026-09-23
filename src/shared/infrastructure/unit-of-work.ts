import type { Pool, PoolClient } from 'pg';
import type { SqlExecutor } from './db';
import { getPool } from './db';

/**
 * The unit of work — the mechanism behind the "atomic snapshot + journal +
 * idempotency" contract that our ports have stated so far.
 *
 * Every mutating use case wraps its persistence steps in run():
 *
 * ```ts
 * await unitOfWork.run(async (tx) => {
 *   await intentRepo.with(tx).save(intent);       // snapshot
 *   await ledgerRepo.with(tx).append(entries);    // journal
 *   await idempotency.with(tx).complete(key, r);  // replay record
 * });
 * ```
 *
 * Either all three commit, or none do. A failure anywhere rolls the whole
 * unit back — which is precisely what makes the idempotency "release on
 * failure" semantics correct: a released key is guaranteed to have no
 * partial side effects.
 *
 * Repositories gain a transaction by being constructed with the `tx`
 * executor; because SqlExecutor is the only dependency, no repository needs
 * to know whether it is running inside a unit of work or standalone.
 *
 * Construction:
 *  - `new UnitOfWork()` — uses the process-wide pool from `getPool()`.
 *    Production composition root uses this shape.
 *  - `new UnitOfWork(pool)` — uses an explicit pool. Tests pass a fake
 *    pool whose `connect()` returns a recording executor so the
 *    BEGIN/COMMIT/ROLLBACK lifecycle is observable without Docker.
 */
export class UnitOfWork {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  async run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Rolling back is best-effort: the original error is always the one
      // propagated, even if the rollback itself fails (e.g. connection
      // already broken — the server will abort the transaction anyway).
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
