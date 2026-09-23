import type { SqlExecutor } from './db';

/**
 * The cross-cutting capability every persistence port must expose so the
 * unit-of-work can route writes through the same database transaction.
 *
 * Usage (production code):
 *
 * ```ts
 * await unitOfWork.run(async (tx) => {
 *   const intentRepo = repos.intents.with(tx);
 *   const ledger = ledgerAppender.with(tx);
 *   await intentRepo.save(intent);
 *   await ledger.append('PaymentIntent', intent.intentId, events);
 * });
 * ```
 *
 * Usage (test code):
 *
 * ```ts
 * const tx = new RecordingSqlExecutor();
 * const intentRepo = new InMemoryPaymentIntentRepository().with(tx);
 * // every method on intentRepo routes through `tx`
 * ```
 *
 * Implementation contract: the returned value is a NEW instance bound to
 * `tx`, NOT a mutating in-place rebind. This lets repos be safely shared
 * across threads/requests without one transaction contaminating another.
 *
 * The constraint `T extends TransactionCapable<T>` is the F-bounded
 * polymorphism that lets `with()` return the same concrete type — callers
 * don't lose type info when they chain it.
 */
export interface TransactionCapable<T extends TransactionCapable<T>> {
  /**
   * Returns a new repository instance bound to the given transaction
   * executor. Every method on the returned instance routes queries through
   * `tx`. The original instance is unchanged.
   *
   * Implementors MUST:
   *  - return a fresh instance, not `this` (no shared state across
   *    transactions);
   *  - preserve all behavior of the original — the only difference is
   *    which executor receives the queries;
   *  - support being called with the pool itself (`with(pool)`) for the
   *    non-transactional case, so use cases can use the same call shape
   *    whether or not they are wrapped in a unit of work.
   */
  with(tx: SqlExecutor): T;
}
