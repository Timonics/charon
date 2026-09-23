import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Base class for every error thrown by the Ledger bounded context.
 * See {@link PaymentDomainError} for the rationale behind a per-context
 * error base class.
 */
export abstract class LedgerDomainError extends DomainError {}

/**
 * Thrown when a {@link LedgerEntry} is constructed with malformed data
 * (empty identifiers, non-positive sequence, unserializable payload, ...).
 *
 * In an append-only audit log, garbage must never get in — there is no
 * update or delete to fix it later — so validation here is stricter than
 * on ordinary entities.
 */
export class InvalidLedgerEntryError extends LedgerDomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

/**
 * Thrown when an entry arrives whose per-aggregate sequence number is not
 * exactly `lastSequence + 1`.
 *
 * Why this deserves its own error type: the ledger is the reconciliation
 * source of truth for the whole service. A sequence gap means an event was
 * lost between the aggregate and the journal — projections rebuilt from a
 * gappy stream would silently produce wrong balances. This error is the
 * tripwire: when it fires, stop projecting, alert, and repair from the
 * webhook inbox (which stores raw verified events for exactly this
 * situation). Never swallow it.
 */
export class SequenceGapError extends LedgerDomainError {
  readonly code = 'LEDGER_SEQUENCE_GAP';

  constructor(
    readonly aggregateType: string,
    readonly aggregateId: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Sequence gap for ${aggregateType} ${aggregateId}: expected ${expected}, received ${received}`,
    );
  }
}
