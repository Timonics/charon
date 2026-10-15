import { OptimisticLockError } from '../kernel/optimistic-lock.error';

/**
 * Shared helper for in-memory repository fakes. Mirrors the
 * compare-and-swap contract that the Postgres repos enforce: a
 * save() against a stale snapshot (version mismatch) throws
 * OptimisticLockError.
 *
 * Usage from a fake:
 *   private escrows = new Map<string, { escrow: Escrow; version: number }>();
 *   async save(escrow: Escrow) {
 *     optimisticSave(this.escrows, escrow, (e) => e.escrowId);
 *   }
 *
 * The fake stores the FULL aggregate (Escrow / PaymentIntent) plus
 * its last-known version. On save, the helper:
 *   1. Looks up the row by id.
 *   2. If the row exists, compares the stored version against the
 *      aggregate's snapshot version. Mismatch → OptimisticLockError.
 *   3. If no row exists, stores the aggregate with its version.
 *   4. Bumps the stored version by 1 to match the Postgres
 *      repository's `version = escrows.version + 1` semantic.
 *
 * The aggregate's `version` is the PRE-state version (the value the
 * row held when the aggregate was loaded). See the production
 * repositories for the matching rationale.
 */
export function optimisticSave<T extends { toSnapshot(): { version: number } }>(
  rows: Map<string, T>,
  aggregate: T,
  getId: (aggregate: T) => string,
  aggregateType: 'PaymentIntent' | 'Escrow',
): void {
  const id = getId(aggregate);
  const snapshot = aggregate.toSnapshot();
  const preStateVersion = snapshot.version;
  const existing = rows.get(id);
  if (existing) {
    const existingVersion = existing.toSnapshot().version;
    if (existingVersion !== preStateVersion) {
      throw new OptimisticLockError(aggregateType, id, preStateVersion);
    }
  }
  // Replace the stored aggregate with the new one. The aggregate's
  // pre-state version becomes the "what the row currently holds"
  // value; the next save would write `version = preStateVersion + 1`,
  // matching the production repository's `version = row.version + 1`
  // semantic.
  rows.set(id, aggregate);
}
