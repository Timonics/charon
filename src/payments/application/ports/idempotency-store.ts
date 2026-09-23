import type { IdempotencyKey } from '../../../shared/kernel/idempotency-key';
import type { SqlExecutor } from '../../../shared/infrastructure/db';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

/**
 * Cross-cutting persistence port for caller-supplied idempotency keys.
 * Implemented in infrastructure (Postgres); fakes live in test code.
 *
 * Lifecycle of a key under a scope:
 *
 *   (absent) --acquire--> in-progress --complete--> completed
 *        ^                    |
 *        |------- release -----+   (on failure; frees the key for retry)
 *
 *  - `acquire` is the concurrency gate: exactly one caller at a time may
 *    hold a key in 'in-progress'. A second `acquire` for the same
 *    (scope, key) MUST return 'in-progress' without waiting — the caller
 *    then rejects the duplicate instead of executing the command twice.
 *  - `getCompleted` is the replay path: after `complete`, any later command
 *    with the same key returns the stored result instead of re-executing.
 *  - `release` exists so a failed command does not pin the key forever;
 *    the caller may then retry (and will re-execute, which is correct —
 *    the previous attempt is known to have failed before side effects).
 *
 * Implementations MUST make acquire/complete/release atomic per (scope, key)
 * (e.g. primary-key insert / conditional update) — this port is the sole
 * mechanism preventing double-charges on client retries.
 */
export interface IdempotencyStore extends TransactionCapable<IdempotencyStore> {
  /**
   * Returns the stored result of a completed command, or null. Generic so
   * callers replay without casts: `getCompleted<MyResult>(...)`.
   */
  getCompleted<T>(scope: string, key: IdempotencyKey): Promise<T | null>;

  /**
   * 'acquired' — this caller now owns the key and must complete or release.
   * 'in-progress' — another caller owns it; reject the duplicate.
   */
  acquire(
    scope: string,
    key: IdempotencyKey,
  ): Promise<'acquired' | 'in-progress'>;

  /** Marks the key completed with its result; replay now returns `result`. */
  complete(scope: string, key: IdempotencyKey, result: unknown): Promise<void>;

  /** Frees an acquired key after a failure so the caller may retry. */
  release(scope: string, key: IdempotencyKey): Promise<void>;
}

export type { SqlExecutor };
