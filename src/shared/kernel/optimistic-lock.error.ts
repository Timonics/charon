import { DomainError } from './domain-error';

/**
 * Thrown when a compare-and-swap update affects zero rows because the
 * row's `version` column has been incremented by a concurrent writer.
 *
 * This is the persistence-layer backstop that prevents the money-loss
 * class of bugs the audit flagged:
 *
 *   1. Caller A loads an aggregate at version 5.
 *   2. Caller B loads the same aggregate at version 5.
 *   3. Caller A mutates + saves → row version becomes 6.
 *   4. Caller B mutates + saves → UPDATE ... WHERE version = 5
 *      affects zero rows → OptimisticLockError.
 *
 * The use-case handler does not retry. The UnitOfWork rolls back, and
 * the application layer surfaces a typed error so the caller can
 * decide whether to reload-and-retry (idempotent commands) or
 * surface a conflict to the user (interactive commands).
 */
export class OptimisticLockError extends DomainError {
  readonly code = 'OPTIMISTIC_LOCK_FAILED';

  constructor(
    public readonly aggregateType: 'PaymentIntent' | 'Escrow',
    public readonly aggregateId: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Optimistic lock failed on ${aggregateType} ${aggregateId}: ` +
        `expected version ${expectedVersion}, but the row was updated ` +
        `by a concurrent writer. Reload and retry.`,
    );
  }
}
