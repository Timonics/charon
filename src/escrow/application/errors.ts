import { DomainError } from '../../shared/kernel/domain-error';

/**
 * Thrown when a command references an escrow id (or payment intent id) that
 * no escrow is registered for. Read-side "not found" — distinct from domain
 * errors because nothing about the request's shape or timing is wrong.
 */
export class EscrowNotFoundError extends DomainError {
  readonly code = 'ESCROW_NOT_FOUND';

  constructor(lookup: string) {
    super(`No escrow found for: ${lookup}`);
  }
}

/**
 * Thrown when an escrow hold is requested against a payment intent that has
 * not reached SUCCEEDED. An escrow is a hold over SETTLED funds only —
 * registering a hold over a pending or failed charge would create a hold
 * the provider's custody primitive can never secure.
 */
export class PaymentNotSettledError extends DomainError {
  readonly code = 'PAYMENT_NOT_SETTLED';

  constructor(readonly paymentIntentId: string) {
    super(
      `Payment intent ${paymentIntentId} is not settled; cannot place an escrow hold`,
    );
  }
}

/**
 * Thrown when an escrow hold is requested for a payment intent that already
 * has one. One hold per settlement keeps the "released + refunded ≤ held"
 * invariant unambiguous — splitting a settlement across multiple escrows
 * would make consumption accounting ambiguous across aggregates.
 */
export class DuplicateEscrowForPaymentError extends DomainError {
  readonly code = 'DUPLICATE_ESCROW_FOR_PAYMENT';

  constructor(
    readonly paymentIntentId: string,
    readonly existingEscrowId: string,
  ) {
    super(
      `Payment intent ${paymentIntentId} already has escrow ${existingEscrowId}`,
    );
  }
}
