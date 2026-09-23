import type { LedgerEntry } from '../../domain/ledger-entry';
import type { SqlExecutor } from '../../../shared/infrastructure/db';
import type { TransactionCapable } from '../../../shared/infrastructure/transaction-capable';

/**
 * Persistence port for the append-only ledger. Implemented in
 * infrastructure (Postgres); the in-memory fake lives in test code.
 *
 * Contract requirements for implementors (these are what make the ledger
 * trustworthy — do not weaken them in the adapter):
 *
 *  - `append` MUST be atomic: all entries in one call are written in a
 *    single transaction, or none are. A partial append would create a
 *    sequence gap that projections cannot distinguish from data loss.
 *  - `append` MUST reject (raise) if any entry's sequence is not exactly
 *    `lastSequence + 1` for its aggregate. Concurrent appends to the same
 *    aggregate must serialize (e.g. via a unique constraint on
 *    (aggregate_id, sequence) and serializable isolation), so the
 *    application layer's optimistic read of `lastSequence` is safe.
 *  - Entries are never updated or deleted. No such methods exist on this
 *    port on purpose.
 */
export interface LedgerRepository extends TransactionCapable<LedgerRepository> {
  /**
   * The highest sequence journaled for this aggregate, or `undefined` if
   * the aggregate has no entries yet. Used by the append path to assign the
   * next sequence.
   */
  lastSequence(aggregateId: string): Promise<number | undefined>;

  /**
   * Atomically appends entries in the order given. Implementations enforce
   * sequence continuity per aggregate (see interface-level contract).
   */
  append(entries: readonly LedgerEntry[]): Promise<void>;
}

export type { SqlExecutor };
